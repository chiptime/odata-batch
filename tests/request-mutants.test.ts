import { operationsToBatch, requestsToBatch, Call } from '../src/request';
import { makeRandomSequenceMock } from './helpers';

const JSON_OPTS = { contentType: 'application/json', accept: 'application/json' };
const V4_OPTS = { ...JSON_OPTS, protocolVersion: '4.0' as const };

const call = (url: string, extra: Partial<Call> = {}): Call => ({ method: 'POST', url, data: {}, ...extra });
const contentIds = (body: string | Buffer) => [...body.toString().matchAll(/^Content-ID: (.*)$/gm)].map((m) => m[1]);

describe('operationsToBatch mutation kills', () => {
    test('without a v4 protocolVersion the contentId scope stays per changeset', () => {
        // Same explicit id in two different changesets is legal v2 behavior
        expect(() =>
            operationsToBatch([[call('/A', { contentId: 'x' })], [call('/B', { contentId: 'x' })]], JSON_OPTS)
        ).not.toThrow();
        expect(contentIds(operationsToBatch([[call('/A', { contentId: 'x' })]], JSON_OPTS).body)).toEqual(['x']);
        // A duplicate inside ONE changeset still reports the changeset scope
        expect(() =>
            operationsToBatch([[call('/A', { contentId: 'x' }), call('/B', { contentId: 'x' })]], JSON_OPTS)
        ).toThrow('Duplicate contentId within a changeset: x');
    });

    test('protocolVersion 4.01 assigns Content-IDs exactly like 4.0', () => {
        const { body } = operationsToBatch([[call('/A'), call('/B')]], { ...JSON_OPTS, protocolVersion: '4.01' });
        expect(contentIds(body)).toEqual(['1', '2']);
    });

    test('two changesets consume the assigned groups in order around an interleaved retrieve', () => {
        const restore = makeRandomSequenceMock([88]);
        try {
            const { body } = operationsToBatch([[call('/A')], { url: '/R' }, [call('/B')]], V4_OPTS);
            expect(contentIds(body)).toEqual(['1', '2']);
            expect(body).toContain('--changeset_88_0');
            expect(body).toContain('--changeset_88_1');
        } finally {
            restore();
        }
    });

    test('each changeset gets its own boundary suffix in document order', () => {
        const restore = makeRandomSequenceMock([77]);
        try {
            const { body } = operationsToBatch([[call('/A')], [call('/B')]], JSON_OPTS);
            expect(body).toContain('boundary=changeset_77_0');
            expect(body).toContain('boundary=changeset_77_1');
        } finally {
            restore();
        }
    });

    test('exact wire bytes for a mixed retrieve + changeset operations batch', () => {
        const restore = makeRandomSequenceMock([500]);
        try {
            const { body } = operationsToBatch([{ url: '/R' }, [call('/A')]], 'abc', JSON_OPTS);
            expect(body).toBe(
                [
                    '--batch_abc',
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'GET /R HTTP/1.1',
                    'Accept: application/json',
                    '',
                    '',
                    '--batch_abc',
                    'Content-Type: multipart/mixed; boundary=changeset_500_0',
                    '',
                    '--changeset_500_0',
                    'Content-Type: application/http',
                    'Content-Transfer-Encoding: binary',
                    '',
                    'POST /A HTTP/1.1',
                    'Content-Type: application/json',
                    'Accept: application/json',
                    '',
                    '{}',
                    '',
                    '--changeset_500_0--',
                    '',
                    '--batch_abc--',
                ].join('\r\n')
            );
        } finally {
            restore();
        }
    });

    test('an undefined JSON body renders as an empty body line', () => {
        const { body } = operationsToBatch([[{ method: 'POST', url: '/A', data: undefined }]], JSON_OPTS);
        // blank line, empty body line, trailing blank, then the changeset close
        expect(body).toContain('Accept: application/json\r\n\r\n\r\n\r\n--changeset_');
    });
});

describe('requestsToBatch mutation kills', () => {
    test('a multi-element XML body joins its lines with CRLF on the wire', () => {
        const { body } = requestsToBatch([[{ method: 'POST', url: '/X', data: ['<e1/>', '<e2/>'] }]], {
            contentType: 'application/xml',
        });
        expect(body).toContain('<e1/>\r\n<e2/>');
    });

    test('the collision check joins XML lines with CRLF: a fragment split across lines does not reroll', () => {
        // '--batch_kx' only exists if the two lines are concatenated without the CRLF
        const { body, boundary } = requestsToBatch(
            [[{ method: 'POST', url: '/X', data: ['<x>--bat', 'ch_kx--y'] }]],
            'kx',
            { contentType: 'application/xml' }
        );
        expect(boundary).toBe('kx');
        expect(body).toContain('--batch_kx\r\n');
    });

    test('a null XML body line renders as an empty line inside a binary Buffer body', () => {
        const { body } = requestsToBatch(
            [
                [
                    {
                        method: 'POST',
                        url: '/A',
                        data: Buffer.from([0xff]),
                        headers: { 'content-type': 'application/octet-stream' },
                    },
                    { method: 'POST', url: '/B', data: null },
                ],
            ],
            { contentType: 'application/xml' }
        );
        expect(body).toBeInstanceOf(Buffer);
        const wire = (body as Buffer).toString('latin1');
        expect(wire).toContain('\xff');
        expect(wire).toContain('POST /B HTTP/1.1\r\nContent-Type: application/xml\r\nAccept: undefined\r\n\r\n\r\n');
    });
});
