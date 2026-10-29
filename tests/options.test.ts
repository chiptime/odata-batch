import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { DummyBatchRepo } from './helpers';

const base = {
    url: 'https://example.com/batch',
    auth: 'user:pass',
    calls: [{ method: 'POST', url: '/Items', data: { a: 1 } }],
};

const sendWith = async (options: Record<string, unknown>) => {
    const repo = new DummyBatchRepo();
    await new ODataBatch({ ...base, ...options } as any, repo).send();
    return repo.lastConfig;
};

describe('transport limits (S1)', () => {
    test('timeout and maxContentLength reach the repository config', async () => {
        const config = await sendWith({ timeout: 5000, maxContentLength: 1024 });
        expect(config.timeout).toBe(5000);
        expect(config.maxContentLength).toBe(1024);
    });

    test('zero is a valid value', async () => {
        const config = await sendWith({ timeout: 0, maxContentLength: 0 });
        expect(config.timeout).toBe(0);
        expect(config.maxContentLength).toBe(0);
    });

    test('omitted options leave the config with headers only (legacy shape)', async () => {
        const config = await sendWith({});
        expect(Object.keys(config)).toEqual(['headers']);
    });

    test.each(['timeout', 'maxContentLength'])('invalid %s throws at construction', (option) => {
        for (const value of [-1, NaN, Infinity, '100', null]) {
            expect(() => new ODataBatch({ ...base, [option]: value } as any, new DummyBatchRepo())).toThrow(
                `${option} must be a non-negative finite number`
            );
        }
    });

    test('the default axios repository forwards the limits to axios', async () => {
        const mock = new MockAdapter(axios as any);
        try {
            mock.onPost().reply(200, '', { 'content-type': 'multipart/mixed; boundary=r' });
            await new ODataBatch(
                { ...base, timeout: 1234, maxContentLength: 99 } as any,
                new ODataBatchAxiosRepository()
            ).send();
            expect(mock.history.post[0].timeout).toBe(1234);
            expect(mock.history.post[0].maxContentLength).toBe(99);
            expect(mock.history.post[0].maxRedirects).toBe(0);
        } finally {
            mock.restore();
        }
    });
});

describe('protocolVersion headers (S2, S5)', () => {
    const versionKeys = (headers: Record<string, string>) => Object.keys(headers).filter((k) => /version/i.test(k));

    test('omitted: no version headers (legacy wire)', async () => {
        const config = await sendWith({});
        expect(versionKeys(config.headers)).toEqual([]);
    });

    test("'2.0' sends DataServiceVersion and MaxDataServiceVersion", async () => {
        const config = await sendWith({ protocolVersion: '2.0' });
        expect(config.headers.DataServiceVersion).toBe('2.0');
        expect(config.headers.MaxDataServiceVersion).toBe('2.0');
        expect(versionKeys(config.headers)).toHaveLength(2);
    });

    test("'4.0' sends OData-Version and OData-MaxVersion", async () => {
        const config = await sendWith({ protocolVersion: '4.0' });
        expect(config.headers['OData-Version']).toBe('4.0');
        expect(config.headers['OData-MaxVersion']).toBe('4.0');
        expect(versionKeys(config.headers)).toHaveLength(2);
    });

    test('a caller header with the same name (any casing) wins', async () => {
        const config = await sendWith({
            protocolVersion: '2.0',
            headers: { dataserviceversion: '1.0', 'X-Other': 'kept' },
        });
        expect(config.headers.dataserviceversion).toBe('1.0');
        expect(config.headers.DataServiceVersion).toBeUndefined();
        expect(config.headers.MaxDataServiceVersion).toBe('2.0');
        expect(config.headers['X-Other']).toBe('kept');
    });

    test('an unsupported protocolVersion throws at construction', () => {
        for (const value of ['3.0', '5.0', 2, '']) {
            expect(() => new ODataBatch({ ...base, protocolVersion: value } as any, new DummyBatchRepo())).toThrow(
                "protocolVersion must be '2.0', '4.0' or '4.01'"
            );
        }
    });
});
