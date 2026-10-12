import * as api from '../src/index';
import { BatchResponse } from '../src/response';
import { DummyBatchRepo } from './helpers';

const wire = (...lines: string[]): string => lines.join('\r\n');
const http = (boundary: string, code = '200', contentId?: string): string[] => [
    `--${boundary}`,
    'Content-Type: application/http',
    ...(contentId ? [`Content-ID: ${contentId}`] : []),
    '',
    `HTTP/1.1 ${code} ${code === '400' ? 'Bad Request' : 'OK'}`,
    '',
    '{"ok":true}',
    '',
];
const changeset = (boundary: string, count: number): string[] => [
    '--batch',
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    '',
    ...Array.from({ length: count }, (_, i) => http(boundary, '200', String(i + 1))).flat(),
    `--${boundary}--`,
];
const failureThenSuccess = wire(...http('batch', '400'), ...changeset('cs', 2), '--batch--');
const parse = (data: string) =>
    new BatchResponse({ data, headers: { 'content-type': 'multipart/mixed; boundary=batch' } }, 'application/json');
const layout: api.BatchRequestLayout = [
    { kind: 'changeset', operationCount: 3 },
    { kind: 'changeset', operationCount: 2 },
];

describe('grouped response semantics', () => {
    test('package entrypoint exposes the grouped-capable parser without changing the flat factory', () => {
        expect(api.BatchResponse).toBe(BatchResponse);
        expect(typeof api.createBatchResponse).toBe('function');
    });

    test('a collapsed three-operation failure retains identity before a successful two-operation group', () => {
        const parser = parse(failureThenSuccess);
        const groups: api.BatchResponseGroup[] = parser.parseGrouped(layout);
        expect(groups).toHaveLength(2);
        expect(groups[0]).toEqual({ kind: 'changeset-error', partIndex: 0, error: parser.response[0] });
        expect(groups[0]).not.toHaveProperty('responses');
        expect(groups[1]).toEqual({ kind: 'changeset', partIndex: 1, responses: parser.response.slice(1) });
        if (groups[1].kind !== 'changeset') throw new Error('Expected a changeset group');
        expect(groups[1].responses.map((r) => r.contentId)).toEqual(['1', '2']);
        expect(parser.response).toHaveLength(3); // No five-operation fake expansion.
    });

    test('raw grouping preserves multipart identity but leaves a top-level HTTP error unclassified', () => {
        const parser = parse(failureThenSuccess);
        expect((parser as any).groupedResponse).toEqual([
            { kind: 'unclassified', partIndex: 0, response: parser.response[0] },
            { kind: 'changeset', partIndex: 1, responses: parser.response.slice(1) },
        ]);
    });

    test('explicit mixed layout distinguishes a GET error from a changeset failure', () => {
        const parser = parse(
            wire(...http('batch', '400'), ...http('batch', '400'), ...changeset('cs', 2), '--batch--')
        );
        const mixed = [
            { kind: 'retrieve' },
            { kind: 'changeset', operationCount: 3 },
            { kind: 'changeset', operationCount: 2 },
        ];
        const groups = (parser as any).parseGrouped(mixed);
        expect(groups.map((g: any) => [g.kind, g.partIndex])).toEqual([
            ['retrieve', 0],
            ['changeset-error', 1],
            ['changeset', 2],
        ]);
        expect(groups[0].response.success).toBe(false);
        expect(groups[1].error.success).toBe(false);
    });

    test('a single nested child error remains a child response without request context', () => {
        const parser = parse(
            wire(
                '--batch',
                'Content-Type: multipart/mixed; boundary=cs',
                '',
                ...http('cs', '400'),
                '--cs--',
                '--batch--'
            )
        );
        expect((parser as any).groupedResponse[0]).toEqual({
            kind: 'changeset',
            partIndex: 0,
            responses: parser.response,
        });
    });

    test.each([
        [[{ kind: 'changeset', operationCount: 3 }], 'Grouped response part count does not match request layout'],
        [[{ kind: 'retrieve' }, { kind: 'retrieve' }], 'Grouped response changeset does not match retrieve layout'],
        [
            [
                { kind: 'changeset', operationCount: 3 },
                { kind: 'changeset', operationCount: 1 },
            ],
            'Grouped response changeset operation count does not match request layout',
        ],
        [
            [
                { kind: 'changeset', operationCount: 0 },
                { kind: 'changeset', operationCount: 2 },
            ],
            'Grouped response has invalid request layout',
        ],
        [
            [{ kind: 'unknown' }, { kind: 'changeset', operationCount: 2 }],
            'Grouped response has invalid request layout',
        ],
    ])('rejects inconsistent layout %j with the exact message', (invalidLayout, message) => {
        expect(() => (parse(failureThenSuccess) as any).parseGrouped(invalidLayout)).toThrow(message as string);
    });

    test('does not accept a successful direct HTTP response as a changeset failure', () => {
        expect(() =>
            (parse(wire(...http('batch'), '--batch--')) as any).parseGrouped([{ kind: 'changeset', operationCount: 1 }])
        ).toThrow('Grouped response expected a multipart changeset or whole-changeset HTTP error');
    });

    test('empty raw batches are empty but cannot satisfy a nonempty request layout', () => {
        const parser = parse('');
        expect((parser as any).parseGrouped()).toEqual([]);
        expect(() => (parser as any).parseGrouped([{ kind: 'retrieve' }])).toThrow(
            'Grouped response part count does not match request layout'
        );
        expect((parse('--batch--') as any).parseGrouped([])).toEqual([]);
    });

    test.each([
        [wire(...http('batch')), 'Grouped response multipart is missing a matching closing boundary'],
        [wire(...http('wrong'), '--wrong--'), 'Grouped response multipart is missing a matching closing boundary'],
        [
            wire('--batch', 'Content-Type: multipart/mixed', '', ...http('cs'), '--batch--'),
            'Grouped response changeset is missing a valid boundary',
        ],
    ])('rejects unclosed or unmatched grouped boundaries with the exact message', (body, message) => {
        expect(() => (parse(body) as any).parseGrouped()).toThrow(message as string);
    });

    test('quoted literal boundaries and MIME header order are supported in grouped parsing', () => {
        const body = wire(
            '--batch',
            'Content-Type: multipart/mixed; boundary="cs+1"',
            '',
            '--cs+1',
            'content-id: 1',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 200 OK',
            '',
            '{}',
            '--cs+1--',
            '--batch--'
        );
        const groups = (parse(body) as any).parseGrouped([{ kind: 'changeset', operationCount: 1 }]);
        expect(groups[0].responses[0]).toMatchObject({ contentId: '1', data: {}, changesetIndex: 0 });
    });

    test.each([
        [
            wire('--batch', 'Content-Type: text/plain', '', 'HTTP/1.1 200 OK', '', '{}', '--batch--'),
            'Grouped response expected an application/http response with a valid status line',
        ],
        [
            wire('--batch', 'Content-Type: application/http', '', 'not an HTTP status', '', '{}', '--batch--'),
            'Grouped response expected an application/http response with a valid status line',
        ],
        [
            wire('--batch', 'Content-Type: multipart/mixed', '', ...http('cs'), '--cs--', '--batch--'),
            'Grouped response changeset is missing a valid boundary',
        ],
    ])(
        'strict grouped parsing rejects unsupported MIME types, invalid statuses, and missing nested boundaries',
        (body, message) => {
            expect(() => (parse(body) as any).parseGrouped()).toThrow(message as string);
        }
    );
});

