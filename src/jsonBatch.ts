import {
    BatchOperation,
    Call,
    RetrieveCall,
    ensureCallIsSafe,
    ensureRetrieveCallIsSafe,
    ensureContentIdsAreSafe,
    assignV4ContentIds,
} from './request';
import {
    BatchResponseParsed,
    BatchResponseGroup,
    BatchRequestLayout,
    BatchResponseInterface,
    BatchResponseConstructor,
} from './response';

// OData JSON Format Version 4.01, section 19 "Batch Requests and Responses":
// https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html

interface JsonBatchRequest {
    id: string;
    atomicityGroup?: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    dependsOn?: string[];
    body?: unknown;
}

const isBinaryData = (data: unknown): data is Buffer | Uint8Array =>
    Buffer.isBuffer(data) || data instanceof Uint8Array;

// RFC 4648 section 5: URL-safe alphabet ('-' and '_') with the '=' padding
// stripped. Spelled out instead of Node's 'base64url' encoding to keep working
// on the Node 14 runtime this library targets.
const toBase64Url = (data: Buffer | Uint8Array): string =>
    Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Retrieves need request ids in JSON batch too: lift each one onto a synthetic
// GET call so assignV4ContentIds assigns its id from the same lowest-free-
// number sequence as changeset members. The synthetic call is never validated
// as a Call (GET is illegal inside changesets) and never serialized.
const retrieveToCall = (retrieve: RetrieveCall): Call => ({
    method: 'GET',
    url: retrieve.url,
    headers: retrieve.headers,
    data: undefined,
});

// Multipart parity for direct GET parts: a body-bearing content-type is
// dropped, the batch-level accept replaces any caller accept
const retrieveHeaders = (
    headers: Record<string, string | number> | undefined,
    accept?: string
): Record<string, string> => {
    const lowered: Record<string, string> = {};
    Object.entries(headers ?? {}).forEach(([key, value]) => {
        if (key.toLowerCase() === 'content-type') {
            return;
        }
        lowered[key.toLowerCase()] = String(value);
    });
    if (accept !== undefined) {
        lowered['accept'] = accept;
    }
    return lowered;
};

// Header rules per request, mirroring the multipart serializer: the batch
// accept replaces any caller accept; a JSON body always carries the batch JSON
// type (caller content-type never wins); binary data requires the call's own
// content-type and keeps it. A bodyless call passes caller headers through.
const memberHeaders = (call: Call, accept?: string): Record<string, string> => {
    const lowered: Record<string, string> = {};
    Object.entries(call.headers ?? {}).forEach(([key, value]) => {
        lowered[key.toLowerCase()] = String(value);
    });

    if (isBinaryData(call.data)) {
        if (lowered['content-type'] === undefined) {
            throw new Error('Binary call data requires its own Content-Type header');
        }
    } else if (call.data !== undefined) {
        lowered['content-type'] = 'application/json';
    }

    if (accept !== undefined) {
        lowered['accept'] = accept;
    }
    return lowered;
};

// OData JSON Format 4.01, section 19.1: for application/json the body member
// is the JSON value itself; for other media types it is a base64url string.
// `data === undefined` omits the member entirely.
const bodyMember = (call: Call): { body?: unknown } => {
    if (call.data === undefined) {
        return {};
    }
    if (isBinaryData(call.data)) {
        return { body: toBase64Url(call.data) };
    }
    return { body: call.data };
};

// OData JSON Format 4.01, section 19.1: dependsOn values must be ids or
// atomicity groups of preceding request objects; forward references are not
// allowed. No implicit dependsOn is ever added.
const ensureDependsOnReferencesEarlierRequests = (call: Call, known: Set<string>): void => {
    if (call.dependsOn === undefined) {
        return;
    }
    call.dependsOn.forEach((reference) => {
        if (!known.has(reference)) {
            throw new Error(`dependsOn must reference an earlier request id or atomicity group: ${reference}`);
        }
    });
};

