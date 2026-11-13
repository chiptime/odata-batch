import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { DummyBatchRepo } from './helpers';

const url = 'https://example.com/batch';
const options = { url, auth: 'user:pass', protocolVersion: '4.01', batchFormat: 'json' };
const write = { method: 'POST', url: '/Items', data: { name: 'new' } };

describe('OData 4.01 JSON batch integration', () => {
    let mock: MockAdapter;
    beforeEach(() => {
        mock = new MockAdapter(axios as any);
    });
    afterEach(() => {
        mock.restore();
    });

    test.each([
        { retrieve: [{ url: '/Items' }] },
        { calls: [write] },
        { calls: [[write]] },
        { operations: [{ url: '/Items' }, [write]] },
    ])('serializes the selected input mode and correlates out-of-order responses: %j', async (mode) => {
        mock.onPost(url).reply((config) => {
            const requests = JSON.parse(config.data).requests;
            return [
                200,
                { responses: [...requests].reverse().map((r: any) => ({ id: r.id, status: 200, body: r.url })) },
            ];
        });
        const result = await new ODataBatch({ ...options, ...mode } as any).send();
        expect(result.map((r) => r.contentId)).toEqual(result.map((_, i) => String(i + 1)));
        expect(result.every((r) => r.success && r.data === '/Items')).toBe(true);
        expect(mock.history.post[0].headers?.['Content-Type']).toBe('application/json');
        expect(mock.history.post[0].headers?.['OData-Version']).toBe('4.01');
        expect(mock.history.post[0].headers?.['OData-MaxVersion']).toBe('4.01');
        expect(mock.history.post[0].maxRedirects).toBe(0);
    });

    test('sendGrouped uses the request layout for a singleton changeset with no response atomicityGroup', async () => {
        mock.onPost(url).reply(200, {
            responses: [
                { id: '2', status: 201 },
                { id: '1', status: 200 },
            ],
        });
        const result = await new ODataBatch({
            ...options,
            operations: [{ url: '/Items' }, [write]],
        } as any).sendGrouped();
        expect(result).toEqual([
            { kind: 'retrieve', partIndex: 0, response: expect.objectContaining({ contentId: '1' }) },
            { kind: 'changeset', partIndex: 1, responses: [expect.objectContaining({ contentId: '2' })] },
        ]);
    });

    test('sendGrouped reports a failed atomicity group even when rolled-back siblings have no response', async () => {
        mock.onPost(url).reply(200, { responses: [{ id: '1', status: 409, body: { error: 'conflict' } }] });
        const result = await new ODataBatch({ ...options, calls: [write, write] } as any).sendGrouped();
        expect(result).toEqual([
            { kind: 'changeset-error', partIndex: 0, error: expect.objectContaining({ code: '409', success: false }) },
        ]);
    });

    test('custom repositories receive JSON text, limits, and a bound response parser', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch({ ...options, timeout: 100, maxContentLength: 200, calls: [write] } as any, repo).send();
        expect(typeof repo.lastRequest).toBe('string');
        expect(JSON.parse(repo.lastRequest.toString()).requests[0].atomicityGroup).toBe('group1');
        expect(repo.lastConfig).toEqual(expect.objectContaining({ timeout: 100, maxContentLength: 200 }));
    });

    test('rejects unsupported batchFormat rather than silently selecting multipart', () => {
        expect(() => new ODataBatch({ ...options, batchFormat: 'other', calls: [write] } as any)).toThrow(
            "batchFormat must be 'multipart' or 'json'"
        );
    });

    test.each([
        { protocolVersion: undefined },
        { protocolVersion: '2.0' },
        { protocolVersion: '4.0' },
        { batchResponseType: 'xml' },
        { individualResponseType: 'xml' },
    ])('rejects incompatible JSON-batch settings: %j', (override) => {
        expect(() => new ODataBatch({ ...options, ...override, calls: [write] } as any)).toThrow(
            "batchFormat 'json' requires protocolVersion '4.01' and JSON media types"
        );
    });

    test('multipart 4.01 still carries Content-ID and remains a multipart request', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch({ url, auth: '', protocolVersion: '4.01', calls: [write] } as any, repo).send();
        expect(repo.lastConfig.headers['OData-Version']).toBe('4.01');
        expect(repo.lastRequest.toString()).toContain('Content-ID: 1');
        expect(repo.lastConfig.headers['Content-Type']).toMatch(/^multipart\/mixed;/);
    });

    test('continueOnError: false sends the preference and reports unprocessed operations as omitted', async () => {
        mock.onPost(url).reply((config) => {
            expect(config.headers?.Prefer).toBe('odata.continue-on-error=false');
            return [200, { responses: [{ id: '1', status: 404 }] }];
        });
        const result = await new ODataBatch({
            ...options,
            continueOnError: false,
            operations: [{ url: '/Missing' }, [write]],
        } as any).send();
        expect(result.map(({ contentId, code, omitted }) => ({ contentId, code, omitted }))).toEqual([
            { contentId: '1', code: '404', omitted: undefined },
            { contentId: '2', code: '', omitted: true },
        ]);
    });
});
