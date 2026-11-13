import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { requestsToBatch, operationsToBatch, Call } from '../src/request';
import { BatchResponse } from '../src/response';
import { DummyBatchRepo, makeRandomMock, makeRandomSequenceMock } from './helpers';

/**
 * Binary / media parts (S4):
 * - Call.data as Buffer or Uint8Array is written verbatim, with the call's
 *   own Content-Type (never the batch-level type) and the batch Accept
 * - a binary call without its own Content-Type is rejected
 * - any binary call turns the serialized body into a Buffer; without binary
 *   data the body stays a legacy string, byte-identical
 * - boundary-collision rerolls also scan binary payloads
 */

const JSON_OPTS = { contentType: 'application/json', accept: 'application/json' };

// Non-UTF8 payload: 0xff/0x00/0x80 do not survive a utf8 round-trip and
// 0x0d proves the bytes are never scanned or rewritten as CRLF
const PAYLOAD = Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x80, 0x41]);

const binaryCall = (overloads: Partial<Call> = {}): Call => ({
    method: 'POST',
    url: '/Files',
    data: PAYLOAD,
    headers: { 'content-type': 'image/png' },
    ...overloads,
});

const bytes = (body: string | Buffer): Buffer => (typeof body === 'string' ? Buffer.from(body, 'utf8') : body);

