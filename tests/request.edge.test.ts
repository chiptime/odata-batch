import { requestsToBatch, Call } from '../src/request';
import { makeRandomMock } from './helpers';

/**
 * Edge-case coverage for requestsToBatch():
 * - legacy vs multi-changeset wire format, asserted byte-for-byte
 * - header override and passthrough branches in parseHeaders
 * - empty arrays and null/undefined inputs (characterization)
 * - XML payloads on both code paths
 */

const JSON_OPTS = { contentType: 'application/json', accept: 'application/json' };
const XML_OPTS = { contentType: 'application/xml', accept: 'application/xml' };

const join = (lines: string[]): string => lines.join('\r\n');

describe('requestsToBatch() edge cases', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('legacy path is bit-identical (golden wire format)', () => {
        test('Call[] with two operations produces the exact v1.2.0 byte sequence', () => {
            // Arrange
            makeRandomMock(42); // changeSetNum = 42
            const calls: Call[] = [
                { method: 'POST', url: '/api/a', headers: undefined, data: { id: 1 } },
                { method: 'GET', url: '/api/b', headers: undefined, data: null },
            ];

            const expected = join([
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42',
                '',
                '--changeset_42',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'POST /api/a HTTP/1.1',
                'Content-Type: application/json',
                'Accept: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_42',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GET /api/b HTTP/1.1',
                'Content-Type: application/json',
                'Accept: application/json',
                '',
                'null',
                '',
                '--changeset_42--',
                '--batch_884--',
            ]);

            // Act
            const result = requestsToBatch(calls, '884', JSON_OPTS);

            // Assert - byte-for-byte equality, no _0 suffix on the changeset boundary
            expect(result).toBe(expected);
        });

        test('empty Call[] still emits a valid (operation-less) legacy envelope', () => {
            // Arrange
            makeRandomMock(42);
            const expected = join([
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42',
                '',
                '--changeset_42--',
                '--batch_884--',
            ]);

            // Act
            const result = requestsToBatch([] as Call[], '884', JSON_OPTS);

            // Assert - documents current behavior: no guard at this layer
            // (ODataBatch.ensureHasCalls is the guard for the public API)
            expect(result).toBe(expected);
        });
    });

    describe('multi-changeset path is bit-identical (golden wire format)', () => {
        test('Call[][] with two changesets produces the exact v1.3.0 byte sequence', () => {
            // Arrange
            makeRandomMock(42); // changeSetNum = 42
            const calls: Call[][] = [
                [{ method: 'POST', url: '/api/a', headers: undefined, data: { id: 1 } }],
                [{ method: 'GET', url: '/api/b', headers: undefined, data: null }],
            ];

            const expected = join([
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42_0',
                '',
                '--changeset_42_0',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'POST /api/a HTTP/1.1',
                'Content-Type: application/json',
                'Accept: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_42_0--',
                '',
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42_1',
                '',
                '--changeset_42_1',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GET /api/b HTTP/1.1',
                'Content-Type: application/json',
                'Accept: application/json',
                '',
                'null',
                '',
                '--changeset_42_1--',
                '',
                '--batch_884--',
            ]);

            // Act
            const result = requestsToBatch(calls, '884', JSON_OPTS);

            // Assert - byte-for-byte equality, indexed boundaries _0/_1
            expect(result).toBe(expected);
        });

        test('multi path keeps XML payloads raw (no JSON.stringify)', () => {
            // Arrange
            makeRandomMock(42);
            const calls: Call[][] = [[{ method: 'POST', url: '/api/x', headers: undefined, data: '<item/>' }]];

            // Act
            const result = requestsToBatch(calls, '884', XML_OPTS);

            // Assert
            expect(result).toContain('\r\n<item/>\r\n');
            expect(result).not.toContain('"<item/>"');
        });

        test('multi path with an empty sub-array emits an operation-less changeset section', () => {
            // Arrange
            makeRandomMock(42);
            const expected = join([
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42_0',
                '',
                '--changeset_42_0--',
                '',
                '--batch_884--',
            ]);

            // Act
            const result = requestsToBatch([[]] as Call[][], '884', JSON_OPTS);

            // Assert - documents current behavior (ODataBatch rejects this shape earlier)
            expect(result).toBe(expected);
        });
    });

    describe('parseHeaders branches', () => {
        test('lowercase accept header is overridden by options accept', () => {
            // Arrange
            makeRandomMock(42);
            const calls: Call[] = [{ method: 'GET', url: '/api/a', headers: { accept: 'text/plain' }, data: null }];

            // Act
            const result = requestsToBatch(calls, '884', JSON_OPTS);

            // Assert
            expect(result).toContain('Accept: application/json');
            expect(result).not.toContain('text/plain');
        });

        test('capitalized Content-Type header is also overridden (case-insensitive match)', () => {
            // Arrange
            makeRandomMock(42);
            const calls: Call[] = [
                { method: 'GET', url: '/api/a', headers: { 'Content-Type': 'text/plain' }, data: null },
            ];

            // Act
            const result = requestsToBatch(calls, '884', JSON_OPTS);

            // Assert
            expect(result).toContain('Content-Type: application/json');
            expect(result).not.toContain('text/plain');
        });

        test('custom headers pass through untouched', () => {
            // Arrange
            makeRandomMock(42);
            const calls: Call[] = [
                {
                    method: 'POST',
                    url: '/api/a',
                    headers: { 'x-csrf-token': 'abc123', 'If-Match': 'W/"42"' },
                    data: { id: 1 },
                },
            ];

            // Act
            const result = requestsToBatch(calls, '884', JSON_OPTS);

            // Assert - passthrough keeps original casing and value formatting.
            // Providing headers REPLACES the defaults entirely: no implicit
            // Content-Type/Accept lines are added when headers are present.
            expect(result).toContain('x-csrf-token: abc123');
            expect(result).toContain('If-Match: W/"42"');
            expect(result).not.toContain('Accept: application/json');
        });

        test('undefined contentType/accept fall back to the provided header values', () => {
            // Arrange
            makeRandomMock(42);
            const calls: Call[] = [
                {
                    method: 'POST',
                    url: '/api/a',
                    headers: { 'Content-Type': 'text/xml', Accept: 'text/xml' },
                    data: '<x/>',
                },
            ];

            // Act
            const result = requestsToBatch(calls, '884', {
                contentType: undefined,
                accept: undefined,
            } as any);

            // Assert - no override applied, header kept as-is, body still JSON.stringify-ed
            expect(result).toContain('Content-Type: text/xml');
            expect(result).toContain('Accept: text/xml');
            expect(result).toContain('"<x/>"');
        });
    });

    describe('malformed inputs (characterization of current behavior)', () => {
        test('null input throws TypeError', () => {
            expect(() => requestsToBatch(null as any, '884', JSON_OPTS)).toThrow(TypeError);
        });

        test('undefined input throws TypeError', () => {
            expect(() => requestsToBatch(undefined as any, '884', JSON_OPTS)).toThrow(TypeError);
        });

        test('Call[] whose first entry is undefined throws TypeError on the legacy path', () => {
            // data[0] is undefined -> Array.isArray fails -> legacy path -> calls.map dereferences it
            expect(() => requestsToBatch([undefined] as any, '884', JSON_OPTS)).toThrow(TypeError);
        });

        test('Call[] whose first entry is null throws TypeError on the legacy path', () => {
            expect(() => requestsToBatch([null] as any, '884', JSON_OPTS)).toThrow(TypeError);
        });
    });
});
