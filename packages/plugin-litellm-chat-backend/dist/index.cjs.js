"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  createRouter: () => createRouter,
  default: () => litellmChatPlugin,
  litellmChatPlugin: () => litellmChatPlugin,
  proxySSE: () => proxySSE
});
module.exports = __toCommonJS(index_exports);

// src/plugin.ts
var import_backend_plugin_api = require("@backstage/backend-plugin-api");

// src/router.ts
var import_express = __toESM(require("express"));
var import_backstage_plugin_litellm_backend = require("@acarmisc/backstage-plugin-litellm-backend");

// src/stream.ts
var import_stream = require("stream");
async function proxySSE(opts) {
  const { upstreamUrl, upstreamBody, userKey, res, logger } = opts;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive"
  };
  const fetchUpstream = async (url, body) => {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userKey}`,
        Accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      const err = new Error(`upstream ${upstream.status}: ${text || upstream.statusText}`);
      err.status = upstream.status;
      throw err;
    }
    return import_stream.Readable.fromWeb(upstream.body);
  };
  try {
    const stream = await fetchUpstream(upstreamUrl, upstreamBody);
    res.writeHead(200, headers);
    res.flushHeaders();
    stream.on("data", (chunk) => {
      res.write(chunk);
    });
    await new Promise((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    res.end();
  } catch (err) {
    if (err.name === "AbortError") {
      logger.debug("SSE client disconnected");
      return;
    }
    logger.error("SSE proxy error", err);
    if (!res.headersSent) {
      res.writeHead(200, headers);
    }
    res.write(`data: ${JSON.stringify({ error: err.message || "stream error" })}

