import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

// The merged-boundary reroll only triggers when a kept part already contains
// the generated boundary; pin randomUUID to force exactly one collision.
jest.mock('crypto', () => {
    const actual = jest.requireActual('crypto');
    const ids = ['collide', 'fresh'];
    return { ...actual, randomUUID: () => ids.shift() ?? actual.randomUUID() };
});

import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { BatchResponse } from '../src/response';

test('the merged boundary is regenerated when a kept part contains it', async () => {
    const mock = new MockAdapter(axios as any);
    try {
        const url = 'https://example.com/batch';
        const part = (payload: string) =>
            [
                '--resp',
                'Content-Type: application/http',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: text/plain',
                '',
                payload,
            ].join('\r\n');
        const accepted = [
            '--resp',
            'Content-Type: application/http',
            '',
            'HTTP/1.1 202 Accepted',
            'Location: https://example.com/m2',
            'Retry-After: 0',
            '',
            '',
        ].join('\r\n');
        mock.onPost(url).reply(202, '', { location: 'https://example.com/m1', 'retry-after': '0' });
        mock.onGet('https://example.com/m1').reply(
            200,
            `${part('text batch_merged_collide inside')}\r\n${accepted}--resp--`,
            {
                'content-type': 'multipart/mixed; boundary=resp',
            }
        );
        mock.onGet('https://example.com/m2').reply(200, `${part('done')}\r\n--resp--`, {
            'content-type': 'multipart/mixed; boundary=resp',
        });

        const result = await new ODataBatchAxiosRepository({ sleep: async () => undefined }).send(
            url,
            'request',
            { headers: {}, asyncPolling: { maxPolls: 5, defaultRetryAfterMs: 0, maxRetryAfterMs: 0 } },
            'text/plain',
            BatchResponse
        );

        expect(result.map((r) => r.data)).toEqual(['text batch_merged_collide inside', 'done']);
    } finally {
        mock.restore();
    }
});
