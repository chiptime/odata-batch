import { requestsToBatch, Call } from '../src/request';
import { BatchResponse } from '../src/response';
import { makeRandomMock } from './helpers';

/**
 * Property-based and security/characterization tests for requestsToBatch().
 *
 * Properties run over deterministically generated inputs (seeded LCG, no
 * external dependencies): the wire format must hold invariants for ANY valid
 * Call[] / Call[][] input, not just for hand-picked fixtures.
 */

const JSON_OPTS = { contentType: 'application/json', accept: 'application/json' };

/** Minimal deterministic PRNG (Numerical Recipes LCG). */
class LCG {
    private state: number;
    constructor(seed: number) {
        this.state = seed >>> 0;
    }
    next(): number {
        this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
        return this.state / 4294967296;
    }
    int(min: number, max: number): number {
        return min + Math.floor(this.next() * (max - min + 1));
    }
    pick<T>(items: T[]): T {
        return items[this.int(0, items.length - 1)];
    }
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'MERGE'];
const PATHS = ['/A', '/B', '/C', '/D/E', "/F('key-1')"];

const randomCall = (rng: LCG): Call => ({
    method: rng.pick(METHODS),
    url: rng.pick(PATHS) + `?n=${rng.int(0, 999)}`,
    headers: rng.next() < 0.3 ? undefined : {},
    data: rng.next() < 0.4 ? null : { id: rng.int(1, 9999), note: 'x'.repeat(rng.int(0, 20)) },
});

const randomCalls = (rng: LCG): { legacy: Call[]; multi: Call[][] } => {
    const changesetCount = rng.int(1, 6);
    const multi: Call[][] = [];
    let total = 0;
    for (let c = 0; c < changesetCount; c++) {
        const ops = rng.int(1, 4);
        total += ops;
        const cs: Call[] = [];
        for (let o = 0; o < ops; o++) cs.push(randomCall(rng));
        multi.push(cs);
    }
    // Legacy flattens the same total number of operations
    const legacy: Call[] = multi.flat();
    return { legacy, multi, ...{ total } } as { legacy: Call[]; multi: Call[][] };
};

describe('requestsToBatch() properties (seeded random inputs)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const SEEDS = [1, 7, 42, 99, 123, 777, 2026, 31415, 65535, 424242];

    test('PROPERTY: output only ever contains CRLF line breaks, never a bare LF', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            makeRandomMock(42);
            const { legacy, multi } = randomCalls(rng);

            for (const calls of [legacy, multi]) {
                const out = requestsToBatch(calls as Call[] & Call[][], 'seed' + seed, JSON_OPTS);
                const lines = out.split('\r\n');
                lines.forEach((line, i) =>
                    expect({ seed, line: i, bareLf: line.includes('\n') }).toEqual({ seed, line: i, bareLf: false })
                );
            }
        }
    });

    test('PROPERTY: N changesets produce exactly boundaries _0.._N-1, each unique', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            makeRandomMock(42);
            const { multi } = randomCalls(rng);

            const out = requestsToBatch(multi, 'seed' + seed, JSON_OPTS);
            const indices = Array.from(out.matchAll(/boundary=changeset_[0-9.]+_(\d+)\r/g)).map((m) =>
                parseInt(m[1], 10)
            );

            expect(indices).toEqual(multi.map((_, i) => i));
        }
    });

    test('PROPERTY: output always ends with the batch terminator', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            makeRandomMock(42);
            const { legacy, multi } = randomCalls(rng);
            const boundary = 'seed' + seed;

            const legacyOut = requestsToBatch(legacy, boundary, JSON_OPTS);
            const multiOut = requestsToBatch(multi, boundary, JSON_OPTS);
            expect(legacyOut.endsWith(`--batch_${boundary}--`)).toBe(true);
            expect(multiOut.endsWith(`--batch_${boundary}--`)).toBe(true);
        }
    });

    test('PROPERTY: legacy output never uses an indexed changeset boundary', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            makeRandomMock(42);
            const { legacy } = randomCalls(rng);

            const out = requestsToBatch(legacy, 'seed' + seed, JSON_OPTS);
            expect(out).toMatch(/boundary=changeset_[0-9.]+\r/);
            expect(out).not.toMatch(/boundary=changeset_[0-9.]+_\d+/);
        }
    });

    test('PROPERTY: determinism - same Math.random and same input produce identical bytes', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            const { multi } = randomCalls(rng);

            makeRandomMock(42);
            const first = requestsToBatch(multi, 'b', JSON_OPTS);
            makeRandomMock(42);
            const second = requestsToBatch(multi, 'b', JSON_OPTS);

            expect(first).toBe(second);
        }
    });

    test('PROPERTY: round-trip - a mirrored response parses back with exact op count and changesetIndex sequence', () => {
        const wire = (...lines: string[]): string => lines.join('\r\n');

        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            makeRandomMock(42);
            const { multi } = randomCalls(rng);

            const request = requestsToBatch(multi, 'rt' + seed, JSON_OPTS);
            const boundaries = Array.from(request.matchAll(/boundary=(changeset_[0-9.]+_\d+)\r/g)).map((m) => m[1]);

            const responseLines: string[] = [];
            multi.forEach((cs, i) => {
                responseLines.push('--batch_rt' + seed, `Content-Type: multipart/mixed; boundary=${boundaries[i]}`, '');
                cs.forEach((_, op) => {
                    responseLines.push(
                        `--${boundaries[i]}`,
                        'Content-Type: application/http',
                        'Content-Transfer-Encoding: binary',
                        '',
                        `HTTP/1.1 200 OK`,
                        'Content-Type: application/json',
                        '',
                        `{"op":${op}}`,
                        ''
                    );
                });
                responseLines.push(`--${boundaries[i]}--`);
            });
            responseLines.push(`--batch_rt${seed}--`);

            const parsed = new BatchResponse(
                {
                    data: wire(...responseLines),
                    headers: { 'content-type': `multipart/mixed; boundary=batch_rt${seed}` },
                },
                'application/json'
            );

            const expectedIndex = multi.flatMap((cs, i) => cs.map(() => i));
            expect(parsed.response.map((r) => r.changesetIndex)).toEqual(expectedIndex);
            expect(parsed.response.every((r) => r.success)).toBe(true);
        }
    });

    test('LIMIT: 50 changesets stay well-formed and uniquely bounded', () => {
        // Arrange
        makeRandomMock(7);
        const multi: Call[][] = Array.from({ length: 50 }, (_, i) => [
            { method: 'POST', url: `/api/x${i}`, headers: undefined, data: { i } },
        ]);

        // Act
        const out = requestsToBatch(multi, 'big', JSON_OPTS);

        // Assert
        const indices = Array.from(out.matchAll(/boundary=changeset_[0-9.]+_(\d+)\r/g)).map((m) => parseInt(m[1], 10));
        expect(indices).toEqual(Array.from({ length: 50 }, (_, i) => i));
        expect(out.endsWith('--batch_big--')).toBe(true);
        expect(out.split('\r\n').every((l) => !l.includes('\n'))).toBe(true);
    });
});

