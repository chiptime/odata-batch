import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchRepository } from '../src/BatchRepository';
import { DummyBatchRepo } from './helpers';

const AUTH = 'user:pass';
const WRITE = { method: 'POST' as const, url: '/A', data: {} };
const REFUSAL = 'Refusing to send credentials over http://; use https:// or set allowInsecureHttp: true';

const constructs =
    (url: string, extra: Record<string, unknown> = {}): (() => ODataBatch) =>
    () =>
        new ODataBatch({ url, auth: AUTH, calls: [WRITE], ...extra } as any, new DummyBatchRepo());

describe('http loopback guard mutation kills', () => {
    test.each([
        'http://127.255.255.255/svc',
        'http://127.0.0.254/svc',
        'http://127.0.0.1/svc',
        'http://LOCALHOST:8080/svc',
        'http://[::1]/svc',
    ])('%s is loopback and constructs', (url) => {
        expect(constructs(url)).not.toThrow();
    });

    // Hosts the WHATWG URL parser actually accepts as non-loopback dotted quads.
    // (Octets >= 256 or non-digit octets make `new URL` itself throw, so those
    // forms never reach the loopback check; the parser normalizes every valid
    // numeric host to a canonical dotted quad.)
    test.each(['http://128.0.0.1/svc', 'http://126.0.0.1/svc', 'http://127.0.0.1x/svc'])(
        '%s is not loopback and is refused',
        (url) => {
            expect(constructs(url)).toThrow(REFUSAL);
        }
    );
});

describe('ODataBatch mutation kills', () => {
    test('empty operations are rejected before any other option validation', () => {
        expect(
            () =>
                new ODataBatch(
                    { url: 'https://x/batch', auth: 'bad\nauth', operations: [] } as any,
                    new DummyBatchRepo()
                )
        ).toThrow('No calls have been passed');
    });

    test('operations combined with calls carries the exact mutual-exclusion message', () => {
        expect(
            () =>
                new ODataBatch(
                    { url: 'https://x/batch', auth: AUTH, operations: [{ url: '/a' }], calls: [WRITE] } as any,
                    new DummyBatchRepo()
                )
        ).toThrow('Pass either operations or calls/retrieve, not both');
    });

    test('json batch format without any calls reports the standard empty-batch error', () => {
        expect(
            () =>
                new ODataBatch(
                    { url: 'https://x/batch', auth: AUTH, batchFormat: 'json', protocolVersion: '4.01' } as any,
                    new DummyBatchRepo()
                )
        ).toThrow('No calls have been passed');
    });

    test('json batch member headers take the batch-level accept over a caller accept', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch(
            {
                url: 'https://x/batch',
                auth: AUTH,
                batchFormat: 'json',
                protocolVersion: '4.01',
                retrieve: [{ url: '/R', headers: { accept: 'text/custom' } }],
            },
            repo
        ).send();
        expect(JSON.parse(repo.lastRequest).requests[0].headers).toEqual({ accept: 'application/json' });
    });

    test('mixed operations mode forwards media types and protocol version to the serializer', async () => {
        const repo = new DummyBatchRepo();
        await new ODataBatch(
            { url: 'https://x/batch', auth: AUTH, protocolVersion: '4.0', operations: [[WRITE]] },
            repo
        ).send();
        expect(repo.lastRequest).toContain('Content-Type: application/json');
        expect(repo.lastRequest).toContain('Accept: application/json');
        expect(repo.lastRequest).toContain('Content-ID: 1');
    });

    test('sendGrouped passes the JSON parser argument only for json batches', async () => {
        const run = async (extra: Record<string, unknown>) => {
            const repo = {
                send: jest.fn(() => Promise.resolve([])),
                sendGrouped: jest.fn((..._args: unknown[]) => Promise.resolve([])),
            };
            await new ODataBatch(
                { url: 'https://x/batch', auth: AUTH, calls: [[WRITE]], ...extra } as any,
                repo as unknown as ODataBatchRepository
            ).sendGrouped();
            return repo.sendGrouped.mock.calls[0];
        };

        expect(await run({})).toHaveLength(5);
        expect((await run({}))[5]).toBeUndefined();

        const jsonArgs = await run({ batchFormat: 'json', protocolVersion: '4.01' });
        expect(jsonArgs).toHaveLength(6);
        expect(typeof jsonArgs[5]).toBe('function');
    });
});