// Serializes ordered mixed operations (retrieve parts and atomic changesets)
// into an OData 4.01 JSON batch request body. `requestIds[i]` lists the ids
// emitted for operations[i], in order, for response correlation.
export const operationsToJsonBatch = (
    operations: BatchOperation[],
    options: { accept?: string } = {}
): { body: string; requestIds: string[][] } => {
    if (!Array.isArray(operations) || operations.length <= 0) {
        throw new Error('No calls have been passed');
    }

    operations.forEach((part) => {
        if (!Array.isArray(part) && (part === null || typeof part !== 'object')) {
            throw new Error('Invalid batch operation part');
        }
    });

    operations.filter((part) => !Array.isArray(part)).forEach((part) => ensureRetrieveCallIsSafe(part as RetrieveCall));
    operations
        .filter((part) => Array.isArray(part))
        .forEach((changeset) => {
            const calls = changeset as Call[];
            if (calls.length <= 0) {
                throw new Error('No calls have been passed');
            }
            calls.forEach(ensureCallIsSafe);
            ensureContentIdsAreSafe(calls);
        });

    // One id space for the whole batch: OData JSON Format 4.01, section 19.1,
    // an id MUST NOT equal any other id nor any atomicityGroup. Reusing
    // assignV4ContentIds keeps explicit ids and assigns the lowest free
    // sequential number to everything else, batch-wide.
    const groups = operations.map((part) => (Array.isArray(part) ? part : [retrieveToCall(part as RetrieveCall)]));
    const assigned = assignV4ContentIds(groups);

    // Group names share the id namespace (section 19.1: a group name MUST NOT
    // be identical to any id) and must be unique among themselves: pick the
    // lowest 'group<n>' no id or earlier group uses.
    const taken = new Set<string>(assigned.flat().map((call) => call.contentId as string));
    let candidate = 1;
    const groupNames = operations.map((part) => {
        if (!Array.isArray(part)) {
            return undefined;
        }
        while (taken.has(`group${candidate}`)) {
            candidate++;
        }
        const name = `group${candidate++}`;
        taken.add(name);
        return name;
    });

    const { accept } = options;
    const requests: JsonBatchRequest[] = [];
    const requestIds: string[][] = [];
    const known = new Set<string>();

    operations.forEach((part, index) => {
        if (!Array.isArray(part)) {
            const id = assigned[index][0].contentId as string;
            requests.push({
                id,
                method: 'get',
                url: (part as RetrieveCall).url,
                headers: retrieveHeaders((part as RetrieveCall).headers, accept),
            });
            known.add(id);
            requestIds.push([id]);
            return;
        }

        const atomicityGroup = groupNames[index] as string;
        const ids: string[] = [];
        assigned[index].forEach((call) => {
            const id = call.contentId as string;
            ensureDependsOnReferencesEarlierRequests(call, known);
            requests.push({
                id,
                atomicityGroup,
                method: call.method.toLowerCase(),
                url: call.url,
                headers: memberHeaders(call, accept),
                ...(call.dependsOn !== undefined ? { dependsOn: [...call.dependsOn] } : {}),
                ...bodyMember(call),
            });
            known.add(id);
            ids.push(id);
        });
        // Cross-group dependencies must name the completed group, not one
        // of its members (OData JSON Format 4.01, section 19.1).
        ids.forEach((id) => known.delete(id));
        known.add(atomicityGroup);
        requestIds.push(ids);
    });

    return { body: JSON.stringify({ requests }), requestIds };
};

interface JsonBatchResponseItem {
    parsed: BatchResponseParsed;
    atomicityGroup?: string;
}

// OData JSON Format 4.01, section 19.5: a batch response body is one object
// with a `responses` array. Anything else is not a JSON batch response.
const parseEnvelope = (data: string | object): { responses: unknown[] } => {
    let envelope: unknown;
    if (typeof data === 'string') {
        try {
            envelope = JSON.parse(data);
        } catch {
            throw new Error('Invalid JSON batch response');
        }
    } else {
        envelope = data;
    }
    if (
        envelope === null ||
        typeof envelope !== 'object' ||
        !Array.isArray((envelope as { responses?: unknown }).responses)
    ) {
        throw new Error('Invalid JSON batch response');
    }
    return envelope as { responses: unknown[] };
};

