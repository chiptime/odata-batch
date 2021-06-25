import { requestsToBatch } from './request';
import { batchToResponses } from './response';
import { ODataBatchRepository } from './BatchRepository'
import { ODataBatchAxiosRepository } from './ODataBatchAxiosRepository';

export class ODataBatch {
    private auth: string;
    private url: string;
    private boundary: string;
    private batchRequest: string;
    private batchResponseType: string;
    private individualResponseType: string;
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

        this.batchResponseType = batchResponseType === 'json' ? 'application/json' : 'application/xml';
        this.individualResponseType = individualResponseType === 'json' ? 'application/json' : 'application/xml';

        const requestResponseType = {
            contentType: this.batchResponseType,
            accept: this.individualResponseType,
        };

        this.boundary = new Date().getTime().toString();
        this.batchRequest = requestsToBatch(calls, this.boundary, requestResponseType);

        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;
    }

    public async invoke() {
        const config = {
            headers: {
                Authorization: `Basic ${this.auth}`,
                Accept: this.batchResponseType,
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary
            },
        };

        const response = await this.batchRepository.send(this.url, this.batchRequest, config);

        return batchToResponses(response);
    }

    private ensureHasCalls(data: any[]) {
        if (data.length <= 0) {
            throw new Error('No calls have been passed');
        }
    }
}