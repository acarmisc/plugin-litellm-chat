"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.litellmChatPlugin = void 0;
const backend_plugin_api_1 = require("@backstage/backend-plugin-api");
const router_1 = require("./router");
exports.litellmChatPlugin = (0, backend_plugin_api_1.createBackendPlugin)({
    pluginId: 'litellm-chat',
    register(reg) {
        reg.registerInit({
            deps: {
                httpRouter: backend_plugin_api_1.coreServices.httpRouter,
                config: backend_plugin_api_1.coreServices.rootConfig,
                logger: backend_plugin_api_1.coreServices.logger,
                auth: backend_plugin_api_1.coreServices.auth,
                discovery: backend_plugin_api_1.coreServices.discovery,
            },
            async init({ httpRouter, config, logger, auth, discovery }) {
                const router = await (0, router_1.createRouter)({ config, logger, auth, discovery });
                httpRouter.use(router);
            },
        });
    },
});
