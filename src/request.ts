import { flatten } from "./utils";

export const requestsToBatch = function (data, boundary, { contentType, accept }) {
    const changeSetNum = Math.random() * 100;

    const aBatchByResponse = data.map(function (val) {
        return [
            '--changeset_' + changeSetNum,
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',

            val.requestType.toUpperCase() + ' ' + val.crudWhereClause + ' HTTP/1.1',
            `Content-Type: ${contentType}`,
            `Accept: ${accept}`,
            '',
            contentType === 'application/xml' ? val.data : JSON.stringify(val.data),
            '',
        ]
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