// Response objects are service-produced: a malformed entry degrades to an
// empty unsuccessful response instead of destroying the whole batch. Property
// access on primitives yields undefined, so only null needs a guard.
const toItem = (raw: unknown): JsonBatchResponseItem => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const status = item.status;
    const hasStatus = typeof status === 'number' && Number.isInteger(status);
    const headers =
        item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
            ? (item.headers as Record<string, unknown>)
            : {};

    return {
        parsed: {
            code: hasStatus ? String(status) : '',
            status: '',
            headers: Object.entries(headers).map(([key, value]) => ({ key, value: String(value) })),
            data: item.body !== undefined ? item.body : null,
            success: hasStatus ? status < 400 : false,
            ...(typeof item.id === 'string' ? { contentId: item.id } : {}),
        },
        ...(typeof item.atomicityGroup === 'string' ? { atomicityGroup: item.atomicityGroup } : {}),
    };
};

interface JsonBatchUnit {
    items: JsonBatchResponseItem[];
    isGroup: boolean;
}

export class JsonBatchResponse implements BatchResponseInterface {
    response: BatchResponseParsed[];
    private items: JsonBatchResponseItem[];
    private requestIds?: string[][];

    constructor(
        { data }: { data: string | object; headers: Record<string, string> },
        accept: string,
        requestIds?: string[][]
    ) {
        if (!accept) {
            throw new Error('Need accept to know how parse.');
        }
        this.requestIds = requestIds;
        this.items = parseEnvelope(data).responses.map(toItem);
        const seen = new Set<string>();
        this.items.forEach(({ parsed }) => {
            if (parsed.contentId !== undefined) {
                if (seen.has(parsed.contentId)) {
                    throw new Error(`JSON batch response does not match request ids: ${parsed.contentId}`);
                }
                seen.add(parsed.contentId);
            }
        });
        if (requestIds !== undefined) {
            this.items = this.orderByRequestIds(this.items, requestIds);
        } else {
            this.assignChangesetIndexByFirstAppearance(this.items);
        }
        // Section 19.5: a failed atomicity group rolls back every member,
        // even when an individual response still carries a 2xx status.
        this.buildUnits().forEach(({ items }) => {
            if (items.some(({ parsed }) => /^[45][0-9]{2}$/.test(parsed.code))) {
                items.forEach(({ parsed }) => {
                    parsed.success = false;
                });
            }
        });
        this.response = this.items.map(({ parsed }) => parsed);
    }

    // Same types and semantics as BatchResponse.parseGrouped in response.ts:
    // responses sharing an atomicityGroup form one changeset unit, standalone
    // responses map to retrieve (with layout) or unclassified (without).
    parseGrouped(layout?: BatchRequestLayout): BatchResponseGroup[] {
        const units = this.buildUnits();
        if (layout) {
            if (!Array.isArray(layout) || layout.length !== units.length) {
                throw new Error('Grouped response part count does not match request layout');
            }
            layout.forEach((entry) => {
                if (
                    !entry ||
                    (entry.kind !== 'retrieve' && entry.kind !== 'changeset') ||
                    (entry.kind === 'changeset' &&
                        (!Number.isInteger(entry.operationCount) || entry.operationCount < 1))
                ) {
                    throw new Error('Grouped response has invalid request layout');
                }
            });
        }

        return units.map((unit, partIndex): BatchResponseGroup => {
            const expected = layout?.[partIndex];
            const failure =
                unit.items.find(({ parsed }) => /^[45][0-9]{2}$/.test(parsed.code)) ??
                unit.items.find(({ parsed }) => !parsed.success);
            if (unit.isGroup || (this.requestIds !== undefined && expected?.kind === 'changeset')) {
                if (expected?.kind === 'retrieve') {
                    throw new Error('Grouped response changeset does not match retrieve layout');
                }
                if (expected?.kind === 'changeset' && unit.items.length !== expected.operationCount && !failure) {
                    throw new Error('Grouped response changeset operation count does not match request layout');
                }
                // OData JSON Format Version 4.01, section 19.5 "Batch
                // Response": "If any response within an atomicity group
                // returns a failure code, all requests within that atomicity
                // group are considered failed, regardless of their individual
                // returned status code." The service MAY answer unattempted
                // members with 424 Failed Dependency; the first failing
                // response carries the unit's error.
                if (failure) {
                    return { kind: 'changeset-error', partIndex, error: failure.parsed };
                }
                return { kind: 'changeset', partIndex, responses: unit.items.map(({ parsed }) => parsed) };
            }

            const response = unit.items[0].parsed;
            if (!expected) {
                return { kind: 'unclassified', partIndex, response };
            }
            if (expected.kind === 'retrieve') {
                return { kind: 'retrieve', partIndex, response };
            }
            if (/^[45][0-9]{2}$/.test(response.code)) {
                return { kind: 'changeset-error', partIndex, error: response };
            }
            throw new Error('Grouped response expected a multipart changeset or whole-changeset HTTP error');
        });
    }

