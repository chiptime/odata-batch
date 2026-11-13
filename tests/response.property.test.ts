import { BatchResponse } from '../src/response';
import { requestsToBatch, Call } from '../src/request';
import { makeRandomMock } from './helpers';

/**
 * Property-based tests for the BatchResponse parser.
 *
 * Properties run over deterministically generated inputs (seeded LCG, no
 * external dependencies): the parser must hold its invariants for ANY valid
 * RFC 2046 boundary and any mix of part kinds, not just for hand-picked
 * fixtures. Runs per property are bounded (fixed seeds, <= ~200 runs each)
 * so the suite stays fast and reproducible.
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

// RFC 2046 bchars: DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," /
// "-" / "." / "/" / ":" / "=" / "?" / SP. Space is legal anywhere EXCEPT as
// the last character (bcharsnospace), and the whole boundary is 1-70 chars.
const BCHARS_NOSPACE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'()+_,-./:=?";
const BCHARS = BCHARS_NOSPACE + ' ';

const randomBoundary = (rng: LCG): string => {
    const length = rng.int(1, 70);
    let boundary = '';
    for (let i = 0; i < length - 1; i++) {
        boundary += BCHARS[rng.int(0, BCHARS.length - 1)];
    }
    return boundary + BCHARS_NOSPACE[rng.int(0, BCHARS_NOSPACE.length - 1)];
};

const randomCase = (rng: LCG, value: string): string =>
    value
        .split('')
        .map((ch) => (rng.next() < 0.5 ? ch.toLowerCase() : ch.toUpperCase()))
        .join('');

const METHODS = ['PATCH', 'POST', 'PUT', 'DELETE', 'MERGE'];
const PATHS = ['/A', '/B', '/C', '/D/E', "/F('key-1')"];

const randomCall = (rng: LCG): Call => ({
    method: rng.pick(METHODS),
    url: rng.pick(PATHS) + `?n=${rng.int(0, 999)}`,
    headers: rng.next() < 0.3 ? undefined : {},
    data: rng.next() < 0.4 ? null : { id: rng.int(1, 9999), note: 'x'.repeat(rng.int(0, 20)) },
});

const randomMultiCalls = (rng: LCG): Call[][] => {
    const changesets: Call[][] = [];
    const count = rng.int(1, 6);
    for (let c = 0; c < count; c++) {
        const ops = rng.int(1, 4);
        const calls: Call[] = [];
        for (let o = 0; o < ops; o++) calls.push(randomCall(rng));
        changesets.push(calls);
    }
    return changesets;
};

const parse = (data: string, contentTypeHeader: string, accept = 'application/json'): BatchResponse =>
    new BatchResponse({ data, headers: { 'content-type': contentTypeHeader } }, accept);

const STATUS_POOL: [code: string, reason: string, success: boolean][] = [
    ['200', 'OK', true],
    ['201', 'Created', true],
    ['400', 'Bad Request', false],
    ['500', 'Internal Server Error', false],
];

describe('BatchResponse properties (seeded random inputs)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const SEEDS = [1, 7, 42, 99, 123, 777, 2026, 31415, 65535, 424242];

    test('PROPERTY: collapsed failures never shift later group identity or invent child responses', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            for (let run = 0; run < 10; run++) {
                const lines: string[] = [];
                const layout: any[] = [];
                const expectedKinds: string[] = [];
                const expectedSizes: number[] = [];
                for (let group = 0; group < 5; group++) {
                    const retrieve = rng.next() < 0.3;
                    const failed = rng.next() < 0.5;
                    const count = retrieve ? 1 : rng.int(1, 5);
                    layout.push(retrieve ? { kind: 'retrieve' } : { kind: 'changeset', operationCount: count });
                    expectedKinds.push(retrieve ? 'retrieve' : failed ? 'changeset-error' : 'changeset');
                    expectedSizes.push(!retrieve && !failed ? count : 1);
                    const boundary = !retrieve && !failed ? `cs_${group}` : 'batch_grouped';
                    if (boundary !== 'batch_grouped')
                        lines.push('--batch_grouped', `Content-Type: multipart/mixed; boundary=${boundary}`, '');
                    for (let op = 0; op < expectedSizes[group]; op++) {
                        lines.push(
                            `--${boundary}`,
                            'Content-Type: application/http',
                            `Content-ID: ${op + 1}`,
                            '',
                            failed ? 'HTTP/1.1 400 Bad Request' : 'HTTP/1.1 200 OK',
                            '',
                            '{}',
                            ''
                        );
                    }
                    if (boundary !== 'batch_grouped') lines.push(`--${boundary}--`);
                }
                lines.push('--batch_grouped--');
                const parser = parse(lines.join(run % 2 ? '\n' : '\r\n'), 'multipart/mixed; boundary=batch_grouped');
                const groups = (parser as any).parseGrouped(layout);
                expect(groups.map((g: any) => g.kind)).toEqual(expectedKinds);
                expect(groups.map((g: any) => g.partIndex)).toEqual([0, 1, 2, 3, 4]);
                expect(groups.map((g: any) => (g.kind === 'changeset' ? g.responses.length : 1))).toEqual(
                    expectedSizes
                );
                expect(parser.response).toHaveLength(expectedSizes.reduce((sum, n) => sum + n, 0));
            }
        }
    });

    test('PROPERTY: IDs preserve case-sensitive values across casing, ordering, framing, and independent groups', () => {
        for (const seed of SEEDS) {
            const rng = new LCG(seed);
            for (let run = 0; run < 8; run++) {
                const lines: string[] = [];
                const expected: (string | undefined)[] = [];
                for (let group = 0; group < 3; group++) {
                    const cs = `changeset_${group}`;
                    lines.push('--batch_ids', `Content-Type: multipart/mixed; boundary=${cs}`, '');
                    for (let op = 0; op < 3; op++) {
                        const contentId = rng.next() < 0.3 ? undefined : `Item-${op}`;
                        const mime = ['Content-Type: application/http'];
                        if (contentId !== undefined) mime.push(`${randomCase(rng, 'Content-ID')}: ${contentId}`);
                        if (rng.next() < 0.5) mime.reverse();
                        lines.push(`--${cs}`, ...mime, '', 'HTTP/1.1 200 OK', 'Content-ID: inner', '', '{}');
                        expected.push(contentId);
                    }
                    lines.push(`--${cs}--`);
                }
                lines.push('--batch_ids--');
                const body = lines.join(rng.next() < 0.5 ? '\n' : '\r\n');
                const result = parse(body, 'multipart/mixed; boundary=batch_ids').response;
                expect(result.map((r) => (r as any).contentId)).toEqual(expected);
                expect(result.map((r) => r.changesetIndex)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
            }
        }
    });

    test('PROPERTY: arbitrary RFC 2046 boundaries round-trip - N ops => N responses with code/data/changesetIndex', () => {
        const RUNS = 20; // 10 seeds x 20 runs = 200 bounded runs

        for (const seed of SEEDS) {
            for (let run = 0; run < RUNS; run++) {
                const rng = new LCG(seed * 1000 + run);
                // Deterministic changeset boundary roll (percentage -> Math.random)
                makeRandomMock(rng.int(0, 99));

                const boundary = randomBoundary(rng);
                const multi = randomMultiCalls(rng);

                // Round-trip with requestsToBatch: the request fixes the batch
                // and changeset boundaries, and the mirrored response reuses them
                const request = requestsToBatch(multi, boundary, JSON_OPTS).body;
                const batchBoundary = 'batch_' + boundary;
                expect(typeof request).toBe('string');
                const changeSetBoundaries = Array.from(
                    request.toString().matchAll(/boundary=(changeset_[0-9.]+_\d+)\r/g)
                ).map((m) => m[1]);
                expect(changeSetBoundaries).toHaveLength(multi.length);

                const lines: string[] = [];
                const expected: { code: string; status: string; success: boolean; data: unknown }[] = [];
                multi.forEach((calls, i) => {
                    lines.push(
                        `--${batchBoundary}`,
                        `Content-Type: multipart/mixed; boundary=${changeSetBoundaries[i]}`,
                        ''
                    );
                    calls.forEach((_, op) => {
                        const [code, reason, success] = rng.pick(STATUS_POOL);
                        lines.push(
                            `--${changeSetBoundaries[i]}`,
                            'Content-Type: application/http',
                            'Content-Transfer-Encoding: binary',
                            '',
                            `HTTP/1.1 ${code} ${reason}`,
                            'Content-Type: application/json',
                            '',
                            `{"cs":${i},"op":${op}}`,
                            ''
                        );
                        expected.push({ code, status: reason, success, data: { cs: i, op } });
                    });
                    lines.push(`--${changeSetBoundaries[i]}--`);
                });
                lines.push(`--${batchBoundary}--`);

                const parsed = parse(lines.join('\r\n'), `multipart/mixed; boundary=${batchBoundary}`).response;

                expect(parsed).toHaveLength(expected.length);
                expect(parsed.map((r) => r.changesetIndex)).toEqual(multi.flatMap((calls, i) => calls.map(() => i)));
                expected.forEach((exp, i) => {
                    expect(parsed[i]).toMatchObject({ code: exp.code, status: exp.status, success: exp.success });
                    expect(parsed[i].data).toEqual(exp.data);
                });
            }
        }
    });

    test('PROPERTY: mixed JSON/empty(204)/non-JSON parts never throw and yield one result per part', () => {
        const RUNS = 20; // 200 bounded runs

        for (const seed of SEEDS) {
            for (let run = 0; run < RUNS; run++) {
                const rng = new LCG(seed * 977 + run);
                const boundary = 'batch_' + randomBoundary(rng);
                const partCount = rng.int(1, 6);

                const lines: string[] = [];
                const expected: { data: unknown; success: boolean }[] = [];
                for (let p = 0; p < partCount; p++) {
                    const kind = rng.int(0, 2);
                    let statusLine = 'HTTP/1.1 200 OK';
                    let payload = '';
                    let data: unknown;
                    let success = true;

                    if (kind === 0) {
                        // Valid JSON part
                        payload = `{"p":${p}}`;
                        data = { p };
                    } else if (kind === 1) {
                        // Empty 204 part: no JSON document => null
                        statusLine = 'HTTP/1.1 204 No Content';
                        data = null;
                    } else {
                        // Non-JSON error body: raw payload string, never a throw
                        statusLine = 'HTTP/1.1 400 Bad Request';
                        payload = `<error>p${p}</error>`;
                        data = `<error>p${p}</error>`;
                        success = false;
                    }

                    lines.push(
                        `--${boundary}`,
                        'Content-Type: application/http',
                        'Content-Transfer-Encoding: binary',
                        '',
                        statusLine,
                        '',
                        payload,
                        ''
                    );
                    expected.push({ data, success });
                }
                lines.push(`--${boundary}--`);

                const parsed = parse(lines.join('\r\n'), `multipart/mixed; boundary=${boundary}`).response;

                expect(parsed).toHaveLength(partCount);
                expect(parsed.map((r) => r.data)).toEqual(expected.map((e) => e.data));
                expect(parsed.map((r) => r.success)).toEqual(expected.map((e) => e.success));
            }
        }
    });

    test('PROPERTY: converting a well-formed CRLF body to LF yields the same parsed result', () => {
        const RUNS = 12; // 120 bounded runs

        for (const seed of SEEDS) {
            for (let run = 0; run < RUNS; run++) {
                const rng = new LCG(seed * 131 + run);
                const boundary = 'batch_' + randomBoundary(rng);
                const partCount = rng.int(1, 5);

                const lines: string[] = [];
                for (let p = 0; p < partCount; p++) {
                    const empty = rng.next() < 0.3;
                    lines.push(
                        `--${boundary}`,
                        'Content-Type: application/http',
                        'Content-Transfer-Encoding: binary',
                        '',
                        empty ? 'HTTP/1.1 204 No Content' : `HTTP/1.1 200 OK`,
                        '',
                        empty ? '' : `{"p":${p}}`,
                        ''
                    );
                }
                lines.push(`--${boundary}--`);

                const crlfBody = lines.join('\r\n');
                const lfBody = crlfBody.split('\r\n').join('\n');

                const fromCrlf = parse(crlfBody, `multipart/mixed; boundary=${boundary}`).response;
                const fromLf = parse(lfBody, `multipart/mixed; boundary=${boundary}`).response;

                expect(fromLf).toEqual(fromCrlf);
                expect(fromCrlf).toHaveLength(partCount);
            }
        }
    });

    test('PROPERTY: any casing of content-type (response headers and part headers) parses', () => {
        const RUNS = 8; // 80 bounded runs

        for (const seed of SEEDS) {
            for (let run = 0; run < RUNS; run++) {
                const rng = new LCG(seed * 5171 + run);
                const boundary = 'batch_' + randomBoundary(rng);
                const partCount = rng.int(1, 4);
                const headerKey = randomCase(rng, 'content-type');
                const partHeader = randomCase(rng, 'Content-Type');

                const lines: string[] = [];
                const expected: unknown[] = [];
                for (let p = 0; p < partCount; p++) {
                    lines.push(
                        `--${boundary}`,
                        `${partHeader}: application/http`,
                        'Content-Transfer-Encoding: binary',
                        '',
                        'HTTP/1.1 200 OK',
                        '',
                        `{"p":${p}}`,
                        ''
                    );
                    expected.push({ p });
                }
                lines.push(`--${boundary}--`);

                const parsed = new BatchResponse(
                    { data: lines.join('\r\n'), headers: { [headerKey]: `multipart/mixed; boundary=${boundary}` } },
                    'application/json'
                ).response;

                expect(parsed).toHaveLength(partCount);
                expect(parsed.map((r) => r.data)).toEqual(expected);
            }
        }
    });
});
