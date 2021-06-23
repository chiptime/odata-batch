import axios from 'axios';

interface Response {
    responseCode: string;
    responseText: string;
    headers: string;
    data: any;
    success: string;
}
var batchBody = function (data, boundary) {
    var batchContent = new Array();

    var changeSetNum = Math.random() * 100;
    batchContent.push('--batch_' + boundary);
    batchContent.push('Content-Type: multipart/mixed; boundary=changeset_' + changeSetNum);
    batchContent.push('');

    data.forEach(function (val) {
        batchContent.push('--changeset_' + changeSetNum);
        batchContent.push('Content-Type: application/http');
        batchContent.push('Content-Transfer-Encoding: binary');
        batchContent.push('');

        batchContent.push(val.requestType.toUpperCase() + ' ' + val.crudWhereClause + ' HTTP/1.1');
        batchContent.push('Content-Type: application/json');
        batchContent.push('Accept: application/json');
        batchContent.push('');
        batchContent.push(JSON.stringify(val.data));
        batchContent.push('');
    });

    batchContent.push('--changeset_' + changeSetNum + '--');
    batchContent.push('--batch_' + boundary + '--');
    //console.log(batchContent);
    return batchContent.join('\r\n');
}


const parseBatch = function (boundary, body) {
    var batchResponses: any = [];

    const contentTypeRegExp = RegExp("^content-type", "i");
    //Split the batch result into its associated parts
    var batchPartRegex = RegExp("--" + boundary + "(?:\r\n)?(?:--\r\n)?");
    var batchParts = body.split(batchPartRegex);
    //console.log("Batch Parts:");
    //console.log(batchParts);
    var batchPartBoundaryTypeRegex = RegExp("boundary=(.+)", "m");
    for (var i = 0; i < batchParts.length; i++) {
        var batchPart = batchParts[i];
        if (contentTypeRegExp.test(batchPart)) {
            //console.log("-- Content for Batch Part " + i);
            // For each batch part, check to see if the part is a changeset.
            var changeSetBoundaryMatch = batchPart.match(batchPartBoundaryTypeRegex);
            //console.log("----Boundary Search for item " + i)
            if (changeSetBoundaryMatch) {
                //console.log("----Boundary Found for item " + i)
                //console.log(changeSetBoundaryMatch)
                //console.log("Getting changeset")
                var changeSetBoundary = changeSetBoundaryMatch[1];
                var changeSetContentRegex = RegExp("(--" + changeSetBoundary + "\r\n[^]+--" + changeSetBoundary + ")", "i");
                var changeSetBody = batchPart.match(changeSetContentRegex);
                //console.log("changeSetBody")
                //console.log(changeSetBody)
                var changeSetPartRegex = RegExp("--" + changeSetBoundary + "(?:\r\n)?(?:--\r\n)?");
                var changeSetParts = changeSetBody[1].split(changeSetPartRegex);
                //console.log("changeSetParts")
                //console.log(changeSetParts);
                //console.log("Getting Changeset Parts");
                var changeSetResponses = parseResponses(changeSetParts);
                //console.log("Change Set Responses");
                //console.log(changeSetResponses)
                batchResponses = batchResponses.concat(changeSetResponses);
            }
            else {
                //console.log("----Boundary Not Found for batch part " + i)
                //console.log("----PArsing batch part " + i);
                if (contentTypeRegExp.test(batchPart)) {
                    var response = parseResponse(batchPart);
                    //console.log(response);
                    batchResponses.push(response);
                }
            }
        }
    }
    //console.log("Batch Responses:");
    //console.log(batchResponses);
    return batchResponses;
};
const parseResponse = function (part) {
    var response = part.split("\r\n\r\n");
    //console.log(response);
    //response[1] are headers for the part
    //response[2] is the response code and headers
    //response[3] is data
    var httpResponseWithHeaders = response[1].split("\r\n");
    //console.log("httpResponseWithHeaders");
    //console.log(httpResponseWithHeaders);
    var responseRegex = RegExp("HTTP/1.1 ([0-9]{3}) (.+)");
    var httpCodeAndDesc = httpResponseWithHeaders[0].match(responseRegex);
    //console.log("httpCodeAndDesc");
    //console.log(httpCodeAndDesc);
    var httpCode = httpCodeAndDesc[1];
    var httpDesc = httpCodeAndDesc[2];
    //console.log("httpCode");
    //console.log(httpCode);
    //console.log("httpDesc");
    //console.log(httpDesc);
    var httpHeaders: any = [];
    for (var h = 1; h < httpResponseWithHeaders.length; h++) {
        var header = httpResponseWithHeaders[h];
        var headerKeyAndValue = header.match("(.+): (.+)");
        //console.log("headerTypeAndValue");
        //console.log(headerTypeAndValue);
        httpHeaders.push({
            key: headerKeyAndValue[1],
            value: headerKeyAndValue[2]
        });
    }
    var responseOut = {
        responseCode: httpCode,
        responseText: httpDesc,
        headers: httpHeaders,
        // Data: response[2].match(/.*/)[0],
        data: response[2],
        success: (httpCode.substring(0, 1) != "4" && httpCode.substring(0, 1) != "5")
    };
    return responseOut;
};
const parseResponses = function (parts) {
    var responses: any = [];
    for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        //console.log("Getting changeset part "+ j)
        //console.log(part);
        //console.log("Getting response from changeset part " + j)
        if (part != "") {
            var response = parseResponse(part);
            responses.push(response);
        }
    }
    return responses;
};
const parseBatchResponse = function (response) {
    const body = response.data;
    // Get the content-type header from the response.
    //console.log(response.data)
    var header = response.headers["content-type"];
    var m = header.match(/boundary=([^;]+)/);
    if (!m) {
        throw new Error('Bad content-type header, no multipart boundary');
    }
    var boundary = m[1];
    var responses = parseBatch(boundary, body);
    return responses;
};

export class ODataBatch {
    private boundary: string;
    private calls: any;
    private auth: string;
    private url: string;

    constructor({ url, auth, calls, batchResponseType, individualResponseType }:
        { url: string, auth: string, calls?: any, batchResponseType?: string, individualResponseType?: string }) {
        this.ensureHasCalls(calls);
        this.boundary = new Date().getTime().toString();
        this.calls = calls;
        this.auth = auth;
        this.url = url;
    }

    public async invoke() {
        var batchRequestBody = batchBody(this.calls, this.boundary);
        const config = {
            // `headers` are custom headers to be sent
            headers: {
                Authorization: `Basic ${this.auth}`,
                Accept: 'application/json',
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary
            },
        };

        const response = await axios.post(this.url, batchRequestBody, config);
        const responseParsed = parseBatchResponse(response);
        return responseParsed.map((r) => ({
            ...r,
            data: JSON.parse(r.data)
        }));
    }

    ensureHasCalls(data) {
        if (data.length <= 0) {
            throw new Error('No calls have been passed');
        }
    }
}