import { flatten } from './utils';
import { generateBoundaryId } from './boundary';

export interface SerializedBatch {
    // Buffer as soon as any call carries binary data, otherwise the legacy string
    body: string | Buffer;
    boundary: string;
}

export interface BatchRequestOptions {
    contentType?: string;
    accept?: string;
    // '4.0' requires a Content-ID on every changeset member (OData v4 multipart)
    protocolVersion?: '2.0' | '4.0' | '4.01';
}

export interface Call {
    method: string;
    url: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload is caller-defined: JSON-serializable value or raw string
    data: any;
    headers?: Record<string, string | number>;
    contentId?: string;
    // OData v4 JSON batch only: ids or atomicity groups this request waits for
    dependsOn?: string[];
}

export interface RetrieveCall {
    url: string;
    headers?: Record<string, string | number>;
}

const LINE_BREAK = /[\r\n]/;

// Header-injection guard: a line break inside the request line or a
// header value would smuggle extra lines into the wire format
const ensureNoLineBreak = (label: string, value: string): void => {
    if (LINE_BREAK.test(value)) {
        throw new Error(`Call ${label} must not contain line breaks: ${JSON.stringify(value)}`);
    }
};

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const ensureMethodIsSafe = (method: string): void => {
    if (typeof method !== 'string' || !HTTP_TOKEN.test(method)) {
        throw new Error('Call method must be a valid HTTP token');
    }
};

const ensureHeadersAreSafe = (headers?: Record<string, string | number>): void => {
    if (!headers) {
        return;
    }

    Object.entries(headers).forEach(([key, value]) => {
        if (LINE_BREAK.test(key) || LINE_BREAK.test(String(value))) {
            throw new Error(`Call header '${key}' must not contain line breaks`);
        }
    });
};

// Every Call is a changeset member, and OData forbids retrieve (query)
// operations inside a changeset: GETs must be direct batch parts
const ensureMethodIsChangeset = (method: string): void => {
    if (method.toUpperCase() === 'GET') {
        throw new Error('GET is not allowed inside a changeset; use retrieve or operations');
    }
};

// Shared by every serializer (multipart and JSON batch)
export const ensureCallIsSafe = (call: Call): void => {
    ensureNoLineBreak('url', call.url);
    ensureMethodIsSafe(call.method);
    ensureMethodIsChangeset(call.method);
    ensureHeadersAreSafe(call.headers);
};

// Binary (media) payloads: written verbatim, never re-encoded as utf8 text
const isBinaryData = (data: unknown): data is Buffer | Uint8Array =>
    Buffer.isBuffer(data) || data instanceof Uint8Array;

// A binary part needs its own media type: the batch-level content type
// describes the JSON/XML bodies and would mislabel raw bytes
const hasOwnContentType = (headers: Record<string, string | number> | undefined): boolean =>
    Object.entries(headers ?? {}).some(([header]) => header.toLowerCase() === 'content-type');

// Multipart has no way to express dependsOn: reject it instead of dropping it
const ensureMultipartCallIsSafe = (call: Call): void => {
    ensureCallIsSafe(call);
    if (call.dependsOn !== undefined) {
        throw new Error("dependsOn requires batchFormat 'json'");
    }
    if (isBinaryData(call.data) && !hasOwnContentType(call.headers)) {
        throw new Error('Binary call data requires its own Content-Type header');
    }
};

export const ensureContentIdsAreSafe = (calls: Call[], scope: 'changeset' | 'batch' = 'changeset'): void => {
    const seen = new Set<string>();
    calls.forEach(({ contentId }) => {
        if (contentId === undefined) {
            return;
        }
        if (typeof contentId !== 'string' || contentId.length === 0 || /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(contentId)) {
            throw new Error('Call contentId must be a nonempty HTTP token');
        }
        if (seen.has(contentId)) {
            throw new Error(
                `Duplicate contentId within ${scope === 'batch' ? 'the batch' : 'a changeset'}: ${contentId}`
            );
        }
        seen.add(contentId);
    });
};

