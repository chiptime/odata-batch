import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { ODataBatch } from '../src/ODataBatch';
import { BatchResponse } from '../src/response';

const HEADERS = { 'content-type': 'multipart/mixed; boundary=resp' };
const PNG = Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a, 0x0a, 0xff, 0x0d]);

const part = (contentType: string | undefined, payload: Buffer | string, status = 'HTTP/1.1 200 OK') =>
    Buffer.concat([
        Buffer.from(
            [
                '--resp',
                'Content-Type: application/http',
                '',
                status,
                ...(contentType ? [`Content-Type: ${contentType}`] : []),
                '',
                '',
            ].join('\r\n'),
            'latin1'
        ),
        Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8'),
        Buffer.from('\r\n', 'latin1'),
    ]);

const batch = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.from('--resp--', 'latin1')]);

describe('binary responses (S3)', () => {
    test('a non-textual part yields its exact bytes; textual parts are decoded and parsed', () => {
        const body = batch(
            part('image/png', PNG),
            part('application/json', '{"name":"ñ€"}'),
            part('text/plain', 'héllo')
        );

        const parsed = new BatchResponse({ data: body, headers: HEADERS } as any, 'application/json').response;

        expect(Buffer.isBuffer(parsed[0].data)).toBe(true);
        expect((parsed[0].data as Buffer).equals(PNG)).toBe(true);
        expect(parsed[0]).toEqual(expect.objectContaining({ code: '200', success: true }));
        expect(parsed[1].data).toEqual({ name: 'ñ€' });
        expect(parsed[2].data).toBe('héllo');
    });

    test('an ArrayBuffer body is accepted', () => {
        const body = batch(part('application/octet-stream', PNG));
        const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

        const parsed = new BatchResponse({ data: arrayBuffer, headers: HEADERS } as any, 'application/json').response;

        expect((parsed[0].data as Buffer).equals(PNG)).toBe(true);
    });

    test('binary children of a changeset survive, flat and grouped', () => {
        const inner = Buffer.concat([
            Buffer.from(
                [
                    '--cs',
                    'Content-Type: application/http',
                    'Content-ID: 1',
                    '',
                    'HTTP/1.1 201 Created',
                    'Content-Type: image/png',
                    '',
                    '',
                ].join('\r\n'),
                'latin1'
            ),
            PNG,
            Buffer.from('\r\n--cs--\r\n', 'latin1'),
        ]);
        const body = Buffer.concat([
            Buffer.from('--resp\r\nContent-Type: multipart/mixed; boundary=cs\r\n\r\n', 'latin1'),
            inner,
            Buffer.from('--resp--', 'latin1'),
        ]);

        const response = new BatchResponse({ data: body, headers: HEADERS } as any, 'application/json');

        expect((response.response[0].data as Buffer).equals(PNG)).toBe(true);
        expect(response.response[0]).toEqual(
            expect.objectContaining({ code: '201', contentId: '1', changesetIndex: 0 })
        );
        const [group] = response.parseGrouped([{ kind: 'changeset', operationCount: 1 }]);
        expect(group.kind).toBe('changeset');
        expect(((group as any).responses[0].data as Buffer).equals(PNG)).toBe(true);
    });

    test('a part without Content-Type follows the accept, and a bodyless 204 yields null', () => {
        const body = batch(part(undefined, '{"a":1}'), part(undefined, '', 'HTTP/1.1 204 No Content'));
        const parsed = new BatchResponse({ data: body, headers: HEADERS } as any, 'application/json').response;
        expect(parsed[0].data).toEqual({ a: 1 });
        expect(parsed[1]).toEqual(expect.objectContaining({ code: '204', data: null }));
    });

    test('ODataBatch with binaryResponses asks axios for an arraybuffer and returns bytes', async () => {
        const mock = new MockAdapter(axios as any);
        try {
            mock.onPost().reply(200, batch(part('image/png', PNG)), HEADERS);
            const result = await new ODataBatch({
                url: 'https://example.com/batch',
                auth: 'u:p',
                binaryResponses: true,
                retrieve: [{ url: '/Photo/$value' }],
            } as any).send();
            expect(mock.history.post[0].responseType).toBe('arraybuffer');
            expect((result[0].data as Buffer).equals(PNG)).toBe(true);
        } finally {
            mock.restore();
        }
    });
});

describe('binary malformed parts', () => {
    test('a truncated part without header separation is unsuccessful and keeps its raw text', () => {
        const body = Buffer.from('--resp\r\nContent-Type: application/http\r\n--resp--', 'latin1');
        const [parsed] = new BatchResponse({ data: body, headers: HEADERS } as any, 'application/json').response;
        expect(parsed).toEqual({
            changesetIndex: 0,
            code: '',
            status: '',
            headers: [],
            data: 'Content-Type: application/http',
            success: false,
        });
    });
});

describe('per-part Content-Type (S4)', () => {
    const text = (contentType: string | undefined, payload: string) =>
        [
            '--resp',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 200 OK',
            ...(contentType ? [`Content-Type: ${contentType}`] : []),
            '',
            payload,
            '--resp--',
        ].join('\r\n');
    const parse = (body: string) =>
        new BatchResponse({ data: body, headers: HEADERS }, 'application/json').response[0].data;

    test('a non-JSON part stays raw under a JSON accept', () => {
        expect(parse(text('text/plain', '123'))).toBe('123');
        expect(parse(text('application/xml', '<a/>'))).toBe('<a/>');
    });

    test('JSON and +json parts are parsed, parameters and casing ignored', () => {
        expect(parse(text('application/json;odata.metadata=minimal', '{"a":1}'))).toEqual({ a: 1 });
        expect(parse(text('Application/Problem+JSON', '{"b":2}'))).toEqual({ b: 2 });
    });

    test('a part without Content-Type keeps the accept-based behavior', () => {
        expect(parse(text(undefined, '123'))).toBe(123);
    });
});

describe('per-part Content-Type never widens a non-JSON accept', () => {
    test('a declared application/json part stays raw under an XML accept (baseline behavior)', () => {
        const raw = [
            '--resp',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"name":"value"}',
            '--resp--',
        ].join('\r\n');
        const parsed = new BatchResponse({ data: raw, headers: HEADERS }, 'application/xml').response;
        expect(parsed[0].data).toBe('{"name":"value"}');
    });
});
