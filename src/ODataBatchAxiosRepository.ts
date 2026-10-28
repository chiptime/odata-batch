import axios from 'axios';
import { BatchRequestConfig, ODataBatchRepository } from './BatchRepository';
import {
    createBatchResponse,
    BatchResponseConstructor,
    BatchResponseParsed,
    BatchResponse,
    BatchRequestLayout,
    BatchResponseGroup,
} from './response';

// Every batch carries an Authorization header. Following a redirect would
// replay those credentials to the redirect target (see GHSA-q3jh-wrc6-jgq8
// and GHSA-8r9p-f939-6h3c in follow-redirects). Fail closed on any 3xx;
// callers can configure the final endpoint instead of replaying a POST.
// Binary batches arrive as a Buffer and are posted unchanged.
const post = (url: string, batchRequest: string | Buffer, config: BatchRequestConfig) =>
    axios.post(url, batchRequest, { ...config, maxRedirects: 0 });

export class ODataBatchAxiosRepository implements ODataBatchRepository {
    async sendGrouped(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        layout: BatchRequestLayout,
        BatchParser: BatchResponseConstructor = BatchResponse
    ): Promise<BatchResponseGroup[]> {
        const request = await post(url, batchRequest, config);
        const parsed = createBatchResponse(
            BatchParser,
            request as unknown as { data: string; headers: Record<string, string> },
            accept
        );
        if (!parsed.parseGrouped) {
            throw new Error('Parser does not support grouped responses');
        }
        return parsed.parseGrouped(layout);
    }

    async send(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        BatchParser: BatchResponseConstructor
    ): Promise<BatchResponseParsed[]> {
        const request = await post(url, batchRequest, config);

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
