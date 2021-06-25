import { flatten } from './utils';

export interface BatchResponseParsed {
    code: string;
    status: string;
    headers: { key: string; value: string; }[];
    data: any[];
    success: boolean;
}

export interface BatchResponseInterface {
    response: BatchResponseParsed[];
}

export interface BatchResponseConstructor {
    new(OResponse: { data, headers }, accept: string,): BatchResponseInterface;
}

export function createBatchResponse(
    ctor: BatchResponseConstructor,
    OResponse: { data, headers },
    accept: string,
): BatchResponseInterface {
    return new ctor(OResponse, accept);
}
export class BatchResponse implements BatchResponseInterface {
    private boundary: string;
    private accept: string;
    response: BatchResponseParsed[];

    constructor({ data, headers }: any, accept: string) {
        this.accept = accept;
        this.ensureHasAccept();

        this.boundary = this.getBoundary(headers);

        this.response = this.parseBatch(data);
    }

    ensureHasAccept() {
        if (!this.accept) {
            throw new Error('Need accept to know how parse.')
        }
    }


    parseResponse(part: string): BatchResponseParsed {
        const responseParts = part.split("\r\n\r\n");
        //responseParts[1] are headers for the part
        //responseParts[2] is the responses code and headers
        //responseParts[3] is data

        const httpResponseWithHeaders = responseParts[1].split("\r\n");

        const regCodeAndStatus = RegExp("HTTP/1.1 ([0-9]{3}) (.+)");

        const headers = httpResponseWithHeaders
            .filter((header: string) => !regCodeAndStatus.test(header))
            .map((header: string) => {
                const headerKeyAndValue = header.match("(.+): (.+)");
                if (!headerKeyAndValue) {
                    return {
                        key: '',
                        value: '',
                    };
                }

                return {
                    key: headerKeyAndValue[1],
                    value: headerKeyAndValue[2]
                };
            })

        const httpCodeAndDesc = httpResponseWithHeaders[0]
            .match(regCodeAndStatus);

        const code = httpCodeAndDesc && httpCodeAndDesc[1] || '';
        const success = code.substring(0, 1) != "4" && code.substring(0, 1) != "5";

        const data = this.parseData(responseParts[2]);

        return {
            code,
            status: httpCodeAndDesc && httpCodeAndDesc[2] || '',
            headers,
            data,
            success,
        };
    }

    parseData(sData: string): any {
        if (this.accept === 'application/json') {
            return JSON.parse(sData);
        }

        const parts = sData.match(/.*/) || [''];

        return parts[0];
    }

    parseBatch(body: string): BatchResponseParsed[] {
        //Split the batch result into its associated parts
        const batchParts = body.split(RegExp("--" + this.boundary + "(?:\r\n)?(?:--\r\n)?"));

        const parseResponses = batchParts
            .filter((batchPart: string) => RegExp("^content-type", "i").test(batchPart))
            .map((batchPart: string) => {
                // For each batch part, check to see if the part is a changeset.
                const boundary = batchPart.match(RegExp("boundary=(.+)", "m"));
                if (!boundary) {
                    return batchPart;
                }

                const changeSetBoundary = boundary[1];

                const changeSetBody = batchPart
                    .match(RegExp("(--" + changeSetBoundary + "\r\n[^]+--" + changeSetBoundary + ")", "i"));

                const changeSetParts = changeSetBody && changeSetBody[1]
                    .split(RegExp("--" + changeSetBoundary + "(?:\r\n)?(?:--\r\n)?")) || [];

                return changeSetParts.filter((p: any) => p);
            });

        return flatten(parseResponses).map(p => this.parseResponse(p));
    }

    getBoundary(headers: { [x: string]: any; }): any {
        const contentType = headers['content-type'];
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);

        this.ensureHasBoundary(boundaryMatch);

        return boundaryMatch[1];
    }

    ensureHasBoundary(boundaryMatch: RegExpExecArray): void {
        if (!boundaryMatch) {
            throw new Error('Bad content-type header, no multipart boundary');
        }
    }
}