import { BatchResponse } from '../src/response';

const HEADERS = { 'content-type': 'multipart/mixed; boundary=resp' };
const GROUPED_HEADERS = { 'content-type': 'multipart/mixed; boundary=g' };

const binaryResponse = (body: Buffer, accept = 'application/json') =>
    new BatchResponse({ data: body, headers: HEADERS }, accept).response;

const lfBatch = (inner: string) => Buffer.from(`--resp\n${inner}\n--resp--`, 'latin1');

describe('response mutation kills (S3)', () => {
    test('binary LF-only batch: 404 part parses exactly (headers, data, contentId)', () => {
        const body = lfBatch('Content-ID: 7\nContent-Type: application/http\n\nHTTP/1.1 404 Not Found\nX-A: 1\n\nbody');

        expect(binaryResponse(body)).toEqual([
            {
                code: '404',
                status: 'Not Found',
                headers: [{ key: 'X-A', value: '1' }],
                data: 'body',
                success: false,
                changesetIndex: 0,
                contentId: '7',
            },
        ]);
    });

    test('binary LF-only batch: 5xx part is not successful', () => {
        const body = lfBatch('Content-Type: application/http\n\nHTTP/1.1 500 Server Error\n\nerr');

        expect(binaryResponse(body)).toEqual([
            { code: '500', status: 'Server Error', headers: [], data: 'err', success: false, changesetIndex: 0 },
        ]);
    });

    test('binary part with a junk-prefixed status line is not a success', () => {
        const body = lfBatch('Content-Type: application/http\n\nxxHTTP/1.1 404 Not Found\nX-A: 1\n\nbody');

        expect(binaryResponse(body)).toEqual([
            {
                code: '',
                status: '',
                headers: [{ key: 'X-A', value: '1' }],
                data: 'body',
                success: false,
                changesetIndex: 0,
            },
        ]);
    });

    test('binary status line with four digits is rejected', () => {
        const body = lfBatch('Content-Type: application/http\n\nHTTP/1.1 2044\n\nx');

        expect(binaryResponse(body)).toEqual([
            { code: '', status: '', headers: [], data: 'x', success: false, changesetIndex: 0 },
        ]);
    });

    test('binary status line without a reason phrase is valid', () => {
        const body = lfBatch('Content-Type: application/http\n\nHTTP/1.1 204\n\nx');

        expect(binaryResponse(body)).toEqual([
            { code: '204', status: '', headers: [], data: 'x', success: true, changesetIndex: 0 },
        ]);
    });

    test('binary 204 part without a payload segment yields an empty payload', () => {
        const body = Buffer.from(
            '--resp\nContent-Type: application/http\n\nHTTP/1.1 204 No Content\n--resp--',
            'latin1'
        );

        expect(binaryResponse(body)).toEqual([
            { code: '204', status: 'No Content', headers: [], data: null, success: true, changesetIndex: 0 },
        ]);
    });

    test('binary textual media types decode to strings; others stay bytes', () => {
        const part = (httpContentType: string | undefined, payload: string) =>
            `Content-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n${
                httpContentType ? `Content-Type: ${httpContentType}\r\n` : ''
            }\r\n${payload}`;
        const body = Buffer.from(
            `--resp\r\n${[
                part('application/hal+json', '{"a":[1]}'),
                part('application/xml', '<x/>'),
                part('application/atom+xml', '<feed/>'),
                part('application/http', 'inner http'),
                part('image/png', '\u0089P'),
            ].join('\r\n--resp\r\n')}\r\n--resp--`,
            'latin1'
        );

        const parsed = binaryResponse(body);
        expect(parsed[0].data).toEqual({ a: [1] });
        expect(parsed[1].data).toBe('<x/>');
        expect(parsed[2].data).toBe('<feed/>');
        expect(parsed[3].data).toBe('inner http');
        expect(Buffer.isBuffer(parsed[4].data)).toBe(true);
        expect((parsed[4].data as Buffer).equals(Buffer.from([0x89, 0x50]))).toBe(true);
    });

    test('a nested multipart/* payload inside a changeset is decoded as text, not bytes', () => {
        const body = Buffer.from(
            [
                '--resp',
                'Content-Type: multipart/mixed; boundary=cs',
                '',
                '--cs',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: multipart/mixed; boundary=n',
                '',
                '--n',
                'inner',
                '--n--',
                '--cs--',
                '--resp--',
            ].join('\r\n'),
            'latin1'
        );

        expect(binaryResponse(body)).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-Type', value: 'multipart/mixed; boundary=n' }],
                data: '--n\r\ninner\r\n--n--',
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('text mode: an empty Content-Type value defers to the accept for JSON parsing', () => {
        const body =
            '--resp\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type:\r\n\r\n{"a":1}\r\n--resp--';

        expect(new BatchResponse({ data: body, headers: HEADERS }, 'application/json').response).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-Type', value: '' }],
                data: { a: 1 },
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('binary mode: an empty Content-Type value still decodes the payload as text', () => {
        const body = Buffer.from(
            '--resp\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type:\r\n\r\n{"a":1}\r\n--resp--',
            'latin1'
        );

        expect(binaryResponse(body)).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-Type', value: '' }],
                data: { a: 1 },
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('unparseable JSON in a JSON-declared part returns the raw payload', () => {
        const body = lfBatch(
            'Content-Type: application/http\n\nHTTP/1.1 200 OK\nContent-Type: application/json\n\n{oops'
        );

        expect(binaryResponse(body)).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-Type', value: 'application/json' }],
                data: '{oops',
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('a media type with spaces before its parameters is still recognized as JSON', () => {
        const body =
            '--resp\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json ; v=1\r\n\r\n{"k":true}\r\n--resp--';

        expect(new BatchResponse({ data: body, headers: HEADERS }, 'application/json').response).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-Type', value: 'application/json ; v=1' }],
                data: { k: true },
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('a quoted boundary with inner spaces is trimmed before use', () => {
        const body = Buffer.from(
            [
                '--resp',
                'Content-Type: multipart/mixed; boundary=" cs "',
                '',
                '--cs',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 200 OK',
                '',
                'in cs',
                '--cs--',
                '--resp--',
            ].join('\r\n'),
            'latin1'
        );

        expect(binaryResponse(body)).toEqual([
            { code: '200', status: 'OK', headers: [], data: 'in cs', success: true, changesetIndex: 0 },
        ]);
    });

    test('an unterminated last part whose payload ends with -- is still parsed', () => {
        const body = '--resp\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\nx--';

        expect(new BatchResponse({ data: body, headers: HEADERS }, 'application/json').response).toEqual([
            { code: '200', status: 'OK', headers: [], data: 'x--', success: true, changesetIndex: 0 },
        ]);
    });

    test('a binary part without a blank line keeps interior line breaks and drops the trailing one', () => {
        const br = new BatchResponse({ data: Buffer.from('--resp--', 'latin1'), headers: HEADERS }, 'text/plain');

        expect(br.parseResponse('a\nb\n')).toEqual({ code: '', status: '', headers: [], data: 'a\nb', success: false });
        expect(br.parseResponse('plain data\n').data).toBe('plain data');
        expect(br.parseResponse('\nplain data\n').data).toBe('plain data');
    });

    test('a Content-ID in HTTP headers is never promoted to the part contentId', () => {
        const body = lfBatch('Content-Type: application/http\n\nHTTP/1.1 200 OK\nContent-ID: 9\n\nx');

        expect(binaryResponse(body)).toEqual([
            {
                code: '200',
                status: 'OK',
                headers: [{ key: 'Content-ID', value: '9' }],
                data: 'x',
                success: true,
                changesetIndex: 0,
            },
        ]);
    });

    test('grouped: LF-only binary body parses exactly', () => {
        const body = Buffer.from(
            '--g\nContent-ID: 7\nContent-Type: application/http\n\nHTTP/1.1 404 Not Found\nX-A: 1\n\nbody\n--g--',
            'latin1'
        );

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(br.parseGrouped()).toEqual([
            {
                kind: 'unclassified',
                partIndex: 0,
                response: {
                    code: '404',
                    status: 'Not Found',
                    headers: [{ key: 'X-A', value: '1' }],
                    data: 'body',
                    success: false,
                    changesetIndex: 0,
                    contentId: '7',
                },
            },
        ]);
    });

    test('grouped: leading blank lines before the MIME headers are ignored', () => {
        const body = '--g\r\n\r\n\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\nok\r\n--g--';

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(br.parseGrouped()).toEqual([
            {
                kind: 'unclassified',
                partIndex: 0,
                response: { code: '200', status: 'OK', headers: [], data: 'ok', success: true, changesetIndex: 0 },
            },
        ]);
    });

    test('grouped: a MIME block without Content-Type throws even if the HTTP headers carry one', () => {
        const body = '--g\r\nContent-ID: 1\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/http\r\n\r\nx\r\n--g--';

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(() => br.parseGrouped()).toThrow('Grouped response part is missing Content-Type');
    });

    test('grouped: a junk-prefixed status line is rejected', () => {
        const body = '--g\r\nContent-Type: application/http\r\n\r\njunkHTTP/1.1 200 OK\r\n\r\nok\r\n--g--';

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(() => br.parseGrouped()).toThrow(
            'Grouped response expected an application/http response with a valid status line'
        );
    });

    test('grouped: a four-digit status line is rejected', () => {
        const body = '--g\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 2044\r\n\r\nok\r\n--g--';

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(() => br.parseGrouped()).toThrow(
            'Grouped response expected an application/http response with a valid status line'
        );
    });

    test('grouped: a status line without a reason phrase is valid', () => {
        const body = '--g\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200\r\n\r\nok\r\n--g--';

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(br.parseGrouped()).toEqual([
            {
                kind: 'unclassified',
                partIndex: 0,
                response: { code: '200', status: '', headers: [], data: 'ok', success: true, changesetIndex: 0 },
            },
        ]);
    });

    test('grouped: a whitespace-only body groups to an empty list', () => {
        const br = new BatchResponse({ data: ' \r\n\t ', headers: GROUPED_HEADERS }, 'application/json');

        expect(br.response).toEqual([]);
        expect(br.parseGrouped()).toEqual([]);
    });

    test('grouped: a changeset media type with a space before the parameter still groups', () => {
        const body = [
            '--g',
            'Content-Type: multipart/mixed ; boundary=cs',
            '',
            '--cs',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 204 No Content',
            '',
            '',
            '--cs--',
            '--g--',
        ].join('\r\n');

        const br = new BatchResponse({ data: body, headers: GROUPED_HEADERS }, 'application/json');

        expect(br.parseGrouped()).toEqual([
            {
                kind: 'changeset',
                partIndex: 0,
                responses: [
                    {
                        code: '204',
                        status: 'No Content',
                        headers: [],
                        data: null,
                        success: true,
                        changesetIndex: 0,
                    },
                ],
            },
        ]);
    });
});
