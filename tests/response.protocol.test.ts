import { BatchResponse } from '../src/response';

/**
 * Protocol conformance edges for BatchResponse parsing:
 * - status-line variants the regex does / does not recognize
 * - boundary extraction variants (parameters, quoting)
 * - header parsing corners (first-colon split, OWS, no colon, duplicates)
 * - payload preservation and accept media-type variants
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
        test('HTTP/1.0 status lines are recognized since the 1.[01] regex fix', () => {
            // Arrange - the parser now accepts both HTTP/1.0 and HTTP/1.1
            const body = wire(...part('HTTP/1.0 200 OK', ['Content-Type: application/json'], '{"id":1}'));

            // Act
            const r = parse(body).response;

            // Assert
            expect(r[0]).toMatchObject({ code: '200', status: 'OK', success: true });
            expect(r[0].data).toEqual({ id: 1 });
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

        test('status line with an empty reason phrase yields the code and status ""', () => {
            // Arrange - RFC 7230 allows an empty reason phrase; only the
            // trailing space after the code remains
            const body = wire(...part('HTTP/1.1 204 ', [], '{"ok":true}'));

            // Act & Assert
            expect(parse(body).response[0]).toMatchObject({ code: '204', status: '', success: true });
        });

        test('unparseable status line yields success=false', () => {
            // Arrange - a response block whose first line is not an HTTP
            // status line cannot be confirmed successful
            const body = wire(...part('NOT-HTTP 200 Great', [], 'x'));

            // Act & Assert
            expect(parse(body, undefined, 'application/xml').response[0]).toMatchObject({
                code: '',
                status: '',
                success: false,
            });
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

        test('QUOTED boundary (RFC 2046) is unwrapped and parses correctly', () => {
            // Arrange - RFC 2046 allows quoted boundary parameters; the quotes
            // are stripped from the captured boundary before matching the body
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

            // Act
            const r = parse(body, 'multipart/mixed; boundary="batch_884"').response;

            // Assert
            expect(r).toHaveLength(1);
            expect(r[0].data).toEqual({ id: 1 });
        });

        test.each(['Content-Type', 'CONTENT-TYPE', 'Content-type', 'CoNtEnT-TyPe'])(
            'header key %s is found case-insensitively (RFC 9110)',
            (key) => {
                // Arrange - header NAMES are case-insensitive; an unrelated
                // key proves the scan skips non-matching entries
                const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

                // Act
                const r = new BatchResponse(
                    { data: body, headers: { 'x-unused': '1', [key]: 'multipart/mixed; boundary=batch_884' } },
                    'application/json'
                ).response;

                // Assert
                expect(r).toHaveLength(1);
                expect(r[0].data).toEqual({ id: 1 });
            }
        );

        test('content-type absent under any casing still throws the descriptive error', () => {
            // Arrange & Act & Assert - other headers must not satisfy the lookup
            expect(() =>
                new BatchResponse({ data: 'x', headers: { accept: 'application/json' } }, 'application/json')
            ).toThrow('Missing content-type header, cannot determine batch boundary');
        });
    });

    describe('header parsing corners', () => {
        test('header without a space after the colon splits into key and value', () => {
            // Arrange - RFC 7230: the field ends at the FIRST colon; spaces
            // around it are optional whitespace, not required syntax
            const body = wire(...part('HTTP/1.1 200 OK', ['X-NoSpace:b'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].headers).toEqual([{ key: 'X-NoSpace', value: 'b' }]);
        });

        test('header value containing ":" splits at the FIRST colon', () => {
            // Arrange - only the first colon separates name from value
            const body = wire(...part('HTTP/1.1 200 OK', ['X-Note: time: 12:30'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert - the colons inside the value stay in the value
            expect(r[0].headers).toEqual([{ key: 'X-Note', value: 'time: 12:30' }]);
        });

        test('optional whitespace around the colon is trimmed from key and value (RFC 7230 OWS)', () => {
            // Arrange
            const body = wire(...part('HTTP/1.1 200 OK', ['X-Space :  padded  '], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].headers).toEqual([{ key: 'X-Space', value: 'padded' }]);
        });

        test('header line with no colon still yields {key:"",value:""}', () => {
            // Arrange - junk lines without a colon carry no field data
            const body = wire(...part('HTTP/1.1 200 OK', ['garbage-without-colon'], 'x'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].headers).toEqual([{ key: '', value: '' }]);
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
        test('non-JSON payload containing a blank line is preserved intact', () => {
            // Arrange - everything after the status/headers block is payload;
            // interior blank lines no longer truncate it
            const body = wire(...part('HTTP/1.1 200 OK', ['Content-Type: application/xml'], 'line1\r\n\r\nline2'));

            // Act
            const r = parse(body, undefined, 'application/xml').response;

            // Assert
            expect(r[0].data).toBe('line1\r\n\r\nline2');
        });

        test('payload is returned whole with only the framing CRLFs trimmed', () => {
            // Arrange - multipart framing appends CRLFs after the body before
            // the next delimiter; they are not part of the payload
            const body = wire(...part('HTTP/1.1 200 OK', [], 'a\r\nb\r\n\r\nc'));

            // Act
            const r = parse(body, undefined, 'text/plain').response;

            // Assert
            expect(r[0].data).toBe('a\r\nb\r\n\r\nc');
        });

        test('JSON payload spanning blank-line whitespace parses natively (segments rejoined)', () => {
            // Arrange - JSON allows whitespace between tokens, even blank
            // lines; the payload segments must be rejoined before parsing
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":\r\n\r\n1}'));

            // Act & Assert
            expect(parse(body).response[0].data).toEqual({ id: 1 });
        });

        test.each([
            'application/json',
            'application/json;odata=verbose',
            'Application/JSON',
            'APPLICATION/JSON; odata=minimalmetadata',
            'application/json ;q=0.9',
        ])('accept %s selects JSON mode (media type before ";", case-insensitive)', (accept) => {
            // Arrange - only the media type decides the mode; parameters
            // like odata=verbose must not disable JSON parsing
            const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

            // Act & Assert
            expect(parse(body, undefined, accept).response[0].data).toEqual({ id: 1 });
        });

        test.each(['text/json', 'application/xml', 'application/atom+xml'])(
            'accept %s is not the application/json media type and stays raw text',
            (accept) => {
                // Arrange - similar-looking media types must not enter JSON mode
                const body = wire(...part('HTTP/1.1 200 OK', [], '{"id":1}'));

                // Act & Assert
                expect(parse(body, undefined, accept).response[0].data).toBe('{"id":1}');
            }
        );

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
                    expect(e instanceof TypeError || e instanceof SyntaxError).toBe(true);
                }
            }
        });
    });
});
