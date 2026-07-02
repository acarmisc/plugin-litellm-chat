import express, { Router, Request, Response } from 'express';
import { Config } from '@backstage/config';
import { AuthService, DiscoveryService } from '@backstage/backend-plugin-api';
import {
  resolveUserId,
  toLiteLLMUserId,
  LiteLLMClient,
} from '@acarmisc/backstage-plugin-litellm-backend';
import { proxySSE } from './stream';
import type {
  VectorStore,
  ChatStreamRequest,
  ChatCompletionsRequest,
  LiteLLMChatConfig,
} from './types';

export interface RouterOptions {
  config: Config;
  logger: any;
  auth: AuthService;
  discovery: DiscoveryService;
}

function readChatConfig(config: Config): LiteLLMChatConfig {
  return {
    baseUrl: config.getString('litellm.baseUrl'),
    defaultModel: config.getOptionalString('litellm.chat.defaultModel'),
    defaultVectorStoreId: config.getOptionalString(
      'litellm.chat.defaultVectorStoreId',
    ),
    maxRequestBudget: config.getOptionalNumber('litellm.chat.maxRequestBudget'),
  };
}

export async function createRouter(options: RouterOptions): Promise<Router> {
  const { config, logger, auth } = options;
  const chatConfig = readChatConfig(config);
  const userIdDomain = config.getOptionalString('litellm.userIdDomain');
  const masterKey = config.getString('litellm.masterKey');

  const router = Router();

  // JSON parser for request bodies. The request bodies are small JSON
  // (messages + model + key). The SSE *response* stream is not affected
  // by the request body parser. Backstage's HttpRouterService does not
  // add compression by default, so the response stream is not buffered.
  router.use(express.json());

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.get('/config', (_req: Request, res: Response) => {
    res.json({
      defaultModel: chatConfig.defaultModel ?? null,
      defaultVectorStoreId: chatConfig.defaultVectorStoreId ?? null,
      maxRequestBudget: chatConfig.maxRequestBudget ?? null,
    });
  });

  router.get('/vector_stores', async (_req: Request, res: Response) => {
    try {
      // LiteLLM-native endpoint (not OpenAI passthrough /v1/vector_stores).
      const upstream = await fetch(
        `${chatConfig.baseUrl}/v1/vector_store/list`,
        {
          headers: { Authorization: `Bearer ${masterKey}` },
        },
      );
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        res.status(upstream.status).json({ error: text || upstream.statusText });
        return;
      }
      const data = await upstream.json();
      // LiteLLM returns { data: [{ vector_store_id, vector_store_name, ... }] }
      const raw: any[] = Array.isArray(data) ? data : (data.data ?? []);
      const stores: VectorStore[] = raw.map(s => ({
        id: s.vector_store_id ?? s.id,
        name: s.vector_store_name ?? s.name,
        status: s.custom_llm_provider ?? s.status,
      }));
      res.json(stores);
    } catch (err: any) {
      logger.error('Failed to list vector stores', err);
      res.status(502).json({ error: err.message });
    }
  });

  // Mint a dedicated chat key for the authenticated user. The real sk- key
  // is returned ONCE and stored client-side in the thread. LiteLLM only
  // stores hashed keys — listKeys cannot recover it.
  router.post('/chat/key', async (req: Request, res: Response) => {
    try {
      const tokenEntityRef = await resolveUserId(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const userId = toLiteLLMUserId(tokenEntityRef, userIdDomain);
      const client = new LiteLLMClient({ baseUrl: chatConfig.baseUrl, masterKey });

      const body = (req.body ?? {}) as { models?: string[]; max_budget?: number };
      const alias = `chat-${userId}-${Date.now()}`;
      const result = await client.generateKey({
        alias,
        models: body.models ?? [],
        max_budget: body.max_budget,
        user_id: userId,
        duration: '24h',
        metadata: {
          created_via: 'backstage-chat',
          created_by_backstage_user: tokenEntityRef,
        },
      });
      res.json({
        key: result.key,
        key_alias: alias,
        expires_at: result.expires_at,
        max_budget: result.max_budget,
      });
    } catch (err: any) {
      logger.error('Failed to mint chat key', err);
      res.status(502).json({ error: err.message });
    }
  });

  // Delete a chat key by its real sk- value (client sends what it stored).
  router.delete('/chat/key', async (req: Request, res: Response) => {
    try {
      const tokenEntityRef = await resolveUserId(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      const { key } = req.body as { key: string };
      if (!key) {
        res.status(400).json({ error: 'key required' });
        return;
      }
      const client = new LiteLLMClient({ baseUrl: chatConfig.baseUrl, masterKey });
      await client.deleteKeys({ keys: [key] });
      res.json({ success: true });
    } catch (err: any) {
      logger.error('Failed to delete chat key', err);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = req.body as ChatCompletionsRequest;
      if (!body?.model || !body?.messages || !body?.user_key) {
        res.status(400).json({
          error: 'model, messages, user_key required',
        });
        return;
      }

      const tokenEntityRef = await resolveUserId(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      // Resolve to confirm identity — LiteLLM auth uses the user_key, but
      // resolving the user_id validates the Backstage token.
      toLiteLLMUserId(tokenEntityRef, userIdDomain);

      const payload: Record<string, unknown> = {
        model: body.model,
        messages: body.messages,
        stream: false,
      };
      if (body.vector_store_id) {
        payload.vector_store_ids = [body.vector_store_id];
        payload.top_k = body.top_k ?? 5;
      }

      const upstream = await fetch(
        `${chatConfig.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${body.user_key}`,
          },
          body: JSON.stringify(payload),
        },
      );
      const data = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json(data);
        return;
      }
      res.json(data);
    } catch (err: any) {
      logger.error('chat/completions failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/chat/stream', async (req: Request, res: Response) => {
    try {
      const body = req.body as ChatStreamRequest;
      if (!body?.model || !body?.messages || !body?.user_key) {
        res.status(400).json({
          error: 'model, messages, user_key required',
        });
        return;
      }

      const tokenEntityRef = await resolveUserId(req, auth);
      if (!tokenEntityRef) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      toLiteLLMUserId(tokenEntityRef, userIdDomain);

      const base = chatConfig.baseUrl;
      const hasVs = !!body.vector_store_id;

      // PRIMARY: /v1/chat/completions + vector_store_ids — works on
      // LiteLLM v1.90.0 with DB-backed pgvector stores.
      // FALLBACK: /v1/rag/query — works only if PG_VECTOR_API_BASE env is
      // set on the LiteLLM pod; kept as fallback for future LiteLLM
      // versions or ops-fixed deployments.
      if (hasVs) {
        const primaryBody = {
          model: body.model,
          messages: body.messages,
          vector_store_ids: [body.vector_store_id],
          stream: true,
        };
        const fallbackBody = {
          model: body.model,
          messages: body.messages,
          retrieval_config: {
            vector_store_id: body.vector_store_id,
            custom_llm_provider: 'pg_vector',
            top_k: body.top_k ?? 5,
          },
          stream: true,
        };
        await proxySSE({
          upstreamUrl: `${base}/v1/chat/completions`,
          upstreamBody: primaryBody,
          userKey: body.user_key,
          res,
          logger,
          fallbackUrl: `${base}/v1/rag/query`,
          fallbackBody,
        });
      } else {
        const chatBody = {
          model: body.model,
          messages: body.messages,
          stream: true,
        };
        await proxySSE({
          upstreamUrl: `${base}/v1/chat/completions`,
          upstreamBody: chatBody,
          userKey: body.user_key,
          res,
          logger,
        });
      }
    } catch (err: any) {
      logger.error('chat/stream failed', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  });

  return router;
}