import { BatchResponse } from '../src/response';

describe('BatchResponse', () => {
    describe('constructor()', () => {
        test('missing accept throws error', () => {
            // Arrange
            const responseData = '--batch_12345\r\nContent-Type: text/plain\r\n\r\ntest\r\n--batch_12345--';
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act & Assert
            expect(() => new BatchResponse({ data: responseData, headers }, undefined as any)).toThrow(
                'Need accept to know how parse.'
            );
        });

        test('missing boundary throws error', () => {
            // Arrange
            const responseData = 'test data';
            const headers = {
                'content-type': 'text/plain',
            };

            // Act & Assert
            expect(() => new BatchResponse({ data: responseData, headers }, 'application/json')).toThrow(
                'Bad content-type header, no multipart boundary'
            );
        });
    });

    describe('parseBatch()', () => {
        test('happy path - 200 with JSON body', () => {
            // Arrange
            // Using a simpler multipart format without changesets for this test
            // The parser expects parts that start with "content-type"
            const responseData = `--batch_12345
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 200 OK
Content-Type: application/json

{"id":1,"name":"test"}
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - LF-only bodies are normalized to CRLF (B9), so the
            // part parses like a wire body
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '200', status: 'OK', success: true });
            expect(response.response[0].data).toEqual({ id: 1, name: 'test' });
        });

        test('4xx status sets success=false', () => {
            // Arrange
            const responseData = `--batch_12345
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error":"Invalid input"}
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - the LF-only fixture parses after normalization (B9)
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '400', status: 'Bad Request', success: false });
            expect(response.response[0].data).toEqual({ error: 'Invalid input' });
        });

        test('5xx status sets success=false', () => {
            // Arrange
            const responseData = `--batch_12345
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{"error":"Server error"}
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - the LF-only fixture parses after normalization (B9)
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({
                code: '500',
                status: 'Internal Server Error',
                success: false,
            });
            expect(response.response[0].data).toEqual({ error: 'Server error' });
        });

        test('multi-changeset response assigns correct indices', () => {
            // Arrange - Multi-changeset response with 2 changesets
            // Format: each batch part must have content-type at the start for parsing
            const responseData = `--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42_0

--changeset_42_0
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 200 OK
Content-Type: application/json

{"id":1,"name":"first"}
--changeset_42_0--
--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42_1

--changeset_42_1
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 201 Created
Content-Type: application/json

{"id":2,"name":"second"}
--changeset_42_1--
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - one parsed response per changeset, indices in order
            expect(response.response).toHaveLength(2);
            expect(response.response.map((item) => [item.code, item.changesetIndex])).toEqual([
                ['200', 0],
                ['201', 1],
            ]);
        });

        test('single/legacy changeset response assigns changesetIndex 0', () => {
            // Arrange - Single changeset response (no index suffix in boundary)
            const responseData = `--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42

--changeset_42
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 200 OK
Content-Type: application/json

{"id":1,"name":"test"}
--changeset_42--
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - the single changeset parses with index 0
            expect(response.response).toHaveLength(1);
            expect(response.response[0]).toMatchObject({ code: '200', changesetIndex: 0 });
            expect(response.response[0].data).toEqual({ id: 1, name: 'test' });
        });

        test('failed changeset (4xx) does not break adjacent responses indices', () => {
            // Arrange - First changeset returns 400, second returns 200
            const responseData = `--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42_0

--changeset_42_0
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error":"bad"}
--changeset_42_0--
--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42_1

--changeset_42_1
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 200 OK
Content-Type: application/json

{"id":2,"name":"ok"}
--changeset_42_1--
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - the 4xx part keeps success=false and both indices survive
            expect(response.response).toHaveLength(2);
            expect(response.response.map((item) => [item.code, item.success, item.changesetIndex])).toEqual([
                ['400', false, 0],
                ['200', true, 1],
            ]);
        });

        test('BatchResponseParsed includes changesetIndex field', () => {
            // Arrange
            const responseData = `--batch_12345
Content-Type: multipart/mixed; boundary=changeset_42_0

--changeset_42_0
Content-Type: application/http
Content-Transfer-Encoding: binary

HTTP/1.1 200 OK
Content-Type: application/json

{"id":1}
--changeset_42_0--
--batch_12345--`;
            const headers = {
                'content-type': 'multipart/mixed; boundary=batch_12345',
            };

            // Act
            const response = new BatchResponse({ data: responseData, headers }, 'application/json');

            // Assert - the parsed entry carries the changesetIndex field
            expect(response.response).toHaveLength(1);
            expect('changesetIndex' in response.response[0]).toBe(true);
        });
    });

    describe('parseData()', () => {
        test('parseData as JSON when accept is application/json', () => {
            // Arrange
            const jsonData = '{"key":"value","number":123}';

            // Act
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json'
            );
            const result = response['parseData'](jsonData);

            // Assert
            expect(result).toEqual({ key: 'value', number: 123 });
        });

        test('parseData returns the raw payload verbatim when accept is not JSON', () => {
            // Arrange - non-JSON payloads are surfaced whole, including line
            // breaks: no first-line truncation
            const xmlData = '<item>\r\n<id>1</id>\r\n</item>';

            // Act
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/xml'
            );
            const result = response['parseData'](xmlData);

            // Assert
            expect(result).toBe('<item>\r\n<id>1</id>\r\n</item>');
        });

        test('parseData as JSON when accept carries parameters (application/json;odata=verbose)', () => {
            // Arrange - the media type before ';' decides the mode
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json;odata=verbose'
            );

            // Act & Assert
            expect(response['parseData']('{"key":"value"}')).toEqual({ key: 'value' });
        });

        test('parseData as JSON when accept differs in case (Application/JSON)', () => {
            // Arrange - media types are case-insensitive
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'Application/JSON'
            );

            // Act & Assert
            expect(response['parseData']('{"key":"value"}')).toEqual({ key: 'value' });
        });

        test('parseData treats an undefined payload as empty (JSON accept => null)', () => {
            // Arrange - defensive contract of the public string | undefined param
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json'
            );

            // Act & Assert
            expect(response['parseData'](undefined)).toBeNull();
        });

        test('parseData treats an undefined payload as empty (raw accept => empty string)', () => {
            // Arrange - the same defensive contract on the raw-text branch
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/xml'
            );

            // Act & Assert
            expect(response['parseData'](undefined)).toBe('');
        });

        test('parseData returns null for an empty payload with JSON accept', () => {
            // Arrange - 204 No Content parts carry no JSON document
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json'
            );

            // Act & Assert
            expect(response['parseData']('')).toBeNull();
        });

        test('parseData returns null for a whitespace-only payload with JSON accept', () => {
            // Arrange - blank payload lines are not a JSON document either
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json'
            );

            // Act & Assert
            expect(response['parseData']('  \r\n ')).toBeNull();
        });

        test('parseData keeps the empty string for an empty payload with non-JSON accept', () => {
            // Arrange - raw-text consumers keep the legacy empty string
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/xml'
            );

            // Act & Assert
            expect(response['parseData']('')).toBe('');
        });

        test('parseData returns the raw string when JSON.parse fails', () => {
            // Arrange - one unparseable part must not throw away the batch
            const response = new BatchResponse(
                { data: '', headers: { 'content-type': 'multipart/mixed; boundary=test' } },
                'application/json'
            );

            // Act & Assert
            expect(response['parseData']('not-json-at-all')).toBe('not-json-at-all');
        });
    });
});
