import { createApiRef, FetchApi } from '@backstage/core-plugin-api';
import type {
  VectorStore,
  ChatRequest,
  ChatStreamChunk,
  SearchResult,
  ChatResult,
  ChatConfig,
} from './types';

export interface LiteLlmChatApiInterface {
  listVectorStores(): Promise<VectorStore[]>;
  getChatConfig(): Promise<ChatConfig>;
  chatStream(
    req: ChatRequest,
    onToken: (chunk: ChatStreamChunk) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AbortController;
  chatCompletions(req: ChatRequest): Promise<ChatResult>;
  mintChatKey(opts?: { models?: string[]; max_budget?: number }): Promise<ChatKey>;
  deleteChatKey(key: string): Promise<{ success: boolean }>;
}

export interface ChatKey {
  key: string;
  key_alias: string;
  expires_at?: string;
  max_budget?: number;
}

export const liteLlmChatApiRef = createApiRef<LiteLlmChatApiInterface>({
  id: 'plugin.litellm-chat.api',
});

const BASE_PATH = '/api/litellm-chat';

/**
 * Normalize a raw SSE `data:` JSON payload (OpenAI-shaped) into the
 * flat ChatStreamChunk shape the UI consumes. LiteLLM emits:
 *   { choices: [{ delta: { content, reasoning_content } }], search_results?: [...] }
 * Also handles the backend's own error events: { error: "..." }.
 */
function normalizeChunk(raw: any): ChatStreamChunk {
  if (raw && typeof raw === 'object' && ('error' in raw || 'delta' in raw)) {
    return raw as ChatStreamChunk;
  }
  const chunk: ChatStreamChunk = {};
  const delta = raw?.choices?.[0]?.delta;
  const content = delta?.content ?? delta?.reasoning_content;
  if (typeof content === 'string') chunk.delta = content;
  if (Array.isArray(raw?.search_results)) {
    chunk.search_results = raw.search_results.map((r: any): SearchResult => ({
      filename: r.filename ?? r.file_name ?? r.source ?? r.name ?? '',
      score: typeof r.score === 'number' ? r.score : 0,
      text: r.text ?? r.snippet ?? r.content ?? '',
    }));
  }
  if (raw?.error) chunk.error = String(raw.error);
  return chunk;
}

export class LiteLlmChatApi implements LiteLlmChatApiInterface {
  private fetchApi: FetchApi;

  constructor(fetchApi: FetchApi) {
    this.fetchApi = fetchApi;
  }

  async listVectorStores(): Promise<VectorStore[]> {
    const res = await this.fetchApi.fetch(`${BASE_PATH}/vector_stores`);
    if (!res.ok) throw new Error(`vector_stores ${res.status}`);
    return res.json();
  }

  async getChatConfig(): Promise<ChatConfig> {
    const res = await this.fetchApi.fetch(`${BASE_PATH}/config`);
    if (!res.ok) {
      return { defaultModel: null, defaultVectorStoreId: null, maxRequestBudget: null };
    }
    return res.json();
  }

  chatStream(
    req: ChatRequest,
    onToken: (chunk: ChatStreamChunk) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AbortController {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          onError(new Error(`${res.status}: ${text || res.statusText}`));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              onDone();
              return;
            }
            try {
              const raw = JSON.parse(payload);
              const chunk = normalizeChunk(raw);
              // Skip empty chunks (e.g. role-only deltas, usage-only final chunks).
              if (chunk.delta || chunk.error || chunk.search_results) {
                onToken(chunk);
              }
            } catch {
              // partial JSON — skip, next chunk reassembles
            }
          }
        }
        onDone();
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        onError(err);
      }
    })();

    return controller;
  }

  async chatCompletions(req: ChatRequest): Promise<ChatResult> {
    const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, stream: false }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text}`);
    }
    const data = await res.json();
    const content =
      data.choices?.[0]?.message?.content ?? data.content ?? '';
    const rawResults: any[] = data.search_results ?? data.citations ?? [];
    const citations = rawResults.map(r => ({
      filename: r.filename ?? r.file_name ?? r.source ?? r.name ?? '',
      score: typeof r.score === 'number' ? r.score : 0,
      snippet: r.text ?? r.snippet ?? r.content ?? '',
    }));
    return { content, citations };
  }

  async mintChatKey(opts?: { models?: string[]; max_budget?: number }): Promise<ChatKey> {
    const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mint key ${res.status}: ${text}`);
    }
    return res.json();
  }

  async deleteChatKey(key: string): Promise<{ success: boolean }> {
    const res = await this.fetchApi.fetch(`${BASE_PATH}/chat/key`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`delete key ${res.status}: ${text}`);
    }
    return res.json();
  }
}