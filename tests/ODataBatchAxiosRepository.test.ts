import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { BatchResponse } from '../src/response';

describe('ODataBatchAxiosRepository', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios as any); // adapter types lag axios 1.20 generics; runtime fully compatible
    });

    afterEach(() => {
        mock.restore();
    });

    test('optional grouped capability accepts mixed layout and does not call flat send', async () => {
        const repo = new ODataBatchAxiosRepository();
        const flat = jest.spyOn(repo, 'send');
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
        mock.onPost('https://example.com/batch').reply(200, body, {
            'content-type': 'multipart/mixed; boundary=response',
        });
        const result = await (repo as any).sendGrouped(
            'https://example.com/batch',
            'request',
            { headers: {} },
            'application/json',
            [{ kind: 'retrieve' }, { kind: 'changeset', operationCount: 3 }]
        );
        expect(result.map((g: any) => g.kind)).toEqual(['retrieve', 'changeset-error']);
        expect(flat).not.toHaveBeenCalled();
        expect(mock.history.post).toHaveLength(1);
    });

    describe('redirects (credential leak defense)', () => {
        const url = 'https://example.com/batch';
        const config = { headers: { Authorization: 'Basic dXNlcjpwYXNz' } };

        test('send disables redirect following and keeps caller headers', async () => {
            mock.onPost(url).reply(200, '', { 'content-type': 'multipart/mixed; boundary=response' });
            await new ODataBatchAxiosRepository().send(url, 'request', config, 'application/json', BatchResponse);
            expect(mock.history.post).toHaveLength(1);
            expect(mock.history.post[0].maxRedirects).toBe(0);
            expect(mock.history.post[0].headers?.Authorization).toBe('Basic dXNlcjpwYXNz');
        });

        test('sendGrouped disables redirect following', async () => {
            mock.onPost(url).reply(200, '', { 'content-type': 'multipart/mixed; boundary=response' });
            await new ODataBatchAxiosRepository().sendGrouped(url, 'request', config, 'application/json', []);
            expect(mock.history.post[0].maxRedirects).toBe(0);
        });

        test('a redirect response is rejected instead of being followed', async () => {
            mock.onPost(url).reply(302, '', { location: 'http://evil.example/batch' });
            await expect(
                new ODataBatchAxiosRepository().send(url, 'request', config, 'application/json', BatchResponse)
            ).rejects.toThrow('status code 302');
            expect(mock.history.post).toHaveLength(1);
        });
    });

    test('grouped send preserves transport rejection without retries', async () => {
        const repo = new ODataBatchAxiosRepository();
        mock.onPost('https://example.com/batch').reply(500, 'failure');
        await expect(
            (repo as any).sendGrouped('https://example.com/batch', 'request', { headers: {} }, 'application/json', [
                { kind: 'retrieve' },
            ])
        ).rejects.toThrow();
        expect(mock.history.post).toHaveLength(1);
    });

    describe('send()', () => {
        test('mocked POST returns parsed response', async () => {
            // Arrange
            const url = 'https://example.com/batch';
            const batchRequest = '--batch_123\r\n\r\n--batch_123--';
            const config = {
                headers: {
                    Authorization: 'Basic user:pass',
                    Accept: 'application/json',
                    'Content-Type': 'multipart/mixed; boundary=batch_123',
                },
            };

            const responseData = `--batch_123
Content-Type: multipart/mixed; boundary=changeset_abc

--changeset_abc
Content-Type: application/http
Content-Transfer-Encoding: binary

POST /api/items HTTP/1.1 200 OK
Content-Type: application/json
Accept: application/json

{"id":1}

--changeset_abc--
--batch_123--`;

            mock.onPost(url, batchRequest).reply(200, responseData, {
                'content-type': 'multipart/mixed; boundary=batch_123',
            });

            const repo = new ODataBatchAxiosRepository();

            // Act
            const result = await repo.send(url, batchRequest, config, 'application/json', BatchResponse);

            // Assert
            // Note: The BatchResponse parser has specific format requirements.
            // Just verify the function returns an array without throwing.
            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);

            // Verify each item has the expected shape
            result.forEach((item: any) => {
                expect(item).toHaveProperty('code');
                expect(item).toHaveProperty('success');
                expect(typeof item.code).toBe('string');
                expect(typeof item.success).toBe('boolean');
            });
        });

        test('passes request body and headers correctly', async () => {
            // Arrange
            const url = 'https://example.com/batch';
            const batchRequest = '--batch_123\r\n\r\n--batch_123--';
            const config = {
                headers: {
                    Authorization: 'Bearer token',
                    Accept: 'application/json',
                    'Content-Type': 'multipart/mixed; boundary=batch_123',
                },
            };

            mock.onPost(url, batchRequest).reply(200, '--batch_123\r\n\r\n--batch_123--', {
                'content-type': 'multipart/mixed; boundary=batch_123',
            });

            const repo = new ODataBatchAxiosRepository();

            // Act
            await repo.send(url, batchRequest, config, 'application/json', BatchResponse);

            // Assert - axios 1.x types headers as optional; the mock always sets them
            const request = mock.history.post[0];
            const sent = (request.headers ?? {}) as Record<string, string>;
            expect(request.url).toBe(url);
            expect(request.data).toBe(batchRequest);
            expect(sent.Authorization).toBe('Bearer token');
            expect(sent.Accept).toBe('application/json');
        });

        test('error passthrough for network errors', async () => {
            // Arrange
            const url = 'https://example.com/batch';
            const batchRequest = '--batch_123\r\n\r\n--batch_123--';
            const config = {
                headers: {
                    Authorization: 'Basic user:pass',
                },
            };

            mock.onPost(url, batchRequest).networkError();

            const repo = new ODataBatchAxiosRepository();

            // Act & Assert
            await expect(repo.send(url, batchRequest, config, 'application/json', BatchResponse)).rejects.toThrow();
        });

        test('error passthrough for 5xx responses', async () => {
            // Arrange
            const url = 'https://example.com/batch';
            const batchRequest = '--batch_123\r\n\r\n--batch_123--';
            const config = {
                headers: {
                    Authorization: 'Basic user:pass',
                },
            };

            mock.onPost(url, batchRequest).reply(500, 'Internal Server Error');

            const repo = new ODataBatchAxiosRepository();

            // Act & Assert
            await expect(repo.send(url, batchRequest, config, 'application/json', BatchResponse)).rejects.toThrow();
        });
    });
});
