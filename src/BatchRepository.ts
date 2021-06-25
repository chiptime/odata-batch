import { BatchResponseConstructor } from "./response";

export interface ODataBatchRepository {
    send(
        url: string,
        batchRequest: string,
        config: any,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<any>
}