// OData v4 multipart: every changeset member MUST carry a Content-ID that is
// unique within the whole batch. Explicit IDs are kept; missing ones get the
// lowest free sequential number. Returns copies, never mutating the input.
export const assignV4ContentIds = (groups: Call[][]): Call[][] => {
    const taken = new Set<string>();
    groups.flat().forEach(({ contentId }) => {
        if (contentId === undefined) {
            return;
        }
        if (taken.has(contentId)) {
            throw new Error(`Duplicate contentId within the batch: ${contentId}`);
        }
        taken.add(contentId);
    });

    let next = 1;
    return groups.map((calls) =>
        calls.map((call) => {
            if (call.contentId !== undefined) {
                return call;
            }
            while (taken.has(String(next))) {
                next++;
            }
            taken.add(String(next));
            return { ...call, contentId: String(next) };
        })
    );
};

// An absent ID contributes no line, preserving the legacy framing exactly.
const contentIdHeaders = ({ contentId }: Call): string[] =>
    contentId === undefined ? [] : [`Content-ID: ${contentId}`];

// GET-only guard: retrieve mode has no way to express a method or a body.
// A `method`/`data` own property (e.g. a Call cast to RetrieveCall) means
// the caller wanted more than a plain GET - reject it instead of silently
// dropping the intent
const ensureRetrieveIsGetOnly = (retrieve: RetrieveCall): void => {
    if (
        Object.prototype.hasOwnProperty.call(retrieve, 'method') ||
        Object.prototype.hasOwnProperty.call(retrieve, 'data')
    ) {
        throw new Error('retrieve calls are GET-only: method and data are not allowed');
    }
};

export const ensureRetrieveCallIsSafe = (retrieve: RetrieveCall): void => {
    ensureRetrieveIsGetOnly(retrieve);
    ensureNoLineBreak('url', retrieve.url);
    ensureHeadersAreSafe(retrieve.headers);
};

// A mixed-batch entry is either one direct (retrieve) part or an atomic
// changeset of write calls. Order across entries is preserved.
export type BatchOperation = RetrieveCall | Call[];

const isChangesetPart = (part: BatchOperation): part is Call[] => Array.isArray(part);

const isXmlMediaType = (contentType?: string): boolean => {
    const mediaType = contentType?.split(';')[0].trim().toLowerCase();
    return mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType === 'application/atom+xml';
};

// Changeset part headers mirror requestsToBatch: an explicit content-type or
// accept is replaced by the batch-level value, everything else passes through.
const changesetHeaders = (
    headers: Record<string, string | number> | undefined,
    contentType?: string,
    accept?: string
): string[] => {
    if (!headers) {
        return [`Content-Type: ${contentType}`, `Accept: ${accept}`];
    }

    return Object.entries(headers).map(([header, value]) => {
        if (header.toLowerCase() === 'content-type' && contentType) {
            return `Content-Type: ${contentType}`;
        }

        if (header.toLowerCase() === 'accept' && accept) {
            return `Accept: ${accept}`;
        }

        return header + ': ' + value;
    });
};

// Direct (GET) part headers mirror retrieveToBatch: only accept plus custom
// headers, a body-bearing content-type is dropped.
const retrievePartHeaders = (headers: Record<string, string | number> | undefined, accept?: string): string[] => {
    if (!headers) {
        return [`Accept: ${accept}`];
    }

    const custom = Object.entries(headers)
        .filter(([header]) => header.toLowerCase() !== 'accept' && header.toLowerCase() !== 'content-type')
        .map(([header, value]) => header + ': ' + value);

    return [`Accept: ${accept}`, ...custom];
};

// Binary part headers: the call's own Content-Type names the payload media
// type and is emitted as given (never replaced by the batch-level type);
// Accept is still overridden by the batch-level accept, others pass through.
const binaryPartHeaders = (headers: Record<string, string | number>, accept?: string): string[] =>
    Object.entries(headers).map(([header, value]) => {
        if (header.toLowerCase() === 'accept' && accept) {
            return `Accept: ${accept}`;
        }

        return header + ': ' + value;
    });