`);
    res.end();
  }
}

// src/router.ts
function readChatConfig(config) {
  return {
    baseUrl: config.getString("litellm.baseUrl"),
    defaultModel: config.getOptionalString("litellm.chat.defaultModel"),
    defaultVectorStoreId: config.getOptionalString(
      "litellm.chat.defaultVectorStoreId"
    ),
    maxRequestBudget: config.getOptionalNumber("litellm.chat.maxRequestBudget")
  };
}
async function createRouter(options) {
  const { config, logger, auth } = options;
  const chatConfig = readChatConfig(config);
  const userIdDomain = config.getOptionalString("litellm.userIdDomain");
  const masterKey = config.getString("litellm.masterKey");
  const router = (0, import_express.Router)();
  router.use(import_express.default.json());
  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  router.get("/config", (_req, res) => {
    res.json({
      defaultModel: chatConfig.defaultModel ?? null,
      defaultVectorStoreId: chatConfig.defaultVectorStoreId ?? null,
      maxRequestBudget: chatConfig.maxRequestBudget ?? null
    });
  });
  router.get("/vector_stores", async (_req, res) => {
    try {
      const upstream = await fetch(
        `${chatConfig.baseUrl}/v1/vector_store/list`,
        {
          headers: { Authorization: `Bearer ${masterKey}` }
        }
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        res.status(upstream.status).json({ error: text || upstream.statusText });
        return;
      }
      const data = await upstream.json();
      const raw = Array.isArray(data) ? data : data.data ?? [];
      const stores = raw.map((s) => ({
        id: s.vector_store_id ?? s.id,
        name: s.vector_store_name ?? s.name,
        status: s.custom_llm_provider ?? s.status
      }));
      res.json(stores);
    } catch (err) {
      logger.error("Failed to list vector stores", err);
      res.status(502).json({ error: err.message });
    }
  });
  router.post("/chat/key", async (req, res) => {
    try {
      const tokenEntityRef = await (0, import_backstage_plugin_litellm_backend.resolveUserId)(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const userId = (0, import_backstage_plugin_litellm_backend.toLiteLLMUserId)(tokenEntityRef, userIdDomain);
      const client = new import_backstage_plugin_litellm_backend.LiteLLMClient({ baseUrl: chatConfig.baseUrl, masterKey });
      const body = req.body ?? {};
      const alias = `chat-${userId}-${Date.now()}`;
      const result = await client.generateKey({
        alias,
        models: body.models ?? [],
        max_budget: body.max_budget,
        user_id: userId,
        duration: "24h",
        metadata: {
          created_via: "backstage-chat",
          created_by_backstage_user: tokenEntityRef
        }
      });
      res.json({
        key: result.key,
        key_alias: alias,
        expires_at: result.expires_at,
        max_budget: result.max_budget
      });
    } catch (err) {
      logger.error("Failed to mint chat key", err);
      res.status(502).json({ error: err.message });
    }
  });
  router.delete("/chat/key", async (req, res) => {
    try {
      const tokenEntityRef = await (0, import_backstage_plugin_litellm_backend.resolveUserId)(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const { key } = req.body;
      if (!key) {
        res.status(400).json({ error: "key required" });
        return;
      }
      const client = new import_backstage_plugin_litellm_backend.LiteLLMClient({ baseUrl: chatConfig.baseUrl, masterKey });
      await client.deleteKeys({ keys: [key] });
      res.json({ success: true });
    } catch (err) {
      logger.error("Failed to delete chat key", err);
      res.status(502).json({ error: err.message });
    }
  });
  router.post("/chat/completions", async (req, res) => {
    try {
      const body = req.body;
      if (!body?.model || !body?.messages || !body?.user_key) {
        res.status(400).json({
          error: "model, messages, user_key required"
        });
        return;
      }
      const tokenEntityRef = await (0, import_backstage_plugin_litellm_backend.resolveUserId)(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      (0, import_backstage_plugin_litellm_backend.toLiteLLMUserId)(tokenEntityRef, userIdDomain);
      const payload = {
        model: body.model,
        messages: body.messages,
        stream: false
      };
      if (body.vector_store_id) {
        payload.vector_store_ids = [body.vector_store_id];
        payload.top_k = body.top_k ?? 5;
      }
      const upstream = await fetch(
        `${chatConfig.baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${body.user_key}`
          },
          body: JSON.stringify(payload)
        }
      );
      const data = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json(data);
        return;
      }
      res.json(data);
    } catch (err) {
      logger.error("chat/completions failed", err);
      res.status(500).json({ error: err.message });
    }
  });
  router.post("/chat/stream", async (req, res) => {
    try {
      const body = req.body;
      if (!body?.model || !body?.messages || !body?.user_key) {
        res.status(400).json({
          error: "model, messages, user_key required"
        });
        return;
      }
      const tokenEntityRef = await (0, import_backstage_plugin_litellm_backend.resolveUserId)(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      (0, import_backstage_plugin_litellm_backend.toLiteLLMUserId)(tokenEntityRef, userIdDomain);
      const base = chatConfig.baseUrl;
      const chatBody = {
        model: body.model,
        messages: body.messages,
        stream: true
      };
      if (body.vector_store_id) {
        chatBody.vector_store_ids = [body.vector_store_id];
      }
      await proxySSE({
        upstreamUrl: `${base}/v1/chat/completions`,
        upstreamBody: chatBody,
        userKey: body.user_key,
        res,
        logger
      });
    } catch (err) {
      logger.error("chat/stream failed", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });
  return router;
}

// src/plugin.ts
var litellmChatPlugin = (0, import_backend_plugin_api.createBackendPlugin)({
  pluginId: "litellm-chat",
  register(reg) {
    reg.registerInit({
      deps: {
        httpRouter: import_backend_plugin_api.coreServices.httpRouter,
        config: import_backend_plugin_api.coreServices.rootConfig,
        logger: import_backend_plugin_api.coreServices.logger,
        auth: import_backend_plugin_api.coreServices.auth,
        discovery: import_backend_plugin_api.coreServices.discovery
      },
      async init({ httpRouter, config, logger, auth, discovery }) {
        const router = await createRouter({ config, logger, auth, discovery });
        httpRouter.use(router);
      }
    });
  }
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createRouter,
  litellmChatPlugin,
  proxySSE
});
//# sourceMappingURL=index.cjs.js.map
