import * as api from '../src/index';
import * as request from '../src/request';
import { Call, RetrieveCall } from '../src/request';
import { BatchResponse, createBatchResponse } from '../src/response';
import { DummyBatchRepo, makeRandomMock, makeRandomSequenceMock } from './helpers';

// T4 API under construction: resolved dynamically so the suite runs and fails
// on the missing behavior (not on a compile error), then passes once exported.
const operationsToBatch = (request as { operationsToBatch?: (...args: any[]) => string }).operationsToBatch as (
    operations: (RetrieveCall | Call[])[],
    boundary: string,
    options: { contentType?: string; accept?: string }
) => string;

/**
 * T4: ordered mixed batches. A single $batch request may interleave direct
 * GET parts and atomic changesets, in input order. Serialization must reuse
 * the existing guards, and grouped parsing/repository must carry the mixed
 * request layout end to end.
 */

const wire = (...lines: string[]): string => lines.join('\r\n');
const ACCEPT_JSON = { contentType: 'application/json', accept: 'application/json' };

const requestLines = (batch: string): string[] =>
    batch.split('\r\n').filter((line) => /^(GET|POST|PUT|PATCH|DELETE|MERGE) .* HTTP\/1\.1$/.test(line));

// Deterministic LCG, matching the hand-rolled seeded generators used elsewhere.
const lcg = (seed: number) => {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};

describe('operationsToBatch() wire format', () => {
    test('interleaves a direct GET, a changeset, then another direct GET in input order', () => {
        const restore = makeRandomMock(11.63); // changeSetNum = 11.63 -> "11.63"
        try {
            const operations: (RetrieveCall | Call[])[] = [
                { url: '/api/a' },
                [
                    { method: 'POST', url: '/api/b', data: { id: 1 } },
                    { method: 'PATCH', url: "/api/b('1')", data: { name: 'x' } },
                ],
                { url: '/api/c' },
            ];

            const result = operationsToBatch(operations, '884', ACCEPT_JSON);

            // The first top-level part is a changeset-free direct GET.
            expect(result.startsWith(wire('--batch_884', 'Content-Type: application/http'))).toBe(true);
            expect(result).toContain(wire('GET /api/a HTTP/1.1', 'Accept: application/json', '', ''));
            // Exactly one changeset wrapper exists, around the two write calls.
            expect(result.match(/Content-Type: multipart\/mixed; boundary=changeset_/g)).toHaveLength(1);
            expect(requestLines(result)).toEqual([
                'GET /api/a HTTP/1.1',
                'POST /api/b HTTP/1.1',
                "PATCH /api/b('1') HTTP/1.1",
                'GET /api/c HTTP/1.1',
            ]);
            expect(result.endsWith('--batch_884--')).toBe(true);
        } finally {
            restore();
        }
    });

    test('a retrieve part never contains changeset delimiters, a changeset part always does', () => {
        const restore = makeRandomMock(1);
        try {
            const result = operationsToBatch([{ url: '/only-get' }], '884', ACCEPT_JSON);
            expect(result).not.toContain('changeset');
            expect(result).toBe(
                wire(
                    '--batch_884',
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'GET /only-get HTTP/1.1',
                    'Accept: application/json',
                    '',
                    '',
                    '--batch_884--'
                )
            );
        } finally {
            restore();
        }
    });

    test('Content-ID inside an operations changeset is emitted in MIME headers', () => {
        const restore = makeRandomMock(1);
        try {
            const result = operationsToBatch(
                [[{ method: 'POST', url: '/api/b', data: {}, contentId: '1' }]],
                '884',
                ACCEPT_JSON
            );
            expect(result).toContain(wire('Content-Transfer-Encoding: binary', 'Content-ID: 1', ''));
        } finally {
            restore();
        }
    });

    test('security: CRLF in an operations url or header is rejected', () => {
        const restore = makeRandomMock(1);
        try {
            expect(() => operationsToBatch([{ url: '/a\r\nX-Evil: 1' }], '884', ACCEPT_JSON)).toThrow(
                'must not contain line breaks'
            );
            expect(() =>
                operationsToBatch(
                    [[{ method: 'POST', url: '/b', data: {}, headers: { 'x-a': 'v\r\nX: 2' } }]],
                    '884',
                    ACCEPT_JSON
                )
            ).toThrow('must not contain line breaks');
        } finally {
            restore();
        }
    });

    test.each([
        [[[] as Call[]] as (RetrieveCall | Call[])[]],
        [[{ url: '/a', method: 'POST' } as unknown as RetrieveCall]],
        [['not-a-part' as unknown as RetrieveCall]],
    ])('rejects an invalid operations part instead of emitting a malformed batch %#', (operations) => {
        expect(() => operationsToBatch(operations as (RetrieveCall | Call[])[], '884', ACCEPT_JSON)).toThrow();
    });

    test('duplicate contentId within one operations changeset is rejected', () => {
        const restore = makeRandomMock(1);
        try {
            expect(() =>
                operationsToBatch(
                    [
                        [
                            { method: 'POST', url: '/a', data: {}, contentId: '1' },
                            { method: 'POST', url: '/b', data: {}, contentId: '1' },
                        ],
                    ],
                    '884',
                    ACCEPT_JSON
                )
            ).toThrow('Duplicate contentId');
        } finally {
            restore();
        }
    });

    test('deterministic property: mixed ordering and part counts are preserved across seeds', () => {
        for (const seed of [1, 7, 42, 1337, 99991]) {
            const rand = lcg(seed);
            const restore = makeRandomMock(rand() * 100);
            try {
                const parts: (RetrieveCall | Call[])[] = Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
                    rand() < 0.5
                        ? ({ url: `/g/${Math.floor(rand() * 100)}` } as RetrieveCall)
                        : ([{ method: 'POST', url: `/p/${Math.floor(rand() * 100)}`, data: { n: rand() } }] as Call[])
                );
                const expected = parts.map((part) =>
                    Array.isArray(part) ? `POST ${part[0].url} HTTP/1.1` : `GET ${part.url} HTTP/1.1`
                );
                const result = operationsToBatch(parts, '884', ACCEPT_JSON);
                expect(requestLines(result)).toEqual(expected);
                expect(result.match(/^--batch_884--$/gm)).toHaveLength(1);
            } finally {
                restore();
            }
        }
    });
});

