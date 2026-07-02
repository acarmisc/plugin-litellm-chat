import type { Thread, Citation } from '../types';
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
export declare function useChat(opts: UseChatOptions): UseChatResult;
