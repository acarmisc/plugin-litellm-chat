import { Router } from 'express';
import { Config } from '@backstage/config';
import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
export interface RouterOptions {
    config: Config;
    logger: any;
    auth: AuthService;
    discovery: DiscoveryService;
}
export declare function createRouter(options: RouterOptions): Promise<Router>;
