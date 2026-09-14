import { flatten } from './utils';

export interface Call {
    method: string;
    url: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload is caller-defined: JSON-serializable value or raw string
    data: any;
    headers?: Record<string, string | number>;
}

export const requestsToBatch = function (
    data: Call[] | Call[][],
    boundary: string,
    { contentType, accept }: { contentType?: string; accept?: string }
): string {
    let changeSetNum = Math.random() * 100;

    const LINE_BREAK = /[\r\n]/;

    // Header-injection guard: a line break inside the request line or a
    // header value would smuggle extra lines into the wire format
    const ensureCallIsSafe = (call: Call): void => {
        if (LINE_BREAK.test(call.url)) {
            throw new Error(`Call url must not contain line breaks: ${JSON.stringify(call.url)}`);
        }
        if (LINE_BREAK.test(call.method)) {
            throw new Error(`Call method must not contain line breaks: ${JSON.stringify(call.method)}`);
        }
        if (call.headers) {
            Object.entries(call.headers).forEach(([key, value]) => {
                if (LINE_BREAK.test(key) || LINE_BREAK.test(String(value))) {
                    throw new Error(`Call header '${key}' must not contain line breaks`);
                }
            });
        }
    };

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
