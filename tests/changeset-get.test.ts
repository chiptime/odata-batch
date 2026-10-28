import { ODataBatch } from '../src/ODataBatch';
import { requestsToBatch, operationsToBatch, retrieveToBatch } from '../src/request';
import { DummyBatchRepo } from './helpers';

const MESSAGE = 'GET is not allowed inside a changeset; use retrieve or operations';
const post = { method: 'POST', url: '/Items', data: { a: 1 } };

describe('GET inside changesets is rejected (S3, OData v2 batch rules)', () => {
    test.each(['GET', 'get', 'Get'])('requestsToBatch flat changeset rejects %s', (method) => {
        expect(() => requestsToBatch([post, { method, url: '/Items', data: null }])).toThrow(MESSAGE);
    });

    test('requestsToBatch grouped changesets reject GET in any group', () => {
        expect(() => requestsToBatch([[post], [post, { method: 'GET', url: '/Items', data: null }]])).toThrow(MESSAGE);
    });

    test('operationsToBatch rejects GET inside a changeset entry', () => {
        expect(() => operationsToBatch([{ url: '/Items' }, [{ method: 'GET', url: '/Items', data: null }]])).toThrow(
            MESSAGE
        );
    });

    test('ODataBatch rejects GET calls at construction', () => {
        expect(
            () =>
                new ODataBatch(
                    { url: 'http://x/batch', auth: 'a:b', calls: [{ method: 'GET', url: '/Items', data: null }] },
                    new DummyBatchRepo()
                )
        ).toThrow(MESSAGE);
    });

    test('GET stays valid as a retrieve part and as a direct operations entry', () => {
        expect(retrieveToBatch([{ url: '/Items' }], 'b', { accept: 'application/json' })).toContain(
            'GET /Items HTTP/1.1'
        );
        expect(operationsToBatch([{ url: '/Items' }, [post]]).body).toContain('GET /Items HTTP/1.1');
    });

    test('write methods inside changesets are still accepted', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'MERGE', 'DELETE']) {
            expect(() => requestsToBatch([{ method, url: '/Items(1)', data: {} }])).not.toThrow();
        }
    });
});
