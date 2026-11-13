import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { BatchResponseParsed } from '../src/response';

// The merged-boundary reroll tests force randomUUID through a queue on
// globalThis; the module factory reads it lazily so every other test keeps
// the real generator.
jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto');
    return {
        ...actual,
        randomUUID: () => (globalThis as { __forcedUuids?: string[] }).__forcedUuids?.shift() ?? actual.randomUUID(),
    };
});

const url = 'https://example.com/batch';
const m1 = 'https://example.com/monitor1';
const m2 = 'https://example.com/monitor2';
const polling = { maxPolls: 10, defaultRetryAfterMs: 777, maxRetryAfterMs: 60000 };
const batchHeaders = { 'content-type': 'multipart/mixed; boundary=resp' };

type Captured = { data?: unknown; headers?: Record<string, string> };

const capturingParser = (captured: Captured) =>
    class CapturingParser {
        response: BatchResponseParsed[] = [];
        constructor(OResponse: { data: unknown; headers: Record<string, string> }) {
            captured.data = OResponse.data;
            captured.headers = OResponse.headers;
        }
    };

const part = (...lines: string[]) => `${lines.join('\r\n')}\r\n`;

const http200Part = (payload: string) =>
    part('Content-Type: application/http', '', 'HTTP/1.1 200 OK', 'Content-Type: text/plain', '', payload);

const acceptedPart = (location: string, retryAfter = '0') =>
    part(
        'Content-Type: application/http',
        '',
        'HTTP/1.1 202 Accepted',
        `Location: ${location}`,
        `Retry-After: ${retryAfter}`,
        ''
    );

const multipartBody = (parts: string[], boundary = 'resp') =>
    `${parts.map((p) => `--${boundary}\r\n${p}`).join('')}--${boundary}--`;

const wrapped = (inner: string, statusLine = 'HTTP/1.1 200 OK', ...headLines: string[]) =>
    [statusLine, ...headLines, '', inner].join('\r\n');

const mergedLayout = (boundary: string, parts: string[]) => multipartBody(parts, boundary);

const headerValueOf = (headers: Record<string, string> | undefined, name: string) =>
    Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

const setup = () => {
    const mock = new MockAdapter(axios as any); // adapter types lag axios 1.20 generics; runtime fully compatible
    const sleeps: number[] = [];
    const repo = new ODataBatchAxiosRepository({
        sleep: async (ms: number) => {
            sleeps.push(ms);
        },
    });
    const config = { headers: {}, asyncPolling: polling };
    const postAccepted = () => mock.onPost(url).reply(202, '', { location: m1, 'retry-after': '0' });
    const finalAt = (location: string) =>
        mock.onGet(location).reply(200, multipartBody([http200Part('done')]), batchHeaders);
    return { mock, sleeps, repo, config, postAccepted, finalAt, capture: capturingParser };
};

describe('retry-after parsing at the polling boundary', () => {
    test.each([
        [' 5 ', 5000],
        ['x5', 777],
        ['5x', 777],
    ])('Retry-After %p waits %i ms', async (value, expected) => {
        const { mock, sleeps, repo, config, postAccepted, finalAt, capture } = setup();
        try {
            postAccepted();
            mock.onGet(m1).reply(202, '', { 'retry-after': value, location: m2 });
            finalAt(m2);

            await repo.send(url, 'request', config, 'application/json', capture({}) as any);

            expect(sleeps.slice(0, 2)).toEqual([0, expected]);
        } finally {
            mock.restore();
        }
    });
});

describe('application/http detection on the monitor answer', () => {
    test("content-type 'application/http ;x=1' still unwraps", async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const inner = multipartBody([http200Part('inner')]);
            mock.onGet(m1).reply(
                200,
                wrapped(inner, 'HTTP/1.1 200 OK', 'Content-Type: multipart/mixed; boundary=resp'),
                {
                    'content-type': 'application/http ;x=1',
                }
            );

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(captured.data).toBe(inner);
            expect(headerValueOf(captured.headers, 'content-type')).toBe('multipart/mixed; boundary=resp');
        } finally {
            mock.restore();
        }
    });
});

