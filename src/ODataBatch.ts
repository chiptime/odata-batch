import { requestsToBatch, retrieveToBatch, Call, RetrieveCall } from './request';
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
            retrieve,
            batchResponseType = 'json',
            individualResponseType = 'json',
        }: {
            url: string;
            headers?: Record<string, string>;
            auth: string;
            calls?: Call[] | Call[][];
            retrieve?: RetrieveCall[];
            batchResponseType?: string;
            individualResponseType?: string;
        },
        batchRepository: ODataBatchRepository = new ODataBatchAxiosRepository()
    ) {
        this.ensureSingleMode(calls, retrieve);

        this.boundary = new Date().getTime().toString();

        this.headers = headers;
        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;

        this.requestResponseType = {
            contentType: batchResponseType === 'json' ? 'application/json' : 'application/xml',
            accept: individualResponseType === 'json' ? 'application/json' : 'application/xml',
        };

        if (retrieve) {
            // Read-only batch: GETs become direct parts, no changeset wrapper
            this.batchRequest = retrieveToBatch(retrieve, this.boundary, { accept: this.requestResponseType.accept });
        } else {
            this.ensureHasCalls(calls);
            this.batchRequest = requestsToBatch(calls, this.boundary, this.requestResponseType);
        }
    }

    public send(): Promise<BatchResponseParsed[]> {
        const config = {
            headers: {
                ...this.headers,

                Authorization: this.headers?.Authorization || `Basic ${this.encodeBasicAuth(this.auth)}`,
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

    // RFC 7617: Basic credentials are base64(user-id:password). The standard
    // base64 alphabet never contains ':', so a colon unambiguously marks RAW
    // credentials (encode them); colon-less values are either pre-encoded
    // credentials or opaque tokens and pass through untouched
    private encodeBasicAuth(auth: string): string {
        if (!auth.includes(':')) {
            return auth;
        }

        return Buffer.from(auth, 'utf8').toString('base64');
    }

    // changeset mode (calls) and retrieve mode are mutually exclusive:
    // passing both is ambiguous, passing neither is a no-op
    private ensureSingleMode(calls: Call[] | Call[][] | undefined, retrieve: RetrieveCall[] | undefined): void {
        if (calls && retrieve) {
            throw new Error('Pass either calls or retrieve, not both');
        }

        if (retrieve && retrieve.length <= 0) {
            throw new Error('No calls have been passed');
        }
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