    // OData JSON Format 4.01, section 19.5: JSON batch response objects MAY
    // appear in any order; ids correlate them back to the requests.
    private orderByRequestIds(items: JsonBatchResponseItem[], requestIds: string[][]): JsonBatchResponseItem[] {
        const expected = requestIds.flat();
        const expectedSet = new Set(expected);
        const byId = new Map<string, JsonBatchResponseItem>();
        items.forEach((item) => {
            const id = item.parsed.contentId;
            if (id === undefined || !expectedSet.has(id)) {
                throw new Error(`JSON batch response does not match request ids: ${id}`);
            }
            byId.set(id, item);
        });

        const operationIndex = new Map<string, number>();
        requestIds.forEach((ids, index) => ids.forEach((id) => operationIndex.set(id, index)));

        return expected.flatMap((id) => {
            const item = byId.get(id);
            if (!item) {
                const group = requestIds[operationIndex.get(id) as number];
                // A failure rolls back the entire atomicity group; 424
                // responses for its other members are optional (§19.5).
                if (
                    group.some((member) => {
                        const sibling = byId.get(member);
                        return sibling !== undefined && /^[45][0-9]{2}$/.test(sibling.parsed.code);
                    })
                ) {
                    return [];
                }
                throw new Error(`JSON batch response does not match request ids: ${id}`);
            }
            return [{ ...item, parsed: { ...item.parsed, changesetIndex: operationIndex.get(id) } }];
        });
    }

    // Without request ids the service order is kept and the operation index is
    // derived by first appearance: a shared atomicityGroup maps to one index,
    // every standalone response gets its own.
    private assignChangesetIndexByFirstAppearance(items: JsonBatchResponseItem[]): void {
        const groupIndex = new Map<string, number>();
        let counter = 0;
        items.forEach((item) => {
            if (item.atomicityGroup === undefined) {
                item.parsed.changesetIndex = counter++;
                return;
            }
            if (!groupIndex.has(item.atomicityGroup)) {
                groupIndex.set(item.atomicityGroup, counter++);
            }
            item.parsed.changesetIndex = groupIndex.get(item.atomicityGroup);
        });
    }

    private buildUnits(): JsonBatchUnit[] {
        if (this.requestIds !== undefined) {
            // Ids prove membership: chunk the (already reordered) items by
            // operation. A chunk with several responses, or any response
            // carrying atomicityGroup, is an atomicity group unit.
            return this.requestIds.map((ids) => {
                const chunk = this.items.filter((item) => ids.includes(item.parsed.contentId as string));
                const isGroup = chunk.length > 1 || chunk.some((item) => item.atomicityGroup !== undefined);
                return { items: chunk, isGroup };
            });
        }

        // Without request ids, group by atomicityGroup; same-group responses
        // merge into one unit even when the service interleaved them.
        const units: JsonBatchUnit[] = [];
        const unitByGroup = new Map<string, JsonBatchUnit>();
        this.items.forEach((item) => {
            if (item.atomicityGroup === undefined) {
                units.push({ items: [item], isGroup: false });
                return;
            }
            let unit = unitByGroup.get(item.atomicityGroup);
            if (!unit) {
                unit = { items: [], isGroup: true };
                unitByGroup.set(item.atomicityGroup, unit);
                units.push(unit);
            }
            unit.items.push(item);
        });
        return units;
    }
}

// Binds the request ids emitted by operationsToJsonBatch so the parser can be
// handed to the existing repository plumbing as a BatchResponseConstructor.
export const createJsonBatchResponseParser = (requestIds: string[][]): BatchResponseConstructor =>
    function (
        OResponse: { data: string | object; headers: Record<string, string> },
        accept: string
    ): BatchResponseInterface {
        return new JsonBatchResponse(OResponse, accept, requestIds);
    } as unknown as BatchResponseConstructor;