describe('unwrapHttpResponse framing', () => {
    const unwrapTo = async (body: string | Buffer, monitorHeaders: Record<string, string>) => {
        const { mock, repo, config, capture } = setup();
        const captured: Captured = {};
        mock.onPost(url).reply(202, '', { location: m1, 'retry-after': '0' });
        mock.onGet(m1).reply(200, body, monitorHeaders);
        await repo.send(url, 'request', config, 'application/json', capture(captured) as any);
        return { captured, mock };
    };

    test('a string monitor body hands the parser the exact string', async () => {
        const inner = multipartBody([http200Part('café-ñ')]);
        const { captured, mock } = await unwrapTo(wrapped(inner), { 'content-type': 'application/http' });
        try {
            expect(typeof captured.data).toBe('string');
            expect(captured.data).toBe(inner);
        } finally {
            mock.restore();
        }
    });

    test('an LF-only wrapped head still unwraps', async () => {
        const inner = multipartBody([http200Part('lf')]);
        const body = ['HTTP/1.1 200 OK', 'Content-Type: multipart/mixed; boundary=resp', '', inner].join('\n');
        const { captured, mock } = await unwrapTo(body, { 'content-type': 'application/http' });
        try {
            expect(captured.data).toBe(inner);
            expect(captured.headers).toEqual({ 'content-type': 'multipart/mixed; boundary=resp' });
        } finally {
            mock.restore();
        }
    });

    test.each([
        ['a leading space before the status line', ' HTTP/1.1 200 OK\r\n\r\nbody'],
        ['a four digit status', 'HTTP/1.1 2000\r\n\r\nbody'],
    ])('%s rejects', async (_name, body) => {
        const { mock, repo, config, postAccepted } = setup();
        try {
            postAccepted();
            mock.onGet(m1).reply(200, body, { 'content-type': 'application/http' });

            await expect(
                repo.send(url, 'request', config, 'application/json', capturingParser({}) as any)
            ).rejects.toThrow('Async batch monitor response is not a valid HTTP response');
        } finally {
            mock.restore();
        }
    });

    test('a status line without reason phrase accepts and parses wrapped headers exactly', async () => {
        const body = 'HTTP/1.1 200\r\nA:1\r\nX-NoColon\r\n X-K : v \r\n\r\nok';
        const { captured, mock } = await unwrapTo(body, { 'content-type': 'application/http' });
        try {
            expect(captured.data).toBe('ok');
            expect(captured.headers).toEqual({ a: '1', 'x-k': 'v' });
        } finally {
            mock.restore();
        }
    });

    test('a status reason containing a colon never becomes a header', async () => {
        const body = wrapped('ok', 'HTTP/1.1 200 Weird: Reason', 'A:1');
        const { captured, mock } = await unwrapTo(body, { 'content-type': 'application/http' });
        try {
            expect(captured.headers).toEqual({ a: '1' });
        } finally {
            mock.restore();
        }
    });
});

describe('a monitor answer without a content-type header', () => {
    test('is neither unwrapped nor multipart and passes through', async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            mock.onGet(m1).reply(200, 'raw answer');

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(captured.data).toBe('raw answer');
            expect(mock.history.get).toHaveLength(1);
        } finally {
            mock.restore();
        }
    });
});

describe('multipart boundary detection on the monitor answer', () => {
    const resumeCase = async (contentType: string, body: string) => {
        const { mock, repo, config, postAccepted, finalAt, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            mock.onGet(m1).reply(200, body, { 'content-type': contentType });
            finalAt(m2);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            return { captured, getUrls: mock.history.get.map((r) => r.url) };
        } finally {
            mock.restore();
        }
    };

    test.each([
        'text/x-multipart/y; boundary=resp',
        'xmultipart/mixed; boundary=resp',
        'application/vnd.odata.batch; type=multipart/mixed; boundary=resp',
    ])('a non-multipart media type (%p) with a boundary param is never treated as multipart', async (contentType) => {
        const body = multipartBody([acceptedPart(m2)]);
        const { captured, getUrls } = await resumeCase(contentType, body);

        expect(getUrls).toEqual([m1]);
        expect(captured.data).toBe(body);
    });

    test.each([
        ' multipart/mixed; boundary=resp',
        'multipart/mixed;boundary=resp',
        'multipart/mixed; boundary =resp',
        'multipart/mixed; boundary="resp"',
        'multipart/mixed; boundary=resp ;x=1',
    ])('%p resumes at the interim 202 part Location', async (contentType) => {
        const { getUrls } = await resumeCase(contentType, multipartBody([acceptedPart(m2)]));

        expect(getUrls).toEqual([m1, m2]);
    });

    test('a boundary with regex metacharacters frames only the real delimiters', async () => {
        const boundary = 'a.b+c';
        const decoyPart = http200Part('safe\r\n--aXbbc\r\nmore');
        const { captured, getUrls } = await resumeCase(
            `multipart/mixed; boundary=${boundary}`,
            multipartBody([decoyPart, acceptedPart(m2)], boundary)
        );

        expect(getUrls).toEqual([m1, m2]);
        const merged = captured.headers?.['content-type']?.match(/boundary=([^;\s]+)/)?.[1];
        expect(captured.data).toBe(mergedLayout(merged as string, [decoyPart, http200Part('done')]));
    });
});

