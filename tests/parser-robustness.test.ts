import { BatchResponse } from '../src/response';

describe('FR-04 & FR-06: parseBatch delimiter anchoring and boundary extraction', () => {
    describe('FR-04: Delimiter anchoring in parseBatch', () => {
        test('preserves JSON payload containing outer boundary substring without splitting', () => {
            const boundary = 'batch_12345';
            const responseData = [
                `--${boundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                `{"id":1,"note":"embedded --${boundary} delimiter in middle of line"}`,
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].success).toBe(true);
            expect(response.response[0].code).toBe('200');
            expect(response.response[0].data).toEqual({
                id: 1,
                note: `embedded --${boundary} delimiter in middle of line`,
            });
        });

        test('preserves changeset payload containing changeset boundary substring without splitting', () => {
            const boundary = 'batch_12345';
            const csBoundary = 'changeset_99999';
            const responseData = [
                `--${boundary}`,
                `Content-Type: multipart/mixed; boundary=${csBoundary}`,
                '',
                `--${csBoundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                `{"id":2,"data":"contains --${csBoundary} in text"}`,
                `--${csBoundary}--`,
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].success).toBe(true);
            expect(response.response[0].data).toEqual({
                id: 2,
                data: `contains --${csBoundary} in text`,
            });
        });
    });

    describe('FR-06: Robust changeset boundary extraction in parseBatch', () => {
        test('extracts operations from changeset with quoted boundary parameter and charset', () => {
            const boundary = 'batch_12345';
            const csBoundary = 'changeset_quoted';
            const responseData = [
                `--${boundary}`,
                `Content-Type: multipart/mixed; boundary="${csBoundary}"; charset=utf-8`,
                '',
                `--${csBoundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"id":42,"status":"ok"}',
                `--${csBoundary}--`,
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].success).toBe(true);
            expect(response.response[0].code).toBe('200');
            expect(response.response[0].data).toEqual({ id: 42, status: 'ok' });
            expect(response.response[0].changesetIndex).toBe(0);
        });

        test('extracts operations from changeset with unquoted boundary parameter and trailing parameters', () => {
            const boundary = 'batch_12345';
            const csBoundary = 'changeset_params';
            const responseData = [
                `--${boundary}`,
                `Content-Type: multipart/mixed; boundary=${csBoundary}; charset=utf-8`,
                '',
                `--${csBoundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 201 Created',
                'Content-Type: application/json',
                '',
                '{"created":true}',
                `--${csBoundary}--`,
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `multipart/mixed; boundary=${boundary}` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].code).toBe('201');
            expect(response.response[0].data).toEqual({ created: true });
        });

        test('extracts boundary with leading/trailing spaces inside quotes and trims them', () => {
            const boundary = 'batch_spaces';
            const responseData = [
                `--${boundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"ok":true}',
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `multipart/mixed; boundary="  ${boundary}  "` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ ok: true });
        });

        test('extracts standalone boundary header without leading semicolon', () => {
            const boundary = 'standalone_batch';
            const responseData = [
                `--${boundary}`,
                'Content-Type: application/http',
                'Content-Transfer-Encoding: binary',
                '',
                'HTTP/1.1 200 OK',
                'Content-Type: application/json',
                '',
                '{"ok":true}',
                `--${boundary}--`,
            ].join('\r\n');

            const headers = { 'content-type': `boundary=${boundary}` };
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            expect(response.response).toHaveLength(1);
            expect(response.response[0].data).toEqual({ ok: true });
        });
    });
});
