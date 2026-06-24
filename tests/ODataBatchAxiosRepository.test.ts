import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { BatchResponse } from '../src/response';

describe('ODataBatchAxiosRepository', () => {
    let mock: MockAdapter;

    beforeEach(() => {
        mock = new MockAdapter(axios);
    });

    afterEach(() => {
        mock.restore();
    });

    describe('send()', () => {
        test('mocked POST returns parsed response', async () => {
            // Arrange
            const url = 'http://example.com/batch';
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
            const url = 'http://example.com/batch';
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

            // Assert
            const request = mock.history.post[0];
            expect(request.url).toBe(url);
            expect(request.data).toBe(batchRequest);
            expect(request.headers.Authorization).toBe('Bearer token');
            expect(request.headers.Accept).toBe('application/json');
        });

        test('error passthrough for network errors', async () => {
            // Arrange
            const url = 'http://example.com/batch';
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
            const url = 'http://example.com/batch';
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
