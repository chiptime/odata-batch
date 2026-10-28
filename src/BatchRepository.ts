import { BatchResponseConstructor, BatchResponseParsed, BatchRequestLayout, BatchResponseGroup } from './response';

export interface BatchRequestConfig {
    headers: Record<string, string>;
    // Present only when the caller sets them on ODataBatch
    timeout?: number;
    maxContentLength?: number;
}

export interface ODataBatchRepository {
    send(
        url: string,
        // Buffer when the batch carries binary (media) parts
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]>;
    sendGrouped?(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        layout: BatchRequestLayout,
        BatchParser?: BatchResponseConstructor
    ): Promise<BatchResponseGroup[]>;
}
