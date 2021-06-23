import { flatten } from './utils';

export interface BatchResponse {
    code: string;
    status: string;
    headers: string;
    data: any[];
    success: boolean;
}

const parseResponse = function (part): BatchResponse {
    const responseParts = part.split("\r\n\r\n");
    //responseParts[1] are headers for the part
    //responseParts[2] is the responses code and headers
    //responseParts[3] is data

    const httpResponseWithHeaders = responseParts[1].split("\r\n");

    const regCodeAndStatus = RegExp("HTTP/1.1 ([0-9]{3}) (.+)");

    const headers = httpResponseWithHeaders
        .filter(header => !regCodeAndStatus.test(header))
        .map(header => {
            const headerKeyAndValue = header.match("(.+): (.+)");

            return {
                key: headerKeyAndValue[1],
                value: headerKeyAndValue[2]
            };
        })

    const httpCodeAndDesc = httpResponseWithHeaders[0]
        .match(regCodeAndStatus);

    const code = httpCodeAndDesc[1];
    const success = code.substring(0, 1) != "4" && code.substring(0, 1) != "5";

    return {
        code,
        status: httpCodeAndDesc[2],
        headers,
        // data: responseParts[2].match(/.*/)[0],
        data: JSON.parse(responseParts[2]),
        success,
    };
};


const parseBatch = function (boundary, body): BatchResponse[] {
    //Split the batch result into its associated parts
    const batchParts = body.split(RegExp("--" + boundary + "(?:\r\n)?(?:--\r\n)?"));

    const parseResponses = batchParts
        .filter(batchPart => RegExp("^content-type", "i").test(batchPart))
        .map(batchPart => {
            // For each batch part, check to see if the part is a changeset.
            const boundary = batchPart.match(RegExp("boundary=(.+)", "m"));
            if (!boundary) {
                return batchPart;
            }

            const changeSetBoundary = boundary[1];

            const changeSetBody = batchPart
                .match(RegExp("(--" + changeSetBoundary + "\r\n[^]+--" + changeSetBoundary + ")", "i"));

            const changeSetParts = changeSetBody[1]
                .split(RegExp("--" + changeSetBoundary + "(?:\r\n)?(?:--\r\n)?"));

            return changeSetParts.filter(p => p);
        });

    return flatten(parseResponses).map(p => parseResponse(p));
};

export const batchToResponses = function ({ data, headers }) {
    const contentType = headers['content-type'];

    const m = contentType.match(/boundary=([^;]+)/);
    if (!m) {
        throw new Error('Bad content-type header, no multipart boundary');
    }

    const boundary = m[1];
    return parseBatch(boundary, data);
};