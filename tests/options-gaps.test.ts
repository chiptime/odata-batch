import { ODataBatch } from '../src/ODataBatch';
import { DummyBatchRepo } from './helpers';

const base = { url: 'http://example.com/batch', auth: 'user:pass', calls: [{ method: 'POST', url: '/A', data: {} }] };
const json = { protocolVersion: '4.01', batchFormat: 'json' };

const configOf = async (options: Record<string, unknown>) => {
    const repo = new DummyBatchRepo();
    await new ODataBatch({ ...base, ...options } as any, repo).send();
    return repo.lastConfig;
};

describe('asyncPolling option (S1)', () => {
    test('adds Prefer: respond-async and normalized polling limits', async () => {
        const config = await configOf({ asyncPolling: {} });
        expect(config.headers.Prefer).toBe('respond-async');
        expect(config.asyncPolling).toEqual({ maxPolls: 30, defaultRetryAfterMs: 1000, maxRetryAfterMs: 30000 });
    });

    test('explicit limits are kept and a caller Prefer header wins', async () => {
        const config = await configOf({
            asyncPolling: { maxPolls: 2, defaultRetryAfterMs: 0, maxRetryAfterMs: 5 },
            headers: { prefer: 'respond-async, wait=10' },
        });
        expect(config.asyncPolling).toEqual({ maxPolls: 2, defaultRetryAfterMs: 0, maxRetryAfterMs: 5 });
        expect(config.headers.prefer).toBe('respond-async, wait=10');
        expect(config.headers.Prefer).toBeUndefined();
    });

    test.each(['maxPolls', 'defaultRetryAfterMs', 'maxRetryAfterMs'])('invalid %s throws', (field) => {
        expect(() => new ODataBatch({ ...base, asyncPolling: { [field]: -1 } } as any, new DummyBatchRepo())).toThrow(
            `asyncPolling.${field} must be a non-negative finite number`
        );
    });

    test('omitted options keep the legacy config shape', async () => {
        const config = await configOf({});
        expect(Object.keys(config)).toEqual(['headers']);
        expect(Object.keys(config.headers).some((k) => k.toLowerCase() === 'prefer')).toBe(false);
    });
});

describe('continueOnError option (S2)', () => {
    test.each([
        [false, 'odata.continue-on-error=false'],
        [true, 'odata.continue-on-error=true'],
    ])('continueOnError %s sends its Prefer value', async (value, prefer) => {
        const config = await configOf({ ...json, continueOnError: value });
        expect(config.headers.Prefer).toBe(prefer);
    });

    test('combined with asyncPolling both preferences are sent', async () => {
        const config = await configOf({ ...json, continueOnError: false, asyncPolling: {} });
        expect(config.headers.Prefer).toBe('respond-async, odata.continue-on-error=false');
    });

    test('multipart batches reject continueOnError', () => {
        expect(() => new ODataBatch({ ...base, continueOnError: false } as any, new DummyBatchRepo())).toThrow(
            "continueOnError requires batchFormat 'json'"
        );
    });
});

describe('binaryResponses option (S3)', () => {
    test('requests an arraybuffer response', async () => {
        expect((await configOf({ binaryResponses: true })).responseType).toBe('arraybuffer');
        expect((await configOf({ binaryResponses: false })).responseType).toBeUndefined();
    });
});

describe('binaryResponses with JSON batch', () => {
    test('is rejected: the JSON envelope must be text', () => {
        expect(() => new ODataBatch({ ...base, ...json, binaryResponses: true } as any, new DummyBatchRepo())).toThrow(
            "binaryResponses requires batchFormat 'multipart'"
        );
    });
});
