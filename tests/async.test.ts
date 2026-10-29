import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { BatchResponse, BatchResponseParsed } from '../src/response';

const url = 'http://example.com/batch';
const monitor = 'http://example.com/monitor';
const authHeaders = { Authorization: 'Basic dXNlcjpwYXNz' };
const polling = { maxPolls: 10, defaultRetryAfterMs: 777, maxRetryAfterMs: 30000 };

const batchBody = (boundary: string, payload = '{"value":1}') =>
    [
        `--${boundary}`,
        'Content-Type: application/http',
        '',
        'HTTP/1.1 200 OK',
        'Content-Type: application/json',
        '',
        payload,
        `--${boundary}--`,
    ].join('\r\n');

const batchHeaders = { 'content-type': 'multipart/mixed; boundary=resp' };

const wrappedBody = (innerBody: string, statusLine = 'HTTP/1.1 200 OK') =>
    [statusLine, 'Content-Type: multipart/mixed; boundary=resp', '', innerBody].join('\r\n');

describe('ODataBatchAxiosRepository async polling (S1)', () => {
    let mock: MockAdapter;
    let sleeps: number[];

    beforeEach(() => {
        mock = new MockAdapter(axios as any); // adapter types lag axios 1.20 generics; runtime fully compatible
        sleeps = [];
    });

    afterEach(() => {
        mock.restore();
    });

    const repo = () =>
        new ODataBatchAxiosRepository({
            sleep: async (ms: number) => {
                sleeps.push(ms);
            },
        });

    const config = (extra: Record<string, unknown> = {}) => ({
        headers: { ...authHeaders },
        asyncPolling: polling,
        ...extra,
    });

    test('an immediate 200 answer is parsed without polling', async () => {
        mock.onPost(url).reply(200, batchBody('resp'), batchHeaders);

        const result = await repo().send(url, 'request', config(), 'application/json', BatchResponse);

        expect(result[0].data).toEqual({ value: 1 });
        expect(mock.history.get).toHaveLength(0);
        expect(sleeps).toEqual([]);
    });

    test("a 202 without asyncPolling keeps today's normal parsing", async () => {
        mock.onPost(url).reply(202, batchBody('resp'), { ...batchHeaders, location: monitor, 'retry-after': '1' });

        const result = await repo().send(
            url,
            'request',
            { headers: { ...authHeaders } },
            'application/json',
            BatchResponse
        );

        expect(result[0].data).toEqual({ value: 1 });
        expect(mock.history.get).toHaveLength(0);
        expect(sleeps).toEqual([]);
    });

    describe('polling loop', () => {
        test('202 -> 202 -> 200 waits the announced Retry-After between polls', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '2' });
            mock.onGet(monitor).replyOnce(202, '', { 'retry-after': '3' });
            mock.onGet(monitor).replyOnce(200, batchBody('resp'), batchHeaders);

            const result = await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(result[0].data).toEqual({ value: 1 });
            expect(sleeps).toEqual([2000, 3000]);
            expect(mock.history.get).toHaveLength(2);
            mock.history.get.forEach((poll) => {
                expect(poll.url).toBe(monitor);
                expect(poll.headers?.Authorization).toBe('Basic dXNlcjpwYXNz');
                expect(poll.maxRedirects).toBe(0);
                expect(poll).not.toHaveProperty('asyncPolling');
            });
            expect(mock.history.post[0]).not.toHaveProperty('asyncPolling');
        });

        test('caps delay-seconds at maxRetryAfterMs', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '60' });
            mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

            await repo().send(
                url,
                'request',
                config({ asyncPolling: { maxPolls: 10, defaultRetryAfterMs: 777, maxRetryAfterMs: 5000 } }),
                'application/json',
                BatchResponse
            );

            expect(sleeps).toEqual([5000]);
        });

        test('accepts an HTTP-date Retry-After and waits until it', async () => {
            const until = new Date(Date.now() + 2000).toUTCString();
            mock.onPost(url).reply(() => [202, '', { location: monitor, 'retry-after': until }]);
            mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

            await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(sleeps[0]).toBeGreaterThan(1000);
            expect(sleeps[0]).toBeLessThanOrEqual(2000);
        });

        test('a past HTTP-date Retry-After waits zero', async () => {
            const until = new Date(Date.now() - 5000).toUTCString();
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': until });
            mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

            await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(sleeps).toEqual([0]);
        });

        test.each(['tomorrow', ''])(
            'an invalid Retry-After (%p) falls back to the configured default',
            async (value) => {
                mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': value });
                mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

                await repo().send(url, 'request', config(), 'application/json', BatchResponse);

                expect(sleeps).toEqual([777]);
            }
        );

        test('a missing Retry-After falls back to the configured default', async () => {
            mock.onPost(url).reply(202, '', { location: monitor });
            mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

            await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(sleeps).toEqual([777]);
        });

        test('stops after maxPolls with a clear error', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(() => [202, '', { 'retry-after': '0' }]);

            await expect(
                repo().send(
                    url,
                    'request',
                    {
                        headers: { ...authHeaders },
                        asyncPolling: { maxPolls: 2, defaultRetryAfterMs: 0, maxRetryAfterMs: 1000 },
                    },
                    'application/json',
                    BatchResponse
                )
            ).rejects.toThrow('Async batch did not finish after 2 polls');

            expect(mock.history.get).toHaveLength(2);
            expect(sleeps).toEqual([0, 0]);
        });

        test('a non-2xx monitor answer rejects like a non-2xx batch response', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(500, 'Internal Server Error');

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Request failed with status code 500'
            );
        });
    });

    describe('Location handling', () => {
        test('resolves a relative Location against the batch url', async () => {
            const svcUrl = 'http://example.com/svc/$batch';
            const resolved = 'http://example.com/svc/monitor/42';
            mock.onPost(svcUrl).reply(202, '', { location: 'monitor/42', 'retry-after': '0' });
            mock.onGet(resolved).reply(200, batchBody('resp'), batchHeaders);

            await repo().send(svcUrl, 'request', config(), 'application/json', BatchResponse);

            expect(mock.history.get).toHaveLength(1);
            expect(mock.history.get[0].url).toBe(resolved);
        });

        test('rejects a different-origin Location before any poll', async () => {
            mock.onPost(url).reply(202, '', { location: 'http://evil.example/monitor', 'retry-after': '1' });

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Async monitor must be on the batch origin'
            );

            expect(mock.history.get).toHaveLength(0);
            expect(sleeps).toEqual([]);
        });

        test('rejects a 202 without Location', async () => {
            mock.onPost(url).reply(202, '', { 'retry-after': '1' });

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Async batch response is missing Location'
            );

            expect(mock.history.get).toHaveLength(0);
        });
    });

    describe('application/http monitor answers', () => {
        test('unwraps the wrapped response and parses it', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, wrappedBody(batchBody('resp')), { 'content-type': 'application/http' });

            const result = await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(result[0].code).toBe('200');
            expect(result[0].data).toEqual({ value: 1 });
        });

        test('a wrapped non-2xx status rejects', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, wrappedBody('{"error":1}', 'HTTP/1.1 500 Internal Server Error'), {
                'content-type': 'application/http',
            });

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Async batch failed with status 500'
            );
        });

        test('unwraps a Buffer body byte-exactly and hands the parser a Buffer', async () => {
            const payload = '{"name":"café"}';
            const wrapped = Buffer.from(wrappedBody(batchBody('resp', payload)), 'latin1');
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, wrapped, { 'content-type': 'application/http' });

            const captured: { data?: unknown; headers?: Record<string, string> } = {};
            class CapturingParser {
                response: BatchResponseParsed[] = [];
                constructor(OResponse: { data: unknown; headers: Record<string, string> }) {
                    captured.data = OResponse.data;
                    captured.headers = OResponse.headers;
                }
            }

            await repo().send(
                url,
                'request',
                config({ responseType: 'arraybuffer' }),
                'application/json',
                CapturingParser as any
            );

            expect(Buffer.isBuffer(captured.data)).toBe(true);
            expect((captured.data as Buffer).toString('latin1')).toBe(batchBody('resp', payload));
            expect(captured.headers?.['content-type']).toBe('multipart/mixed; boundary=resp');
        });
    });

    describe('monitor edge cases', () => {
        test('a later 202 may move the monitor; the new Location is followed', async () => {
            const moved = 'http://example.com/monitor-2';
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(202, '', { location: moved, 'retry-after': '0' });
            mock.onGet(moved).reply(200, batchBody('resp'), batchHeaders);

            const result = await repo().send(url, 'request', config(), 'application/json', BatchResponse);

            expect(mock.history.get.map((r) => r.url)).toEqual([monitor, moved]);
            expect(result[0].data).toEqual({ value: 1 });
        });

        test('a later 202 moving the monitor to another origin is rejected without polling it', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(202, '', { location: 'http://evil.example/monitor', 'retry-after': '0' });

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Async monitor must be on the batch origin'
            );
            expect(mock.history.get).toHaveLength(1);
        });

        test('a wrapped Buffer body keeps bare CR/LF bytes inside the payload', async () => {
            const head = Buffer.from(
                'HTTP/1.1 200 OK\r\nContent-Type: multipart/mixed; boundary=resp\r\n\r\n',
                'latin1'
            );
            const body = Buffer.from([0x2d, 0x0a, 0x0d, 0xff, 0x00, 0x0a]);
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, Buffer.concat([head, body]), { 'content-type': 'application/http' });

            const captured: { data?: Buffer } = {};
            class CapturingParser {
                response: BatchResponseParsed[] = [];
                constructor(OResponse: { data: Buffer }) {
                    captured.data = OResponse.data;
                }
            }
            await repo().send(
                url,
                'request',
                config({ responseType: 'arraybuffer' }),
                'application/json',
                CapturingParser as any
            );

            expect(captured.data?.equals(body)).toBe(true);
        });
    });

    describe('malformed monitor answers and parser capability', () => {
        test.each([
            ['no blank line', 'HTTP/1.1 200 OK'],
            ['no status line', 'garbage\r\n\r\nbody'],
        ])('an application/http monitor body with %s rejects', async (_name, body) => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, body, { 'content-type': 'application/http' });

            await expect(repo().send(url, 'request', config(), 'application/json', BatchResponse)).rejects.toThrow(
                'Async batch monitor response is not a valid HTTP response'
            );
        });

        test('sendGrouped with a parser lacking parseGrouped rejects', async () => {
            mock.onPost(url).reply(200, batchBody('resp'), batchHeaders);
            class FlatOnly {
                response: BatchResponseParsed[] = [];
            }
            await expect(
                repo().sendGrouped(
                    url,
                    'request',
                    { headers: {} },
                    'application/json',
                    [{ kind: 'retrieve' }],
                    FlatOnly as any
                )
            ).rejects.toThrow('Parser does not support grouped responses');
        });
    });

    describe('grouped and default construction', () => {
        test('sendGrouped polls the monitor too', async () => {
            const body = [
                '--response',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 404 Not Found',
                '',
                '{}',
                '--response',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 400 Bad Request',
                '',
                '{}',
                '--response--',
            ].join('\r\n');
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, body, { 'content-type': 'multipart/mixed; boundary=response' });

            const result = await repo().sendGrouped(url, 'request', config(), 'application/json', [
                { kind: 'retrieve' },
                { kind: 'changeset', operationCount: 3 },
            ]);

            expect(result.map((group: any) => group.kind)).toEqual(['retrieve', 'changeset-error']);
            expect(mock.history.get).toHaveLength(1);
            expect(mock.history.get[0].maxRedirects).toBe(0);
        });

        test('the default constructor keeps working with the real setTimeout', async () => {
            mock.onPost(url).reply(202, '', { location: monitor, 'retry-after': '0' });
            mock.onGet(monitor).reply(200, batchBody('resp'), batchHeaders);

            const result = await new ODataBatchAxiosRepository().send(
                url,
                'request',
                config(),
                'application/json',
                BatchResponse
            );

            expect(result[0].data).toEqual({ value: 1 });
            expect(mock.history.get).toHaveLength(1);
        });
    });
});

describe('async monitor origin (real sockets)', () => {
    const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const close = (server: Server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    const port = (server: Server) => (server.address() as AddressInfo).port;

    test('a cross-origin Location is rejected before any request reaches the foreign server', async () => {
        const foreignHits: string[] = [];
        const foreign = createServer((req, res) => {
            foreignHits.push(req.url ?? '');
            req.resume();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
        await listen(foreign);

        const originHits: unknown[] = [];
        const origin = createServer((req, res) => {
            originHits.push(req.headers.prefer);
            req.resume();
            res.writeHead(202, {
                Location: `http://127.0.0.1:${port(foreign)}/monitor`,
                'Retry-After': '1',
            });
            res.end();
        });
        await listen(origin);

        try {
            const batch = new ODataBatch({
                url: `http://127.0.0.1:${port(origin)}/$batch`,
                auth: 'user:pass',
                retrieve: [{ url: '/Items' }],
                asyncPolling: { maxPolls: 3 },
            });

            await expect(batch.send()).rejects.toThrow('Async monitor must be on the batch origin');
            expect(originHits).toEqual(['respond-async']);
            expect(foreignHits).toEqual([]);
        } finally {
            await close(origin);
            await close(foreign);
        }
    });
});
