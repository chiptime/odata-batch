import { ODataBatch } from '../src/ODataBatch';
import { ODataBatchAxiosRepository } from '../src/ODataBatchAxiosRepository';
import { DummyBatchRepo } from './helpers';

describe('ODataBatch', () => {
    describe('constructor()', () => {
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
                    [
                        { method: 'GET', url: '/api/b', data: null },
                    ],
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
            const beforeTime = new Date().getTime().toString();

            // Act
            const batch = new ODataBatch(config);
            const afterTime = new Date().getTime().toString();

            // Assert
            expect(batch['boundary']).toBeDefined();
            expect(parseInt(batch['boundary'], 10)).toBeGreaterThanOrEqual(parseInt(beforeTime, 10));
            expect(parseInt(batch['boundary'], 10)).toBeLessThanOrEqual(parseInt(afterTime, 10));
        });
    });

    describe('send()', () => {
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
});
