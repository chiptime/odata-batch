import * as requestModule from '../src/request';
import { makeRandomMock } from './helpers';

const requestsToBatch = (...args: any[]): any => (requestModule.requestsToBatch as any)(...args).body;

describe('requestsToBatch()', () => {
    describe('optional MIME Content-ID', () => {
        afterEach(() => jest.restoreAllMocks());

        test.each([false, true])('emits Content-ID outside HTTP headers with multi=%s', (multi) => {
            makeRandomMock(42);
            const calls = [
                { method: 'POST', url: '/Items', data: { name: 'one' }, contentId: '1' },
                { method: 'POST', url: '$1/Lines', data: {}, contentId: 'line-2' },
            ];
            const result = requestsToBatch(multi ? [calls] : calls, 'id', {
                contentType: 'application/json',
                accept: 'application/json',
            });

            expect(result).toContain('Content-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\nPOST /Items HTTP/1.1');
            expect(result).toContain('Content-ID: line-2\r\n\r\nPOST $1/Lines HTTP/1.1');
            expect(result.match(/^Content-ID:/gm)).toHaveLength(2);
        });

        test.each(['0', 'order_1', 'Case.ID-2', 'id+tag.example'])(
            'preserves safe identifier %s verbatim',
            (contentId) => {
                makeRandomMock(42);
                const calls = [{ method: 'POST', url: '/Items', data: {}, contentId }];
                expect(requestsToBatch(calls, 'id', {})).toContain(`Content-ID: ${contentId}\r\n\r\nPOST`);
            }
        );

        test('dependent URLs do not infer an identifier', () => {
            makeRandomMock(42);
            const result = requestsToBatch([{ method: 'POST', url: '$1/Lines', data: {} }], 'id', {});
            expect(result).toContain('POST $1/Lines HTTP/1.1');
            expect(result).not.toContain('Content-ID:');
        });
    });

    describe('produces valid batch envelope', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('single call produces valid batch envelope', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'POST',
                    url: '/api/items',
                    headers: {},
                    data: { id: 1 },
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert
            expect(result).toContain('--batch_1234567890');
            expect(result).toContain('Content-Type: multipart/mixed');
            expect(result).toContain('POST /api/items HTTP/1.1');
            expect(result).toContain('--batch_1234567890--');
            restoreRandom();
        });

        test('Content-Type header is overridden by options', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'POST',
                    url: '/api/items',
                    headers: { 'content-type': 'text/plain' },
                    data: { id: 1 },
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert
            expect(result).toContain('Content-Type: application/json');
            expect(result).not.toContain('Content-Type: text/plain');
            restoreRandom();
        });

        test('no headers emits defaults', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'DELETE',
                    url: '/api/items',
                    headers: undefined,
                    data: null,
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert
            expect(result).toContain('Content-Type: application/json');
            expect(result).toContain('Accept: application/json');
            restoreRandom();
        });

        test('handles XML content type without JSON.stringify', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'POST',
                    url: '/api/items',
                    headers: {},
                    data: '<item><id>1</id></item>',
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/xml',
                accept: 'application/xml',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert
            expect(result).toContain('<item><id>1</id></item>');
            expect(result).not.toContain('"<item><id>1</id></item>"');
            restoreRandom();
        });

        test('uses \\r\\n delimiters for CRLF line endings', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'DELETE',
                    url: '/api/items',
                    headers: {},
                    data: null,
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert
            expect(result).toContain('\r\n');
            expect(result).not.toContain('\n\n');
            restoreRandom();
        });
    });

    describe('multi-changeset support', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        test('Call[] produces same output as before (regression)', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                {
                    method: 'POST',
                    url: '/api/items',
                    headers: {},
                    data: { id: 1 },
                },
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert - legacy format without index suffix
            expect(result).toContain('boundary=changeset_42');
            expect(result).not.toContain('boundary=changeset_42_0');
            expect(result).toContain('--changeset_42\r\n');
            restoreRandom();
        });

        test('Call[][] with 3 changesets produces 3 different boundaries', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                [
                    { method: 'POST', url: '/api/a', headers: {}, data: { id: 1 } },
                    { method: 'POST', url: '/api/a2', headers: {}, data: { id: 2 } },
                ],
                [{ method: 'DELETE', url: '/api/b', headers: {}, data: null }],
                [
                    { method: 'POST', url: '/api/c', headers: {}, data: { id: 3 } },
                    { method: 'DELETE', url: '/api/c2', headers: {}, data: null },
                    { method: 'DELETE', url: '/api/c3', headers: {}, data: null },
                ],
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert - 3 changesets with unique boundaries
            expect(result).toContain('boundary=changeset_42_0');
            expect(result).toContain('boundary=changeset_42_1');
            expect(result).toContain('boundary=changeset_42_2');
            expect(result).toContain('--changeset_42_0\r\n');
            expect(result).toContain('--changeset_42_1\r\n');
            expect(result).toContain('--changeset_42_2\r\n');
            expect(result).toContain('--changeset_42_0--');
            expect(result).toContain('--changeset_42_1--');
            expect(result).toContain('--changeset_42_2--');
            restoreRandom();
        });

        test('[[call1]] (1 changeset, 1 op) produces similar structure to [call1]', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const singleCall = [
                {
                    method: 'POST',
                    url: '/api/items',
                    headers: {},
                    data: { id: 1 },
                },
            ];
            const wrappedCall = [
                [
                    {
                        method: 'POST',
                        url: '/api/items',
                        headers: {},
                        data: { id: 1 },
                    },
                ],
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const legacyResult = requestsToBatch(singleCall, boundary, options);
            const multiResult = requestsToBatch(wrappedCall, boundary, options);

            // Assert - both should contain batch boundary and HTTP request
            expect(legacyResult).toContain('--batch_1234567890');
            expect(multiResult).toContain('--batch_1234567890');
            expect(legacyResult).toContain('POST /api/items HTTP/1.1');
            expect(multiResult).toContain('POST /api/items HTTP/1.1');

            // Multi format has index suffix, legacy does not
            expect(legacyResult).toContain('boundary=changeset_42');
            expect(multiResult).toContain('boundary=changeset_42_0');
            restoreRandom();
        });

        test('multi-changeset wire format has proper section boundaries', () => {
            // Arrange
            const restoreRandom = makeRandomMock(42);
            const calls = [
                [{ method: 'POST', url: '/api/a', headers: {}, data: { id: 1 } }],
                [{ method: 'DELETE', url: '/api/b', headers: {}, data: null }],
            ];
            const boundary = '1234567890';
            const options = {
                contentType: 'application/json',
                accept: 'application/json',
            };

            // Act
            const result = requestsToBatch(calls, boundary, options);

            // Assert - each changeset wrapped with batch boundary
            const sections = result.split('--batch_1234567890');
            // Should have: start, changeset 0, changeset 1, end
            expect(sections.length).toBeGreaterThanOrEqual(3);
            expect(result).toContain('--batch_1234567890\r\nContent-Type: multipart/mixed; boundary=changeset_42_0');
            expect(result).toContain('--batch_1234567890\r\nContent-Type: multipart/mixed; boundary=changeset_42_1');
            restoreRandom();
        });
    });
});
