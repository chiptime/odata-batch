import axios, { AxiosRequestConfig } from 'axios';
import { ODataBatchRepository } from "./BatchRepository";
import { createBatchResponse, BatchResponseConstructor } from './response';

export class ODataBatchAxiosRepository implements ODataBatchRepository {
    async send(
        url: string,
        batchRequest: string,
        config: AxiosRequestConfig | undefined,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<any> {

        const request = await axios.post(url, batchRequest, config);

        return createBatchResponse(BatchParser, request, accept).response;
    }
}