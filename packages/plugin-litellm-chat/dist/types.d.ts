export interface VectorStore {
    id: string;
    name: string;
    file_count?: number;
    status?: string;
}
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}
export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    vector_store_id?: string;
    top_k?: number;
    user_key: string;
}
export interface SearchResult {
    filename: string;
    score: number;
    text: string;
}
/**
 * Normalized SSE chunk shape emitted by the backend stream and consumed
 * by the frontend. LiteLLM emits OpenAI-shaped chunks
 * `{ choices: [{ delta: { content } }], search_results? }` — the api.ts
 * SSE reader normalizes them into this shape.
 */
export interface ChatStreamChunk {
    delta?: string;
    error?: string;
    search_results?: SearchResult[];
}
export interface Citation {
    filename: string;
    score: number;
    snippet: string;
}
export interface ChatResult {
    content: string;
    citations: Citation[];
}
export interface ChatConfig {
    defaultModel: string | null;
    defaultVectorStoreId: string | null;
    maxRequestBudget: number | null;
}
export interface Thread {
    id: string;
    title: string;
    messages: ChatMessage[];
    model: string;
    vectorStoreId: string | null;
    keyAlias: string;
    keyToken: string;
    createdAt: number;
    updatedAt: number;
}
