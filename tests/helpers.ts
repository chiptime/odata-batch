import { ODataBatchRepository } from '../src/BatchRepository';
import { BatchResponseConstructor } from '../src/response';

/**
 * Dummy repository for ODataBatch unit tests.
 * Tracks the last call to `send()` and returns a mocked success response.
 */
export class DummyBatchRepo implements ODataBatchRepository {
    public lastUrl = '';
    public lastRequest = '';
    public lastConfig: any = null;

    send(
        url: string,
        batchRequest: string,
        config: any,
        accept: string,
        parser: BatchResponseConstructor
    ): Promise<any> {
        this.lastUrl = url;
        this.lastRequest = batchRequest;
        this.lastConfig = config;
        // Return a mocked success response
        return Promise.resolve([
            {
                code: '200',
                status: 'OK',
                headers: [],
                data: {},
                success: true,
            },
        ]);
    }
}

/**
 * Mock helper for deterministic Math.random in tests.
 * Returns a function that restores the original when called.
 */
export function makeRandomMock(value: number): () => void {
    const original = Math.random;
    Math.random = jest.fn(() => value);
    return () => {
        Math.random = original;
    };
}

/**
 * Mock helper for deterministic Date.now in tests.
 * Returns a function that restores the original when called.
 */
export function makeDateMock(timestamp: number): () => void {
    const original = Date.now;
    Date.now = jest.fn(() => timestamp);
    return () => {
        Date.now = original;
    };
}

/**
 * Cleanup helper to restore all mocked globals.
 */
export function restoreMocks(): void {
    jest.restoreAllMocks();
}
