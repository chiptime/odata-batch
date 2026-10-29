import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { ODataBatchRepository } from '../src/BatchRepository';
import { BatchResponse, BatchResponseConstructor, createBatchResponse } from '../src/response';
import { Call } from '../src/request';
import { DummyBatchRepo } from './helpers';
import '../src/index';

/**
 * End-to-end tests: the full ODataBatch.send() pipeline over a mocked HTTP
 * transport (axios-mock-adapter), plus send() configuration semantics and
 * compile-time type-surface assertions.
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

/** axios 1.x types request headers as optional; tests always set them. */
const sentHeaders = (req: { headers?: unknown }): Record<string, string> =>
    (req.headers ?? {}) as Record<string, string>;

describe('ODataBatch.send() end-to-end (mocked axios transport)', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios as any); // adapter types lag axios 1.20 generics; runtime fully compatible
    });

    afterEach(() => {
        mock.restore();
    });

    test('sendGrouped posts once and preserves a collapsed failure followed by a successful changeset', async () => {
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            individualResponseType: 'application/json;odata=verbose',
            calls: [
                Array.from({ length: 3 }, () => ({ method: 'POST', url: '/Items', data: {} })),
                [1, 2].map((id) => ({ method: 'POST', url: '/Lines', data: {}, contentId: String(id) })),
            ],
        });
        mock.onPost('https://sap.example.com/batch').reply(
            200,
            wire(
                '--response',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 400 Bad Request',
                '',
                '{"error":"atomic failure"}',
                '--response',
                'Content-Type: multipart/mixed; boundary=cs',
                '',
                '--cs',
                'Content-Type: application/http',
                'Content-ID: 1',
                '',
                'HTTP/1.1 201 Created',
                '',
                '{"id":1}',
                '--cs',
                'Content-Type: application/http',
                'Content-ID: 2',
                '',
                'HTTP/1.1 204 No Content',
                '',
                '',
                '--cs--',
                '--response--'
            ),
            { 'content-type': 'multipart/mixed; boundary=response' }
        );

        const groups = await (batch as any).sendGrouped();

        expect(mock.history.post).toHaveLength(1);
        expect(sentHeaders(mock.history.post[0]).Accept).toBe('application/json;odata=verbose');
        expect(groups.map((g: any) => [g.kind, g.partIndex])).toEqual([
            ['changeset-error', 0],
            ['changeset', 1],
        ]);
        expect(groups[0].error.data).toEqual({ error: 'atomic failure' });
        expect(groups[0]).not.toHaveProperty('responses');
        expect(groups[1].responses.map((r: any) => [r.contentId, r.data])).toEqual([
            ['1', { id: 1 }],
            ['2', null],
        ]);
    });

    test('sendGrouped identifies retrieve errors and rejects malformed counts after only one POST', async () => {
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            retrieve: [{ url: '/Items' }],
        });
        const response = wire(
            '--response',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 404 Not Found',
            '',
            '{}',
            '--response--'
        );
        mock.onPost('https://sap.example.com/batch').replyOnce(200, response, {
            'content-type': 'multipart/mixed; boundary=response',
        });
        expect((await (batch as any).sendGrouped())[0].kind).toBe('retrieve');
        mock.onPost('https://sap.example.com/batch').replyOnce(200, '--response--', {
            'content-type': 'multipart/mixed; boundary=response',
        });
        await expect((batch as any).sendGrouped()).rejects.toThrow(/Grouped response/);
        expect(mock.history.post).toHaveLength(2);
    });

    test('Content-ID and dependent URLs survive the full mocked pipeline without inference', async () => {
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            calls: [
                [
                    { method: 'POST', url: '/Items', data: { name: 'one' }, contentId: '1' },
                    { method: 'POST', url: '$1/Lines', data: {}, contentId: '2' },
                    { method: 'POST', url: '$1/Other', data: {} },
                ],
            ],
        });
        mock.onPost('https://sap.example.com/batch').reply(
            200,
            wire(
                '--response',
                'Content-Type: multipart/mixed; boundary=cs',
                '',
                '--cs',
                'Content-Type: application/http',
                'Content-ID: 1',
                '',
                'HTTP/1.1 201 Created',
                '',
                '{"id":1}',
                '--cs',
                'Content-Type: application/http',
                'content-id: 2',
                '',
                'HTTP/1.1 204 No Content',
                '',
                '',
                '--cs',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 204 No Content',
                '',
                '',
                '--cs--',
                '--response--'
            ),
            { 'content-type': 'multipart/mixed; boundary=response' }
        );

        const result = await batch.send();

        expect(mock.history.post[0].data).toContain('Content-ID: 1\r\n\r\nPOST /Items HTTP/1.1');
        expect(mock.history.post[0].data).toContain('Content-ID: 2\r\n\r\nPOST $1/Lines HTTP/1.1');
        expect(mock.history.post[0].data.match(/^Content-ID:/gm)).toHaveLength(2);
        expect(result.map((r) => r.contentId)).toEqual(['1', '2', undefined]);
        expect(result.map((r) => r.data)).toEqual([{ id: 1 }, null, null]);
        expect(result[2]).not.toHaveProperty('contentId');
    });

    test('invalid or duplicate explicit Content-ID rejects before axios transport', () => {
        for (const contentId of ['1\r\nX-Injected: yes', '1']) {
            expect(
                () =>
                    new ODataBatch({
                        url: 'https://sap.example.com/batch',
                        auth: 'user:pass',
                        calls: [
                            { method: 'POST', url: '/Items', data: {}, contentId: '1' },
                            { method: 'POST', url: '$1/Lines', data: {}, contentId },
                        ],
                    })
            ).toThrow(/contentId/);
        }
        expect(mock.history.post).toHaveLength(0);
    });

    test.each([
        ['Application/JSON;odata=verbose', 'application/json;odata=verbose', { id: 1 }, '{"id":1}', { id: 2 }],
        ['Application/XML;charset=utf-8', 'application/xml;charset=utf-8', '<item/>', '<item/>', '<result/>'],
    ])(
        'parameterized %s reaches axios and controls response parsing',
        async (value, expected, data, serialized, response) => {
            const batch = new ODataBatch({
                url: 'https://sap.example.com/batch',
                auth: 'user:pass',
                calls: [
                    [
                        {
                            method: 'POST',
                            url: '/items',
                            data,
                            headers: { 'content-type': 'text/plain', accept: 'text/plain' },
                        },
                    ],
                ],
                batchResponseType: value,
                individualResponseType: value,
            });
            mock.onPost('https://sap.example.com/batch').reply(
                200,
                wire(
                    '--response',
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'HTTP/1.1 200 OK',
                    `Content-Type: ${expected}`,
                    '',
                    typeof response === 'string' ? response : JSON.stringify(response),
                    '--response--'
                ),
                { 'content-type': 'multipart/mixed; boundary=response' }
            );

            const result = await batch.send();

            const req = mock.history.post[0];
            expect(sentHeaders(req).Accept).toBe(expected);
            expect(sentHeaders(req)['Content-Type']).toMatch(/^multipart\/mixed; boundary=batch_/);
            expect(req.data).toContain(`Content-Type: ${expected}\r\nAccept: ${expected}\r\n\r\n${serialized}\r\n`);
            expect(result[0].data).toEqual(response);
        }
    );

    test('retrieve propagates parameterized JSON Accept and parses JSON without a response Content-Type', async () => {
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            retrieve: [{ url: '/items', headers: { accept: 'text/plain', 'content-type': 'text/plain' } }],
            individualResponseType: 'APPLICATION/JSON;odata=verbose',
        });
        mock.onPost('https://sap.example.com/batch').reply(
            200,
            wire('--response', 'Content-Type: application/http', '', 'HTTP/1.1 200 OK', '', '{"id":1}', '--response--'),
            { 'content-type': 'multipart/mixed; boundary=response' }
        );

        const result = await batch.send();

        expect(sentHeaders(mock.history.post[0]).Accept).toBe('application/json;odata=verbose');
        expect(mock.history.post[0].data).toContain(
            'GET /items HTTP/1.1\r\nAccept: application/json;odata=verbose\r\n'
        );
        expect(mock.history.post[0].data).not.toContain('text/plain');
        expect(result[0].data).toEqual({ id: 1 });
    });

    test('200 with CRLF multi-changeset body parses embedded errors through the full pipeline', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            calls: [
                [{ method: 'POST', url: '/api/a', data: { id: 1 } }],
                [{ method: 'POST', url: '/api/b', data: { id: 2 } }],
            ],
        });
        const ts = (batch as any)['boundary'] as string;

        const body = wire(
            '--batch_' + ts,
            'Content-Type: multipart/mixed; boundary=changeset_' + ts + '_0',
            '',
            '--changeset_' + ts + '_0',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 201 Created',
            'Content-Type: application/json',
            '',
            '{"id":1}',
            '',
            '--changeset_' + ts + '_0--',
            '--batch_' + ts,
            'Content-Type: multipart/mixed; boundary=changeset_' + ts + '_1',
            '',
            '--changeset_' + ts + '_1',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 400 Bad Request',
            'Content-Type: application/json',
            '',
            '{"error":{"code":"XX","message":"bad"}}',
            '',
            '--changeset_' + ts + '_1--',
            '--batch_' + ts + '--'
        );
        mock.onPost('https://sap.example.com/batch').reply(200, body, {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        const result = await batch.send();

        // Assert - transport said 200, the inner 400 surfaces as success=false
        expect(result).toHaveLength(2);
        expect(result.map((r: any) => [r.code, r.success, r.changesetIndex])).toEqual([
            ['201', true, 0],
            ['400', false, 1],
        ]);
        expect(result[1].data).toEqual({ error: { code: 'XX', message: 'bad' } });
    });

    test('request reaching the transport is the exact CRLF wire format', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            calls: [[{ method: 'DELETE', url: "/Items('1')", data: null }]],
        });
        const ts = (batch as any)['boundary'] as string;
        mock.onPost('https://sap.example.com/batch').reply(200, '--batch_' + ts + '--', {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        await batch.send();

        // Assert
        const req = mock.history.post[0];
        expect(req.url).toBe('https://sap.example.com/batch');
        expect(req.data).toContain('--batch_' + ts + '\r\nContent-Type: multipart/mixed; boundary=changeset_');
        expect(req.data.endsWith('--batch_' + ts + '--')).toBe(true);
        const sent = sentHeaders(req);
        expect(sent['Content-Type']).toBe(`multipart/mixed; boundary=batch_${ts}`);
        expect(sent.Accept).toBe('application/json');
        expect(sent.Authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
    });

    test('batch-level non-2xx rejects the promise (axios validateStatus)', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            calls: [{ method: 'DELETE', url: '/Items', data: null }],
        });
        mock.onPost('https://sap.example.com/batch').reply(400, 'Bad Request');

        // Act & Assert - an HTTP error on the batch itself never reaches the parser
        await expect(batch.send()).rejects.toThrow();
    });
});

