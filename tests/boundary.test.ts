import * as boundaryModule from '../src/boundary';
import { generateBoundaryId } from '../src/boundary';
import { requestsToBatch, Call, RetrieveCall } from '../src/request';
import * as requestModule from '../src/request';
import { ODataBatch } from '../src/ODataBatch';
import { DummyBatchRepo } from './helpers';

const operationsToBatch = (requestModule as any).operationsToBatch;

describe('FR-01 & FR-08: CSPRNG boundary generation and collision guards', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('generateBoundaryId() produces a valid UUID v4 token', () => {
        const id = generateBoundaryId();
        expect(typeof id).toBe('string');
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('FR-01: requestsToBatch returns { body, boundary } and rerolls on outer boundary collision', () => {
        jest.spyOn(boundaryModule, 'generateBoundaryId')
            .mockReturnValueOnce('colliding-batch')
            .mockReturnValueOnce('clean-batch')
            .mockReturnValueOnce('cs-id');

        const calls: Call[] = [
            { method: 'POST', url: '/items', headers: {}, data: { text: '--batch_colliding-batch' } },
        ];

        const result: any = (requestsToBatch as any)(calls, {
            contentType: 'application/json',
            accept: 'application/json',
        });

        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('body');
        expect(result).toHaveProperty('boundary');
        expect(result.boundary).toBe('clean-batch');
        expect(result.body).toContain('--batch_clean-batch');
        expect(result.body).not.toContain('boundary=batch_colliding-batch');
    });

    test('FR-01: requestsToBatch throws when outer batch boundary collides persistently (10 attempts)', () => {
        const spy = jest.spyOn(boundaryModule, 'generateBoundaryId').mockReturnValue('persistent-batch-collision');

        const calls: Call[] = [
            { method: 'POST', url: '/items', headers: {}, data: { text: '--batch_persistent-batch-collision' } },
        ];

        expect(() =>
            (requestsToBatch as any)(calls, { contentType: 'application/json', accept: 'application/json' })
        ).toThrow('Unable to generate a batch boundary that does not collide with the payload');
        expect(spy).toHaveBeenCalledTimes(10);
    });

    test('FR-01: requestsToBatch throws when changeset boundary collides persistently (10 attempts)', () => {
        const spy = jest
            .spyOn(boundaryModule, 'generateBoundaryId')
            .mockReturnValueOnce('clean-batch')
            .mockReturnValue('persistent-cs-collision');

        const calls: Call[] = [
            { method: 'POST', url: '/items', headers: {}, data: { text: '--changeset_persistent-cs-collision' } },
        ];

        expect(() =>
            (requestsToBatch as any)(calls, { contentType: 'application/json', accept: 'application/json' })
        ).toThrow('Unable to generate a changeset boundary that does not collide with the payload');
        expect(spy).toHaveBeenCalledTimes(11);
    });

    test('FR-01: operationsToBatch returns { body, boundary } and rerolls on outer boundary collision', () => {
        jest.spyOn(boundaryModule, 'generateBoundaryId')
            .mockReturnValueOnce('colliding-op-batch')
            .mockReturnValueOnce('clean-op-batch')
            .mockReturnValueOnce('cs-op-id');

        const ops: (RetrieveCall | Call[])[] = [
            [{ method: 'POST', url: '/items', headers: {}, data: { text: '--batch_colliding-op-batch' } }],
        ];

        const result: any = operationsToBatch(ops, { contentType: 'application/json', accept: 'application/json' });

        expect(typeof result).toBe('object');
        expect(result).toHaveProperty('body');
        expect(result).toHaveProperty('boundary');
        expect(result.boundary).toBe('clean-op-batch');
        expect(result.body).toContain('--batch_clean-op-batch');
    });

    test('FR-01: operationsToBatch throws when outer batch boundary collides persistently', () => {
        const spy = jest.spyOn(boundaryModule, 'generateBoundaryId').mockReturnValue('persistent-op-collision');

        const ops: (RetrieveCall | Call[])[] = [
            [{ method: 'POST', url: '/items', headers: {}, data: { text: '--batch_persistent-op-collision' } }],
        ];

        expect(() => operationsToBatch(ops, { contentType: 'application/json', accept: 'application/json' })).toThrow(
            'Unable to generate a batch boundary that does not collide with the payload'
        );
        expect(spy).toHaveBeenCalledTimes(10);
    });

    test('FR-01: operationsToBatch throws when changeset boundary collides persistently (10 attempts)', () => {
        const spy = jest
            .spyOn(boundaryModule, 'generateBoundaryId')
            .mockReturnValueOnce('clean-op-batch')
            .mockReturnValue('persistent-op-cs-collision');

        const ops: (RetrieveCall | Call[])[] = [
            [{ method: 'POST', url: '/items', headers: {}, data: { text: '--changeset_persistent-op-cs-collision' } }],
        ];

        expect(() => operationsToBatch(ops, { contentType: 'application/json', accept: 'application/json' })).toThrow(
            'Unable to generate a changeset boundary that does not collide with the payload'
        );
        expect(spy).toHaveBeenCalledTimes(11);
    });

    test('FR-01: ODataBatch stores the rerolled boundary for Content-Type', async () => {
        jest.spyOn(boundaryModule, 'generateBoundaryId')
            .mockReturnValueOnce('batch-col-1')
            .mockReturnValueOnce('batch-clean-final')
            .mockReturnValueOnce('cs-col-id');

        const repo = new DummyBatchRepo();
        const batch = new ODataBatch(
            {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'POST', url: '/items', headers: {}, data: { text: '--batch_batch-col-1' } }],
            },
            repo
        );

        await batch.send();
        expect(repo.lastConfig.headers['Content-Type']).toBe('multipart/mixed; boundary=batch_batch-clean-final');
    });

    test('FR-08: changeset boundary generation uses generateBoundaryId() seam', () => {
        const spy = jest.spyOn(boundaryModule, 'generateBoundaryId');
        const calls: Call[] = [{ method: 'POST', url: '/items', headers: {}, data: { text: 'clean' } }];

        (requestsToBatch as any)(calls, { contentType: 'application/json', accept: 'application/json' });
        expect(spy).toHaveBeenCalled();
    });
});
