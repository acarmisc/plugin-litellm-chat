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
export interface ChatStreamRequest {
    model: string;
    messages: ChatMessage[];
    vector_store_id?: string;
    top_k?: number;
    user_key: string;
}
export interface ChatCompletionsRequest extends ChatStreamRequest {
    stream?: false;
}
export interface SearchResult {
    filename: string;
    score: number;
    text: string;
}
export interface ChatStreamChunk {
    delta?: string;
    error?: string;
    search_results?: SearchResult[];
}
export interface ChatResult {
    content: string;
    citations: Array<{
        filename: string;
        score: number;
        snippet: string;
    }>;
}
export interface LiteLLMChatConfig {
    baseUrl: string;
    defaultModel?: string;
    defaultVectorStoreId?: string;
    maxRequestBudget?: number;
}