describe('ODataBatch send() configuration semantics', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios as any); // adapter types lag axios 1.20 generics; runtime fully compatible
    });

    afterEach(() => {
        mock.restore();
    });

    test('user headers cannot override Accept or Content-Type (fixed values win)', async () => {
        // Arrange - spread order puts ...headers first and the fixed
        // Accept/Content-Type keys after, so they always overwrite
        const batch = new ODataBatch({
            url: 'https://sap.example.com/batch',
            auth: 'user:pass',
            headers: { Accept: 'text/plain', 'Content-Type': 'text/plain', 'X-Custom': 'keep-me' } as any,
            calls: [{ method: 'DELETE', url: '/Items', data: null }],
        });
        const ts = (batch as any)['boundary'] as string;
        mock.onPost('https://sap.example.com/batch').reply(200, '--batch_' + ts + '--', {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        await batch.send();

        // Assert
        const headers = sentHeaders(mock.history.post[0]);
        expect(headers.Accept).toBe('application/json');
        expect(headers['Content-Type']).toBe(`multipart/mixed; boundary=batch_${ts}`);
        expect(headers['X-Custom']).toBe('keep-me'); // unrelated headers survive
    });

    test('empty auth composes as "Basic " (empty credentials, unencoded)', async () => {
        // Arrange - DummyRepo instead of axios: axios 1.x trims trailing
        // whitespace when serializing header values, so the transport would
        // show 'Basic'; what matters here is what ODataBatch itself composes
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            { url: 'https://x/batch', auth: '', calls: [{ method: 'DELETE', url: '/Items', data: null }] },
            repo
        );

        // Act
        await batch.send();

        // Assert - documented as-is
        expect(repo.lastConfig.headers.Authorization).toBe('Basic ');
    });

    test.each([
        ['raw user:pass is base64-encoded per RFC 7617', 'user:pass', Buffer.from('user:pass').toString('base64')],
        ['pre-encoded credentials pass through untouched (no double-encode)', 'dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
        ['colon-less token passes through untouched', 'hunter2', 'hunter2'],
        ['raw credentials with unicode encode from utf8', 'ñoño:pw', Buffer.from('ñoño:pw', 'utf8').toString('base64')],
        ['empty-ish "user:" encodes to its base64 form', 'user:', Buffer.from('user:').toString('base64')],
    ])('Basic auth heuristic: %s', async (_label, auth, expected) => {
        // Arrange
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            { url: 'https://x/batch', auth, calls: [{ method: 'DELETE', url: '/Items', data: null }] },
            repo
        );

        // Act
        await batch.send();

        // Assert - the discriminator is ':': present => raw credentials to
        // encode; absent => pre-encoded or opaque token, byte-identical
        expect(repo.lastConfig.headers.Authorization).toBe(`Basic ${expected}`);
    });

    test('custom repository replaces the axios transport entirely', async () => {
        // Arrange
        const seen: string[] = [];
        const customRepo: ODataBatchRepository = {
            send(url: string, batchRequest: string): Promise<any> {
                seen.push(url, batchRequest);
                return Promise.resolve([]);
            },
        };
        const batch = new ODataBatch(
            { url: 'https://x/batch', auth: 'a:b', calls: [{ method: 'DELETE', url: '/x', data: null }] },
            customRepo
        );

        // Act
        await batch.send();

        // Assert - no HTTP call was attempted; the repository got everything
        expect(seen[0]).toBe('https://x/batch');
        expect(seen[1]).toContain('--batch_');
        expect(mock.history.post).toHaveLength(0);
    });
});

describe('compile-time type surface', () => {
    test('Call and Call[][] shapes are assignable', () => {
        const call: Call = { method: 'DELETE', url: '/x', data: null };
        const withHeaders: Call = { method: 'POST', url: '/x', headers: { 'x-a': 'b' }, data: {} };
        const legacy: Call[] = [call, withHeaders];
        const multi: Call[][] = [[call], [withHeaders]];

        expect(legacy).toHaveLength(2);
        expect(multi).toHaveLength(2);
    });

    test('repository interface is implementable and BatchResponse satisfies the constructor contract', () => {
        const repo: ODataBatchRepository = new ODataBatchAxiosRepository();
        const ctor: BatchResponseConstructor = BatchResponse;

        expect(repo).toBeDefined();
        expect(ctor).toBe(BatchResponse);
        expect(typeof createBatchResponse).toBe('function');
    });
});
