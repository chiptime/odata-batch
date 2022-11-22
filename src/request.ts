import { flatten } from "./utils";


export const requestsToBatch = function (data, boundary, { contentType, accept }) {
    const changeSetNum = Math.random() * 100;

    const parseHeaders = (headers) => {
        if (!headers) {
            return [
                `Content-Type: ${contentType}`,
                `Accept: ${accept}`,
            ];
        }

        const _headers = Object.entries(headers).map(h => {
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

    const aBatchByResponse = data.map(function (val) {

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
        '--batch_' + boundary + '--'
    ])
        .join('\r\n');
}
