import { readFileSync } from 'fs';
import { join } from 'path';
import { BatchResponse, BatchResponseGroup } from '../src/response';

/**
 * Golden corpus: real-shaped OData V2 batch bodies read from
 * tests/fixtures/sap. These are synthetic but realistic samples (see the
 * fixtures README); they pin the parser against frozen inputs instead of
 * bodies rebuilt inside each test.
 */

const load = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'sap', name), 'utf8');

const parse = (name: string, boundary: string, accept = 'application/json'): BatchResponse =>
    new BatchResponse(
        { data: load(name), headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } },
        accept
    );

describe('SAP batch golden corpus', () => {
    test('changeset-success: three operations parsed in order, Content-ID kept', () => {
        const result = parse('changeset-success.multipart', 'batch_1001').response;

        expect(result.map((r) => [r.code, r.success])).toEqual([
            ['201', true],
            ['204', true],
            ['200', true],
        ]);
        expect(result.map((r) => r.contentId)).toEqual(['1', undefined, undefined]);
        expect(result[0].data).toEqual({ id: 1, name: 'one' });
        expect(result[1].data).toBeNull();
        expect(result[2].data).toEqual({ id: 3 });
    });

    test('changeset-collapsed-error: one error part represents the whole transaction', () => {
        const parser = parse('changeset-collapsed-error.multipart', 'batch_1002');

        expect(parser.response).toHaveLength(1);
        expect(parser.response[0]).toMatchObject({ code: '400', success: false });
        expect((parser.response[0].data as { error: { code: string } }).error.code).toBe(
            '/IWBEP/CX_MGW_BUSI_EXCEPTION'
        );

        const groups = parser.parseGrouped([{ kind: 'changeset', operationCount: 3 }]);
        expect(groups[0]).toMatchObject({ kind: 'changeset-error', partIndex: 0 });
    });

    test('content-id: MIME identifiers are exposed, not the inner HTTP header', () => {
        const result = parse('content-id.multipart', 'batch_1003').response;

        expect(result.map((r) => r.contentId)).toEqual(['1', '2']);
        expect(result.map((r) => r.data)).toEqual([{ id: 10 }, { id: 11 }]);
    });

    test('preamble: a header-looking preamble is ignored and the real part parses', () => {
        const result = parse('preamble.multipart', 'batch_1004').response;

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ code: '200', success: true, data: { ok: true } });
    });

    test('retrieve-mixed: grouped layout distinguishes a GET from a changeset', () => {
        const parser = parse('retrieve-mixed.multipart', 'batch_1005');
        const groups: BatchResponseGroup[] = parser.parseGrouped([
            { kind: 'retrieve' },
            { kind: 'changeset', operationCount: 1 },
        ]);

        expect(groups.map((g) => g.kind)).toEqual(['retrieve', 'changeset']);
        expect(groups[1]).toMatchObject({ kind: 'changeset', partIndex: 1 });
    });

    test('line-ending normalization: the LF fixture and a CRLF twin parse identically', () => {
        const lf = parse('changeset-success.multipart', 'batch_1001').response;
        const crlfBody = load('changeset-success.multipart').replace(/\n/g, '\r\n');
        const crlf = new BatchResponse(
            { data: crlfBody, headers: { 'content-type': 'multipart/mixed; boundary=batch_1001' } },
            'application/json'
        ).response;

        expect(crlf).toEqual(lf);
    });

    test('verbose accept parses the JSON bodies of the corpus', () => {
        const result = parse('changeset-success.multipart', 'batch_1001', 'application/json;odata=verbose').response;

        expect(result[2].data).toEqual({ id: 3 });
    });
});