describe('splitParts framing', () => {
    test('an epilogue after the close delimiter is ignored even when it contains a delimiter line', async () => {
        const { mock, repo, config, postAccepted, finalAt, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const body = `${multipartBody([acceptedPart(m2)])}\r\nepilogue\r\n--resp\r\nnot a part\r\n--resp--`;
            mock.onGet(m1).reply(200, body, batchHeaders);
            finalAt(m2);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(mock.history.get.map((r) => r.url)).toEqual([m1, m2]);
            expect(captured.data).toBe(multipartBody([http200Part('done')]));
        } finally {
            mock.restore();
        }
    });

    test('two kept parts before the 202 both survive with the exact merged layout', async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const first = http200Part('step-1');
            const second = http200Part('step-2');
            mock.onGet(m1).reply(200, multipartBody([first, second, acceptedPart(m2)]), batchHeaders);
            mock.onGet(m2).reply(200, multipartBody([http200Part('step-3')]), batchHeaders);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            const merged = captured.headers?.['content-type']?.match(/boundary=([^;\s]+)/)?.[1];
            expect(captured.data).toBe(mergedLayout(merged as string, [first, second, http200Part('step-3')]));
        } finally {
            mock.restore();
        }
    });
});

describe('interim continuation detection', () => {
    const continuationCase = async (lastPart: string) => {
        const { mock, repo, config, postAccepted, finalAt, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const body = multipartBody([http200Part('early'), lastPart]);
            mock.onGet(m1).reply(200, body, batchHeaders);
            finalAt(m2);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            return { captured, getUrls: mock.history.get.map((r) => r.url), body };
        } finally {
            mock.restore();
        }
    };

    test('an LF-only interim part resumes', async () => {
        const { mock, repo, config, postAccepted, finalAt, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const body = [
                '--resp',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 202 Accepted',
                `Location: ${m2}`,
                'Retry-After: 0',
                '',
                '--resp--',
            ].join('\n');
            mock.onGet(m1).reply(200, body, batchHeaders);
            finalAt(m2);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(mock.history.get.map((r) => r.url)).toEqual([m1, m2]);
        } finally {
            mock.restore();
        }
    });

    test('a MIME content-type that is not application/http never resumes, even with a 202 block', async () => {
        const { captured, getUrls, body } = await continuationCase(
            part(
                'Content-Type: text/plain',
                'X-Content-Type: application/http',
                '',
                `HTTP/1.1 202 Accepted`,
                `Location: ${m2}`
            )
        );

        expect(getUrls).toEqual([m1]);
        expect(captured.data).toBe(body);
    });

    test("'Content-Type:application/http' without a space resumes", async () => {
        const { getUrls } = await continuationCase(
            part('Content-Type:application/http', '', `HTTP/1.1 202 Accepted`, `Location: ${m2}`)
        );

        expect(getUrls).toEqual([m1, m2]);
    });

    test('an application/http part without a blank line after the headers does not resume and does not throw', async () => {
        const { captured, getUrls, body } = await continuationCase(
            part('Content-Type: application/http', `HTTP/1.1 202 Accepted`, `Location: ${m2}`)
        );

        expect(getUrls).toEqual([m1]);
        expect(captured.data).toBe(body);
    });

    test('a two-block 202 part without a trailing body resumes', async () => {
        const { getUrls } = await continuationCase(
            part('Content-Type: application/http', '', `HTTP/1.1 202 Accepted`, `Location: ${m2}`)
        );

        expect(getUrls).toEqual([m1, m2]);
    });

    test.each([
        ['a 200 status with a Location header', `HTTP/1.1 200 OK`, `Location: ${m2}`],
        ['a status line that does not start with HTTP/', `XHTTP/1.1 202 Accepted`, `Location: ${m2}`],
        ['a location-ish line without a colon', `HTTP/1.1 202 Accepted`, `locationX`],
    ])('%s does not resume', async (_name, statusLine, headerLine) => {
        const { captured, getUrls, body } = await continuationCase(
            part('Content-Type: application/http', '', statusLine, headerLine)
        );

        expect(getUrls).toEqual([m1]);
        expect(captured.data).toBe(body);
    });

    test("'Location : url' with a space before the colon resumes", async () => {
        const { getUrls } = await continuationCase(
            part('Content-Type: application/http', '', `HTTP/1.1 202 Accepted`, `Location : ${m2}`)
        );

        expect(getUrls).toEqual([m1, m2]);
    });

    test('a non-breaking space between the colon and the Location value is trimmed before resolving', async () => {
        const { getUrls } = await continuationCase(
            part('Content-Type: application/http', '', `HTTP/1.1 202 Accepted`, `Location:\u00A0${m2}`)
        );

        expect(getUrls).toEqual([m1, m2]);
    });
});

