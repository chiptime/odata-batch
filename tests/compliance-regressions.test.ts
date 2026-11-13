import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ODataBatch, JsonBatchResponse } from '../src';
import { requestsToBatch, operationsToBatch, Call } from '../src/request';

const call = (data: unknown = null): Call => ({ method: 'POST', url: '/Items', data });

describe('independent compliance regressions', () => {
    test.each([false, true])('legacy empty XML array framing, grouped=%s', (grouped) => {
        const member = call([]);
        const { body } = requestsToBatch(grouped ? [[member]] : [member], 'fixed', {
            contentType: 'application/xml',
            accept: 'application/json',
        });
        expect(typeof body).toBe('string');
        expect(String(body)).toMatch(/Accept: application\/json\r\n\r\n\r\n--changeset_/);
        expect(String(body)).not.toMatch(/Accept: application\/json\r\n\r\n\r\n\r\n--changeset_/);
    });

    test.each(['4.0', '4.01'] as const)(
        'v%s same-group duplicates use the batch-wide diagnostic',
        (protocolVersion) => {
            const duplicate = { ...call(), contentId: 'a' };
            expect(() => requestsToBatch([duplicate, duplicate], { protocolVersion })).toThrow(
                new Error('Duplicate contentId within the batch: a')
            );
            expect(() => operationsToBatch([[duplicate, duplicate]], { protocolVersion })).toThrow(
                new Error('Duplicate contentId within the batch: a')
            );
            expect(() => requestsToBatch([duplicate, duplicate])).toThrow(
                new Error('Duplicate contentId within a changeset: a')
            );
        }
    );

    test('exported unbound JSON parser rejects duplicate response ids', () => {
        expect(
            () =>
                new JsonBatchResponse(
                    {
                        headers: {},
                        data: {
                            responses: [
                                { id: 'a', status: 200 },
                                { id: 'a', status: 201 },
                            ],
                        },
                    },
                    'application/json'
                )
        ).toThrow(new Error('JSON batch response does not match request ids: a'));
    });

    test('README multiple-changeset example constructs without contacting a server', () => {
        const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
        const section = readme.split('## Multiple changesets (atomic groups)')[1].split('### Grouped responses')[0];
        const literal = section.match(/const calls: Call\[\]\[\] = ([\s\S]*?);/);
        expect(literal).not.toBeNull();
        const calls = new Function('return (' + literal![1] + ')')() as Call[][];
        expect(() => new ODataBatch({ url: 'http://127.0.0.1:1/batch', auth: 'u:p', calls })).not.toThrow();
    });
});
