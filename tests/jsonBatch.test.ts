import { operationsToJsonBatch, JsonBatchResponse, createJsonBatchResponseParser } from '../src/jsonBatch';
import { BatchOperation, Call } from '../src/request';
import { createBatchResponse, BatchRequestLayout } from '../src/response';

const ACCEPT = 'application/json';

const call = (url: string, extra: Partial<Call> = {}): Call => ({ method: 'POST', url, data: {}, ...extra });

const requestsOf = (body: string): any[] => JSON.parse(body).requests;

const responseOf = (responses: unknown[], requestIds?: string[][]): JsonBatchResponse =>
    new JsonBatchResponse({ data: JSON.stringify({ responses }), headers: {} }, ACCEPT, requestIds);

describe('operationsToJsonBatch (S6 request serialization)', () => {
    test('maps a retrieve operation to a JSON get request with an assigned id', () => {
        const { body, requestIds } = operationsToJsonBatch([{ url: '/Customers' }], { accept: ACCEPT });

        expect(typeof body).toBe('string');
        expect(Object.keys(JSON.parse(body))).toEqual(['requests']);
        expect(requestsOf(body)).toEqual([{ id: '1', method: 'get', url: '/Customers', headers: { accept: ACCEPT } }]);
        expect(requestIds).toEqual([['1']]);
    });

    test('maps changeset members with atomicityGroup, lowercased method, JSON content-type and inline body', () => {
        const { body, requestIds } = operationsToJsonBatch(
            [[call('/A', { data: { name: 'x' } }), call('/B', { method: 'PATCH' })]],
            { accept: ACCEPT }
        );

        expect(requestsOf(body)).toEqual([
            {
                id: '1',
                atomicityGroup: 'group1',
                method: 'post',
                url: '/A',
                headers: { 'content-type': ACCEPT, accept: ACCEPT },
                body: { name: 'x' },
            },
            {
                id: '2',
                atomicityGroup: 'group1',
                method: 'patch',
                url: '/B',
                headers: { 'content-type': ACCEPT, accept: ACCEPT },
                body: {},
            },
        ]);
        expect(requestIds).toEqual([['1', '2']]);
    });

    test('rejects empty or non-array operations', () => {
        expect(() => operationsToJsonBatch([])).toThrow('No calls have been passed');
        expect(() => operationsToJsonBatch(undefined as unknown as BatchOperation[])).toThrow(
            'No calls have been passed'
        );
    });

    test('rejects an empty changeset', () => {
        expect(() => operationsToJsonBatch([[]])).toThrow('No calls have been passed');
    });

    test('rejects a non-object, non-changeset operation part', () => {
        expect(() => operationsToJsonBatch([null as unknown as BatchOperation])).toThrow(
            'Invalid batch operation part'
        );
        expect(() => operationsToJsonBatch([42 as unknown as BatchOperation])).toThrow('Invalid batch operation part');
    });

    test('reuses the GET-inside-changeset guard', () => {
        expect(() => operationsToJsonBatch([[call('/A', { method: 'GET' })]])).toThrow(
            'GET is not allowed inside a changeset; use retrieve or operations'
        );
    });

    test('assigns ids to retrieves and members from one free-number sequence, keeping explicit ids', () => {
        const { body, requestIds } = operationsToJsonBatch(
            [{ url: '/R' }, [call('/A', { contentId: '5' }), call('/B')], [call('/C')]],
            { accept: ACCEPT }
        );

        expect(requestIds).toEqual([['1'], ['5', '2'], ['3']]);
        expect(requestsOf(body).map((request) => request.id)).toEqual(['1', '5', '2', '3']);
    });

    test('rejects duplicate contentId across changesets', () => {
        expect(() =>
            operationsToJsonBatch([[call('/A', { contentId: 'x' })], [call('/B', { contentId: 'x' })]])
        ).toThrow('Duplicate contentId within the batch: x');
    });

    test('rejects duplicate contentId inside one changeset', () => {
        expect(() => operationsToJsonBatch([[call('/A', { contentId: 'x' }), call('/B', { contentId: 'x' })]])).toThrow(
            'Duplicate contentId within a changeset: x'
        );
    });

    test('atomicity group names never collide with any request id', () => {
        const { body } = operationsToJsonBatch([[call('/A', { contentId: 'group1' })], [call('/B')]], {});

        expect(requestsOf(body).map((request) => request.atomicityGroup)).toEqual(['group2', 'group3']);
    });

    test('passes dependsOn through when it references earlier request ids or groups', () => {
        const { body } = operationsToJsonBatch(
            [
                { url: '/R' },
                [call('/A', { contentId: 'first', dependsOn: [] })],
                [call('/B', { dependsOn: ['1', 'group1'] })],
            ],
            {}
        );

        expect(requestsOf(body)[2].dependsOn).toEqual(['1', 'group1']);
        expect(requestsOf(body)[1].dependsOn).toEqual([]);
    });

    test('rejects own-group and cross-group member dependencies but allows earlier same-group members', () => {
        for (const operations of [
            [[call('/A'), call('/B', { dependsOn: ['group1'] })]],
            [[call('/A', { contentId: 'first' })], [call('/B', { dependsOn: ['first'] })]],
        ]) {
            expect(() => operationsToJsonBatch(operations)).toThrow(/dependsOn/);
        }
        expect(() =>
            operationsToJsonBatch([[call('/A', { contentId: 'first' }), call('/B', { dependsOn: ['first'] })]])
        ).not.toThrow();
    });

    test('rejects dependsOn pointing at an unknown id or group', () => {
        expect(() => operationsToJsonBatch([[call('/A', { dependsOn: ['nope'] })]])).toThrow(
            'dependsOn must reference an earlier request id or atomicity group: nope'
        );
    });

    test('rejects forward and self references in dependsOn', () => {
        expect(() => operationsToJsonBatch([[call('/A', { dependsOn: ['2'] }), call('/B')]])).toThrow(
            'dependsOn must reference an earlier request id or atomicity group: 2'
        );
        expect(() => operationsToJsonBatch([[call('/A', { dependsOn: ['group1'] })]])).toThrow(
            'dependsOn must reference an earlier request id or atomicity group: group1'
        );
    });

    test('batch accept replaces any caller accept (case-insensitive); other headers pass through lowercased', () => {
        const { body } = operationsToJsonBatch(
            [[call('/A', { headers: { Accept: 'text/plain', 'CONTENT-TYPE': 'text/plain', 'X-Token': 7 } })]],
            { accept: ACCEPT }
        );

        expect(requestsOf(body)[0].headers).toEqual({ accept: ACCEPT, 'content-type': ACCEPT, 'x-token': '7' });
    });

    test('caller accept survives when no batch accept is given', () => {
        const { body } = operationsToJsonBatch([[call('/A', { headers: { accept: 'text/csv' } })]], {});

        expect(requestsOf(body)[0].headers).toEqual({ accept: 'text/csv', 'content-type': ACCEPT });
    });

    test('binary Buffer data becomes an unpadded base64url body with its own content-type', () => {
        const { body } = operationsToJsonBatch(
            [[call('/A', { data: Buffer.from('hi'), headers: { 'Content-Type': 'application/octet-stream' } })]],
            {}
        );

        expect(requestsOf(body)[0]).toEqual({
            id: '1',
            atomicityGroup: 'group1',
            method: 'post',
            url: '/A',
            headers: { 'content-type': 'application/octet-stream' },
            body: 'aGk',
        });
    });

    test('binary Uint8Array data uses the URL-safe base64url alphabet', () => {
        const { body } = operationsToJsonBatch(
            [[call('/A', { data: new Uint8Array([0xfb, 0xff, 0xbf]), headers: { 'Content-Type': 'image/png' } })]],
            {}
        );

        expect(requestsOf(body)[0].body).toBe('-_-_');
    });

    test('binary data without its own Content-Type throws', () => {
        expect(() => operationsToJsonBatch([[call('/A', { data: Buffer.from('hi') })]])).toThrow(
            'Binary call data requires its own Content-Type header'
        );
    });

    test('data undefined omits the body member and keeps a bodyless caller content-type', () => {
        const { body } = operationsToJsonBatch(
            [[call('/A', { data: undefined, headers: { 'Content-Type': 'foo/bar' } })]],
            {}
        );

        expect(requestsOf(body)[0]).toEqual({
            id: '1',
            atomicityGroup: 'group1',
            method: 'post',
            url: '/A',
            headers: { 'content-type': 'foo/bar' },
        });
    });

    test('retrieve caller content-type is dropped, like multipart direct parts', () => {
        const { body } = operationsToJsonBatch(
            [{ url: '/R', headers: { 'Content-Type': 'text/plain', Accept: 'text/csv' } }],
            {}
        );

        expect(requestsOf(body)[0].headers).toEqual({ accept: 'text/csv' });
    });

    test('caller operations are never mutated', () => {
        const operations: BatchOperation[] = [[call('/A')], { url: '/R' }];
        operationsToJsonBatch(operations, {});

        expect((operations[0] as Call[])[0].contentId).toBeUndefined();
        expect(operations[1]).toEqual({ url: '/R' });
    });
});

