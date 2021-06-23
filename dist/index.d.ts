export declare class ODataBatch {
    private boundary;
    private calls;
    private auth;
    private url;
    constructor({ url, auth, calls, batchResponseType, individualResponseType }: {
        url: string;
        auth: string;
        calls?: any;
        batchResponseType?: string;
        individualResponseType?: string;
    });
    invoke(): Promise<any>;
    ensureHasCalls(data: any): void;
}
