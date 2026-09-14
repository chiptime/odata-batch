import { ODataBatch, createBatchResponse } from '../src/index';
import { BatchResponse } from '../src/response';
import { DummyBatchRepo } from './helpers';

/**
 * Public API surface: the package entrypoint must re-export the runtime API,
 * and ODataBatch must map its response-type options onto content types.
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

describe('public API surface (src/index)', () => {
    test('exports ODataBatch and createBatchResponse as runtime values', () => {
        expect(ODataBatch).toBeDefined();
        expect(typeof ODataBatch).toBe('function');
        expect(createBatchResponse).toBeDefined();
        expect(typeof createBatchResponse).toBe('function');
    });

    test('createBatchResponse builds a BatchResponse through the factory', () => {
        // Arrange
        const data = wire(
            '--batch_1',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            '',
            '{"ok":true}',
            '',
            '--batch_1--'
        );

        // Act
        const parsed = createBatchResponse(
            BatchResponse,
            { data, headers: { 'content-type': 'multipart/mixed; boundary=batch_1' } },
            'application/json'
        );

        // Assert
        expect(parsed.response).toHaveLength(1);
        expect(parsed.response[0].data).toEqual({ ok: true });
    });

    test('ODataBatch works end-to-end through the entrypoint export', async () => {
        // Arrange
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [[{ method: 'POST', url: '/api/a', data: { id: 1 } }]],
            },
            repo
        );

        // Act
        const result = await batch.send();

        // Assert
        expect(repo.lastRequest).toContain('boundary=changeset_');
        expect(result).toEqual([{ code: '200', status: 'OK', headers: [], data: {}, success: true }]);
    });
});

describe('ODataBatch response-type mapping', () => {
    test('defaults map BOTH response types to application/json and reach the wire', async () => {
        // Arrange - pins the default 'json' parameter value and the ternary
        // true-branch end to end
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
            },
            repo
        );

        // Act
        await batch.send();

        // Assert - type mapping
        expect(batch['requestResponseType']).toEqual({
            contentType: 'application/json',
            accept: 'application/json',
        });
        // Assert - per-call default headers on the wire
        expect(repo.lastRequest).toContain('\r\nContent-Type: application/json\r\nAccept: application/json\r\n');
        expect(repo.lastConfig.headers.Accept).toBe('application/json');
    });

    test("explicit 'json' values map exactly like the defaults", () => {
        // Arrange
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
                batchResponseType: 'json',
                individualResponseType: 'json',
            },
            new DummyBatchRepo()
        );

        // Act & Assert
        expect(batch['requestResponseType']).toEqual({
            contentType: 'application/json',
            accept: 'application/json',
        });
    });

    test('legacy call objects exposing a length property are not mistaken for changeset sub-arrays', () => {
        // Arrange - Array.isArray discriminates, not duck-typing on .length
        const batch = new ODataBatch({
            url: 'http://example.com/batch',
            auth: 'user:pass',
            calls: [{ method: 'GET', url: '/items', data: null, length: 0 } as any],
        });

        // Act & Assert
        expect(batch).toBeInstanceOf(ODataBatch);
    });
    test("batchResponseType 'xml' maps contentType to application/xml", () => {
        // Arrange
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
                batchResponseType: 'xml',
            },
            new DummyBatchRepo()
        );

        // Act & Assert
        expect(batch['requestResponseType']).toEqual({
            contentType: 'application/xml',
            accept: 'application/json',
        });
    });

    test("individualResponseType 'xml' maps accept to application/xml and propagates to send()", async () => {
        // Arrange
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
                individualResponseType: 'xml',
            },
            repo
        );

        // Act
        await batch.send();

        // Assert
        expect(batch['requestResponseType'].accept).toBe('application/xml');
        expect(repo.lastConfig.headers.Accept).toBe('application/xml');
    });

    test('both response types xml keeps raw payloads on the wire', () => {
        // Arrange
        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'POST', url: '/items', data: '<item/>' }],
                batchResponseType: 'xml',
                individualResponseType: 'xml',
            },
            repo
        );

        // Act
        batch.send();

        // Assert - XML payload is not JSON.stringify-ed
        expect(repo.lastRequest).toContain('\r\n<item/>\r\n');
    });
});
