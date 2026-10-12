export interface BatchResponseParsed {
    code: string;
    status: string;
    headers: { key: string; value: string }[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed payload is caller-defined
    data: any;
    success: boolean;
    changesetIndex?: number;
    contentId?: string;
}

export type BatchRequestPart = { kind: 'retrieve' } | { kind: 'changeset'; operationCount: number };
export type BatchRequestLayout = readonly BatchRequestPart[];

export type BatchResponseGroup =
    | { kind: 'changeset'; partIndex: number; responses: BatchResponseParsed[] }
    | { kind: 'changeset-error'; partIndex: number; error: BatchResponseParsed }
    | { kind: 'retrieve'; partIndex: number; response: BatchResponseParsed }
    | { kind: 'unclassified'; partIndex: number; response: BatchResponseParsed };

export interface BatchResponseInterface {
    response: BatchResponseParsed[];
}

export interface BatchResponseConstructor {
    new (OResponse: { data: string; headers: Record<string, string> }, accept: string): BatchResponseInterface;
}

export function createBatchResponse(
    ctor: BatchResponseConstructor,
    OResponse: { data: string; headers: Record<string, string> },
    accept: string
): BatchResponseInterface {
    return new ctor(OResponse, accept);
}

// RFC 2046 boundaries may legally contain regex metacharacters; escape them
// so boundary delimiters are always matched literally
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BOUNDARY_REGEX = /(?:^|;) *boundary *= *(?:"([^"\r\n]*)"(?![^;\r\n])|([^;\r\n]+))/im;

const extractBoundary = (headerOrPart: string): string | undefined => {
    const match = headerOrPart.match(BOUNDARY_REGEX);
    if (!match) {
        return undefined;
    }
    return (match[1] ?? match[2]).trim();
};

export class BatchResponse implements BatchResponseInterface {
    private boundary: string;
    private accept: string;
    private rawBody: string;
    response: BatchResponseParsed[];

    constructor({ data, headers }: { data: string; headers: Record<string, string> }, accept: string) {
        this.accept = accept;
        this.ensureHasAccept();

        this.boundary = this.getBoundary(headers);
        this.rawBody = data;

        this.response = this.parseBatch(data);
    }

    get groupedResponse(): BatchResponseGroup[] {
        return this.parseGrouped();
    }

