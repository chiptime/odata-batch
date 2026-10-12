import { ODataBatch } from '../src/ODataBatch';
import { RetrieveCall } from '../src/request';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { DummyBatchRepo } from './helpers';

describe('ODataBatch', () => {
    describe('constructor()', () => {
        describe.each(['batchResponseType', 'individualResponseType'])('%s validation', (option) => {
            test.each([
                '',
                '   ',
                'yaml',
                'text/plain',
                'application/problem+json',
                'application/*',
                'application/json,application/xml',
                'json;odata=verbose',
                'application /json',
                'application/json;',
                'application/json; charset',
                'application/json; charset=',
                'application/json; =utf-8',
                'application/json; charset=utf 8',
                'application/json; charset="utf-8',
                'application/json; charset="utf-8"junk',
                'application/json; charset=utf-8;;odata=verbose',
                'application/json\r\nX-Injected: yes',
                '\napplication/xml',
                'application/xml; charset="utf\r\n8"',
                'application/json; charset=utf-8\u0000',
                'application/json; charset="utf\u007f8"',
                'application/json\t;odata=verbose',
                'application/json; profile="café"',
            ])('rejects invalid media type %j before sending', (value) => {
                const repo = new DummyBatchRepo();
                expect(
                    () =>
                        new ODataBatch(
                            {
                                url: 'http://example.com/batch',
                                auth: 'user:pass',
                                calls: [{ method: 'POST', url: '/items', data: {} }],
                                [option]: value,
                            },
                            repo
                        )
                ).toThrow(`${option} must be a supported JSON or XML media type`);
                expect(repo.lastRequest).toBe('');
            });
        });

        test.each(['batchResponseType', 'individualResponseType'])('validates %s in retrieve mode too', (option) => {
            expect(
                () =>
                    new ODataBatch({
                        url: 'http://example.com/batch',
                        auth: 'user:pass',
                        retrieve: [{ url: '/items' }],
                        [option]: 'text/plain',
                    })
            ).toThrow(`${option} must be a supported JSON or XML media type`);
        });

        test.each([null, 42, {}, ['json']])('rejects non-string options from JavaScript callers: %j', (value) => {
            for (const option of ['batchResponseType', 'individualResponseType']) {
                expect(
                    () =>
                        new ODataBatch({
                            url: 'http://example.com/batch',
                            auth: 'user:pass',
                            calls: [{ method: 'POST', url: '/items', data: {} }],
                            [option]: value as any,
                        })
                ).toThrow(`${option} must be a supported JSON or XML media type`);
            }
        });

        test('empty calls throws error', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [] as any[],
            };

            // Act & Assert
            expect(() => new ODataBatch(config)).toThrow('No calls have been passed');
        });

        test('empty sub-array throws error', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [[] as any[]] as any[][],
            };

            // Act & Assert
            expect(() => new ODataBatch(config)).toThrow('No calls have been passed');
        });

        test('multi-changeset with empty sub-array throws error', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [
                    [{ method: 'POST', url: '/api/a', data: { id: 1 } }],
                    [] as any[],
                    [{ method: 'GET', url: '/api/b', data: null }],
                ] as any[][],
            };

            // Act & Assert
            expect(() => new ODataBatch(config)).toThrow('No calls have been passed');
        });

        test('multi-changeset format is accepted', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [
                    [
                        { method: 'POST', url: '/api/a', data: { id: 1 } },
                        { method: 'POST', url: '/api/a2', data: { id: 2 } },
                    ],
                    [{ method: 'GET', url: '/api/b', data: null }],
                ],
            };

            // Act & Assert
            expect(() => new ODataBatch(config)).not.toThrow();
        });

        test('legacy Call[] format still works', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [
                    { method: 'POST', url: '/api/a', data: { id: 1 } },
                    { method: 'GET', url: '/api/b', data: null },
                ],
            };

            // Act & Assert
            expect(() => new ODataBatch(config)).not.toThrow();
        });

        test('default repository is ODataBatchAxiosRepository', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
            };

            // Act
            const batch = new ODataBatch(config);

            // Assert
            expect(batch).toBeInstanceOf(ODataBatch);
            expect(batch['batchRepository']).toBeDefined();
            expect(batch['batchRepository']).toBeInstanceOf(ODataBatchAxiosRepository);
        });

        test('boundary equals current timestamp', () => {
            // Arrange
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
            };
            jest.useFakeTimers({ now: 1700000000123 });

            try {
                // Act
                const batch = new ODataBatch(config);

                // Assert
                expect(batch['boundary']).toBe('1700000000123');
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('send()', () => {
        test.each([false, true])(
            'parameterized XML stays raw with multi-changeset=%s and boundary collision',
            async (multi) => {
                const random = jest.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValue(0.5);
                const repo = new DummyBatchRepo();
                const data = '<item>\r\n--changeset_25\r\n</item>';
                const call = { method: 'POST', url: '/items', data };

                try {
                    const batch = new ODataBatch(
                        {
                            url: 'http://example.com/batch',
                            auth: 'user:pass',
                            calls: multi ? [[call], [call]] : [call],
                            batchResponseType: 'application/xml;charset=utf-8',
                        },
                        repo
                    );
                    await batch.send();

                    expect(random).toHaveBeenCalledTimes(2);
                    expect(repo.lastRequest).toContain('boundary=changeset_50');
                    expect(repo.lastRequest.split(`\r\n\r\n${data}\r\n`)).toHaveLength(multi ? 3 : 2);
                    expect(repo.lastRequest).not.toContain(JSON.stringify(data));
                } finally {
                    random.mockRestore();
                }
            }
        );

        test('delegates to mock repository', async () => {
            // Arrange
            const dummyRepo = new DummyBatchRepo();
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
            };
            const batch = new ODataBatch(config, dummyRepo);

            // Act
            await batch.send();

            // Assert
            expect(dummyRepo.lastUrl).toBe('http://example.com/batch');
            expect(dummyRepo.lastRequest).toBeDefined();
            expect(dummyRepo.lastConfig).toBeDefined();
            expect(dummyRepo.lastConfig.headers).toBeDefined();
        });

        test('header Authorization takes priority over constructor auth', async () => {
            // Arrange
            const dummyRepo = new DummyBatchRepo();
            const config = {
                url: 'http://example.com/batch',
                auth: 'basic:pass',
                headers: { Authorization: 'Bearer token123' },
                calls: [{ method: 'GET', url: '/items', data: null }],
            };
            const batch = new ODataBatch(config, dummyRepo);

            // Act
            await batch.send();

            // Assert
            expect(dummyRepo.lastConfig.headers.Authorization).toBe('Bearer token123');
        });

        test('includes Accept and Content-Type in config', async () => {
            // Arrange
            const dummyRepo = new DummyBatchRepo();
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [{ method: 'GET', url: '/items', data: null }],
            };
            const batch = new ODataBatch(config, dummyRepo);

            // Act
            await batch.send();

            // Assert
            expect(dummyRepo.lastConfig.headers.Accept).toBe('application/json');
            expect(dummyRepo.lastConfig.headers['Content-Type']).toContain('multipart/mixed');
        });

        test('multi-changeset format produces valid wire format', async () => {
            // Arrange
            const dummyRepo = new DummyBatchRepo();
            const config = {
                url: 'http://example.com/batch',
                auth: 'user:pass',
                calls: [
                    [{ method: 'POST', url: '/api/a', data: { id: 1 } }],
                    [{ method: 'GET', url: '/api/b', data: null }],
                ],
            };
            const batch = new ODataBatch(config, dummyRepo);

            // Act
            await batch.send();

            // Assert
            expect(dummyRepo.lastRequest).toContain('--batch_');
            expect(dummyRepo.lastRequest).toContain('boundary=changeset_');
            // Should contain multiple changeset boundaries
            expect(dummyRepo.lastRequest).toContain('Content-Type: multipart/mixed; boundary=');
        });
    });

    describe('retrieve mode', () => {
        describe('constructor()', () => {
            test('both calls and retrieve throws error', () => {
                // Arrange
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    calls: [{ method: 'GET', url: '/items', data: null }],
                    retrieve: [{ url: '/items' }],
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).toThrow('Pass either calls or retrieve, not both');
            });

            test('neither calls nor retrieve throws error', () => {
                // Arrange
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).toThrow('No calls have been passed');
            });

            test('empty retrieve throws error', () => {
                // Arrange
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    retrieve: [] as RetrieveCall[],
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).toThrow('No calls have been passed');
            });

            test('retrieve entry with a method property throws GET-only error', () => {
                // Arrange - a Call accidentally passed where a RetrieveCall is expected
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    retrieve: [{ url: '/items', method: 'POST' } as RetrieveCall],
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).toThrow(
                    'retrieve calls are GET-only: method and data are not allowed'
                );
            });

            test('retrieve entry with a data property throws GET-only error', () => {
                // Arrange
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    retrieve: [{ url: '/items', data: { id: 1 } } as RetrieveCall],
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).toThrow(
                    'retrieve calls are GET-only: method and data are not allowed'
                );
            });

            test('retrieve-only construction builds without calls', () => {
                // Arrange
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    retrieve: [{ url: '/items' }, { url: '/items(2)' }],
                };

                // Act & Assert
                expect(() => new ODataBatch(config)).not.toThrow();
            });
        });

        describe('send()', () => {
            test('passes the retrieve body and batch headers to the repository', async () => {
                // Arrange
                const dummyRepo = new DummyBatchRepo();
                const config = {
                    url: 'http://example.com/batch',
                    auth: 'user:pass',
                    retrieve: [{ url: '/items' }, { url: '/items(2)' }],
                };
                const batch = new ODataBatch(config, dummyRepo);

                // Act
                await batch.send();

                // Assert - direct GET parts, no changeset anywhere
                expect(dummyRepo.lastRequest).toContain('GET /items HTTP/1.1');
                expect(dummyRepo.lastRequest).toContain('GET /items(2) HTTP/1.1');
                expect(dummyRepo.lastRequest).not.toContain('changeset');
                expect(dummyRepo.lastConfig.headers['Content-Type']).toBe(
                    'multipart/mixed; boundary=batch_' + batch['boundary']
                );
                expect(dummyRepo.lastConfig.headers.Accept).toBe('application/json');
            });

            test('resolves to the repository results', async () => {
                // Arrange
                const canned = [
                    { code: '404', status: 'Not Found', headers: [], data: { error: 'none' }, success: false },
                ];
                const dummyRepo = new DummyBatchRepo(canned);
                const batch = new ODataBatch(
                    { url: 'http://example.com/batch', auth: 'user:pass', retrieve: [{ url: '/nope' }] },
                    dummyRepo
                );

                // Act
                const result = await batch.send();

                // Assert
                expect(result).toEqual(canned);
            });
        });
    });
});
