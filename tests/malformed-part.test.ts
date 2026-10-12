import { BatchResponse } from '../src/response';

describe('FR-05: Resilient malformed parts in parseResponse', () => {
    test('handles part without blank-line separation without throwing TypeError', () => {
        const boundary = 'batch_12345';
        const rawPartText = 'Content-Type: application/http';
        const responseData = [`--${boundary}`, rawPartText, `--${boundary}--`].join('\r\n');

        const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
        const response = new BatchResponse({ data: responseData, headers }, 'application/json');

        expect(response.response).toHaveLength(1);
        expect(response.response[0]).toEqual({
            code: '',
            status: '',
            headers: [],
            data: rawPartText,
            success: false,
            changesetIndex: 0,
        });
    });

    test('parses adjacent valid parts alongside a malformed part', () => {
        const boundary = 'batch_12345';
        const malformedPart = 'Content-Type: application/http';
        const responseData = [
            `--${boundary}`,
            malformedPart,
            `--${boundary}`,
            'Content-Type: application/http',
            'Content-Transfer-Encoding: binary',
            '',
            'HTTP/1.1 200 OK',
            'Content-Type: application/json',
            '',
            '{"id":1}',
            `--${boundary}--`,
        ].join('\r\n');

        const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
        const response = new BatchResponse({ data: responseData, headers }, 'application/json');

        expect(response.response).toHaveLength(2);
        expect(response.response[0]).toEqual({
            code: '',
            status: '',
            headers: [],
            data: malformedPart,
            success: false,
            changesetIndex: 0,
        });
        expect(response.response[1]).toMatchObject({
            code: '200',
            status: 'OK',
            success: true,
            data: { id: 1 },
            changesetIndex: 1,
        });
    });

    test('strips only trailing CRLF from malformed part preserving internal line breaks', () => {
        const boundary = 'batch_12345';
        const rawPartText = 'Content-Type: application/http\r\nX-Malformed: line2';
        const responseData = [`--${boundary}`, rawPartText, `--${boundary}--`].join('\r\n');

        const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
        const response = new BatchResponse({ data: responseData, headers }, 'application/json');

        expect(response.response).toHaveLength(1);
        expect(response.response[0].data).toBe(rawPartText);
    });
});