    // Grouping is opt-in and strict. The flat parser above retains its legacy
    // permissive behavior; raw HTTP parts are ambiguous without request layout.
    parseGrouped(layout?: BatchRequestLayout): BatchResponseGroup[] {
        const parts = this.splitGroupedMultipart(this.rawBody.replace(/\r?\n/g, '\r\n'), this.boundary);
        if (layout) {
            if (!Array.isArray(layout) || layout.length !== parts.length) {
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

        return parts.map((part, partIndex): BatchResponseGroup => {
            const mime = this.readGroupedMime(part);
            const expected = layout?.[partIndex];
            if (mime.mediaType === 'multipart/mixed') {
                if (expected?.kind === 'retrieve') {
                    throw new Error('Grouped response changeset does not match retrieve layout');
                }
                const boundary = extractBoundary(mime.contentType);
                if (!boundary) {
                    throw new Error('Grouped response changeset is missing a valid boundary');
                }
                const children = this.splitGroupedMultipart(mime.body, boundary);
                const responses = children.map((child) => this.parseGroupedHttp(child, partIndex));
                if (
                    !responses.length ||
                    (expected?.kind === 'changeset' && responses.length !== expected.operationCount)
                ) {
                    throw new Error('Grouped response changeset operation count does not match request layout');
                }
                return { kind: 'changeset', partIndex, responses };
            }

            const response = this.parseGroupedHttp(part, partIndex);
            if (!expected) {
                return { kind: 'unclassified', partIndex, response };
            }
            if (expected.kind === 'retrieve') {
                return { kind: 'retrieve', partIndex, response };
            }
            if (!/^[45][0-9]{2}$/.test(response.code)) {
                throw new Error('Grouped response expected a multipart changeset or whole-changeset HTTP error');
            }
            return { kind: 'changeset-error', partIndex, error: response };
        });
    }

    private readGroupedMime(part: string): { contentType: string; mediaType: string; body: string } {
        const trimmed = part.trimStart();
        const separator = trimmed.indexOf('\r\n\r\n');
        if (separator === -1) {
            throw new Error('Grouped response part is missing MIME header separation');
        }
        const contentType = trimmed
            .slice(0, separator)
            .split('\r\n')
            .map((line) => this.parseHeaderLine(line))
            .find(({ key }) => key.toLowerCase() === 'content-type')?.value;
        if (!contentType) {
            throw new Error('Grouped response part is missing Content-Type');
        }
        return {
            contentType,
            mediaType: contentType.split(';')[0].trim().toLowerCase(),
            body: trimmed.slice(separator + 4),
        };
    }

    private parseGroupedHttp(part: string, partIndex: number): BatchResponseParsed {
        const mime = this.readGroupedMime(part);
        if (
            mime.mediaType !== 'application/http' ||
            !/^HTTP\/1\.[01] [0-9]{3}(?: [^\r\n]*)?$/.test(mime.body.split('\r\n')[0])
        ) {
            throw new Error('Grouped response expected an application/http response with a valid status line');
        }
        return { ...this.parseResponse(part.trimStart()), changesetIndex: partIndex };
    }

    private splitMultipart(body: string, boundary: string, requireClosingBoundary = false): string[] {
        if (!boundary || /[\r\n]/.test(boundary)) {
            throw new Error('Grouped response has an invalid multipart boundary');
        }
        if (!body.trim()) {
            return [];
        }
        // Delimiters must occupy complete lines, not substrings in payloads.
        const delimiter = new RegExp(`^--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\r\\n|$)`, 'gmi');
        const parts: string[] = [];
        let start: number | undefined;
        for (const match of body.matchAll(delimiter)) {
            if (start !== undefined) {
                parts.push(body.slice(start, match.index));
            }
            if (match[1]) {
                return parts;
            }
            start = match.index + match[0].length;
        }
        if (requireClosingBoundary) {
            throw new Error('Grouped response multipart is missing a matching closing boundary');
        }
        if (start !== undefined) {
            parts.push(body.slice(start));
        }
        return parts;
    }

    private splitGroupedMultipart(body: string, boundary: string): string[] {
        return this.splitMultipart(body, boundary, true);
    }

    ensureHasAccept(): void {
        if (!this.accept) {
            throw new Error('Need accept to know how parse.');
        }
    }

    parseResponse(part: string): BatchResponseParsed {
        // Split into part headers, status+response headers and payload. Only
        // the first two blank-line separators are structural: everything
        // after them is payload, even when the payload itself contains
        // blank lines.
        const responseParts = part.split('\r\n\r\n');
        // Only MIME headers identify the operation; an inner HTTP Content-ID
        // remains in `headers` and must never be inferred as MIME metadata.
        const contentId = responseParts[0]
            .split('\r\n')
            .map((line) => this.parseHeaderLine(line))
            .find(({ key }) => key.toLowerCase() === 'content-id')?.value;

        const httpResponseWithHeaders = responseParts[1].split('\r\n');

        // RFC 7230 allows an empty reason phrase ("HTTP/1.1 204 ")
        const regCodeAndStatus = RegExp('HTTP/1\\.[01] ([0-9]{3})(?: (.*))?');

        const headers = httpResponseWithHeaders
            .filter((header: string) => !regCodeAndStatus.test(header))
            .map((header: string) => this.parseHeaderLine(header));

        const httpCodeAndDesc = httpResponseWithHeaders[0].match(regCodeAndStatus);

        const code = (httpCodeAndDesc && httpCodeAndDesc[1]) || '';
        // An unparseable status line cannot be confirmed successful: only a
        // recognized 1xx/2xx/3xx code counts as success
        const success = httpCodeAndDesc !== null && code.substring(0, 1) != '4' && code.substring(0, 1) != '5';

        // The payload is everything after the status/headers block; the
        // trailing CRLFs belong to the multipart framing, not the payload
        const payload = responseParts
            .slice(2)
            .join('\r\n\r\n')
            .replace(/(?:\r\n)+$/, '');

        const data = this.parseData(payload);

        return {
            code,
            status: (httpCodeAndDesc && httpCodeAndDesc[2]) || '',
            headers,
            data,
            success,
            ...(contentId ? { contentId } : {}),
        };
    }

    // RFC 7230: a header field ends at its FIRST colon; optional whitespace
    // around the separator is not part of the name or the value. A line
    // without a colon carries no field data.
    parseHeaderLine(line: string): { key: string; value: string } {
        const separator = line.indexOf(':');
        if (separator === -1) {
            return {
                key: '',
                value: '',
            };
        }

        return {
            key: line.slice(0, separator).trim(),
            value: line.slice(separator + 1).trim(),
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed payload is caller-defined
    parseData(sData: string | undefined): any {
        // A 204 No Content part can end right after its status line, leaving
        // no payload segment at all: treat it as an empty payload
        const payload = sData ?? '';

        if (this.acceptsJson()) {
            // Empty or whitespace-only payloads carry no JSON document
            // (204 No Content): yield null instead of throwing
            if (payload.trim() === '') {
                return null;
            }

            try {
                return JSON.parse(payload);
            } catch {
                // One unparseable part must never destroy the whole batch:
                // surface the raw payload instead of throwing
                return payload;
            }
        }

        return payload;
    }

    // The Accept header may carry parameters ('application/json;odata=verbose'):
    // only the media type (before ';', trimmed, case-insensitive) selects the
    // payload parsing mode
    acceptsJson(): boolean {
        return this.accept.split(';')[0].trim().toLowerCase() === 'application/json';
    }

    parseBatch(body: string): BatchResponseParsed[] {
        // The framing below is CRLF-based; tolerate LF-only or mixed line
        // endings by normalizing every line break to CRLF first
        const normalizedBody = body.replace(/\r?\n/g, '\r\n');

        // Split the batch result into its associated parts using anchored delimiters
        const batchParts = this.splitMultipart(normalizedBody, this.boundary);

        const parseResponses = batchParts
            // MIME headers may start with Content-ID, not just Content-Type.
            // Keep unmatched boundary/preamble text from becoming a part.
            .filter(
                (batchPart: string) =>
                    !batchPart.startsWith('--') && /^content-type:/im.test(batchPart.split('\r\n\r\n')[0])
            )
            .flatMap((batchPart: string, changesetIndex: number) => {
                // For each batch part, check to see if the part is a changeset.
                const changeSetBoundary = extractBoundary(batchPart);
                if (!changeSetBoundary) {
                    // No boundary found - return raw part with current changesetIndex
                    return [{ part: batchPart, changesetIndex }];
                }

                const changeSetParts = this.splitMultipart(batchPart, changeSetBoundary);

                // Return each changeset part with its changesetIndex
                return changeSetParts
                    .filter((p: string) => p.trim() !== '')
                    .map((part: string) => ({
                        part,
                        changesetIndex,
                    }));
            });

        return parseResponses.map(({ part, changesetIndex }) => ({
            ...this.parseResponse(part),
            changesetIndex,
        }));
    }

    getBoundary(headers: Record<string, string>): string {
        // RFC 9110: header field names are case-insensitive, so the lookup
        // must not depend on the casing the HTTP client normalized to
        const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
        if (!contentType) {
            throw new Error('Missing content-type header, cannot determine batch boundary');
        }
        const boundaryMatch = contentType.match(BOUNDARY_REGEX);

        this.ensureHasBoundary(boundaryMatch);

        // RFC 2046 allows quoted boundary parameters; the quotes are not
        // part of the delimiter used in the body
        return (boundaryMatch[1] ?? boundaryMatch[2]).trim();
    }

    ensureHasBoundary(boundaryMatch: RegExpMatchArray | null): asserts boundaryMatch is RegExpMatchArray {
        if (!boundaryMatch) {
            throw new Error('Bad content-type header, no multipart boundary');
        }
    }
}