describe('JsonBatchResponse (S6 response parsing)', () => {
    test('parses a string body and maps every field', () => {
        const parsed = new JsonBatchResponse(
            {
                data: JSON.stringify({
                    responses: [
                        {
                            id: '1',
                            status: 201,
                            headers: { location: '/X(1)', 'content-length': 42 },
                            body: { Id: 1 },
                        },
                    ],
                }),
                headers: {},
            },
            ACCEPT
        );

        expect(parsed.response).toEqual([
            {
                code: '201',
                status: '',
                headers: [
                    { key: 'location', value: '/X(1)' },
                    { key: 'content-length', value: '42' },
                ],
                data: { Id: 1 },
                success: true,
                contentId: '1',
                changesetIndex: 0,
            },
        ]);
    });

    test('accepts an already-parsed object body; missing body means data null and absent headers an empty list', () => {
        const parsed = new JsonBatchResponse({ data: { responses: [{ id: '1', status: 204 }] }, headers: {} }, ACCEPT);

        expect(parsed.response).toEqual([
            { code: '204', status: '', headers: [], data: null, success: true, contentId: '1', changesetIndex: 0 },
        ]);
    });

    test('non-integer or absent status yields an empty code and success false', () => {
        const parsed = responseOf([{ id: '1', status: '200' }, { id: '2' }, { id: '3', status: 4.5 }]);

        expect(parsed.response.map(({ code, success }) => ({ code, success }))).toEqual([
            { code: '', success: false },
            { code: '', success: false },
            { code: '', success: false },
        ]);
    });

    test('a malformed response item degrades to an empty unsuccessful response', () => {
        const parsed = responseOf([null]);

        expect(parsed.response).toEqual([
            { code: '', status: '', headers: [], data: null, success: false, changesetIndex: 0 },
        ]);
    });

    test('non-object header values yield an empty header list', () => {
        const parsed = responseOf([
            { id: '1', status: 200, headers: 'nope' },
            { id: '2', status: 200, headers: ['a'] },
        ]);

        expect(parsed.response.map(({ headers }) => headers)).toEqual([[], []]);
    });

    test('a body that is not valid JSON, or lacks a responses array, throws', () => {
        expect(() => new JsonBatchResponse({ data: '{nope', headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
        expect(() => new JsonBatchResponse({ data: JSON.stringify({}), headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
        expect(() => new JsonBatchResponse({ data: JSON.stringify({ responses: {} }), headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
        expect(() => new JsonBatchResponse({ data: null as unknown as object, headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
        expect(() => new JsonBatchResponse({ data: 42 as unknown as object, headers: {} }, ACCEPT)).toThrow(
            'Invalid JSON batch response'
        );
    });

    test('an empty accept is rejected, like the multipart parser', () => {
        expect(() => new JsonBatchResponse({ data: { responses: [] }, headers: {} }, '')).toThrow(
            'Need accept to know how parse.'
        );
    });

    test('with requestIds, responses are returned in request order with the operation index', () => {
        const parsed = responseOf(
            [
                { id: '3', status: 200, atomicityGroup: 'g1' },
                { id: '1', status: 200 },
                { id: '2', status: 201, atomicityGroup: 'g1' },
            ],
            [['1'], ['2', '3']]
        );

        expect(parsed.response.map(({ contentId }) => contentId)).toEqual(['1', '2', '3']);
        expect(parsed.response.map(({ changesetIndex }) => changesetIndex)).toEqual([0, 1, 1]);
    });

    test('an unknown response id throws', () => {
        expect(() => responseOf([{ id: '99', status: 200 }], [['1']])).toThrow(
            'JSON batch response does not match request ids: 99'
        );
    });

    test('a response without an id throws', () => {
        expect(() => responseOf([{ status: 200 }], [['1']])).toThrow(
            'JSON batch response does not match request ids: undefined'
        );
    });

    test('a request id without a response throws', () => {
        expect(() => responseOf([{ id: '1', status: 200 }], [['1'], ['2']])).toThrow(
            'JSON batch response does not match request ids: 2'
        );
    });

    test('duplicate response ids never overwrite an earlier result', () => {
        expect(() =>
            responseOf(
                [
                    { id: '1', status: 500 },
                    { id: '1', status: 200 },
                ],
                [['1']]
            )
        ).toThrow('JSON batch response does not match request ids: 1');
    });

    test('a failed group can omit rolled-back siblings without inventing responses', () => {
        const parsed = responseOf([{ id: '2', status: 409 }], [['1', '2']]);
        expect(parsed.response).toEqual([expect.objectContaining({ contentId: '2', code: '409', changesetIndex: 0 })]);
        expect(parsed.parseGrouped([{ kind: 'changeset', operationCount: 2 }])[0].kind).toBe('changeset-error');
    });

    test('a failed atomicity group never reports its rolled-back 2xx siblings as successful', () => {
        for (const ids of [undefined, [['1', '2']]]) {
            const parsed = responseOf(
                [
                    { id: '1', atomicityGroup: 'g', status: 201 },
                    { id: '2', atomicityGroup: 'g', status: 409 },
                ],
                ids
            );
            expect(parsed.response.map((r) => r.success)).toEqual([false, false]);
            expect(parsed.parseGrouped()[0]).toEqual({
                kind: 'changeset-error',
                partIndex: 0,
                error: expect.objectContaining({ contentId: '2', code: '409' }),
            });
        }
    });

    test('request layout disambiguates a successful singleton changeset with no atomicityGroup', () => {
        const parsed = responseOf([{ id: '1', status: 201 }], [['1']]);
        expect(parsed.parseGrouped([{ kind: 'changeset', operationCount: 1 }])).toEqual([
            { kind: 'changeset', partIndex: 0, responses: [expect.objectContaining({ code: '201' })] },
        ]);
    });

    test('without requestIds, service order is kept and changesetIndex follows first appearance', () => {
        const parsed = responseOf([
            { id: 'a', status: 200, atomicityGroup: 'g2' },
            { id: 'b', status: 200 },
            { id: 'c', status: 200, atomicityGroup: 'g1' },
            { id: 'd', status: 200, atomicityGroup: 'g2' },
            { id: 'e', status: 200 },
        ]);

        expect(parsed.response.map(({ contentId, changesetIndex }) => ({ contentId, changesetIndex }))).toEqual([
            { contentId: 'a', changesetIndex: 0 },
            { contentId: 'b', changesetIndex: 1 },
            { contentId: 'c', changesetIndex: 2 },
            { contentId: 'd', changesetIndex: 0 },
            { contentId: 'e', changesetIndex: 3 },
        ]);
    });
});

describe('JsonBatchResponse.parseGrouped (S6 grouped parsing)', () => {
    test('groups responses by atomicityGroup and marks standalones unclassified', () => {
        const parsed = responseOf([
            { id: '1', status: 200, atomicityGroup: 'g1' },
            { id: '2', status: 201, atomicityGroup: 'g1' },
            { id: '3', status: 200 },
        ]);

        expect(parsed.parseGrouped()).toEqual([
            { kind: 'changeset', partIndex: 0, responses: [parsed.response[0], parsed.response[1]] },
            { kind: 'unclassified', partIndex: 1, response: parsed.response[2] },
        ]);
    });

    test('a failed atomicity group becomes a single changeset-error with the first failing response', () => {
        // OData JSON Format 4.01, section 19.5: any failure inside an
        // atomicity group fails the whole group; 424 responses may appear
        // for members that were never attempted
        const parsed = responseOf([
            { id: '1', status: 200, atomicityGroup: 'g1' },
            { id: '2', status: 500, atomicityGroup: 'g1' },
            { id: '3', status: 424, atomicityGroup: 'g1' },
        ]);

        expect(parsed.parseGrouped()).toEqual([
            { kind: 'changeset-error', partIndex: 0, error: expect.objectContaining({ contentId: '2', code: '500' }) },
        ]);
    });

    test('non-adjacent responses of the same group merge into one unit', () => {
        const parsed = responseOf([
            { id: '1', status: 200, atomicityGroup: 'g1' },
            { id: '2', status: 200 },
            { id: '3', status: 201, atomicityGroup: 'g1' },
        ]);

        expect(parsed.parseGrouped()).toEqual([
            { kind: 'changeset', partIndex: 0, responses: [parsed.response[0], parsed.response[2]] },
            { kind: 'unclassified', partIndex: 1, response: parsed.response[1] },
        ]);
    });

    test('a layout classifies units as retrieve and changeset', () => {
        const parsed = responseOf([
            { id: '1', status: 200 },
            { id: '2', status: 200, atomicityGroup: 'g1' },
            { id: '3', status: 201, atomicityGroup: 'g1' },
        ]);

        expect(parsed.parseGrouped([{ kind: 'retrieve' }, { kind: 'changeset', operationCount: 2 }])).toEqual([
            { kind: 'retrieve', partIndex: 0, response: parsed.response[0] },
            { kind: 'changeset', partIndex: 1, responses: [parsed.response[1], parsed.response[2]] },
        ]);
    });

    test('layout length and shape mismatches throw', () => {
        const parsed = responseOf([{ id: '1', status: 200 }]);

        expect(() => parsed.parseGrouped([])).toThrow('Grouped response part count does not match request layout');
        expect(() => parsed.parseGrouped('not-an-array' as unknown as BatchRequestLayout)).toThrow(
            'Grouped response part count does not match request layout'
        );
        expect(() => parsed.parseGrouped([{ kind: 'bogus' } as unknown as BatchRequestLayout[number]])).toThrow(
            'Grouped response has invalid request layout'
        );
        expect(() =>
            parsed.parseGrouped([{ kind: 'changeset', operationCount: 0 } as BatchRequestLayout[number]])
        ).toThrow('Grouped response has invalid request layout');
    });

    test('a group where the layout expects a retrieve throws', () => {
        const parsed = responseOf([{ id: '1', status: 200, atomicityGroup: 'g1' }]);

        expect(() => parsed.parseGrouped([{ kind: 'retrieve' }])).toThrow(
            'Grouped response changeset does not match retrieve layout'
        );
    });

    test('a group whose size differs from operationCount throws', () => {
        const parsed = responseOf([
            { id: '1', status: 200, atomicityGroup: 'g1' },
            { id: '2', status: 200, atomicityGroup: 'g1' },
        ]);

        expect(() => parsed.parseGrouped([{ kind: 'changeset', operationCount: 3 }])).toThrow(
            'Grouped response changeset operation count does not match request layout'
        );
    });

    test('a standalone response where the layout expects a changeset maps to changeset-error only on error codes', () => {
        const failed = responseOf([{ id: '1', status: 409 }]);
        expect(failed.parseGrouped([{ kind: 'changeset', operationCount: 1 }])).toEqual([
            { kind: 'changeset-error', partIndex: 0, error: expect.objectContaining({ code: '409' }) },
        ]);

        const succeeded = responseOf([{ id: '1', status: 200 }]);
        expect(() => succeeded.parseGrouped([{ kind: 'changeset', operationCount: 1 }])).toThrow(
            'Grouped response expected a multipart changeset or whole-changeset HTTP error'
        );
    });

    test('with requestIds, units follow the request layout even when the service omits atomicityGroup', () => {
        const parsed = responseOf(
            [
                { id: '3', status: 200 },
                { id: '1', status: 204 },
                { id: '2', status: 201 },
            ],
            [['1'], ['2', '3']]
        );

        expect(parsed.parseGrouped([{ kind: 'retrieve' }, { kind: 'changeset', operationCount: 2 }])).toEqual([
            { kind: 'retrieve', partIndex: 0, response: expect.objectContaining({ contentId: '1' }) },
            {
                kind: 'changeset',
                partIndex: 1,
                responses: [expect.objectContaining({ contentId: '2' }), expect.objectContaining({ contentId: '3' })],
            },
        ]);
    });

    test('with requestIds, a failed group is reported in request order', () => {
        const parsed = responseOf(
            [
                { id: '3', status: 500, atomicityGroup: 'g1' },
                { id: '1', status: 204 },
                { id: '2', status: 200, atomicityGroup: 'g1' },
            ],
            [['1'], ['2', '3']]
        );

        expect(parsed.parseGrouped([{ kind: 'retrieve' }, { kind: 'changeset', operationCount: 2 }])).toEqual([
            { kind: 'retrieve', partIndex: 0, response: expect.objectContaining({ contentId: '1' }) },
            { kind: 'changeset-error', partIndex: 1, error: expect.objectContaining({ contentId: '3' }) },
        ]);
    });

    test('a single-member operation carrying atomicityGroup is a changeset unit, not unclassified', () => {
        const parsed = responseOf(
            [
                { id: '1', status: 200 },
                { id: '2', status: 201, atomicityGroup: 'g1' },
            ],
            [['1'], ['2']]
        );

        expect(parsed.parseGrouped()).toEqual([
            { kind: 'unclassified', partIndex: 0, response: expect.objectContaining({ contentId: '1' }) },
            { kind: 'changeset', partIndex: 1, responses: [expect.objectContaining({ contentId: '2' })] },
        ]);
    });
});

describe('createJsonBatchResponseParser (S6 parser factory)', () => {
    test('binds the request ids and satisfies BatchResponseConstructor', () => {
        const Parser = createJsonBatchResponseParser([['1'], ['2']]);

        const instance = createBatchResponse(
            Parser,
            {
                data: JSON.stringify({
                    responses: [
                        { id: '2', status: 200 },
                        { id: '1', status: 204 },
                    ],
                }),
                headers: {},
            },
            ACCEPT
        );

        expect(instance.response.map(({ contentId }) => contentId)).toEqual(['1', '2']);
        expect(
            new Parser(
                {
                    data: JSON.stringify({
                        responses: [
                            { id: '1', status: 204 },
                            { id: '2', status: 200 },
                        ],
                    }),
                    headers: {},
                },
                ACCEPT
            ).response.map(({ contentId }) => contentId)
        ).toEqual(['1', '2']);
    });
});
