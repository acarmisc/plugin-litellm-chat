import React from 'react';
export interface ChatComposerProps {
    model: string;
    setModel: (m: string) => void;
    vectorStoreId: string | null;
    setVectorStoreId: (id: string | null) => void;
    keyVal: {
        alias: string;
        token: string;
    };
    setKeyVal: (v: {
        alias: string;
        token: string;
    }) => void;
    defaultModel?: string | null;
    defaultVectorStoreId?: string | null;
    onSend: (text: string) => void;
    onStop: () => void;
    isStreaming: boolean;
    disabled: boolean;
}
export declare const ChatComposer: React.FC<ChatComposerProps>;
