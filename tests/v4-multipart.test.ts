import { ODataBatch } from '../src/ODataBatch';
import { requestsToBatch, operationsToBatch, Call } from '../src/request';
import { DummyBatchRepo } from './helpers';

const V4 = { contentType: 'application/json', accept: 'application/json', protocolVersion: '4.0' as const };
const call = (url: string, contentId?: string): Call => ({
    method: 'POST',
    url,
    data: {},
    ...(contentId !== undefined ? { contentId } : {}),
});
const contentIds = (body: string | Buffer) => [...body.toString().matchAll(/^Content-ID: (.*)$/gm)].map((m) => m[1]);

describe('OData v4 multipart Content-ID (S5)', () => {
    test('every changeset member gets an auto-assigned Content-ID', () => {
        const { body } = requestsToBatch([call('/A'), call('/B')], V4);
        expect(contentIds(body)).toEqual(['1', '2']);
    });

    test('auto-assigned IDs never collide with explicit ones, across changesets', () => {
        const { body } = requestsToBatch(
            [
                [call('/A', '2'), call('/B')],
                [call('/C'), call('/D', '4')],
            ],
            V4
        );
        expect(contentIds(body)).toEqual(['2', '1', '3', '4']);
    });

    test('operations mode assigns IDs to changeset members only', () => {
        const { body } = operationsToBatch([{ url: '/R' }, [call('/A'), call('/B', 'x')]], V4);
        expect(contentIds(body)).toEqual(['1', 'x']);
    });

    test('explicit IDs must be unique across the whole batch', () => {
        expect(() => requestsToBatch([[call('/A', 'a')], [call('/B', 'a')]], V4)).toThrow(
            'Duplicate contentId within the batch: a'
        );
        expect(() => operationsToBatch([[call('/A', 'a')], [call('/B', 'a')]], V4)).toThrow(
            'Duplicate contentId within the batch: a'
        );
    });

    test('caller Call objects are not mutated', () => {
        const calls = [call('/A')];
        requestsToBatch(calls, V4);
        expect(calls[0]).not.toHaveProperty('contentId');
    });

    test('ODataBatch with protocolVersion 4.0 emits the IDs on the wire', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch(
            { url: 'https://x/batch', auth: 'a:b', protocolVersion: '4.0', calls: [call('/A'), call('/B')] },
            repo
        ).send();
        expect(contentIds(repo.lastRequest)).toEqual(['1', '2']);
    });

    test('without protocolVersion 4.0 nothing changes: no IDs added, same-ID across changesets allowed', () => {
        expect(contentIds(requestsToBatch([call('/A'), call('/B')]).body)).toEqual([]);
        expect(contentIds(requestsToBatch([call('/A')], { ...V4, protocolVersion: '2.0' }).body)).toEqual([]);
        expect(() => requestsToBatch([[call('/A', 'a')], [call('/B', 'a')]])).not.toThrow();
    });
});

describe('dependsOn is JSON-batch only (S6)', () => {
    test.each([
        ['requestsToBatch', () => requestsToBatch([{ ...call('/A'), dependsOn: ['x'] }], V4)],
        ['operationsToBatch', () => operationsToBatch([[{ ...call('/A'), dependsOn: ['x'] }]], V4)],
    ])('%s rejects dependsOn in multipart', (_name, run) => {
        expect(run).toThrow("dependsOn requires batchFormat 'json'");
    });
});