// The wire format is CRLF-joined lines; a binary body interrupts the text.
// Without binary data the segments are plain strings and the join is
// byte-identical to the legacy wire format; with binary data every text
// segment is utf8-encoded and the payload bytes are written verbatim.
const joinWireLines = (lines: (string | Buffer)[]): string | Buffer => {
    if (!lines.some((line) => Buffer.isBuffer(line))) {
        return lines.join('\r\n');
    }

    return Buffer.concat(
        lines.reduce<Buffer[]>((chunks, line, index) => {
            if (index > 0) {
                chunks.push(Buffer.from('\r\n', 'utf8'));
            }
            chunks.push(Buffer.isBuffer(line) ? line : Buffer.from(line == null ? '' : String(line), 'utf8'));
            return chunks;
        }, [])
    );
};

// Ordered mixed batch: GET entries are emitted as direct application/http
// parts, Call[] entries as atomic changesets, in input order. Reuses the
// injection/contentId guards and the boundary-collision reroll.
export const operationsToBatch = function (
    operations: BatchOperation[],
    boundaryOrOptions?: string | BatchRequestOptions,
    maybeOptions?: BatchRequestOptions
): SerializedBatch {
    if (!Array.isArray(operations) || operations.length <= 0) {
        throw new Error('No calls have been passed');
    }

    let initialBoundary: string | undefined;
    let options: BatchRequestOptions;

    if (typeof boundaryOrOptions === 'string') {
        initialBoundary = boundaryOrOptions;
        options = maybeOptions || {};
    } else {
        initialBoundary = undefined;
        options = boundaryOrOptions || {};
    }

    const { contentType, accept, protocolVersion } = options;

    operations.forEach((part) => {
        if (!isChangesetPart(part) && (part === null || typeof part !== 'object')) {
            throw new Error('Invalid batch operation part');
        }
    });

    operations
        .filter((part) => !isChangesetPart(part))
        .forEach((part) => ensureRetrieveCallIsSafe(part as RetrieveCall));
    operations.filter(isChangesetPart).forEach((calls) => {
        if (calls.length <= 0) {
            throw new Error('No calls have been passed');
        }
        calls.forEach(ensureMultipartCallIsSafe);
        ensureContentIdsAreSafe(calls, protocolVersion === '4.0' || protocolVersion === '4.01' ? 'batch' : 'changeset');
    });

    if (protocolVersion === '4.0' || protocolVersion === '4.01') {
        const assigned = assignV4ContentIds(operations.filter(isChangesetPart));
        let changesetCursor = 0;
        operations = operations.map((part) => (isChangesetPart(part) ? assigned[changesetCursor++] : part));
    }
    const changesets = operations.filter(isChangesetPart);

    const isXml = isXmlMediaType(contentType);
    // JSON.stringify returns undefined for `undefined` input; Array.join used
    // to coerce that to an empty line, so normalize to '' to keep those bytes
    const serializeBody = (call: Call): string | Buffer =>
        isBinaryData(call.data)
            ? Buffer.from(call.data)
            : isXml
              ? String(call.data)
              : (JSON.stringify(call.data) ?? '');
    const serializedBodies = changesets.flat().map(serializeBody);

    let batchBoundary = initialBoundary || generateBoundaryId();
    for (let attempts = 0; serializedBodies.some((body) => body.includes(`--batch_${batchBoundary}`)); attempts++) {
        if (attempts >= 9) {
            throw new Error('Unable to generate a batch boundary that does not collide with the payload');
        }
        batchBoundary = generateBoundaryId();
    }

    let changeSetId = generateBoundaryId();
    for (let attempts = 0; serializedBodies.some((body) => body.includes(`--changeset_${changeSetId}`)); attempts++) {
        if (attempts >= 9) {
            throw new Error('Unable to generate a changeset boundary that does not collide with the payload');
        }
        changeSetId = generateBoundaryId();
    }

    let changesetIndex = 0;
    const parts = operations.map((operation) => {
        if (isChangesetPart(operation)) {
            const csBoundary = `changeset_${changeSetId}_${changesetIndex++}`;

            const inner = operation.map((call) =>
                flatten([
                    `--${csBoundary}`,
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    ...contentIdHeaders(call),
                    '',

                    `${call.method.toUpperCase()} ${call.url} HTTP/1.1`,
                    // binary implies a content-type header, so headers is defined
                    isBinaryData(call.data)
                        ? binaryPartHeaders(call.headers as Record<string, string | number>, accept)
                        : changesetHeaders(call.headers, contentType, accept),
                    '',
                    serializeBody(call),
                    '',
                ])
            );

            return flatten([
                `--batch_${batchBoundary}`,
                `Content-Type: multipart/mixed; boundary=${csBoundary}`,
                '',
                flatten(inner),
                `--${csBoundary}--`,
                '',
            ]);
        }

        const retrieve = operation as RetrieveCall;

        return flatten([
            `--batch_${batchBoundary}`,
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',

            `GET ${retrieve.url} HTTP/1.1`,
            retrievePartHeaders(retrieve.headers, accept),
            '',
            '',
        ]);
    });

    return {
        body: joinWireLines(flatten(parts).concat(`--batch_${batchBoundary}--`)),
        boundary: batchBoundary,
    };
};

