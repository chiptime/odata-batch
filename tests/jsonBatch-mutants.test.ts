import { operationsToJsonBatch, JsonBatchResponse } from '../src/jsonBatch';
import { Call } from '../src/request';

const ACCEPT = 'application/json';

const call = (url: string, extra: Partial<Call> = {}): Call => ({ method: 'POST', url, data: {}, ...extra });
const requestsOf = (body: string): any[] => JSON.parse(body).requests;
const responseOf = (responses: unknown[], requestIds?: string[][]): JsonBatchResponse =>
    new JsonBatchResponse({ data: JSON.stringify({ responses }), headers: {} }, ACCEPT, requestIds);

describe('operationsToJsonBatch mutation kills', () => {
    test('double base64 padding is stripped: a one-byte body serializes unpadded', () => {
        const { body } = operationsToJsonBatch([
            [call('/A', { data: Buffer.from('a'), headers: { 'content-type': 'application/octet-stream' } })],
        ]);
        // Buffer.from('a') is 'YQ==' in base64; base64url strips both padding chars
        expect(requestsOf(body)[0].body).toBe('YQ');
    });

    test('a one-byte Uint8Array exercises the + and / alphabet replacements unpadded', () => {
        const { body } = operationsToJsonBatch([
            [call('/A', { data: new Uint8Array([0xfb]), headers: { 'content-type': 'application/octet-stream' } })],
        ]);
        // 0xfb is '+w==' in base64; URL-safe and unpadded it becomes '-w'
        expect(requestsOf(body)[0].body).toBe('-w');
    });

    test('two changesets take the lowest free group names in order', () => {
        const { body } = operationsToJsonBatch([[call('/A')], [call('/B')]]);
        expect(requestsOf(body).map((request) => request.atomicityGroup)).toEqual(['group1', 'group2']);
    });

    test('retrieve operations are validated: unsafe urls and headers throw', () => {
        expect(() => operationsToJsonBatch([{ url: '/a\nb' }])).toThrow(
            'Call url must not contain line breaks: "/a\\nb"'
        );
        expect(() => operationsToJsonBatch([{ url: '/ok', headers: { 'x-h': 'bad\nv' } }])).toThrow(
            "Call header 'x-h' must not contain line breaks"
        );
    });
});

describe('JsonBatchResponse mutation kills', () => {
    test('an envelope that is not an object is rejected even when it carries a responses array', () => {
        const fn = (() => 'x') as unknown as { responses?: unknown };
        fn.responses = [];
        expect(() => new JsonBatchResponse({ data: fn as unknown as object, headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
    });

    test('success follows the exact status boundary: 400 fails, 404 fails, 201 succeeds', () => {
        const parsed = responseOf([{ status: 400 }, { status: 404 }, { status: 201 }]);
        expect(parsed.response.map(({ code, success }) => ({ code, success }))).toEqual([
            { code: '400', success: false },
            { code: '404', success: false },
            { code: '201', success: true },
        ]);
    });

    test('a non-string id is not adopted as contentId', () => {
        const parsed = responseOf([{ id: 5, status: 200 }]);
        expect(parsed.response[0].contentId).toBeUndefined();
    });

    test('a non-string atomicityGroup is ignored: same-group responses stay standalone', () => {
        const parsed = responseOf([
            { status: 200, atomicityGroup: 7 },
            { status: 201, atomicityGroup: 7 },
        ]);
        expect(parsed.parseGrouped().map((unit) => unit.kind)).toEqual(['unclassified', 'unclassified']);
    });

    test('several responses without ids parse without a duplicate-id error', () => {
        const parsed = responseOf([{ status: 200 }, { status: 201 }]);
        expect(parsed.response.map(({ code }) => code)).toEqual(['200', '201']);
    });

    test('rollback detection anchors the full three-digit code at both ends', () => {
        // '4040' starts with 404 but is not a failure code; '-404' ends with 404 but is < 400
        const parsed = responseOf([
            { status: 4040, atomicityGroup: 'g' },
            { status: -404, atomicityGroup: 'g' },
            { status: 200, atomicityGroup: 'g' },
        ]);
        expect(parsed.response.map(({ success }) => success)).toEqual([false, true, true]);
    });

    test('group failure selection: an exact 4xx/5xx code wins over a later non-success', () => {
        const parsed = responseOf([
            { status: 4040, body: 'A', atomicityGroup: 'g' },
            { status: 500, body: 'B', atomicityGroup: 'g' },
        ]);
        expect(parsed.parseGrouped()[0]).toEqual({
            kind: 'changeset-error',
            partIndex: 0,
            error: expect.objectContaining({ code: '500', data: 'B' }),
        });
    });

    test('group failure selection: a non-exact code never wins over the first non-success', () => {
        const parsed = responseOf([
            { status: -404, body: 'A', atomicityGroup: 'g' },
            { status: 4040, body: 'B', atomicityGroup: 'g' },
        ]);
        expect(parsed.parseGrouped()[0]).toEqual({
            kind: 'changeset-error',
            partIndex: 0,
            error: expect.objectContaining({ code: '4040', data: 'B' }),
        });
    });

    test('a standalone response under a changeset layout errors unless the code is exactly 4xx/5xx', () => {
        const standalone = (status: number) =>
            new JsonBatchResponse({ data: JSON.stringify({ responses: [{ status }] }), headers: {} }, ACCEPT);
        expect(() => standalone(4040).parseGrouped([{ kind: 'changeset', operationCount: 1 }])).toThrow(
            'Grouped response expected a multipart changeset or whole-changeset HTTP error'
        );
        expect(() => standalone(-404).parseGrouped([{ kind: 'changeset', operationCount: 1 }])).toThrow(
            'Grouped response expected a multipart changeset or whole-changeset HTTP error'
        );
    });

    test('a missing response id only degrades to an omitted entry after a real 4xx/5xx failure', () => {
        // Neither '-404' nor '4040' is a failure code, so the missing id '2' must throw
        expect(() =>
            responseOf(
                [
                    { id: '1', status: -404 },
                    { id: '3', status: 4040 },
                ],
                [['1', '2', '3']]
            )
        ).toThrow('JSON batch response does not match request ids: 2');
    });

    test('a requestIds chunk with several responses is an atomicity group even without atomicityGroup fields', () => {
        const parsed = responseOf(
            [
                { id: '1', status: 200 },
                { id: '2', status: 201 },
            ],
            [['1', '2']]
        );
        expect(parsed.parseGrouped()).toEqual([
            {
                kind: 'changeset',
                partIndex: 0,
                responses: [expect.objectContaining({ code: '200' }), expect.objectContaining({ code: '201' })],
            },
        ]);
    });
});
