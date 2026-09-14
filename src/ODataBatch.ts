import { requestsToBatch, Call } from './request';
import { BatchResponse, BatchResponseParsed } from './response';
import { ODataBatchRepository } from './BatchRepository';
import { ODataBatchAxiosRepository } from './ODataBatchAxiosRepository';

export class ODataBatch {
    private auth: string;
    private headers: Record<string, string> | undefined;
    private url: string;
    private boundary: string;
    private batchRequest: string;
    private requestResponseType: {
        contentType: string;
        accept: string;
    };
    private batchRepository: ODataBatchRepository;

    constructor(
        {
            url,
            headers,
            auth,
            calls,
            batchResponseType = 'json',
            individualResponseType = 'json',
        }: {
            url: string;
            headers?: Record<string, string>;
            auth: string;
            calls?: Call[] | Call[][];
            batchResponseType?: string;
            individualResponseType?: string;
        },
        batchRepository: ODataBatchRepository = new ODataBatchAxiosRepository()
    ) {
        this.ensureHasCalls(calls);

        this.boundary = new Date().getTime().toString();

        this.headers = headers;
        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;

        this.requestResponseType = {
            contentType: batchResponseType === 'json' ? 'application/json' : 'application/xml',
            accept: individualResponseType === 'json' ? 'application/json' : 'application/xml',
        };

        this.batchRequest = requestsToBatch(calls, this.boundary, this.requestResponseType);
    }

    public send(): Promise<BatchResponseParsed[]> {
        const config = {
            headers: {
                ...this.headers,

                Authorization: this.headers?.Authorization || `Basic ${this.auth}`,
                Accept: this.requestResponseType.accept,
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary,
            },
        };

        return this.batchRepository.send(
            this.url,
            this.batchRequest,
            config,
            this.requestResponseType.accept,
            BatchResponse
        );
    }

    private ensureHasCalls(data: Call[] | Call[][] | undefined): asserts data is Call[] | Call[][] {
        if (!data || data.length <= 0) {
            throw new Error('No calls have been passed');
        }

        // If it's a multi-changeset format, check each sub-array
        if (Array.isArray(data[0])) {
            (data as Call[][]).forEach((cs) => {
                if (cs.length === 0) {
                    throw new Error('No calls have been passed');
                }
            });
        }
    }
}