describe('grouped MIME and status-line branches', () => {
    test('accepts HTTP/1.0 and HTTP/1.1 status lines but rejects HTTP/2', () => {
        const ok10 = wire('--batch', 'Content-Type: application/http', '', 'HTTP/1.0 200 OK', '', '{}', '--batch--');
        expect((parse(ok10) as any).parseGrouped([{ kind: 'retrieve' }])).toHaveLength(1);

        const bad2 = wire('--batch', 'Content-Type: application/http', '', 'HTTP/2 200 OK', '', '{}', '--batch--');
        expect(() => (parse(bad2) as any).parseGrouped([{ kind: 'retrieve' }])).toThrow(
            'Grouped response expected an application/http response with a valid status line'
        );
    });

    test('a part missing the MIME header separation is rejected with the exact message', () => {
        const parser = parse(
            wire('--batch', 'Content-Type: application/http', '', 'HTTP/1.1 200 OK', '', '{}', '--batch--')
        );
        expect(() => (parser as any).readGroupedMime('Content-Type: application/http\r\n')).toThrow(
            'Grouped response part is missing MIME header separation'
        );
    });

    test('a part missing Content-Type is rejected with the exact message', () => {
        const body = wire('--batch', 'Content-ID: 1', '', 'HTTP/1.1 200 OK', '', '{}', '--batch--');
        expect(() => (parse(body) as any).parseGrouped()).toThrow('Grouped response part is missing Content-Type');
    });

    test('an unquoted boundary with trailing parameters is recognized', () => {
        const body = wire(
            '--batch',
            'Content-Type: multipart/mixed; boundary=cs+1; charset=utf-8',
            '',
            '--cs+1',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 200 OK',
            '',
            '{}',
            '--cs+1--',
            '--batch--'
        );
        const groups = (parse(body) as any).parseGrouped([{ kind: 'changeset', operationCount: 1 }]);
        expect(groups[0].kind).toBe('changeset');
        expect(groups[0].responses).toHaveLength(1);
    });

    test.each(['bad\nboundary', 'bad\rboundary'])('a boundary containing a line break is rejected', (boundary) => {
        const body = wire('--batch', 'Content-Type: application/http', '', 'HTTP/1.1 200 OK', '', '{}', '--batch--');
        const parser = parse(body);
        expect(() => (parser as any).splitGroupedMultipart(body, boundary)).toThrow(
            'Grouped response has an invalid multipart boundary'
        );
    });
});

