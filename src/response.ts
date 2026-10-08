export interface BatchResponseParsed {
    code: string;
    status: string;
    headers: { key: string; value: string }[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed payload is caller-defined
    data: any;
    success: boolean;
    changesetIndex?: number;
}

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

export class BatchResponse implements BatchResponseInterface {
    private boundary: string;
    private accept: string;
    response: BatchResponseParsed[];

    constructor({ data, headers }: { data: string; headers: Record<string, string> }, accept: string) {
        this.accept = accept;
        this.ensureHasAccept();

        this.boundary = this.getBoundary(headers);

        this.response = this.parseBatch(data);
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
        const success =
            httpCodeAndDesc !== null && code.substring(0, 1) != '4' && code.substring(0, 1) != '5';

        // The payload is everything after the status/headers block; the
        // trailing CRLFs belong to the multipart framing, not the payload
        const payload = responseParts.slice(2).join('\r\n\r\n').replace(/(?:\r\n)+$/, '');

        const data = this.parseData(payload);

        return {
            code,
            status: (httpCodeAndDesc && httpCodeAndDesc[2]) || '',
            headers,
            data,
            success,
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

        //Split the batch result into its associated parts
        const batchParts = normalizedBody.split(RegExp('--' + escapeRegExp(this.boundary) + '(?:\r\n)?(?:--\r\n)?'));

        const parseResponses = batchParts
            .filter((batchPart: string) => RegExp('^content-type', 'i').test(batchPart))
            .flatMap((batchPart: string, changesetIndex: number) => {
                // For each batch part, check to see if the part is a changeset.
                const boundary = batchPart.match(RegExp('boundary=(.+)', 'm'));
                if (!boundary) {
                    // No boundary found - return raw part with current changesetIndex
                    return [{ part: batchPart, changesetIndex }];
                }

                const changeSetBoundary = escapeRegExp(boundary[1]);

                const changeSetBody = batchPart.match(
                    RegExp('(--' + changeSetBoundary + '\r\n[^]+--' + changeSetBoundary + ')', 'i')
                );

                const changeSetParts =
                    (changeSetBody &&
                        // Split with the same case-insensitivity as the changeset
                        // body match above, so declared/used case mismatches do
                        // not leave delimiters inside the parts
                        changeSetBody[1].split(RegExp('--' + changeSetBoundary + '(?:\r\n)?(?:--\r\n)?', 'i'))) ||
                    [];

                // Return each changeset part with its changesetIndex
                return changeSetParts
                    .filter((p: string) => p)
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
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);

        this.ensureHasBoundary(boundaryMatch);

        // RFC 2046 allows quoted boundary parameters; the quotes are not
        // part of the delimiter used in the body
        return boundaryMatch[1].replace(/^"(.*)"$/, '$1');
    }

    ensureHasBoundary(boundaryMatch: RegExpMatchArray | null): asserts boundaryMatch is RegExpMatchArray {
        if (!boundaryMatch) {
            throw new Error('Bad content-type header, no multipart boundary');
        }
    }
}
