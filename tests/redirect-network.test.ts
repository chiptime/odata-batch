import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ODataBatch } from '../src/ODataBatch';

// Real localhost sockets (no mock adapter): proves the default transport
// never replays credentials to a redirect target.
const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
const batchUrl = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/batch`;

describe.each(['send', 'sendGrouped'] as const)('default transport %s on redirect', (method) => {
    test.each([301, 302, 303, 307, 308])('rejects %i without contacting the redirect target', async (status) => {
        const forwarded: unknown[] = [];
        const received: unknown[] = [];
        const target = createServer((req, res) => {
            forwarded.push(req.headers.authorization);
            req.resume();
            res.writeHead(200, { 'Content-Type': 'multipart/mixed; boundary=r' });
            res.end('--r--');
        });
        const origin = createServer((req, res) => {
            received.push([req.method, req.url, req.headers.authorization]);
            req.resume();
            res.writeHead(status, { Location: batchUrl(target) });
            res.end();
        });
        await listen(target);
        await listen(origin);
        try {
            const batch = new ODataBatch({
                url: batchUrl(origin),
                auth: 'user:pass',
                retrieve: [{ url: '/Items' }],
            });

            await expect(batch[method]()).rejects.toThrow(`Request failed with status code ${status}`);
            expect(received).toEqual([['POST', '/batch', 'Basic dXNlcjpwYXNz']]);
            expect(forwarded).toEqual([]);
        } finally {
            await close(origin);
            await close(target);
        }
    });
});
