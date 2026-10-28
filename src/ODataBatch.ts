import { requestsToBatch, retrieveToBatch, operationsToBatch, Call, RetrieveCall, BatchOperation } from './request';
import { generateBoundaryId } from './boundary';
import {
    BatchResponse,
    BatchResponseConstructor,
    BatchResponseParsed,
    BatchRequestLayout,
    BatchResponseGroup,
} from './response';
import { ODataBatchRepository, BatchRequestConfig } from './BatchRepository';
import { ODataBatchAxiosRepository } from './ODataBatchAxiosRepository';
import { operationsToJsonBatch, createJsonBatchResponseParser } from './jsonBatch';

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

const ensureLimitIsValid = (value: unknown, option: string): void => {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`${option} must be a non-negative finite number`);
    }
};

export type ProtocolVersion = '2.0' | '4.0' | '4.01';
export type BatchFormat = 'multipart' | 'json';

const VERSION_HEADERS: Record<ProtocolVersion, Record<string, string>> = {
    '2.0': { DataServiceVersion: '2.0', MaxDataServiceVersion: '2.0' },
    '4.0': { 'OData-Version': '4.0', 'OData-MaxVersion': '4.0' },
    '4.01': { 'OData-Version': '4.01', 'OData-MaxVersion': '4.01' },
};

const ensureProtocolVersionIsValid = (value: unknown): void => {
    if (value !== undefined && !Object.prototype.hasOwnProperty.call(VERSION_HEADERS, value as string)) {
        throw new Error("protocolVersion must be '2.0', '4.0' or '4.01'");
    }
};

export class ODataBatch {
    private auth: string;
    private protocolVersion: ProtocolVersion | undefined;
    private limits: Pick<BatchRequestConfig, 'timeout' | 'maxContentLength'>;
    private headers: Record<string, string> | undefined;
    private url: string;
    private boundary = '';
    private batchFormat: BatchFormat;
    private BatchParser: BatchResponseConstructor = BatchResponse;
    // Buffer when any call carries binary data, otherwise the legacy string
    private batchRequest: string | Buffer;
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
            timeout,
            maxContentLength,
            protocolVersion,
            batchFormat = 'multipart',
        }: {
            url: string;
            headers?: Record<string, string>;
            auth: string;
            calls?: Call[] | Call[][];
            retrieve?: RetrieveCall[];
            operations?: BatchOperation[];
            batchResponseType?: string;
            individualResponseType?: string;
            timeout?: number;
            maxContentLength?: number;
            protocolVersion?: ProtocolVersion;
            batchFormat?: BatchFormat;
        },
        batchRepository: ODataBatchRepository = new ODataBatchAxiosRepository()
    ) {
        this.ensureSingleMode(calls, retrieve, operations);
        ensureAuthIsSafe(auth);
        ensureHeadersAreSafe(headers);
        ensureLimitIsValid(timeout, 'timeout');
        ensureLimitIsValid(maxContentLength, 'maxContentLength');
        ensureProtocolVersionIsValid(protocolVersion);
        this.protocolVersion = protocolVersion;
        if (batchFormat !== 'multipart' && batchFormat !== 'json') {
            throw new Error("batchFormat must be 'multipart' or 'json'");
        }
        this.batchFormat = batchFormat;
        this.limits = {
            ...(timeout !== undefined ? { timeout } : {}),
            ...(maxContentLength !== undefined ? { maxContentLength } : {}),
        };

        this.headers = headers;
        this.auth = auth;
        this.url = url;
        this.batchRepository = batchRepository;

        this.requestResponseType = {
            contentType: normalizeMediaType(batchResponseType, 'batchResponseType'),
            accept: normalizeMediaType(individualResponseType, 'individualResponseType'),
        };

        if (batchFormat === 'json') {
            if (
                protocolVersion !== '4.01' ||
                Object.values(this.requestResponseType).some((type) => type.split(';')[0] !== 'application/json')
            ) {
                throw new Error("batchFormat 'json' requires protocolVersion '4.01' and JSON media types");
            }
            let jsonOperations: BatchOperation[];
            if (retrieve) {
                jsonOperations = retrieve;
            } else if (operations) {
                jsonOperations = operations;
            } else {
                this.ensureHasCalls(calls);
                jsonOperations = Array.isArray(calls[0]) ? (calls as Call[][]) : [calls as Call[]];
            }
            this.requestLayout = jsonOperations.map((part) =>
                Array.isArray(part) ? { kind: 'changeset', operationCount: part.length } : { kind: 'retrieve' }
            );
            const { body, requestIds } = operationsToJsonBatch(jsonOperations, {
                accept: this.requestResponseType.accept,
            });
            this.batchRequest = body;
            this.BatchParser = createJsonBatchResponseParser(requestIds);
            return;
        }

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
            const { body, boundary } = operationsToBatch(operations, { ...this.requestResponseType, protocolVersion });
            this.boundary = boundary;
            this.batchRequest = body;
        } else {
            this.ensureHasCalls(calls);
            const groups = Array.isArray(calls[0]) ? (calls as Call[][]) : [calls as Call[]];
            this.requestLayout = groups.map((group) => ({ kind: 'changeset', operationCount: group.length }));
            const { body, boundary } = requestsToBatch(calls, { ...this.requestResponseType, protocolVersion });
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
            this.BatchParser
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
            this.requestLayout,
            ...(this.batchFormat === 'json' ? [this.BatchParser] : [])
        );
    }

    private createRequestConfig(): BatchRequestConfig {
        // RFC 9110: header names are case-insensitive. A caller-supplied
        // `authorization` in any casing overrides `auth`; it is re-emitted
        // under one canonical key so no second (Basic) entry can shadow it.
        const { authorization, rest } = Object.entries(this.headers ?? {}).reduce(
            (acc, [key, value]) => {
                if (key.toLowerCase() === 'authorization') {
                    acc.authorization = acc.authorization || value;
                } else {
                    acc.rest[key] = value;
                }
                return acc;
            },
            { authorization: '', rest: {} as Record<string, string> }
        );

        // Opt-in protocol version headers; a caller header of the same name
        // (any casing) is the caller's explicit choice and is never doubled
        const callerKeys = new Set(Object.keys(rest).map((key) => key.toLowerCase()));
        const versionHeaders = Object.fromEntries(
            Object.entries(this.protocolVersion ? VERSION_HEADERS[this.protocolVersion] : {}).filter(
                ([key]) => !callerKeys.has(key.toLowerCase())
            )
        );

        return {
            headers: {
                ...rest,
                ...versionHeaders,
                Authorization: authorization || `Basic ${this.encodeBasicAuth(this.auth)}`,
                Accept: this.requestResponseType.accept,
                'Content-Type':
                    this.batchFormat === 'json'
                        ? 'application/json'
                        : 'multipart/mixed; boundary=batch_' + this.boundary,
            },
            ...this.limits,
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