describe('optional grouped repository capability', () => {
    test('legacy custom repositories still support flat send and reject grouped send before transport', async () => {
        const repo = new DummyBatchRepo();
        const batch = new api.ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'POST', url: '/Items', data: {} }],
            },
            repo
        );
        const send = jest.spyOn(repo, 'send');
        await expect((batch as any).sendGrouped()).rejects.toThrow('Repository does not support grouped responses');
        expect(send).not.toHaveBeenCalled();
        expect(await batch.send()).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])(
        'capable custom repository receives a request layout snapshot with retrieve=%s',
        async (retrieve) => {
            const result = [{ kind: 'retrieve', partIndex: 0, response: { code: '200' } }];
            const repo = { send: jest.fn(), sendGrouped: jest.fn().mockResolvedValue(result) };
            const calls = [
                [{ method: 'POST', url: '/Items', data: {} }],
                [{ method: 'POST', url: '/Lines', data: {} }],
            ];
            const batch = new api.ODataBatch(
                {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    ...(retrieve ? { retrieve: [{ url: '/Items' }, { url: '/Lines' }] } : { calls }),
                },
                repo
            );
            calls[0].push({ method: 'POST', url: '/ignored-after-construction', data: {} });
            expect(await (batch as any).sendGrouped()).toBe(result);
            expect(repo.send).not.toHaveBeenCalled();
            expect(repo.sendGrouped).toHaveBeenCalledTimes(1);
            const args = repo.sendGrouped.mock.calls[0];
            expect(args[0]).toBe('http://example.com/batch');
            expect(args[2].headers.Accept).toBe('application/json');
            expect(args[4]).toEqual(
                retrieve
                    ? [{ kind: 'retrieve' }, { kind: 'retrieve' }]
                    : [
                          { kind: 'changeset', operationCount: 1 },
                          { kind: 'changeset', operationCount: 1 },
                      ]
            );
        }
    );

    test('legacy flat calls form one contextual changeset, not one group per operation', async () => {
        const repo = { send: jest.fn(), sendGrouped: jest.fn().mockResolvedValue([]) };
        const batch = new api.ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: Array.from({ length: 3 }, () => ({ method: 'POST', url: '/Items', data: {} })),
            },
            repo
        );
        await (batch as any).sendGrouped();
        expect(repo.sendGrouped.mock.calls[0][4]).toEqual([{ kind: 'changeset', operationCount: 3 }]);
        expect(repo.send).not.toHaveBeenCalled();
    });
});
