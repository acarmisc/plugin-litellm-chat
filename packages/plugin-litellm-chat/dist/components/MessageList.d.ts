import React from 'react';
import type { ChatMessage, Citation } from '../types';
export interface MessageListProps {
    messages: ChatMessage[];
    citations: Citation[];
    isStreaming: boolean;
}
export declare const MessageList: React.FC<MessageListProps>;
