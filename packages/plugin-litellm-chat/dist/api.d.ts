import { FetchApi } from '@backstage/core-plugin-api';
import type { VectorStore, ChatRequest, ChatStreamChunk, ChatResult, ChatConfig } from './types';
export interface LiteLlmChatApiInterface {
    listVectorStores(): Promise<VectorStore[]>;
    getChatConfig(): Promise<ChatConfig>;
    chatStream(req: ChatRequest, onToken: (chunk: ChatStreamChunk) => void, onDone: () => void, onError: (err: Error) => void): AbortController;
    chatCompletions(req: ChatRequest): Promise<ChatResult>;
    mintChatKey(opts?: {
        models?: string[];
        max_budget?: number;
    }): Promise<ChatKey>;
    deleteChatKey(key: string): Promise<{
        success: boolean;
    }>;
}
export interface ChatKey {
    key: string;
    key_alias: string;
    expires_at?: string;
    max_budget?: number;
}
export declare const liteLlmChatApiRef: import("@backstage/core-plugin-api").ApiRef<LiteLlmChatApiInterface>;
export declare class LiteLlmChatApi implements LiteLlmChatApiInterface {
    private fetchApi;
    constructor(fetchApi: FetchApi);
    listVectorStores(): Promise<VectorStore[]>;
    getChatConfig(): Promise<ChatConfig>;
    chatStream(req: ChatRequest, onToken: (chunk: ChatStreamChunk) => void, onDone: () => void, onError: (err: Error) => void): AbortController;
    chatCompletions(req: ChatRequest): Promise<ChatResult>;
    mintChatKey(opts?: {
        models?: string[];
        max_budget?: number;
    }): Promise<ChatKey>;
    deleteChatKey(key: string): Promise<{
        success: boolean;
    }>;
}
