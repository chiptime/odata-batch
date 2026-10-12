import { requestsToBatch, operationsToBatch, Call } from '../src/request';
import { makeRandomMock } from './helpers';

describe('FR-07: HTTP method token validation (RFC 9110)', () => {
    const JSON_OPTS = { contentType: 'application/json', accept: 'application/json' };

    beforeEach(() => {
        makeRandomMock(1);
    });

    describe('requestsToBatch', () => {
        test.each([
            ['POST /admin HTTP/1.1'],
            [''],
            ['POST '],
            [' GET'],
            ['POST\t'],
            ['POST\r\n'],
            ['POST\n'],
            ['POST\r'],
            ['POST@'],
            ['POST,'],
            ['POST;'],
            ['POST?'],
            ['POST/'],
            ['POST='],
            ['POST{'],
        ])('rejects invalid HTTP method token %j with exact message', (invalidMethod) => {
            const call: Call = {
                method: invalidMethod,
                url: '/items',
                data: null,
            };

            expect(() => requestsToBatch([call], 'boundary_1', JSON_OPTS)).toThrow(
                'Call method must be a valid HTTP token'
            );
        });

        test('rejects non-string method', () => {
            const call: any = {
                method: 123,
                url: '/items',
                data: null,
            };

            expect(() => requestsToBatch([call], 'boundary_1', JSON_OPTS)).toThrow(
                'Call method must be a valid HTTP token'
            );
        });

        test.each([
            ['GET'],
            ['POST'],
            ['PUT'],
            ['DELETE'],
            ['PATCH'],
            ['HEAD'],
            ['OPTIONS'],
            ['CUSTOM-METHOD'],
            ['CUSTOM+METHOD'],
            ['my_method'],
            ['method~1'],
            ['foo*bar'],
            ['M'],
        ])('accepts valid RFC 9110 method token %j', (validMethod) => {
            const call: Call = {
                method: validMethod,
                url: '/items',
                data: null,
            };

            expect(() => requestsToBatch([call], 'boundary_1', JSON_OPTS)).not.toThrow();
        });
    });

    describe('operationsToBatch', () => {
        test('rejects invalid method in mixed operations changeset', () => {
            const call: Call = {
                method: 'POST /admin HTTP/1.1',
                url: '/items',
                data: null,
            };

            expect(() => operationsToBatch([[call]], 'boundary_1', JSON_OPTS)).toThrow(
                'Call method must be a valid HTTP token'
            );
        });

        test('accepts valid method in mixed operations changeset', () => {
            const call: Call = {
                method: 'PATCH',
                url: '/items',
                data: null,
            };

            expect(() => operationsToBatch([[call]], 'boundary_1', JSON_OPTS)).not.toThrow();
        });
    });
});
