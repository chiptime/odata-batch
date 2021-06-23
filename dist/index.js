"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ODataBatch = void 0;
const axios_1 = __importDefault(require("axios"));
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
    return batchContent.join('\r\n');
};
const parseBatch = function (boundary, body) {
    var batchResponses = [];
    const contentTypeRegExp = RegExp("^content-type", "i");
    var batchPartRegex = RegExp("--" + boundary + "(?:\r\n)?(?:--\r\n)?");
    var batchParts = body.split(batchPartRegex);
    var batchPartBoundaryTypeRegex = RegExp("boundary=(.+)", "m");
    for (var i = 0; i < batchParts.length; i++) {
        var batchPart = batchParts[i];
        if (contentTypeRegExp.test(batchPart)) {
            var changeSetBoundaryMatch = batchPart.match(batchPartBoundaryTypeRegex);
            if (changeSetBoundaryMatch) {
                var changeSetBoundary = changeSetBoundaryMatch[1];
                var changeSetContentRegex = RegExp("(--" + changeSetBoundary + "\r\n[^]+--" + changeSetBoundary + ")", "i");
                var changeSetBody = batchPart.match(changeSetContentRegex);
                var changeSetPartRegex = RegExp("--" + changeSetBoundary + "(?:\r\n)?(?:--\r\n)?");
                var changeSetParts = changeSetBody[1].split(changeSetPartRegex);
                var changeSetResponses = parseResponses(changeSetParts);
                batchResponses = batchResponses.concat(changeSetResponses);
            }
            else {
                if (contentTypeRegExp.test(batchPart)) {
                    var response = parseResponse(batchPart);
                    batchResponses.push(response);
                }
            }
        }
    }
    return batchResponses;
};
const parseResponse = function (part) {
    var response = part.split("\r\n\r\n");
    var httpResponseWithHeaders = response[1].split("\r\n");
    var responseRegex = RegExp("HTTP/1.1 ([0-9]{3}) (.+)");
    var httpCodeAndDesc = httpResponseWithHeaders[0].match(responseRegex);
    var httpCode = httpCodeAndDesc[1];
    var httpDesc = httpCodeAndDesc[2];
    var httpHeaders = [];
    for (var h = 1; h < httpResponseWithHeaders.length; h++) {
        var header = httpResponseWithHeaders[h];
        var headerKeyAndValue = header.match("(.+): (.+)");
        httpHeaders.push({
            key: headerKeyAndValue[1],
            value: headerKeyAndValue[2]
        });
    }
    var responseOut = {
        responseCode: httpCode,
        responseText: httpDesc,
        headers: httpHeaders,
        data: response[2],
        success: (httpCode.substring(0, 1) != "4" && httpCode.substring(0, 1) != "5")
    };
    return responseOut;
};
const parseResponses = function (parts) {
    var responses = [];
    for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        if (part != "") {
            var response = parseResponse(part);
            responses.push(response);
        }
    }
    return responses;
};
const parseBatchResponse = function (response) {
    const body = response.data;
    var header = response.headers["content-type"];
    var m = header.match(/boundary=([^;]+)/);
    if (!m) {
        throw new Error('Bad content-type header, no multipart boundary');
    }
    var boundary = m[1];
    var responses = parseBatch(boundary, body);
    return responses;
};
class ODataBatch {
    constructor({ url, auth, calls, batchResponseType, individualResponseType }) {
        this.ensureHasCalls(calls);
        this.boundary = new Date().getTime().toString();
        this.calls = calls;
        this.auth = auth;
        this.url = url;
    }
    async invoke() {
        var batchRequestBody = batchBody(this.calls, this.boundary);
        const config = {
            headers: {
                Authorization: `Basic ${this.auth}`,
                Accept: 'application/json',
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary
            },
        };
        const response = await axios_1.default.post(this.url, batchRequestBody, config);
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
exports.ODataBatch = ODataBatch;
//# sourceMappingURL=index.js.map