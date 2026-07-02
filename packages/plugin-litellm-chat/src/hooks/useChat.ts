import { useState, useCallback, useRef, useEffect } from 'react';
import { useApi } from '@backstage/core-plugin-api';
import { liteLlmChatApiRef, LiteLlmChatApi } from '../api';
import type {
  Thread,
  ChatMessage,
  ChatStreamChunk,
  Citation,
} from '../types';

const STORAGE_PREFIX = 'litellm-chat:threads';

function loadThreads(userId: string): Thread[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}:${userId}`);
    return raw ? (JSON.parse(raw) as Thread[]) : [];
  } catch {
    return [];
  }
}

function saveThreads(userId: string, threads: Thread[]) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${userId}`, JSON.stringify(threads));
  } catch {
    // quota or disabled — ignore
  }
}

function genId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface UseChatOptions {
  userId: string;
  model: string;
  vectorStoreId: string | null;
  keyAlias: string;
  keyToken: string;
  topK?: number;
}

export interface UseChatResult {
  threads: Thread[];
  activeThread: Thread | null;
  newThread: () => void;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  sendMessage: (text: string) => void;
  stopGeneration: () => void;
  isStreaming: boolean;
  error: string | null;
  citations: Citation[];
}

export function useChat(opts: UseChatOptions): UseChatResult {
  const { userId, model, vectorStoreId, keyAlias, keyToken, topK } = opts;
  const api = useApi(liteLlmChatApiRef) as InstanceType<typeof LiteLlmChatApi>;

  const [threads, setThreads] = useState<Thread[]>(() => loadThreads(userId));
  const [activeId, setActiveId] = useState<string | null>(
    () => threads[0]?.id ?? null,
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [citations, setCitations] = useState<Citation[]>([]);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveThreads(userId, threads);
  }, [userId, threads]);

  const activeThread = threads.find(t => t.id === activeId) ?? null;

  const newThread = useCallback(() => {
    const thread: Thread = {
      id: genId(),
      title: 'New chat',
      messages: [],
      model,
      vectorStoreId,
      keyAlias,
      keyToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setThreads(prev => [thread, ...prev]);
    setActiveId(thread.id);
    setError(null);
    setCitations([]);
  }, [model, vectorStoreId, keyAlias, keyToken]);

  const selectThread = useCallback((id: string) => {
    setActiveId(id);
    setError(null);
    setCitations([]);
  }, []);

  const deleteThread = useCallback(
    (id: string) => {
      const thread = threads.find(t => t.id === id);
      const remaining = threads.filter(t => t.id !== id);
      setThreads(remaining);
      if (activeId === id) {
        setActiveId(remaining[0]?.id ?? null);
      }
      // Best-effort key cleanup — fire and forget.
      if (thread?.keyToken) {
        api.deleteChatKey(thread.keyToken).catch(() => {});
      }
    },
    [activeId, threads, api],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || !activeThread || !keyToken) return;

      setError(null);
      setCitations([]);

      const userMsg: ChatMessage = { role: 'user', content: text };
      const assistantMsg: ChatMessage = { role: 'assistant', content: '' };

      const threadId = activeThread.id;
      const updatedMessages = [...activeThread.messages, userMsg, assistantMsg];

      setThreads(prev =>
        prev.map(t =>
          t.id === threadId
            ? {
                ...t,
                messages: updatedMessages,
                title: t.messages.length === 0 ? text.slice(0, 40) : t.title,
                model,
                vectorStoreId,
                keyAlias,
                keyToken,
                updatedAt: Date.now(),
              }
            : t,
        ),
      );

      setIsStreaming(true);

      const reqMessages = updatedMessages.slice(0, -1);

      const controller = api.chatStream(
        {
          model,
          messages: reqMessages,
          vector_store_id: vectorStoreId ?? undefined,
          top_k: topK,
          user_key: keyToken,
        },
        (chunk: ChatStreamChunk) => {
          if (chunk.error) {
            setError(chunk.error);
            return;
          }
          if (chunk.search_results) {
            setCitations(
              chunk.search_results.map(r => ({
                filename: r.filename,
                score: r.score,
                snippet: r.text,
              })),
            );
          }
          if (chunk.delta) {
            setThreads(prev =>
              prev.map(t => {
                if (t.id !== threadId) return t;
                const msgs = [...t.messages];
                const last = msgs[msgs.length - 1];
                msgs[msgs.length - 1] = {
                  ...last,
                  content: last.content + chunk.delta,
                };
                return { ...t, messages: msgs, updatedAt: Date.now() };
              }),
            );
          }
        },
        () => {
          setIsStreaming(false);
          abortRef.current = null;
        },
        (err: Error) => {
          setError(err.message);
          setIsStreaming(false);
          abortRef.current = null;
        },
      );

      abortRef.current = controller;
    },
    [activeThread, api, keyToken, model, vectorStoreId, keyAlias, topK],
  );

  return {
    threads,
    activeThread,
    newThread,
    selectThread,
    deleteThread,
    sendMessage,
    stopGeneration,
    isStreaming,
    error,
    citations,
  };
}