describe('binary call data (S4)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('requestsToBatch', () => {
        test('writes non-UTF8 bytes verbatim in a Buffer body (legacy path, golden bytes)', () => {
            makeRandomMock(42); // changeSetNum = 42
            const { body, boundary } = requestsToBatch(
                [
                    {
                        method: 'POST',
                        url: '/Files',
                        data: PAYLOAD,
                        headers: { 'content-type': 'image/png', Accept: 'text/csv' },
                    },
                ],
                '884',
                JSON_OPTS
            );

            expect(boundary).toBe('884');
            expect(Buffer.isBuffer(body)).toBe(true);
            const expected = Buffer.concat([
                Buffer.from(
                    '--batch_884\r\n' +
                        'Content-Type: multipart/mixed; boundary=changeset_42\r\n' +
                        '\r\n' +
                        '--changeset_42\r\n' +
                        'Content-Type: application/http\r\n' +
                        'Content-Transfer-Encoding: binary\r\n' +
                        '\r\n' +
                        'POST /Files HTTP/1.1\r\n' +
                        'content-type: image/png\r\n' + // own Content-Type, emitted as given
                        'Accept: application/json\r\n' + // overridden by the batch accept
                        '\r\n',
                    'utf8'
                ),
                PAYLOAD,
                Buffer.from('\r\n\r\n--changeset_42--\r\n--batch_884--', 'utf8'),
            ]);
            expect(body).toEqual(expected);
        });

        test('accepts Uint8Array data and copies it verbatim', () => {
            makeRandomMock(42);
            const data = new Uint8Array([0xff, 0x00, 0x0d, 0x00, 0x7f]);
            const { body } = requestsToBatch([binaryCall({ data })], '884', JSON_OPTS);

            expect(Buffer.isBuffer(body)).toBe(true);
            const expected = Buffer.concat([
                Buffer.from(
                    '--batch_884\r\n' +
                        'Content-Type: multipart/mixed; boundary=changeset_42\r\n' +
                        '\r\n' +
                        '--changeset_42\r\n' +
                        'Content-Type: application/http\r\n' +
                        'Content-Transfer-Encoding: binary\r\n' +
                        '\r\n' +
                        'POST /Files HTTP/1.1\r\n' +
                        'content-type: image/png\r\n' + // no batch accept: nothing injected, nothing overridden
                        '\r\n',
                    'utf8'
                ),
                Buffer.from(data),
                Buffer.from('\r\n\r\n--changeset_42--\r\n--batch_884--', 'utf8'),
            ]);
            expect(body).toEqual(expected);
        });

        test('mixed binary and JSON calls keep per-part framing within and across changesets', () => {
            makeRandomMock(42);
            const { body } = requestsToBatch(
                [
                    [{ method: 'POST', url: '/A', data: { a: 1 } }, binaryCall({ url: '/B' })],
                    [binaryCall({ url: '/C', headers: { 'CONTENT-TYPE': 'application/pdf' } })],
                ],
                '884',
                JSON_OPTS
            );

            expect(Buffer.isBuffer(body)).toBe(true);
            const wire = bytes(body);
            // JSON member keeps today's batch-level headers and JSON body
            expect(wire.includes('Content-Type: application/json')).toBe(true);
            expect(wire.includes('{"a":1}')).toBe(true);
            // binary members keep their own Content-Type, emitted as given
            expect(wire.includes('content-type: image/png')).toBe(true);
            expect(wire.includes('CONTENT-TYPE: application/pdf')).toBe(true);
            // payloads stay verbatim and in input order
            const jsonAt = wire.indexOf('{"a":1}');
            const firstAt = wire.indexOf(PAYLOAD);
            const secondAt = wire.indexOf(PAYLOAD, firstAt + 1);
            expect(jsonAt).toBeGreaterThan(-1);
            expect(firstAt).toBeGreaterThan(jsonAt);
            expect(secondAt).toBeGreaterThan(firstAt);
        });

        test('keeps the call Accept when no batch accept is configured', () => {
            makeRandomMock(42);
            const { body } = requestsToBatch(
                [
                    {
                        method: 'POST',
                        url: '/F',
                        data: PAYLOAD,
                        headers: { 'content-type': 'image/png', Accept: 'text/csv' },
                    },
                ],
                '884'
            );

            const wire = bytes(body);
            expect(wire.includes('Accept: text/csv')).toBe(true);
        });

        test.each([
            [
                'flat, no headers',
                () => requestsToBatch([{ method: 'POST', url: '/F', data: PAYLOAD }], '884', JSON_OPTS),
            ],
            [
                'multi, headers without content-type',
                () =>
                    requestsToBatch(
                        [[{ method: 'POST', url: '/F', data: PAYLOAD, headers: { slug: 'a' } }]],
                        '884',
                        JSON_OPTS
                    ),
            ],
            [
                'operations, Uint8Array data',
                () => operationsToBatch([[{ method: 'POST', url: '/F', data: new Uint8Array([1]) }]], JSON_OPTS),
            ],
        ])('binary data without its own Content-Type throws (%s)', (_name, run) => {
            expect(run).toThrow('Binary call data requires its own Content-Type header');
        });

        test('a binary payload containing the batch delimiter forces a boundary reroll', () => {
            makeRandomSequenceMock([42, 77]);
            const colliding = Buffer.concat([Buffer.from('x--batch_collide', 'utf8'), PAYLOAD]);

            const { body, boundary } = requestsToBatch([binaryCall({ data: colliding })], 'collide', JSON_OPTS);

            expect(boundary).toBe('42'); // rerolled off the colliding id
            expect(bytes(body).includes(Buffer.from('x--batch_collide', 'utf8'))).toBe(true); // payload intact
        });

        test('a binary payload containing the changeset delimiter forces a changeset reroll', () => {
            // generated ids in order: batch 42, changeset 77 (collides) -> 88
            makeRandomSequenceMock([42, 77, 88]);
            const colliding = Buffer.concat([PAYLOAD, Buffer.from('--changeset_77', 'utf8')]);

            const { body, boundary } = requestsToBatch([binaryCall({ data: colliding })], JSON_OPTS);

            expect(boundary).toBe('42'); // batch id generated first, no collision
            const wire = bytes(body);
            expect(wire.includes(Buffer.from('boundary=changeset_88\r\n', 'utf8'))).toBe(true);
            expect(wire.includes('boundary=changeset_77')).toBe(false);
        });

        test('without binary data the body stays a plain string, byte-identical', () => {
            makeRandomMock(42);
            const { body } = requestsToBatch([{ method: 'POST', url: '/api/a', data: { id: 1 } }], '884', JSON_OPTS);

            expect(typeof body).toBe('string');
            expect(body).toBe(
                '--batch_884\r\n' +
                    'Content-Type: multipart/mixed; boundary=changeset_42\r\n' +
                    '\r\n' +
                    '--changeset_42\r\n' +
                    'Content-Type: application/http\r\n' +
                    'Content-Transfer-Encoding: binary\r\n' +
                    '\r\n' +
                    'POST /api/a HTTP/1.1\r\n' +
                    'Content-Type: application/json\r\n' +
                    'Accept: application/json\r\n' +
                    '\r\n' +
                    '{"id":1}\r\n' +
                    '\r\n' +
                    '--changeset_42--\r\n' +
                    '--batch_884--'
            );

            const operations = operationsToBatch([{ url: '/R' }, [{ method: 'POST', url: '/A', data: {} }]], JSON_OPTS);
            expect(typeof operations.body).toBe('string');
        });
    });

    describe('operationsToBatch', () => {
        test('serializes binary changeset members alongside retrieve parts', () => {
            makeRandomMock(42);
            const { body } = operationsToBatch([{ url: '/R' }, [binaryCall()]], JSON_OPTS);

            expect(Buffer.isBuffer(body)).toBe(true);
            const wire = bytes(body);
            expect(wire.includes('GET /R HTTP/1.1')).toBe(true);
            expect(wire.includes('content-type: image/png')).toBe(true);
            expect(wire.includes(PAYLOAD)).toBe(true);
        });
    });

    describe('ODataBatch + repository', () => {
        test('ODataBatch.send hands the serialized Buffer to the repository', async () => {
            const repo = new DummyBatchRepo();
            await new ODataBatch({ url: 'https://x/batch', auth: 'user:pass', calls: [binaryCall()] }, repo).send();

            const sent: unknown = repo.lastRequest;
            expect(Buffer.isBuffer(sent)).toBe(true);
            expect(Buffer.isBuffer(sent) && sent.includes(PAYLOAD)).toBe(true);
        });
    });

    describe('ODataBatchAxiosRepository transport', () => {
        let mock: MockAdapter;

        beforeEach(() => {
            mock = new MockAdapter(axios as any);
        });

        afterEach(() => {
            mock.restore();
        });

        test('posts the Buffer body unchanged with redirects disabled', async () => {
            const url = 'https://example.com/batch';
            mock.onPost(url).reply(200, '', { 'content-type': 'multipart/mixed; boundary=response' });

            const { body } = requestsToBatch([binaryCall()], '884', JSON_OPTS);
            await new ODataBatchAxiosRepository().send(url, body, { headers: {} }, 'application/json', BatchResponse);

            const posted: unknown = mock.history.post[0].data;
            expect(Buffer.isBuffer(posted)).toBe(true);
            expect(Buffer.isBuffer(posted) && posted.includes(PAYLOAD)).toBe(true);
            expect(mock.history.post[0].maxRedirects).toBe(0);
        });
    });
});