describe('requestsToBatch() security / robustness characterizations', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('CRLF injection: a url containing \\r\\n flows into the wire unsanitized', () => {
        // Arrange - a hostile/buggy caller embeds a line break in the url.
        // The library performs NO sanitization: the break lands inside the
        // request line and would corrupt the part on a real server.
        makeRandomMock(42);
        const calls: Call[] = [{ method: 'POST', url: '/api/a\r\nX-Evil: injected', headers: undefined, data: {} }];

        // Act
        const out = requestsToBatch(calls, '884', JSON_OPTS);

        // Assert - documented as-is: header injection is possible today
        expect(out).toContain('X-Evil: injected');
    });

    test('boundary collision: payload containing the changeset terminator is not escaped', () => {
        // Arrange - with changeSetNum 42 the first multi boundary is
        // changeset_42_0; a payload echoing '--changeset_42_0--' would
        // terminate the changeset early on the server side.
        makeRandomMock(42);
        const calls: Call[][] = [
            [{ method: 'POST', url: '/api/a', headers: undefined, data: { pad: '--changeset_42_0--' } }],
        ];

        // Act
        const out = requestsToBatch(calls, '884', JSON_OPTS);

        // Assert - documented as-is: no escaping of boundary-like payloads
        expect(out).toContain('"pad":"--changeset_42_0--"');
    });

    test('unicode survives JSON.stringify unescaped in both paths', () => {
        // Arrange
        makeRandomMock(42);
        const call: Call = {
            method: 'POST',
            url: '/Entidades(' + encodeURIComponent('ñ') + ')',
            headers: undefined,
            data: { name: 'ñ é 😀' },
        };

        // Act
        const legacy = requestsToBatch([call], '884', JSON_OPTS);
        const multi = requestsToBatch([[call]], '884', JSON_OPTS);

        // Assert - JSON.stringify does not escape these code points
        expect(legacy).toContain('"name":"ñ é 😀"');
        expect(multi).toContain('"name":"ñ é 😀"');
    });

    test('lowercase method is normalized to uppercase in both paths', () => {
        // Arrange
        makeRandomMock(42);
        const call: Call = { method: 'post', url: '/api/a', headers: undefined, data: null };

        // Act
        const legacy = requestsToBatch([call], '884', JSON_OPTS);
        const multi = requestsToBatch([[call]], '884', JSON_OPTS);

        // Assert
        expect(legacy).toContain('POST /api/a HTTP/1.1');
        expect(multi).toContain('POST /api/a HTTP/1.1');
    });

    test('undefined data renders as an empty body line in BOTH content types', () => {
        // Arrange - Array.join() coerces undefined to '' (NOT to the string
        // 'undefined', which only happens with '+' concatenation), so the xml
        // branch behaves exactly like the json branch here: empty body line
        makeRandomMock(42);
        const calls: Call[] = [{ method: 'GET', url: '/api/a', headers: undefined, data: undefined }];

        // Act
        const json = requestsToBatch(calls, '884', JSON_OPTS);
        const xml = requestsToBatch(calls, '884', {
            contentType: 'application/xml',
            accept: 'application/xml',
        });

        // Assert - no 'undefined' token ever reaches the wire; the body
        // position is empty (blank line + trailing blank)
        expect(json).not.toContain('undefined');
        expect(xml).not.toContain('undefined');
        expect(json).toContain('Accept: application/json\r\n\r\n\r\n\r\n--changeset_42--');
        expect(xml).toContain('Accept: application/xml\r\n\r\n\r\n\r\n--changeset_42--');
    });

    test('non-string header values are coerced with string concatenation', () => {
        // Arrange
        makeRandomMock(42);
        const calls: Call[] = [
            { method: 'POST', url: '/api/a', headers: { 'x-retry-count': 3, 'x-ratio': 0.5 }, data: null },
        ];

        // Act
        const out = requestsToBatch(calls, '884', JSON_OPTS);

        // Assert
        expect(out).toContain('x-retry-count: 3');
        expect(out).toContain('x-ratio: 0.5');
    });
});
