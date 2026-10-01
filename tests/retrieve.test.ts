import { retrieveToBatch, RetrieveCall } from '../src/request';
import { BatchResponse, createBatchResponse } from '../src/response';

/**
 * Read-only batches: retrieveToBatch() emits each GET as a DIRECT batch
 * part (OData V2 retrieve operations must never live inside a changeset),
 * and BatchResponse parses those direct parts back, one per retrieve call.
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

const ACCEPT_JSON = { accept: 'application/json' };

describe('retrieveToBatch() wire format', () => {
    describe('golden wire format (byte-for-byte)', () => {
        test('single retrieve call emits one direct GET part and the terminator', () => {
            // Arrange
            const retrieve: RetrieveCall[] = [{ url: '/api/items' }];

            const expected = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GET /api/items HTTP/1.1',
                'Accept: application/json',
                '',
                '',
                '--batch_884--'
            );

            // Act
            const result = retrieveToBatch(retrieve, '884', ACCEPT_JSON);

            // Assert
            expect(result).toBe(expected);
        });

        test('several retrieve calls emit one direct part each, in input order', () => {
            // Arrange
            const retrieve: RetrieveCall[] = [
                { url: '/api/items' },
                { url: "/api/items('2')", headers: { 'x-api-key': 'abc' } },
                { url: '/api/items/$count' },
            ];

            const expected = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GET /api/items HTTP/1.1',
                'Accept: application/json',
                '',
                '',
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                "GET /api/items('2') HTTP/1.1",
                'Accept: application/json',
                'x-api-key: abc',
                '',
                '',
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GET /api/items/$count HTTP/1.1',
                'Accept: application/json',
                '',
                '',
                '--batch_884--'
            );

            // Act
            const result = retrieveToBatch(retrieve, '884', ACCEPT_JSON);

            // Assert - part order mirrors input order
            expect(result).toBe(expected);
        });

        test('empty RetrieveCall[] still emits the (operation-less) batch terminator', () => {
            // Arrange - documents current behavior: no guard at this layer
            // (ODataBatch.ensureSingleMode is the guard for the public API)
            const expected = wire('--batch_884--');

            // Act
            const result = retrieveToBatch([], '884', ACCEPT_JSON);

            // Assert
            expect(result).toBe(expected);
        });
    });

    describe('no changeset anywhere', () => {
        test('output contains no changeset delimiters or wrappers, only GET request lines', () => {
            // Arrange
            const retrieve: RetrieveCall[] = [
                { url: '/api/a', headers: { 'x-custom': '1' } },
                { url: '/api/b' },
                { url: '/api/c' },
            ];

            // Act
            const result = retrieveToBatch(retrieve, '884', ACCEPT_JSON);

            // Assert
            expect(result).not.toContain('changeset');
            expect(result.endsWith('--batch_884--')).toBe(true);

            // every request line is a GET line
            const requestLines = result.split('\r\n').filter((line) => line.endsWith(' HTTP/1.1'));
            expect(requestLines).toEqual(['GET /api/a HTTP/1.1', 'GET /api/b HTTP/1.1', 'GET /api/c HTTP/1.1']);
            requestLines.forEach((line) => expect(line.startsWith('GET ')).toBe(true));
        });
    });

    describe('headers', () => {
        test('no headers emits only the default Accept line', () => {
            // Act
            const result = retrieveToBatch([{ url: '/api/a' }], '884', ACCEPT_JSON);

            // Assert - one Accept line, no request-level Content-Type (a GET has no body)
            expect(result).toContain('GET /api/a HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n');
            expect(result).not.toContain('Accept: application/xml');
        });

        test('custom headers pass through untouched after the Accept line', () => {
            // Arrange
            const retrieve: RetrieveCall[] = [
                { url: '/api/a', headers: { 'x-csrf-token': 'abc123', 'If-Match': 'W/"42"', 'x-retry-count': 3 } },
            ];

            // Act
            const result = retrieveToBatch(retrieve, '884', ACCEPT_JSON);

            // Assert - passthrough keeps original casing and value formatting
            expect(result).toContain(
                'Accept: application/json\r\nx-csrf-token: abc123\r\nIf-Match: W/"42"\r\nx-retry-count: 3\r\n'
            );
        });

        test('a custom accept header (any casing) is replaced by the batch-level accept', () => {
            // Arrange
            const lower = retrieveToBatch([{ url: '/a', headers: { accept: 'text/plain' } }], '884', ACCEPT_JSON);
            const capitalized = retrieveToBatch([{ url: '/a', headers: { Accept: 'text/plain' } }], '884', ACCEPT_JSON);

            // Assert
            expect(lower).toContain('Accept: application/json');
            expect(lower).not.toContain('text/plain');
            expect(capitalized).toContain('Accept: application/json');
            expect(capitalized).not.toContain('text/plain');
        });

        test('a custom content-type header (any casing) is dropped', () => {
            // Arrange
            const retrieve: RetrieveCall[] = [
                { url: '/a', headers: { 'content-type': 'application/xml', 'Content-Type': 'text/plain' } },
            ];

            // Act
            const result = retrieveToBatch(retrieve, '884', ACCEPT_JSON);

            // Assert - neither custom value reaches the request block; the MIME
            // part header stays application/http
            expect(result).not.toContain('application/xml');
            expect(result).not.toContain('text/plain');
            expect(result).toContain('Content-Type: application/http');
            expect(result).toContain('Accept: application/json\r\n\r\n\r\n');
        });

        test('undefined accept renders as the literal "Accept: undefined" (characterization)', () => {
            // Arrange - Array/template coercion of undefined, exactly like the
            // changeset parseHeaders does for its default lines

            // Act
            const result = retrieveToBatch([{ url: '/a' }], '884', {});

            // Assert
            expect(result).toContain('Accept: undefined');
        });
    });

    describe('security', () => {
        test('CRLF injection: a url containing \\r\\n is REJECTED before reaching the wire', () => {
            // Arrange - a hostile/buggy caller embeds a line break in the url
            const retrieve = [{ url: '/api/a\r\nX-Evil: injected' }] as RetrieveCall[];

            // Act & Assert
            expect(() => retrieveToBatch(retrieve, '884', ACCEPT_JSON)).toThrow(
                'Call url must not contain line breaks'
            );
        });

        test('line breaks in header keys/values are rejected', () => {
            // Arrange & Assert - header value
            expect(() =>
                retrieveToBatch([{ url: '/a', headers: { 'x-a': 'v\r\nX-Evil: 2' } }], '884', ACCEPT_JSON)
            ).toThrow("Call header 'x-a' must not contain line breaks");

            // header key
            expect(() => retrieveToBatch([{ url: '/a', headers: { 'x-a\r\n': 'v' } }], '884', ACCEPT_JSON)).toThrow(
                'must not contain line breaks'
            );
        });

        test('GET-only guard: a method own property is rejected', () => {
            // Arrange - a Call accidentally passed where a RetrieveCall is expected
            const smuggled = [{ url: '/a', method: 'POST' } as RetrieveCall];

            // Act & Assert
            expect(() => retrieveToBatch(smuggled, '884', ACCEPT_JSON)).toThrow(
                'retrieve calls are GET-only: method and data are not allowed'
            );
        });

        test('GET-only guard: a data own property is rejected', () => {
            // Arrange
            const smuggled = [{ url: '/a', data: { id: 1 } } as RetrieveCall];

            // Act & Assert
            expect(() => retrieveToBatch(smuggled, '884', ACCEPT_JSON)).toThrow(
                'retrieve calls are GET-only: method and data are not allowed'
            );
        });

        test('GET-only guard checks OWN properties only: inherited method is ignored', () => {
            // Arrange - method lives on the prototype, not the entry itself
            const entry = Object.create({ method: 'POST' }) as RetrieveCall;
            entry.url = '/a';

            // Act & Assert
            expect(() => retrieveToBatch([entry], '884', ACCEPT_JSON)).not.toThrow();
        });
    });
});

describe('BatchResponse parses retrieve responses (direct parts)', () => {
    test('200 + 404 mixed: code, status, success, JSON data and per-part ordering', () => {
        // Arrange - a typical read-only batch answer: one hit, one miss
        const body = wire(
            '--batch_884',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"id":1,"name":"alpha"}',
            '',
            '--batch_884',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 404 Not Found',
            'Content-Type: application/json',
            '',
            '{"error":"missing"}',
            '',
            '--batch_884--'
        );

        // Act
        const parsed = createBatchResponse(
            BatchResponse,
            { data: body, headers: { 'content-type': 'multipart/mixed; boundary=batch_884' } },
            'application/json'
        );

        // Assert - responses come back in part order, one per retrieve call
        expect(parsed.response).toHaveLength(2);
        expect(parsed.response.map((r) => [r.code, r.status, r.success])).toEqual([
            ['200', 'OK', true],
            ['404', 'Not Found', false],
        ]);
        expect(parsed.response[0].data).toEqual({ id: 1, name: 'alpha' });
        expect(parsed.response[1].data).toEqual({ error: 'missing' });
    });

    test('round-trip: a mirrored response to retrieveToBatch output parses one part per entry, in order', () => {
        // Arrange - build the request, then mirror one direct response part
        // per retrieve entry, each tagged with its position
        const urls = ['/api/a', '/api/b', '/api/c'];
        const request = retrieveToBatch(
            urls.map((url) => ({ url }) as RetrieveCall),
            '884',
            ACCEPT_JSON
        );

        const sentUrls = request
            .split('\r\n')
            .filter((line) => line.endsWith(' HTTP/1.1'))
            .map((line) => line.slice('GET '.length, -' HTTP/1.1'.length));
        expect(sentUrls).toEqual(urls);

        const body = wire(
            ...urls.flatMap((_url, i) => [
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                `{"i":${i}}`,
                '',
            ]),
            '--batch_884--'
        );

        // Act
        const parsed = createBatchResponse(
            BatchResponse,
            { data: body, headers: { 'content-type': 'multipart/mixed; boundary=batch_884' } },
            'application/json'
        );

        // Assert - part order maps 1:1 onto retrieve input order
        expect(parsed.response).toHaveLength(3);
        expect(parsed.response.map((r) => r.data.i)).toEqual([0, 1, 2]);
        expect(parsed.response.every((r) => r.success)).toBe(true);
    });
});