describe('merge', () => {
    test('a string run merges without mojibake and stays a string', async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            const kept = http200Part('señal-1');
            mock.onGet(m1).reply(200, multipartBody([kept, acceptedPart(m2)]), batchHeaders);
            mock.onGet(m2).reply(200, multipartBody([http200Part('señal-2')]), batchHeaders);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(typeof captured.data).toBe('string');
            const merged = captured.headers?.['content-type']?.match(/boundary=([^;\s]+)/)?.[1];
            expect(captured.data).toBe(mergedLayout(merged as string, [kept, http200Part('señal-2')]));
        } finally {
            mock.restore();
        }
    });

    test('merged headers keep every other header and exactly one content-type', async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        try {
            postAccepted();
            mock.onGet(m1).reply(200, multipartBody([http200Part('early'), acceptedPart(m2)]), batchHeaders);
            mock.onGet(m2).reply(200, multipartBody([http200Part('done')]), {
                'Content-Type': 'multipart/mixed; boundary=resp',
                'OData-Version': '4.01',
            });

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            const keys = Object.keys(captured.headers ?? {});
            expect(keys.filter((key) => key.toLowerCase() === 'content-type')).toHaveLength(1);
            const merged = headerValueOf(captured.headers, 'content-type')?.match(/boundary=([^;\s]+)/)?.[1];
            expect(headerValueOf(captured.headers, 'content-type')).toBe(`multipart/mixed; boundary=${merged}`);
            expect(headerValueOf(captured.headers, 'odata-version')).toBe('4.01');
        } finally {
            mock.restore();
        }
    });

    test('the merged boundary is rerolled when a kept part carries it as a line', async () => {
        const { mock, repo, config, postAccepted, capture } = setup();
        const captured: Captured = {};
        (globalThis as { __forcedUuids?: string[] }).__forcedUuids = ['collide', 'fresh'];
        try {
            postAccepted();
            const kept = http200Part('x\r\n--batch_merged_collide\r\ny');
            mock.onGet(m1).reply(200, multipartBody([kept, acceptedPart(m2)]), batchHeaders);
            mock.onGet(m2).reply(200, multipartBody([http200Part('done')]), batchHeaders);

            await repo.send(url, 'request', config, 'application/json', capture(captured) as any);

            expect(headerValueOf(captured.headers, 'content-type')).toBe(
                'multipart/mixed; boundary=batch_merged_fresh'
            );
            expect(captured.data).toBe(mergedLayout('batch_merged_fresh', [kept, http200Part('done')]));
        } finally {
            delete (globalThis as { __forcedUuids?: string[] }).__forcedUuids;
            mock.restore();
        }
    });

    test('a non-multipart final answer after kept interim parts rejects', async () => {
        const { mock, repo, config, postAccepted } = setup();
        try {
            postAccepted();
            mock.onGet(m1).reply(200, multipartBody([http200Part('early'), acceptedPart(m2)]), batchHeaders);
            mock.onGet(m2).reply(200, '{"done":true}', { 'content-type': 'application/json' });

            await expect(
                repo.send(url, 'request', config, 'application/json', capturingParser({}) as any)
            ).rejects.toThrow('Async batch interim results cannot be combined with a non-multipart final answer');
            expect(mock.history.get.map((r) => r.url)).toEqual([m1, m2]);
        } finally {
            mock.restore();
        }
    });
});

describe('the default sleep waits in real time', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('no poll happens before the Retry-After elapsed and one happens right after', async () => {
        jest.useFakeTimers();
        const mock = new MockAdapter(axios as any);
        try {
            mock.onPost(url).reply(202, '', { location: m1, 'retry-after': '5' });
            mock.onGet(m1).reply(200, multipartBody([http200Part('done')]), batchHeaders);

            const pending = new ODataBatchAxiosRepository().send(
                url,
                'request',
                { headers: {}, asyncPolling: polling },
                'application/json',
                capturingParser({}) as any
            );

            await jest.advanceTimersByTimeAsync(4999);
            expect(mock.history.get).toHaveLength(0);
            await jest.advanceTimersByTimeAsync(1);
            await pending;

            expect(mock.history.get).toHaveLength(1);
        } finally {
            mock.restore();
        }
    });
});
