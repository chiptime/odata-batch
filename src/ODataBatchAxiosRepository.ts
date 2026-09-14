import axios from 'axios';
import { BatchRequestConfig, ODataBatchRepository } from './BatchRepository';
import { createBatchResponse, BatchResponseConstructor, BatchResponseParsed } from './response';

export class ODataBatchAxiosRepository implements ODataBatchRepository {
    async send(
        url: string,
        batchRequest: string,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]> {
        const request = await axios.post(url, batchRequest, config);

        return createBatchResponse(BatchParser, request, accept).response;
    }
}