describe('ODataBatch mixed operations mode', () => {
    test('exposes operations and derives a mixed grouped layout snapshot', async () => {
        const result = [{ kind: 'retrieve', partIndex: 0, response: { code: '200' } }];
        const repo = { send: jest.fn(), sendGrouped: jest.fn().mockResolvedValue(result) };
        const batch = new api.ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                operations: [{ url: '/a' }, [{ method: 'POST', url: '/b', data: {} }], { url: '/c' }],
            } as any,
            repo
        );

        await (batch as any).sendGrouped();

        expect(repo.sendGrouped.mock.calls[0][4]).toEqual([
            { kind: 'retrieve' },
            { kind: 'changeset', operationCount: 1 },
            { kind: 'retrieve' },
        ]);
    });

    test('legacy calls/retrieve remain mutually exclusive with operations', () => {
        const opts = { url: 'http://x/batch', auth: 'user:pass' };
        expect(
            () =>
                new api.ODataBatch(
                    { ...opts, operations: [{ url: '/a' }], calls: [{ method: 'GET', url: '/b', data: {} }] } as any,
                    new DummyBatchRepo()
                )
        ).toThrow();
        expect(
            () =>
                new api.ODataBatch(
                    { ...opts, operations: [{ url: '/a' }], retrieve: [{ url: '/b' }] } as any,
                    new DummyBatchRepo()
                )
        ).toThrow();
    });

    test.each([[undefined], [[] as (RetrieveCall | Call[])[]]])(
        'rejects missing or empty operations %#',
        (operations) => {
            expect(
                () =>
                    new api.ODataBatch(
                        { url: 'http://x/batch', auth: 'user:pass', operations } as any,
                        new DummyBatchRepo()
                    )
            ).toThrow();
        }
    );

    test('end-to-end: a mixed request is posted once and its mixed response parses in order', async () => {
        // Arrange - a mirrored response: GET, changeset, GET
        const body = wire(
            '--batch_884',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"kind":"get"}',
            '',
            '--batch_884',
            'Content-Type: multipart/mixed; boundary=changeset_1',
            '',
            '--changeset_1',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 204 No Content',
            '',
            '',
            '--changeset_1--',
            '--batch_884',
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"kind":"get2"}',
            '',
            '--batch_884--'
        );

        const repo = {
            send: jest
                .fn()
                .mockResolvedValue(
                    createBatchResponse(
                        BatchResponse,
                        { data: body, headers: { 'content-type': 'multipart/mixed; boundary=batch_884' } },
                        'application/json'
                    ).response
                ),
            sendGrouped: jest
                .fn()
                .mockResolvedValue(
                    (
                        createBatchResponse(
                            BatchResponse,
                            { data: body, headers: { 'content-type': 'multipart/mixed; boundary=batch_884' } },
                            'application/json'
                        ) as any
                    ).parseGrouped([
                        { kind: 'retrieve' },
                        { kind: 'changeset', operationCount: 1 },
                        { kind: 'retrieve' },
                    ])
                ),
        };

        const restore = makeRandomMock(1);
        try {
            const batch = new api.ODataBatch(
                {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    operations: [{ url: '/a' }, [{ method: 'POST', url: '/b', data: { x: 1 } }], { url: '/c' }],
                } as any,
                repo
            );

            // Act
            const flat = await batch.send();
            const grouped = await (batch as any).sendGrouped();

            // Assert - one POST, ordered flat results, semantic groups
            expect(repo.send).toHaveBeenCalledTimes(1);
            expect(repo.sendGrouped).toHaveBeenCalledTimes(1);
            expect(flat.map((r: any) => r.code)).toEqual(['200', '204', '200']);
            expect(grouped.map((g: any) => g.kind)).toEqual(['retrieve', 'changeset', 'retrieve']);
            expect(grouped[1].responses.map((r: any) => r.code)).toEqual(['204']);
        } finally {
            restore();
        }
    });
});

