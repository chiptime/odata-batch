import { ODataBatch } from '../src/ODataBatch';
import { DummyBatchRepo } from './helpers';

const MESSAGE = 'Refusing to send credentials over http://; use https:// or set allowInsecureHttp: true';
const calls = [{ method: 'POST', url: '/Items', data: {} }];
const build = (url: string, extra: Record<string, unknown> = {}) =>
    new ODataBatch({ url, auth: 'user:pass', calls, ...extra } as any, new DummyBatchRepo());

describe('credentials over http:// (S1)', () => {
    test.each([
        'http://sap.example.com/sap/opu/odata/sap/SRV/$batch',
        'HTTP://SAP.EXAMPLE.COM/$batch',
        'http://10.0.0.5:8000/$batch',
        'http://localhost.evil.example/$batch',
        'http://127.0.0.1.nip.io/$batch',
    ])('rejects %s', (url) => {
        expect(() => build(url)).toThrow(MESSAGE);
    });

    test('rejects even when only a Bearer header carries the credentials', () => {
        expect(() =>
            build('http://sap.example.com/$batch', { auth: '', headers: { Authorization: 'Bearer token' } })
        ).toThrow(MESSAGE);
    });

    test.each([
        'https://sap.example.com/$batch',
        'http://localhost:3000/$batch',
        'http://127.0.0.1/$batch',
        'http://127.10.20.30:8080/$batch',
        'http://[::1]:4004/$batch',
        '/sap/opu/odata/sap/SRV/$batch',
    ])('accepts %s', (url) => {
        expect(() => build(url)).not.toThrow();
    });

    test('allowInsecureHttp: true is the explicit opt-out', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch(
            { url: 'http://sap.internal/$batch', auth: 'user:pass', calls, allowInsecureHttp: true } as any,
            repo
        ).send();
        expect(repo.lastUrl).toBe('http://sap.internal/$batch');
    });

    test('allowInsecureHttp must be a boolean', () => {
        expect(() => build('https://sap.example.com/$batch', { allowInsecureHttp: 'yes' })).toThrow(
            'allowInsecureHttp must be a boolean'
        );
    });
});
