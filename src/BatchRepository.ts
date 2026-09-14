import { BatchResponseConstructor, BatchResponseParsed } from './response';

export interface BatchRequestConfig {
    headers: Record<string, string>;
}

export interface ODataBatchRepository {
    send(
        url: string,
        batchRequest: string,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]>;
}
