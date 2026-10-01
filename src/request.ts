import { flatten } from './utils';

export interface Call {
    method: string;
    url: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload is caller-defined: JSON-serializable value or raw string
    data: any;
    headers?: Record<string, string | number>;
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

const ensureCallIsSafe = (call: Call): void => {
    ensureNoLineBreak('url', call.url);
    ensureNoLineBreak('method', call.method);
    ensureHeadersAreSafe(call.headers);
};

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

const ensureRetrieveCallIsSafe = (retrieve: RetrieveCall): void => {
    ensureRetrieveIsGetOnly(retrieve);
    ensureNoLineBreak('url', retrieve.url);
    ensureHeadersAreSafe(retrieve.headers);
};

export const requestsToBatch = function (
    data: Call[] | Call[][],
    boundary: string,
    { contentType, accept }: { contentType?: string; accept?: string }
): string {
    let changeSetNum = Math.random() * 100;

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

    const allCalls: Call[] = isMulti ? (data as Call[][]).flat() : (data as Call[]);
    allCalls.forEach(ensureCallIsSafe);

    // Boundary-collision guard: if a serialized payload already contains the
    // changeset delimiter, the server would cut the changeset early - reroll
    // the boundary until the wire is unambiguous
    const serializeBody = (call: Call): string =>
        contentType === 'application/xml' ? String(call.data) : JSON.stringify(call.data);
    const serializedBodies = allCalls.map(serializeBody);

    for (
        let attempts = 0;
        serializedBodies.some((body) => typeof body === 'string' && body.includes(`--changeset_${changeSetNum}`));
        attempts++
    ) {
        if (attempts >= 9) {
            throw new Error('Unable to generate a changeset boundary that does not collide with the payload');
        }
        changeSetNum = Math.random() * 100;
    }

    if (!isMulti) {
        // Legacy path - bit-identical to v1.2.0
        const calls = data as Call[];

        const aBatchByResponse = calls.map(function (val) {
            const headers = parseHeaders(val.headers);

            return flatten([
                '--changeset_' + changeSetNum,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',

                val.method.toUpperCase() + ' ' + val.url + ' HTTP/1.1',
                headers,
                '',
                contentType === 'application/xml' ? val.data : JSON.stringify(val.data),
                '',
            ]);
        });

        return flatten([
            '--batch_' + boundary,
            'Content-Type: multipart/mixed; boundary=changeset_' + changeSetNum,
            '',

            flatten(aBatchByResponse),

            '--changeset_' + changeSetNum + '--',
            '--batch_' + boundary + '--',
        ]).join('\r\n');
    }

    // Multi-changeset path - Call[][]
    const changesets = (data as Call[][]).map((calls, index) => {
        const csBoundary = `changeset_${changeSetNum}_${index}`;

        const parts = calls.map((call) => {
            const headers = parseHeaders(call.headers);

            return flatten([
                `--${csBoundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',

                `${call.method.toUpperCase()} ${call.url} HTTP/1.1`,
                headers,
                '',
                contentType === 'application/xml' ? call.data : JSON.stringify(call.data),
                '',
            ]);
        });

        return [
            `--batch_${boundary}`,
            `Content-Type: multipart/mixed; boundary=${csBoundary}`,
            '',
            ...flatten(parts),
            `--${csBoundary}--`,
            '',
        ];
    });

    return flatten(changesets).concat(`--batch_${boundary}--`).join('\r\n');
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
