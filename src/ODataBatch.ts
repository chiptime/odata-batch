import { requestsToBatch, retrieveToBatch, operationsToBatch, Call, RetrieveCall, BatchOperation } from './request';
import { generateBoundaryId } from './boundary';
import { BatchResponse, BatchResponseParsed, BatchRequestLayout, BatchResponseGroup } from './response';
import { ODataBatchRepository, BatchRequestConfig } from './BatchRepository';
import { ODataBatchAxiosRepository } from './ODataBatchAxiosRepository';

// Parameters are HTTP tokens or quoted printable ASCII, including quoted-pair
// escapes. Validate the whole value before trimming so CR/LF cannot disappear.
const MEDIA_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_QUOTED_VALUE = String.raw`"(?:[ !#-\[\]-~]|\\[ -~])*"`;
const MEDIA_PARAMETER = `; *${MEDIA_TOKEN} *= *(?:${MEDIA_TOKEN}|${MEDIA_QUOTED_VALUE}) *`;
const MEDIA_TYPE = new RegExp(
    `^(application/json|application/xml|text/xml|application/atom\\+xml)( *(?:${MEDIA_PARAMETER})*)$`,
    'i'
);

const normalizeMediaType = (value: string, option: string): string => {
    const invalid = (): never => {
        throw new Error(`${option} must be a supported JSON or XML media type`);
    };

    if (typeof value !== 'string' || /[^ -~]/.test(value)) {
        return invalid();
    }

    const trimmed = value.trim();
    const alias = trimmed.toLowerCase();
    if (alias === 'json' || alias === 'xml') {
        return `application/${alias}`;
    }

    const match = MEDIA_TYPE.exec(trimmed);
    if (!match) {
        return invalid();
    }

    return match[1].toLowerCase() + match[2];
};

const LINE_BREAK = /[\r\n]/;

const ensureAuthIsSafe = (auth: string): void => {
    if (LINE_BREAK.test(auth)) {
        throw new Error('Call auth must not contain line breaks');
    }
};

const ensureHeadersAreSafe = (headers?: Record<string, string>): void => {
    if (!headers) {
        return;
    }

    Object.entries(headers).forEach(([key, value]) => {
        if (LINE_BREAK.test(key) || LINE_BREAK.test(String(value))) {
            throw new Error(`Call header '${key}' must not contain line breaks`);
        }
    });
};

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
    private requestLayout: BatchRequestLayout;

    constructor(
        {
            url,
            headers,
            auth,
            calls,
            retrieve,
            operations,
            batchResponseType = 'json',
            individualResponseType = 'json',
        }: {
            url: string;
            headers?: Record<string, string>;
            auth: string;
            calls?: Call[] | Call[][];
            retrieve?: RetrieveCall[];
            operations?: BatchOperation[];
            batchResponseType?: string;
            individualResponseType?: string;
        },
        batchRepository: ODataBatchRepository = new ODataBatchAxiosRepository()
    ) {
        this.ensureSingleMode(calls, retrieve, operations);
        ensureAuthIsSafe(auth);
        ensureHeadersAreSafe(headers);

        this.headers = headers;
        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;

        this.requestResponseType = {
            contentType: normalizeMediaType(batchResponseType, 'batchResponseType'),
            accept: normalizeMediaType(individualResponseType, 'individualResponseType'),
        };

        if (retrieve) {
            this.requestLayout = retrieve.map(() => ({ kind: 'retrieve' }));
            // Read-only batch: GETs become direct parts, no changeset wrapper
            this.boundary = generateBoundaryId();
            this.batchRequest = retrieveToBatch(retrieve, this.boundary, { accept: this.requestResponseType.accept });
        } else if (operations) {
            // Ordered mixed batch: GET entries are direct parts, Call[] entries
            // are atomic changesets, serialized in input order
            this.requestLayout = operations.map((part) =>
                Array.isArray(part) ? { kind: 'changeset', operationCount: part.length } : { kind: 'retrieve' }
            );
            const { body, boundary } = operationsToBatch(operations, this.requestResponseType);
            this.boundary = boundary;
            this.batchRequest = body;
        } else {
            this.ensureHasCalls(calls);
            const groups = Array.isArray(calls[0]) ? (calls as Call[][]) : [calls as Call[]];
            this.requestLayout = groups.map((group) => ({ kind: 'changeset', operationCount: group.length }));
            const { body, boundary } = requestsToBatch(calls, this.requestResponseType);
            this.boundary = boundary;
            this.batchRequest = body;
        }
    }

    public send(): Promise<BatchResponseParsed[]> {
        return this.batchRepository.send(
            this.url,
            this.batchRequest,
            this.createRequestConfig(),
            this.requestResponseType.accept,
            BatchResponse
        );
    }

    public async sendGrouped(): Promise<BatchResponseGroup[]> {
        if (typeof this.batchRepository.sendGrouped !== 'function') {
            throw new Error('Repository does not support grouped responses');
        }
        return this.batchRepository.sendGrouped(
            this.url,
            this.batchRequest,
            this.createRequestConfig(),
            this.requestResponseType.accept,
            this.requestLayout
        );
    }

    private createRequestConfig(): BatchRequestConfig {
        return {
            headers: {
                ...this.headers,
                Authorization: this.headers?.Authorization || `Basic ${this.encodeBasicAuth(this.auth)}`,
                Accept: this.requestResponseType.accept,
                'Content-Type': 'multipart/mixed; boundary=batch_' + this.boundary,
            },
        };
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

    // changeset mode (calls), retrieve mode, and ordered mixed operations are
    // mutually exclusive: passing more than one is ambiguous, passing none is
    // a no-op handled by ensureHasCalls
    private ensureSingleMode(
        calls: Call[] | Call[][] | undefined,
        retrieve: RetrieveCall[] | undefined,
        operations: BatchOperation[] | undefined
    ): void {
        if (calls && retrieve) {
            throw new Error('Pass either calls or retrieve, not both');
        }

        if (operations && (calls || retrieve)) {
            throw new Error('Pass either operations or calls/retrieve, not both');
        }

        if (retrieve && retrieve.length <= 0) {
            throw new Error('No calls have been passed');
        }

        if (operations && operations.length <= 0) {
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
