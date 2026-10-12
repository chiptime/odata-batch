import { BatchResponse } from '../src/response';
import { requestsToBatch, Call } from '../src/request';
import { makeRandomMock } from './helpers';

/**
 * Protocol-level tests for BatchResponse against real OData V2 wire format.
 *
 * Fixtures use CRLF line endings; LF-only and mixed bodies are normalized
 * to CRLF by the parser before splitting (documented in a dedicated test).
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

const BATCH_HEADERS = { 'content-type': 'multipart/mixed; boundary=batch_884' };

const directPartLines = (statusLine: string, headers: string[], body: string): string[] => [
    '--batch_884',
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    '',
    statusLine,
    ...headers,
    '',
    body,
    '',
];

const directPart = (statusLine: string, headers: string[], body: string): string[] => [
    ...directPartLines(statusLine, headers, body),
    '--batch_884--',
];

const parse = (data: string, accept = 'application/json'): BatchResponse =>
    new BatchResponse({ data, headers: BATCH_HEADERS }, accept);

const parseWithBoundary = (boundary: string, data: string, accept = 'application/json'): BatchResponse =>
    new BatchResponse({ data, headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } }, accept);

describe('BatchResponse wire-format parsing', () => {
    test.each([false, true])(
        'extracts each MIME Content-ID without leaking into HTTP headers with nested=%s',
        (nested) => {
            const delimiter = nested ? 'changeset_ids' : 'batch_884';
            const body = wire(
                ...(nested ? ['--batch_884', `Content-Type: multipart/mixed; boundary=${delimiter}`, ''] : []),
                `--${delimiter}`,
                'Content-Type: application/http',
                'Content-ID: 1',
                '',
                'HTTP/1.1 201 Created',
                'Location: /Items(1)',
                '',
                '{"id":1}',
                `--${delimiter}`,
                'Content-Type: application/http',
                'Content-ID: child-2',
                '',
                'HTTP/1.1 400 Bad Request',
                '',
                '{"error":"bad"}',
                `--${delimiter}--`,
                ...(nested ? ['--batch_884--'] : [])
            );
            const result = parse(body).response;
            expect(result.map((r) => (r as any).contentId)).toEqual(['1', 'child-2']);
            expect(result.map((r) => r.success)).toEqual([true, false]);
            expect(result[0].headers).toEqual([{ key: 'Location', value: '/Items(1)' }]);
            expect(result[1].headers).toEqual([]);
        }
    );

    describe('direct application/http parts (no changeset wrapper)', () => {
        test('parses code, status, headers, JSON data and success', () => {
            // Arrange
            const body = wire(
                ...directPart(
                    'HTTP/1.1 200 OK',
                    ['Content-Type: application/json', 'Content-Length: 21'],
                    '{"id":1,"name":"alpha"}'
                )
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({
                code: '200',
                status: 'OK',
                success: true,
                changesetIndex: 0,
            });
            expect(response.response[0].data).toEqual({ id: 1, name: 'alpha' });
            expect(response.response[0].headers).toEqual([
                { key: 'Content-Type', value: 'application/json' },
                { key: 'Content-Length', value: '21' },
            ]);
        });

        test('status line is excluded from parsed headers', () => {
            // Arrange
            const body = wire(...directPart('HTTP/1.1 204 No Content', ['X-SAP-Message: deleted'], ''));

            // Act
            const response = parse(body, 'application/xml');

            // Assert
            expect(response.response[0].code).toBe('204');
            expect(response.response[0].headers).toEqual([{ key: 'X-SAP-Message', value: 'deleted' }]);
        });
    });

    describe('changeset parts', () => {
        test('single legacy changeset with two operations assigns changesetIndex 0 to both', () => {
            // Arrange
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_77',
                '',
                '--changeset_77',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_77',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 201 Created',
                'Content-Type: application/json',
                '',
                '{"id":2}',
                '',
                '--changeset_77--',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(2);
            expect(response.response.map((r) => r.code)).toEqual(['200', '201']);
            expect(response.response.every((r) => r.changesetIndex === 0)).toBe(true);
        });

        test('multi-changeset round-trip: boundaries mirrored from requestsToBatch parse back with correct indices', () => {
            // Arrange - build the request, then mirror its changeset boundaries in a response
            makeRandomMock(42); // changeset boundaries become changeset_42_0 / changeset_42_1
            const calls: Call[][] = [
                [{ method: 'POST', url: '/api/a', headers: undefined, data: { id: 1 } }],
                [{ method: 'POST', url: '/api/b', headers: undefined, data: { id: 2 } }],
            ];
            const request = requestsToBatch(calls, '884', {
                contentType: 'application/json',
                accept: 'application/json',
            }).body;

            const boundaries = Array.from(request.matchAll(/boundary=(changeset_42_\d)/g)).map((m) => m[1]);
            expect(boundaries).toEqual(['changeset_42_0', 'changeset_42_1']);

            const respond = (boundary: string, code: string, payload: string): string[] => [
                '--batch_884',
                `Content-Type: multipart/mixed; boundary=${boundary}`,
                '',
                `--${boundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                `HTTP/1.1 ${code}`,
                'Content-Type: application/json',
                '',
                payload,
                '',
                `--${boundary}--`,
            ];

            const body = wire(
                ...respond(boundaries[0], '201 Created', '{"id":1}'),
                ...respond(boundaries[1], '409 Conflict', '{"error":"dup"}'),
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(2);
            expect(response.response.map((r) => [r.code, r.changesetIndex])).toEqual([
                ['201', 0],
                ['409', 1],
            ]);
            expect(response.response[1].success).toBe(false);
        });
    });

    describe('batch 200 with embedded HTTP errors', () => {
        test('inner 4xx and 5xx responses set success=false without breaking siblings', () => {
            // Arrange - transport-level 200; three inner responses: 201, 400, 500
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42_0',
                '',
                '--changeset_42_0',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 201 Created',
                'Content-Type: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_42_0',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 400 Bad Request',
                'Content-Type: application/json',
                '',
                '{"error":"bad"}',
                '',
                '--changeset_42_0--',
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42_1',
                '',
                '--changeset_42_1',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 500 Internal Server Error',
                'Content-Type: application/json',
                '',
                '{"error":"boom"}',
                '',
                '--changeset_42_1--',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(3);
            expect(response.response.map((r) => [r.code, r.status, r.success, r.changesetIndex])).toEqual([
                ['201', 'Created', true, 0],
                ['400', 'Bad Request', false, 0],
                ['500', 'Internal Server Error', false, 1],
            ]);
            expect(response.response[0].data).toEqual({ id: 1 });
            expect(response.response[1].data).toEqual({ error: 'bad' });
        });
    });

    describe('malformed and partial responses', () => {
        test('junk parts are skipped and valid parts still parse (partial response)', () => {
            // Arrange
            const body = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                '',
                '{"id":1}',
                '',
                '--batch_884',
                'this part is not MIME and must be filtered',
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                '',
                '{"id":2}',
                '',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(2);
            expect(response.response.map((r) => r.data.id)).toEqual([1, 2]);
        });

        test('changeset declaring a boundary but containing no delimiters contributes nothing', () => {
            // Arrange - empty changeset: boundary= header present, zero --boundary occurrences
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_ghost',
                '',
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                '',
                '{"id":1}',
                '',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ id: 1 });
        });

        test('part with content-type but no response block yields resilient malformed part without TypeError', () => {
            // Arrange - truncated part: passes the content-type filter, but has no
            // \r\n\r\n-separated response block, so responseParts[1] is undefined
            const body = wire('--batch_884', 'Content-Type: application/http', '--batch_884--');

            // Act & Assert - resilient handling per FR-05
            const response = parse(body);
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toEqual({
                code: '',
                status: '',
                headers: [],
                data: 'Content-Type: application/http',
                success: false,
                changesetIndex: 0,
            });
        });

        test('response block without an HTTP status line yields empty code/status and success=false', () => {
            // Arrange - first line of the response block is not 'HTTP/1.1 ### ...';
            // also covers the malformed-header branch that returns {key:"",value:""}
            const body = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'GARBAGE FIRST LINE',
                'X-Header: v',
                '',
                'BODY',
                '',
                '--batch_884--'
            );

            // Act
            const response = parse(body, 'application/xml');

            // Assert - no matchable status -> code '' -> cannot be confirmed
            // successful (B8)
            expect(response.response[0].code).toBe('');
            expect(response.response[0].status).toBe('');
            expect(response.response[0].success).toBe(false);
            expect(response.response[0].headers).toEqual([
                { key: '', value: '' }, // 'GARBAGE FIRST LINE' has no colon
                { key: 'X-Header', value: 'v' },
            ]);
            expect(response.response[0].data).toBe('BODY');
        });

        test('empty batch body returns an empty response array', () => {
            // Act
            const response = parse('');

            // Assert
            expect(response.response).toEqual([]);
        });
    });

    describe('non-JSON payloads', () => {
        test('accept application/xml returns the raw body string', () => {
            // Arrange
            const body = wire(
                ...directPart('HTTP/1.1 200 OK', ['Content-Type: application/xml'], '<entry><id>1</id></entry>')
            );

            // Act
            const response = parse(body, 'application/xml');

            // Assert
            expect(response.response[0].data).toBe('<entry><id>1</id></entry>');
        });

        test('accept application/json with an unparseable body yields the raw payload string', () => {
            // Arrange - server ignored the Accept header and sent plain text
            const body = wire(...directPart('HTTP/1.1 200 OK', [], 'not-json-at-all'));

            // Act - one bad part must never throw and lose the batch
            const response = parse(body, 'application/json');

            // Assert - the payload is surfaced verbatim instead of throwing
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toBe('not-json-at-all');
        });

        test('one unparseable JSON part does not destroy its siblings', () => {
            // Arrange - three parts: valid JSON, plain text, valid JSON
            const body = wire(
                ...directPartLines('HTTP/1.1 200 OK', [], '{"id":1}'),
                ...directPartLines('HTTP/1.1 200 OK', ['Content-Type: text/plain'], 'oops not json'),
                ...directPart('HTTP/1.1 200 OK', [], '{"id":3}')
            );

            // Act
            const response = parse(body, 'application/json');

            // Assert - every part survives; the bad one carries its raw body
            expect(response.response).toHaveLength(3);
            expect(response.response.map((r) => r.data)).toEqual([{ id: 1 }, 'oops not json', { id: 3 }]);
        });

        test('accept application/xml with an empty body returns empty string', () => {
            // Arrange - 204-style part with an empty data block
            const body = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 204 No Content',
                '',
                '',
                '',
                '--batch_884--'
            );

            // Act
            const response = parse(body, 'application/xml');

            // Assert
            expect(response.response[0].code).toBe('204');
            expect(response.response[0].data).toBe('');
        });
    });

    describe('204 No Content and empty payloads (JSON accept)', () => {
        test('204 part inside a changeset yields data null instead of throwing', () => {
            // Arrange - SAP-style 204 inside a changeset: status line, blank
            // line, nothing else before the closing delimiter
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42',
                '',
                '--changeset_42',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 204 No Content',
                '',
                '',
                '--changeset_42--',
                '--batch_884--'
            );

            // Act
            const response = parse(body, 'application/json');

            // Assert - an empty 204 body carries no JSON document: null, no throw
            expect(response.response).toHaveLength(1);
            expect(response.response[0].code).toBe('204');
            expect(response.response[0].data).toBeNull();
        });

        test('204 part ending right after the status line has no payload segment at all', () => {
            // Arrange - no blank line before the closing delimiter: after the
            // \r\n\r\n split the part has only 2 segments, so the payload
            // segment is undefined
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42',
                '',
                '--changeset_42',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 204 No Content',
                '--changeset_42--',
                '--batch_884--'
            );

            // Act
            const response = parse(body, 'application/json');

            // Assert - the missing payload segment is treated as empty => null
            expect(response.response).toHaveLength(1);
            expect(response.response[0].code).toBe('204');
            expect(response.response[0].data).toBeNull();
        });

        test('direct 204 part with an empty payload yields data null', () => {
            // Arrange - same shape as the xml-empty test, but with JSON accept
            const body = wire(...directPart('HTTP/1.1 204 No Content', [], ''));

            // Act
            const response = parse(body, 'application/json');

            // Assert
            expect(response.response[0].code).toBe('204');
            expect(response.response[0].data).toBeNull();
        });

        test('whitespace-only payload with JSON accept yields data null', () => {
            // Arrange - payload is spaces only: no JSON document either
            const body = wire(...directPart('HTTP/1.1 204 No Content', [], '   '));

            // Act
            const response = parse(body, 'application/json');

            // Assert
            expect(response.response[0].data).toBeNull();
        });
    });

    describe('CRLF vs LF line endings', () => {
        test('LF-only body parses after line-ending normalization', () => {
            // Arrange - same shape as a valid fixture but joined with bare '\n'
            const body = [
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"id":1}',
                '',
                '--batch_884--',
            ].join('\n');

            // Act
            const response = parse(body);

            // Assert - LF-only bodies are normalized to CRLF before parsing
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '200', status: 'OK', success: true });
            expect(response.response[0].data).toEqual({ id: 1 });
        });

        test('body mixing CRLF and LF line endings parses', () => {
            // Arrange - each line break is a different mix of endings
            const body = [
                '--batch_884\n',
                'Content-Type: application/http\r\n',
                'Content-Transfer-Encoding: binary\n',
                '\r\n',
                'HTTP/1.1 200 OK\n',
                'Content-Type: application/json\r\n',
                '\n',
                '{"id":1}\n',
                '\r\n',
                '--batch_884--',
            ].join('');

            // Act
            const response = parse(body);

            // Assert - mixed endings are normalized to CRLF before parsing
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '200', status: 'OK', success: true });
            expect(response.response[0].data).toEqual({ id: 1 });
        });
    });

    describe('parser robustness (mutation-hardening)', () => {
        test('body mentioning the batch boundary substring does not split the part', () => {
            // Arrange - the split must anchor on '--<boundary>', never on the
            // bare boundary token, or payloads echoing it would fragment
            const body = wire(
                '--batch_884',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"note":"mentions batch_884 inside"}',
                '',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ note: 'mentions batch_884 inside' });
        });

        test('changeset boundary match is case-insensitive (declared vs used case mismatch)', () => {
            // Arrange - declared boundary differs in case from the delimiters;
            // the changeset-body regex matches without case sensitivity
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=Changeset_42',
                '',
                '--changeset_42',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_42--',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ id: 1 });
        });

        test('blank line after the opening changeset delimiter still parses', () => {
            // Arrange - some servers emit an empty line between the changeset
            // delimiter and the first part; the split must consume only the
            // delimiter's CRLF so the part keeps exactly one leading blank
            const body = wire(
                '--batch_884',
                'Content-Type: multipart/mixed; boundary=changeset_42',
                '',
                '--changeset_42',
                '',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"id":1}',
                '',
                '--changeset_42--',
                '--batch_884--'
            );

            // Act
            const response = parse(body);

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '200', status: 'OK', success: true });
            expect(response.response[0].data).toEqual({ id: 1 });
        });

        test('quote characters inside an unquoted boundary are preserved verbatim', () => {
            // Arrange - a boundary that CONTAINS quotes but does not start
            // with one must not be unquoted; the body uses it verbatim
            const body = wire(
                '--batch"_884"',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"ok":true}',
                '',
                '--batch"_884"--'
            );

            // Act
            const response = new BatchResponse(
                { data: body, headers: { 'content-type': 'multipart/mixed; boundary=batch"_884"' } },
                'application/json'
            );

            // Assert
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ ok: true });
        });

        test('quoted boundary with trailing junk is used verbatim (not unquoted)', () => {
            // Arrange - unquoting requires the quotes to wrap the WHOLE value:
            // '"batch_884"junk' starts with a quote but does not end with one,
            // so it is kept as-is and the body must use it verbatim
            const body = wire(
                '--"batch_884"junk',
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"ok":true}',
                '',
                '--"batch_884"junk--'
            );

            // Act
            const response = new BatchResponse(
                { data: body, headers: { 'content-type': 'multipart/mixed; boundary="batch_884"junk' } },
                'application/json'
            );

            // Assert - the malformed boundary is preserved and still parses
            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ ok: true });
        });
    });

    describe('regex metacharacters in boundaries', () => {
        test.each(['batch+1', 'batch?1', 'batch(1', 'batch.1', 'a|b', 'a[b'])(
            'batch boundary %s is treated as a literal delimiter',
            (boundary) => {
                // Arrange - every variant is a legal RFC 2046 boundary but a regex
                // metacharacter; unescaped interpolation corrupts the split regex
                const body = wire(
                    `--${boundary}`,
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'HTTP/1.1 200 OK',
                    'Content-Type: application/json',
                    '',
                    '{"id":1}',
                    '',
                    `--${boundary}--`
                );

                // Act
                const response = parseWithBoundary(boundary, body);

                // Assert
                expect(response.response).toHaveLength(1);
                expect(response.response[0].data).toEqual({ id: 1 });
            }
        );

        test.each(['changeset+1', 'changeset?1', 'changeset(1', 'changeset.1', 'a|b', 'a[b'])(
            'changeset boundary %s is treated as a literal delimiter',
            (boundary) => {
                // Arrange - the metacharacter sits in the changeset boundary
                // declared by the part header and used by the body delimiters
                const body = wire(
                    '--batch_884',
                    `Content-Type: multipart/mixed; boundary=${boundary}`,
                    '',
                    `--${boundary}`,
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'HTTP/1.1 201 Created',
                    '',
                    '{"id":1}',
                    '',
                    `--${boundary}--`,
                    '--batch_884--'
                );

                // Act
                const response = parseWithBoundary('batch_884', body);

                // Assert
                expect(response.response).toHaveLength(1);
                expect(response.response[0].data).toEqual({ id: 1 });
            }
        );
    });

    describe('malformed multipart boundaries', () => {
        test('missing content-type header throws a descriptive error', () => {
            // Act & Assert - was a raw TypeError before the fix
            expect(() => new BatchResponse({ data: 'x', headers: {} }, 'application/json')).toThrow(
                'Missing content-type header, cannot determine batch boundary'
            );
        });

        test('missing boundary in content-type header throws', () => {
            // Act & Assert
            expect(
                () =>
                    new BatchResponse({ data: 'x', headers: { 'content-type': 'multipart/mixed' } }, 'application/json')
            ).toThrow('Bad content-type header, no multipart boundary');
        });

        test('boundary that never appears in the body yields an empty response array', () => {
            // Arrange - body built with a different boundary than the header declares
            const body = wire(
                '--batch_other',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 200 OK',
                '',
                '{}',
                '',
                '--batch_other--'
            );

            // Act
            const response = parse(body);

            // Assert - split produced no recognizable parts
            expect(response.response).toEqual([]);
        });
    });
});

describe('MIME preamble before the first boundary', () => {
    test.each([
        ['plain text', 'This is a multi-part message in MIME format.'],
        ['a Content-Type-looking line', 'intro\r\nContent-Type: text/plain'],
        ['a Content-ID-looking line', 'intro\r\nContent-ID: 7'],
        ['a content-type line after a blank line', 'intro\r\n\r\nContent-Type: text/plain'],
    ])('ignores %s preamble and still parses the real response', (_name, preamble) => {
        const body = wire(
            preamble,
            '--batch_884',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"id":1}',
            '',
            '--batch_884--'
        );

        const response = parse(body);

        expect(response.response).toHaveLength(1);
        expect(response.response[0].code).toBe('200');
        expect(response.response[0].data).toEqual({ id: 1 });
    });

    test('keeps a Content-ID-first real part when no preamble is present', () => {
        const body = wire(
            '--batch_884',
            'Content-ID: 1',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 204 No Content',
            '',
            '',
            '--batch_884--'
        );

        const response = parse(body);

        expect(response.response).toHaveLength(1);
        expect((response.response[0] as { contentId?: string }).contentId).toBe('1');
    });
});
