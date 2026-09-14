import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { ODataBatchRepository } from '../src/BatchRepository';
import { BatchResponse, BatchResponseConstructor, createBatchResponse, Call } from '../src/response';
import '../src/index';

/**
 * End-to-end tests: the full ODataBatch.send() pipeline over a mocked HTTP
 * transport (axios-mock-adapter), plus send() configuration semantics and
 * compile-time type-surface assertions.
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

describe('ODataBatch.send() end-to-end (mocked axios transport)', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        mock.restore();
    });

    test('200 with CRLF multi-changeset body parses embedded errors through the full pipeline', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'http://sap.example.com/batch',
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
        mock.onPost('http://sap.example.com/batch').reply(200, body, {
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
            url: 'http://sap.example.com/batch',
            auth: 'user:pass',
            calls: [[{ method: 'GET', url: "/Items('1')", data: null }]],
        });
        const ts = (batch as any)['boundary'] as string;
        mock.onPost('http://sap.example.com/batch').reply(200, '--batch_' + ts + '--', {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        await batch.send();

        // Assert
        const req = mock.history.post[0];
        expect(req.url).toBe('http://sap.example.com/batch');
        expect(req.data).toContain('--batch_' + ts + '\r\nContent-Type: multipart/mixed; boundary=changeset_');
        expect(req.data.endsWith('--batch_' + ts + '--')).toBe(true);
        expect(req.headers['Content-Type']).toBe(`multipart/mixed; boundary=batch_${ts}`);
        expect(req.headers.Accept).toBe('application/json');
        expect(req.headers.Authorization).toBe('Basic user:pass'); // raw, NOT base64-encoded
    });

    test('batch-level non-2xx rejects the promise (axios validateStatus)', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'http://sap.example.com/batch',
            auth: 'user:pass',
            calls: [{ method: 'GET', url: '/Items', data: null }],
        });
        mock.onPost('http://sap.example.com/batch').reply(400, 'Bad Request');

        // Act & Assert - an HTTP error on the batch itself never reaches the parser
        await expect(batch.send()).rejects.toThrow();
    });
});

describe('ODataBatch send() configuration semantics', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        mock.restore();
    });

    test('user headers cannot override Accept or Content-Type (fixed values win)', async () => {
        // Arrange - spread order puts ...headers first and the fixed
        // Accept/Content-Type keys after, so they always overwrite
        const batch = new ODataBatch({
            url: 'http://sap.example.com/batch',
            auth: 'user:pass',
            headers: { Accept: 'text/plain', 'Content-Type': 'text/plain', 'X-Custom': 'keep-me' } as any,
            calls: [{ method: 'GET', url: '/Items', data: null }],
        });
        const ts = (batch as any)['boundary'] as string;
        mock.onPost('http://sap.example.com/batch').reply(200, '--batch_' + ts + '--', {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        await batch.send();

        // Assert
        const headers = mock.history.post[0].headers;
        expect(headers.Accept).toBe('application/json');
        expect(headers['Content-Type']).toBe(`multipart/mixed; boundary=batch_${ts}`);
        expect(headers['X-Custom']).toBe('keep-me'); // unrelated headers survive
    });

    test('empty auth composes as "Basic " (empty credentials, unencoded)', async () => {
        // Arrange
        const batch = new ODataBatch({
            url: 'http://sap.example.com/batch',
            auth: '',
            calls: [{ method: 'GET', url: '/Items', data: null }],
        });
        const ts = (batch as any)['boundary'] as string;
        mock.onPost('http://sap.example.com/batch').reply(200, '--batch_' + ts + '--', {
            'content-type': `multipart/mixed; boundary=batch_${ts}`,
        });

        // Act
        await batch.send();

        // Assert - documented as-is
        expect(mock.history.post[0].headers.Authorization).toBe('Basic ');
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
            { url: 'http://x/batch', auth: 'a:b', calls: [{ method: 'GET', url: '/x', data: null }] },
            customRepo
        );

        // Act
        await batch.send();

        // Assert - no HTTP call was attempted; the repository got everything
        expect(seen[0]).toBe('http://x/batch');
        expect(seen[1]).toContain('--batch_');
        expect(mock.history.post).toHaveLength(0);
    });
});

describe('compile-time type surface', () => {
    test('Call and Call[][] shapes are assignable', () => {
        const call: Call = { method: 'GET', url: '/x', data: null };
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
