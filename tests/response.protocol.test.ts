import { BatchResponse } from '../src/response';

/**
 * Protocol conformance edges for BatchResponse parsing:
 * - status-line variants the regex does / does not recognize
 * - boundary extraction variants (parameters, quoting)
 * - header parsing corners (no space, ':' inside values, duplicates)
 * - payload truncation and accept-string variants
 * - bounded deterministic fuzz: garbage never hangs the parser
 */

const wire = (...lines: string[]): string => lines.join('\r\n');

const headersWith = (contentType: string) => ({ 'content-type': contentType });

const part = (statusLine: string, headerLines: string[], body: string): string[] => [
    '--batch_884',
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    '',
    statusLine,
    ...headerLines,
    '',
    body,
    '',
    '--batch_884--',
];

const parse = (data: string, contentType = 'multipart/mixed; boundary=batch_884', accept = 'application/json') =>
    new BatchResponse({ data, headers: headersWith(contentType) }, accept);

describe('BatchResponse protocol conformance edges', () => {
    describe('status-line recognition', () => {
        test('HTTP/1.0 status line is NOT recognized: code stays empty, success stays true', () => {
            // Arrange - the parser only knows 'HTTP/1.1 ### ...'; an HTTP/1.0
            // line falls through to the no-status behavior
            const body = wire(...part('HTTP/1.0 200 OK', ['Content-Type: application/json'], '{"id":1}'));

            // Act
            const r = parse(body).response;

            // Assert - characterization: 1.0 responses read as "unknown" and
            // therefore count as success
            expect(r[0].code).toBe('');
            expect(r[0].status).toBe('');
            expect(r[0].success).toBe(true);
        });

        test.each([
            ['100', 'Continue'],
            ['200', 'OK'],
            ['201', 'Created'],
            ['204', 'No Content'],
            ['302', 'Found'],
            ['304', 'Not Modified'],
        ])('status %s maps to success=true (only 4xx/5xx fail)', (code, reason) => {
            // Arrange
            const body = wire(...part(`HTTP/1.1 ${code} ${reason}`, [], '{"ok":true}'));

            // Act & Assert
            expect(parse(body).response[0]).toMatchObject({ code, status: reason, success: true });
        });

        test.each([
            ['400', 'Bad Request'],
            ['404', 'Not Found'],
            ['409', 'Conflict'],
            ['500', 'Internal Server Error'],
            ['503', 'Service Unavailable'],
        ])('status %s maps to success=false', (code, reason) => {
            // Arrange
            const body = wire(...part(`HTTP/1.1 ${code} ${reason}`, [], '{"e":1}'));

            // Act & Assert
            expect(parse(body).response[0]).toMatchObject({ code, status: reason, success: false });
        });
    });

    describe('boundary extraction variants', () => {
        test('boundary followed by more parameters is extracted up to the semicolon', () => {
            // Arrange
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

            // Act
            const r = parse(body, 'multipart/mixed; boundary=batch_884; charset=utf-8').response;

            // Assert - [^;]+ stops before '; charset'
            expect(r).toHaveLength(1);
            expect(r[0].data).toEqual({ id: 1 });
        });

        test('QUOTED boundary never matches the body delimiters: empty result', () => {
            // Arrange - RFC 2046 allows quoted boundary parameters; the parser
            // keeps the quotes in the capture, so nothing is recognized
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

            // Act
            const r = parse(body, 'multipart/mixed; boundary="batch_884"').response;

            // Assert - documented as-is
            expect(r).toEqual([]);
        });
    });

    describe('header parsing corners', () => {
        test('header without a space after the colon yields {key:"",value:""}', () => {
            // Arrange - '(.+): (.+)' requires exactly ': '
            const body = wire(...part('HTTP/1.1 200 OK', ['X-NoSpace:b'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].headers).toEqual([{ key: '', value: '' }]);
        });

        test('header value containing ": " splits at the LAST occurrence', () => {
            // Arrange - greedy (.+) backtracks from the end
            const body = wire(...part('HTTP/1.1 200 OK', ['X-Note: time: 12:30'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert - documented as-is
            expect(r[0].headers).toEqual([{ key: 'X-Note: time', value: '12:30' }]);
        });

        test('duplicate header keys are all preserved in order', () => {
            // Arrange
            const body = wire(...part('HTTP/1.1 200 OK', ['Set-Cookie: a=1', 'Set-Cookie: b=2'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].headers).toEqual([
                { key: 'Set-Cookie', value: 'a=1' },
                { key: 'Set-Cookie', value: 'b=2' },
            ]);
        });
    });

    describe('payload edges', () => {
        test('non-XML payload containing a blank line is TRUNCATED at the first \\r\\n\\r\\n', () => {
            // Arrange - only responseParts[2] is used as data; anything after
            // the next blank line is silently dropped
            const body = wire(...part('HTTP/1.1 200 OK', ['Content-Type: application/xml'], 'line1\r\n\r\nline2'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert - documented as-is
            expect(r[0].data).toBe('line1');
        });

        test('accept strings other than exactly application/json take the raw-text branch', () => {
            // Arrange - the check is ===, not a media-type comparison
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

            // Act
            const r = parse(body, undefined, 'text/json').response;

            // Assert - JSON body returned as raw string
            expect(r[0].data).toBe('{"id":1}');
        });

        test.each([
            ['null', null],
            ['[]', []],
            ['[1,2]', [1, 2]],
            ['42', 42],
            ['true', true],
            ['{"a":{"b":[1,2,3]}}', { a: { b: [1, 2, 3] } }],
        ])('JSON scalar/collection payload %s parses natively', (payload, expected) => {
            // Arrange
            const body = wire(...part('HTTP/1.1 200 OK', [], payload));

            // Act & Assert
            expect(parse(body).response[0].data).toEqual(expected);
        });
    });

    describe('bounded deterministic fuzz', () => {
        test('random garbage never hangs: parse returns an array or throws TypeError/SyntaxError', () => {
            // Arrange - seeded LCG over a hostile alphabet including the
            // tokens the parser is sensitive to
            const LCG = (): { next: () => number } => {
                let s = 0xc0ffee;
                return { next: () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296) };
            };
            const rng = LCG();
            const ALPHABET = [
                '--',
                '\r',
                '\n',
                'Content-Type:',
                'boundary=',
                'x',
                'HTTP/1.1 200 OK',
                ':',
                ' ',
                '{}',
                'batch_884',
            ];

            // Act & Assert
            for (let i = 0; i < 300; i++) {
                const len = 1 + Math.floor(rng.next() * 40);
                let garbage = '';
                for (let j = 0; j < len; j++) garbage += ALPHABET[Math.floor(rng.next() * ALPHABET.length)];

                const attempt = () => parse(garbage).response;
                try {
                    const result = attempt();
                    expect(Array.isArray(result)).toBe(true);
                } catch (e) {
                    expect([TypeError, SyntaxError]).toContain(e.constructor);
                }
            }
        });
    });
});
