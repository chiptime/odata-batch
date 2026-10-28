import { ODataBatchRepository } from '../src/BatchRepository';
import { BatchResponseConstructor } from '../src/response';
import * as boundaryModule from '../src/boundary';

/**
 * Dummy repository for ODataBatch unit tests.
 * Tracks the last call to `send()` and returns a mocked success response
 * (or the canned response passed to the constructor).
 */
export class DummyBatchRepo implements ODataBatchRepository {
    public lastUrl = '';
    // Widened for binary batches (S4): a Buffer body when any call carries
    // binary data. Kept `any` so legacy string assertions keep compiling.
    public lastRequest: any = '';
    public lastConfig: any = null;

    constructor(
        // Canned response so tests can assert what ODataBatch.send() resolves to
        private response: any[] = [
            {
                code: '200',
                status: 'OK',
                headers: [],
                data: {},
                success: true,
            },
        ]
    ) {}

    send(
        url: string,
        batchRequest: string | Buffer,
        config: any,
        _accept: string,
        _parser: BatchResponseConstructor
    ): Promise<any> {
        this.lastUrl = url;
        this.lastRequest = batchRequest;
        this.lastConfig = config;
        // Return the mocked (or canned) response
        return Promise.resolve(this.response);
    }
}

/**
 * Mock helper for deterministic Math.random and boundary generation in tests.
 * Returns a function that restores the original when called.
 */
export function makeRandomMock(value: number): () => void {
    const original = Math.random;
    Math.random = jest.fn(() => value / 100);
    const spy = jest.spyOn(boundaryModule, 'generateBoundaryId').mockReturnValue(String(value));
    return () => {
        Math.random = original;
        spy.mockRestore();
    };
}

/**
 * Mock helper for a deterministic SEQUENCE of Math.random and boundary values.
 * The last value repeats if exhausted.
 */
export function makeRandomSequenceMock(values: number[]): () => void {
    const original = Math.random;
    let i = 0;
    Math.random = jest.fn(() => values[Math.min(i++, values.length - 1)] / 100);
    let j = 0;
    const spy = jest.spyOn(boundaryModule, 'generateBoundaryId').mockImplementation(() => {
        return String(values[Math.min(j++, values.length - 1)]);
    });
    return () => {
        Math.random = original;
        spy.mockRestore();
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
