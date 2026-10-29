import axios from 'axios';
import { AsyncPollingConfig, BatchRequestConfig, ODataBatchRepository } from './BatchRepository';
import {
    createBatchResponse,
    BatchResponse,
    BatchResponseConstructor,
    BatchResponseParsed,
    BatchRequestLayout,
    BatchResponseGroup,
} from './response';

// Every batch carries an Authorization header. Following a redirect would
// replay those credentials to the redirect target (see GHSA-q3jh-wrc6-jgq8
// and GHSA-8r9p-f939-6h3c in follow-redirects). Fail closed on any 3xx;
// callers can configure the final endpoint instead of replaying a POST.
// Binary batches arrive as a Buffer and are posted unchanged.
// asyncPolling configures this repository itself and is never forwarded.
const transportConfig = (config: BatchRequestConfig) => {
    const transport: Record<string, unknown> = { ...config, maxRedirects: 0 };
    delete transport.asyncPolling;
    return transport as unknown as BatchRequestConfig & { maxRedirects: number };
};

const post = (url: string, batchRequest: string | Buffer, config: BatchRequestConfig) =>
    axios.post(url, batchRequest, transportConfig(config));

const get = (url: string, config: BatchRequestConfig) => axios.get(url, transportConfig(config));

const sleepMilliseconds = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// RFC 9110: header field names are case-insensitive, so never depend on the
// casing the HTTP client normalized to
const headerValue = (headers: unknown, name: string): string | undefined => {
    const entry = Object.entries((headers ?? {}) as Record<string, unknown>).find(
        ([key]) => key.toLowerCase() === name
    );
    return entry === undefined ? undefined : String(entry[1]);
};

// OData 4.01 Protocol §11.6: the status monitor lives on the service that
// answered the batch. A Location pointing elsewhere would replay the batch
// Authorization header to a foreign origin, so reject it before any poll.
const monitorUrl = (batchUrl: string, location: string): string => {
    const resolved = new URL(location, batchUrl);
    if (resolved.origin !== new URL(batchUrl).origin) {
        throw new Error('Async monitor must be on the batch origin');
    }
    return resolved.toString();
};

// RFC 7231 Retry-After: delay-seconds or an HTTP-date. Anything else (or a
// missing header) falls back to the configured default.
const retryAfterMs = (value: string | undefined, polling: AsyncPollingConfig): number => {
    const trimmed = (value ?? '').trim();
    if (/^[0-9]+$/.test(trimmed)) {
        return Math.min(Number(trimmed) * 1000, polling.maxRetryAfterMs);
    }
    const until = Date.parse(trimmed);
    if (!Number.isNaN(until)) {
        return Math.min(Math.max(0, until - Date.now()), polling.maxRetryAfterMs);
    }
    return polling.defaultRetryAfterMs;
};

const isApplicationHttp = (headers: unknown): boolean =>
    (headerValue(headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/http';

// §11.7.7.6: the monitor may answer application/http, wrapping the real
// batch response (status line, headers incl. its Content-Type, body).
// Binary payloads must survive byte-exactly: framing runs on a latin1 view
// of a Buffer body and hands a Buffer back. Only the status/header block is
// line-normalized; the body after the first blank line is never touched.
const unwrapHttpResponse = (monitor: {
    data: unknown;
    headers: unknown;
}): { data: string | Buffer; headers: Record<string, string> } => {
    // A Buffer instance takes the TypedArray copy path inside Buffer.from,
    // so both Buffer and ArrayBuffer monitors frame to the same latin1 view
    const asText =
        typeof monitor.data === 'string' ? monitor.data : Buffer.from(monitor.data as ArrayBuffer).toString('latin1');
    const blankLine = /\r?\n\r?\n/.exec(asText);
    if (!blankLine) {
        throw new Error('Async batch monitor response is not a valid HTTP response');
    }
    const head = asText.slice(0, blankLine.index).replace(/\r?\n/g, '\r\n');
    const body = asText.slice(blankLine.index + blankLine[0].length);
    const statusLine = head.split('\r\n')[0];
    const status = /^HTTP\/1\.[01] ([0-9]{3})(?: .*)?$/.exec(statusLine);
    if (!status) {
        throw new Error('Async batch monitor response is not a valid HTTP response');
    }
    if (status[1].charAt(0) !== '2') {
        throw new Error(`Async batch failed with status ${status[1]}`);
    }
    const headers: Record<string, string> = {};
    head.split('\r\n')
        .slice(1)
        .forEach((line) => {
            const colon = line.indexOf(':');
            if (colon !== -1) {
                headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
            }
        });
    return {
        data: typeof monitor.data === 'string' ? body : Buffer.from(body, 'latin1'),
        headers,
    };
};

export class ODataBatchAxiosRepository implements ODataBatchRepository {
    constructor(private readonly options: { sleep?: (ms: number) => Promise<void> } = {}) {}

    // Polling waits are injectable so tests never need real timers
    private sleep(ms: number): Promise<void> {
        return (this.options.sleep ?? sleepMilliseconds)(ms);
    }

    async sendGrouped(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig,
        accept: string,
        layout: BatchRequestLayout,
        BatchParser: BatchResponseConstructor = BatchResponse
    ): Promise<BatchResponseGroup[]> {
        const request = await this.deliver(url, batchRequest, config);
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
        const request = await this.deliver(url, batchRequest, config);

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

    // OData 4.01 §11.6: with respond-async the service answers 202 + Location
    // and the finished batch response is collected from the status monitor.
    // Without asyncPolling a 202 keeps today's normal parsing.
    private async deliver(
        url: string,
        batchRequest: string | Buffer,
        config: BatchRequestConfig
    ): Promise<{ data: string | Buffer; headers: Record<string, string> }> {
        const request = await post(url, batchRequest, config);
        if (request.status !== 202 || !config.asyncPolling) {
            return request as unknown as { data: string; headers: Record<string, string> };
        }

        const location = headerValue(request.headers, 'location');
        if (!location) {
            throw new Error('Async batch response is missing Location');
        }
        const polling = config.asyncPolling;
        let monitor = monitorUrl(url, location);

        let waitMs = retryAfterMs(headerValue(request.headers, 'retry-after'), polling);
        for (let polls = 0; polls < polling.maxPolls; polls++) {
            await this.sleep(waitMs);
            const response = await get(monitor, config);
            if (response.status === 202) {
                // §11.6: an interim 202 carries a Location that may change
                // between polls; each new one is origin-checked again. A lax
                // service omitting it keeps the already-validated monitor.
                const next = headerValue(response.headers, 'location');
                if (next) {
                    monitor = monitorUrl(url, next);
                }
                waitMs = retryAfterMs(headerValue(response.headers, 'retry-after'), polling);
                continue;
            }
            return isApplicationHttp(response.headers)
                ? unwrapHttpResponse(response)
                : (response as unknown as { data: string; headers: Record<string, string> });
        }
        throw new Error(`Async batch did not finish after ${polling.maxPolls} polls`);
    }
}
