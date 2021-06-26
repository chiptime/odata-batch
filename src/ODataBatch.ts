import { requestsToBatch } from './request';
import { BatchResponse } from './response';
import { ODataBatchRepository } from './BatchRepository'
import { ODataBatchAxiosRepository } from './ODataBatchAxiosRepository';

export class ODataBatch {
    private auth: string;
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
            auth,
            calls,
            batchResponseType = 'json',
            individualResponseType = 'json'
        }:
            {
                url: string,
                auth: string,
                calls?: any,
                batchResponseType?: string,
                individualResponseType?: string
            },
        batchRepository: ODataBatchRepository = new ODataBatchAxiosRepository()
    ) {

        this.ensureHasCalls(calls);

        this.boundary = new Date().getTime().toString();

        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;

        this.requestResponseType = {
            contentType:  batchResponseType === 'json' ? 'application/json' : 'application/xml',
            accept:  individualResponseType === 'json' ? 'application/json' : 'application/xml',
        };

        this.batchRequest = requestsToBatch(calls, this.boundary, this.requestResponseType);
    }

    public async send() {
        const config = {
            headers: {
                Authorization: `Basic ${this.auth}`,
                Accept: this.requestResponseType.accept,
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary
            },
        };

        const response = await this.batchRepository.send(
            this.url,
            this.batchRequest,
            config,
            this.requestResponseType.accept,
            BatchResponse
        );

        return response;
    }

    private ensureHasCalls(data: any[]) {
        if (data.length <= 0) {
            throw new Error('No calls have been passed');
        }
    }
}