describe('operationsToBatch() byte-exact wire and branch coverage', () => {
    const mixed: (RetrieveCall | Call[])[] = [
        { url: '/api/a' },
        [{ method: 'POST', url: '/api/b', data: { id: 1 } }],
        { url: '/api/c' },
    ];

    test('emits the exact direct part and changeset block bytes for a mixed batch', () => {
        const restore = makeRandomMock(11.63);
        try {
            const result = operationsToBatch(mixed, '884', ACCEPT_JSON);

            expect(result).toContain(
                '--batch_884\r\n' +
                    'Content-Type: application/http\r\n' +
                    'Content-Transfer-Encoding: binary\r\n' +
                    '\r\n' +
                    'GET /api/a HTTP/1.1\r\n' +
                    'Accept: application/json\r\n\r\n'
            );
            expect(result).toContain(
                '--batch_884\r\n' +
                    'Content-Type: multipart/mixed; boundary=changeset_11.63_0\r\n' +
                    '\r\n' +
                    '--changeset_11.63_0\r\n' +
                    'Content-Type: application/http\r\n' +
                    'Content-Transfer-Encoding: binary\r\n' +
                    '\r\n' +
                    'POST /api/b HTTP/1.1\r\n' +
                    'Content-Type: application/json\r\n' +
                    'Accept: application/json\r\n' +
                    '\r\n' +
                    '{"id":1}\r\n' +
                    '\r\n' +
                    '--changeset_11.63_0--'
            );
        } finally {
            restore();
        }
    });

    test('rerolls the changeset boundary when a payload collides with it', () => {
        const restore = makeRandomSequenceMock([11, 11, 22]);
        try {
            const result = operationsToBatch(
                [[{ method: 'POST', url: '/b', data: '--changeset_11' }]],
                '884',
                ACCEPT_JSON
            );
            expect(result).toContain('boundary=changeset_22_0');
            expect(result).not.toContain('boundary=changeset_11');
        } finally {
            restore();
        }
    });

    test('gives up after bounded collision attempts', () => {
        const restore = makeRandomSequenceMock([11]);
        try {
            expect(() =>
                operationsToBatch([[{ method: 'POST', url: '/b', data: '--changeset_11' }]], '884', ACCEPT_JSON)
            ).toThrow('Unable to generate a changeset boundary that does not collide with the payload');
        } finally {
            restore();
        }
    });

    test('rejects an empty operations array, empty changeset, and invalid parts with exact messages', () => {
        const restore = makeRandomMock(1);
        try {
            expect(() => operationsToBatch([], '884', ACCEPT_JSON)).toThrow('No calls have been passed');
            expect(() => operationsToBatch([[]], '884', ACCEPT_JSON)).toThrow('No calls have been passed');
            expect(() => operationsToBatch([null as unknown as RetrieveCall], '884', ACCEPT_JSON)).toThrow(
                'Invalid batch operation part'
            );
            expect(() => operationsToBatch(['x' as unknown as RetrieveCall], '884', ACCEPT_JSON)).toThrow(
                'Invalid batch operation part'
            );
        } finally {
            restore();
        }
    });

    test.each([['text/xml'], ['application/atom+xml'], ['application/xml;charset=utf-8'], ['TEXT/XML']])(
        'serializes %s changeset bodies verbatim, never as JSON',
        (contentType) => {
            const restore = makeRandomMock(1);
            try {
                const result = operationsToBatch([[{ method: 'POST', url: '/b', data: '<entry/>' }]], '884', {
                    contentType,
                    accept: contentType,
                });
                expect(result).toContain('\r\n\r\n<entry/>\r\n');
                expect(result).not.toContain('"<entry/>"');
            } finally {
                restore();
            }
        }
    );

    test('serializes JSON changeset bodies with JSON.stringify even with parameters', () => {
        const restore = makeRandomMock(1);
        try {
            const result = operationsToBatch([[{ method: 'POST', url: '/b', data: { a: 1 } }]], '884', {
                contentType: 'application/json;odata=verbose',
                accept: 'application/json',
            });
            expect(result).toContain('\r\n\r\n{"a":1}\r\n');
        } finally {
            restore();
        }
    });
});
