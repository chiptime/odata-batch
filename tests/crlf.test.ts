import http from 'http';
import { ODataBatch } from '../src/ODataBatch';
import { DummyBatchRepo } from './helpers';

describe('FR-02 & FR-03: CRLF injection defense-in-depth', () => {
    const baseCalls = [{ method: 'POST', url: '/items', headers: {}, data: {} }];
    const baseOpts = {
        url: 'https://example.com/batch',
        auth: 'user:pass',
        calls: baseCalls,
    };

    describe('FR-02: auth parameter CRLF validation', () => {
        test.each([
            ['user:pass\r\nX-Injected: evil'],
            ['user:pass\nX-Injected: evil'],
            ['token-with-\r-only'],
            ['token-with-\r\n-crlf'],
        ])('rejects auth containing line breaks with exact message without echoing value %j', (authWithBreak) => {
            expect(() => {
                new ODataBatch({ ...baseOpts, auth: authWithBreak }, new DummyBatchRepo());
            }).toThrow('Call auth must not contain line breaks');

            try {
                new ODataBatch({ ...baseOpts, auth: authWithBreak }, new DummyBatchRepo());
            } catch (err: any) {
                expect(err.message).toBe('Call auth must not contain line breaks');
                expect(err.message).not.toContain(authWithBreak);
                expect(err.message).not.toContain('X-Injected');
            }
        });

        test('documents Node.js native http header validation behavior', () => {
            // Node.js native http module rejects headers containing CRLF
            expect(() => {
                const req = new http.OutgoingMessage();
                req.setHeader('X-Custom-Test', 'value\r\nX-Injected: 1');
            }).toThrow(/Invalid character in header content|ERR_INVALID_CHAR/);
        });
    });

    describe('FR-03: root headers CRLF validation', () => {
        test.each(['X-Injected\r\nHeader', 'X-Injected\nHeader', 'X-Injected\rHeader'])(
            'rejects line break in root header key %j',
            (key) => {
                expect(() => {
                    new ODataBatch(
                        {
                            ...baseOpts,
                            headers: { [key]: 'valid' },
                        },
                        new DummyBatchRepo()
                    );
                }).toThrow(`Call header '${key}' must not contain line breaks`);
            }
        );

        test.each(['value\r\nInjected: evil', 'value\nInjected: evil', 'value\rInjected: evil'])(
            'rejects line break in root header value %j',
            (val) => {
                expect(() => {
                    new ODataBatch(
                        {
                            ...baseOpts,
                            headers: { 'X-Custom': val },
                        },
                        new DummyBatchRepo()
                    );
                }).toThrow("Call header 'X-Custom' must not contain line breaks");
            }
        );

        test('allows valid root headers without line breaks', () => {
            expect(() => {
                new ODataBatch(
                    {
                        ...baseOpts,
                        headers: { 'X-Custom-Safe': 'safe-value-123' },
                    },
                    new DummyBatchRepo()
                );
            }).not.toThrow();
        });

        test('validates root headers across retrieve and operations modes', () => {
            expect(() => {
                new ODataBatch(
                    {
                        url: 'https://example.com/batch',
                        auth: 'user:pass',
                        retrieve: [{ url: '/items' }],
                        headers: { 'X-Bad': 'v\r\n' },
                    },
                    new DummyBatchRepo()
                );
            }).toThrow("Call header 'X-Bad' must not contain line breaks");

            expect(() => {
                new ODataBatch(
                    {
                        url: 'https://example.com/batch',
                        auth: 'user:pass',
                        operations: [{ url: '/items' }],
                        headers: { 'X-Bad': 'v\r\n' },
                    },
                    new DummyBatchRepo()
                );
            }).toThrow("Call header 'X-Bad' must not contain line breaks");
        });
    });
});
