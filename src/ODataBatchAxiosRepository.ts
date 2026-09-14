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

        // axios 1.x types headers as AxiosHeaders; the runtime shape is the
        // plain string-indexable map the parser expects
        return createBatchResponse(
            BatchParser,
            request as unknown as {
                data: string;
                headers: Record<string, string>;
            },
            accept
        ).response;
    }
}
