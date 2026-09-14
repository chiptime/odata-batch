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
    const changeSetNum = Math.random() * 100;

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
