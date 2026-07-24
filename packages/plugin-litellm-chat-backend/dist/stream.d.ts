import type { Response } from 'express';
export interface ProxySSEOptions {
    upstreamUrl: string;
    upstreamBody: unknown;
    userKey: string;
    res: Response;
    logger: any;
}
export declare function proxySSE(opts: ProxySSEOptions): Promise<void>;