export const requestsToBatch = function (
    data: Call[] | Call[][],
    boundaryOrOptions?: string | BatchRequestOptions,
    maybeOptions?: BatchRequestOptions
): SerializedBatch {
    let initialBoundary: string | undefined;
    let options: BatchRequestOptions;

    if (typeof boundaryOrOptions === 'string') {
        initialBoundary = boundaryOrOptions;
        options = maybeOptions || {};
    } else {
        initialBoundary = undefined;
        options = boundaryOrOptions || {};
    }

    const { contentType, accept, protocolVersion } = options;
    const mediaType = contentType?.split(';')[0].trim().toLowerCase();
    const isXml = mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType === 'application/atom+xml';

    const parseHeaders = (headers?: Record<string, string | number>): string[] => {
        if (!headers) {
            return [`Content-Type: ${contentType}`, `Accept: ${accept}`];
        }

        const _headers = Object.entries(headers).map((h) => {
            const [header, value] = h;

            if (header.toLowerCase() === 'content-type' && contentType) {
                return `Content-Type: ${contentType}`;
            }

            if (header.toLowerCase() === 'accept' && accept) {
                return `Accept: ${accept}`;
            }

            return header + ': ' + value;
        });

        return _headers;
    };

    // Auto-detect multi-changeset format
    const isMulti = Array.isArray(data[0]);

    (isMulti ? (data as Call[][]).flat() : (data as Call[])).forEach(ensureMultipartCallIsSafe);
    (isMulti ? (data as Call[][]) : [data as Call[]]).forEach((calls) =>
        ensureContentIdsAreSafe(calls, protocolVersion === '4.0' || protocolVersion === '4.01' ? 'batch' : 'changeset')
    );

    if (protocolVersion === '4.0' || protocolVersion === '4.01') {
        const assigned = assignV4ContentIds(isMulti ? (data as Call[][]) : [data as Call[]]);
        data = isMulti ? assigned : assigned[0];
    }

    const allCalls: Call[] = isMulti ? (data as Call[][]).flat() : (data as Call[]);

    // Boundary-collision guard: if a serialized payload already contains the
    // batch or changeset delimiter, the server would cut the message early -
    // reroll the boundary until the wire is unambiguous
    // JSON.stringify returns undefined for `undefined` input; Array.join used
    // to coerce that to an empty line, so normalize to '' to keep those bytes
    const serializeBody = (call: Call): string | Buffer =>
        isBinaryData(call.data)
            ? Buffer.from(call.data)
            : isXml
              ? flatten([call.data]).join('\r\n')
              : (JSON.stringify(call.data) ?? '');
    const serializedBodies = allCalls.map(serializeBody);

    let batchBoundary = initialBoundary || generateBoundaryId();
    for (let attempts = 0; serializedBodies.some((body) => body.includes(`--batch_${batchBoundary}`)); attempts++) {
        if (attempts >= 9) {
            throw new Error('Unable to generate a batch boundary that does not collide with the payload');
        }
        batchBoundary = generateBoundaryId();
    }

    let changeSetId = generateBoundaryId();
    for (let attempts = 0; serializedBodies.some((body) => body.includes(`--changeset_${changeSetId}`)); attempts++) {
        if (attempts >= 9) {
            throw new Error('Unable to generate a changeset boundary that does not collide with the payload');
        }
        changeSetId = generateBoundaryId();
    }

    if (!isMulti) {
        // Legacy path - bit-identical to v1.2.0
        const calls = data as Call[];

        const aBatchByResponse = calls.map(function (val) {
            // binary implies a content-type header, so headers is defined
            const headers = isBinaryData(val.data)
                ? binaryPartHeaders(val.headers as Record<string, string | number>, accept)
                : parseHeaders(val.headers);

            return flatten([
                '--changeset_' + changeSetId,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                ...contentIdHeaders(val),
                '',

                val.method.toUpperCase() + ' ' + val.url + ' HTTP/1.1',
                headers,
                '',
                // Keep legacy XML flattening: [] contributes no line at all.
                isXml && !isBinaryData(val.data) ? val.data : serializeBody(val),
                '',
            ]);
        });

        return {
            body: joinWireLines(
                flatten([
                    '--batch_' + batchBoundary,
                    'Content-Type: multipart/mixed; boundary=changeset_' + changeSetId,
                    '',

                    flatten(aBatchByResponse),

                    '--changeset_' + changeSetId + '--',
                    '--batch_' + batchBoundary + '--',
                ])
            ),
            boundary: batchBoundary,
        };
    }

    // Multi-changeset path - Call[][]
    const changesets = (data as Call[][]).map((calls, index) => {
        const csBoundary = `changeset_${changeSetId}_${index}`;

        const parts = calls.map((call) => {
            // binary implies a content-type header, so headers is defined
            const headers = isBinaryData(call.data)
                ? binaryPartHeaders(call.headers as Record<string, string | number>, accept)
                : parseHeaders(call.headers);

            return flatten([
                `--${csBoundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                ...contentIdHeaders(call),
                '',

                `${call.method.toUpperCase()} ${call.url} HTTP/1.1`,
                headers,
                '',
                isXml && !isBinaryData(call.data) ? call.data : serializeBody(call),
                '',
            ]);
        });

        return [
            `--batch_${batchBoundary}`,
            `Content-Type: multipart/mixed; boundary=${csBoundary}`,
            '',
            ...flatten(parts),
            `--${csBoundary}--`,
            '',
        ];
    });

    return {
        body: joinWireLines(flatten(changesets).concat(`--batch_${batchBoundary}--`)),
        boundary: batchBoundary,
    };
};

// OData V2 retrieve operations (GETs) must be direct batch parts, never
// changeset members: each entry below becomes its own application/http
// part under the batch boundary, with no changeset delimiters anywhere
export const retrieveToBatch = function (
    data: RetrieveCall[],
    boundary: string,
    { accept }: { accept?: string }
): string {
    data.forEach(ensureRetrieveCallIsSafe);

    // A GET has no body: a custom content-type is dropped and a custom
    // accept is replaced by the batch-level accept (the individual
    // response media type), the same override parseHeaders applies to
    // changeset parts
    const parseHeaders = (headers?: Record<string, string | number>): string[] => {
        if (!headers) {
            return [`Accept: ${accept}`];
        }

        const custom = Object.entries(headers)
            .filter(([header]) => header.toLowerCase() !== 'accept' && header.toLowerCase() !== 'content-type')
            .map(([header, value]) => header + ': ' + value);

        return [`Accept: ${accept}`, ...custom];
    };

    const parts = data.map((retrieve) => {
        const headers = parseHeaders(retrieve.headers);

        return flatten([
            `--batch_${boundary}`,
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',

            `GET ${retrieve.url} HTTP/1.1`,
            headers,
            '',
            '',
        ]);
    });

    return flatten(parts).concat(`--batch_${boundary}--`).join('\r\n');
};
