import React from 'react';
import { Box, Typography } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, Citation } from '../types';
import { CitationsPanel } from './CitationsPanel';

export interface MessageListProps {
  messages: ChatMessage[];
  citations: Citation[];
  isStreaming: boolean;
}

const blink = {
  '@keyframes blink': {
    '0%, 50%': { opacity: 1 },
    '51%, 100%': { opacity: 0 },
  },
};

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  citations,
  isStreaming,
}) => {
  return (
    <Box
      sx={{
        flex: 1,
        overflowY: 'auto',
        px: 2,
        py: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      {messages.length === 0 && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography color="text.secondary">
            Start a conversation…
          </Typography>
        </Box>
      )}
      {messages.map((msg, i) => {
        const isUser = msg.role === 'user';
        const isLast = i === messages.length - 1;
        const showCitations = !isUser && isLast && !isStreaming && citations.length > 0;

        return (
          <Box
            key={i}
            sx={{
              alignSelf: isUser ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
            }}
          >
            <Box
              sx={{
                bgcolor: isUser ? 'primary.main' : 'background.paper',
                color: isUser ? 'primary.contrastText' : 'text.primary',
                border: isUser ? 'none' : 1,
                borderColor: 'divider',
                borderRadius: 2,
                px: 1.5,
                py: 1,
                wordBreak: 'break-word',
                '& p': { margin: 0 },
                '& pre': { overflowX: 'auto', maxWidth: '100%' },
                '& code': {
                  fontFamily: 'monospace',
                  fontSize: '0.85em',
                  bgcolor: isUser ? 'transparent' : 'action.hover',
                  px: 0.5,
                  borderRadius: 0.5,
                },
                '& pre code': { bgcolor: 'transparent', px: 0 },
              }}
            >
              {isUser ? (
                <Box sx={{ whiteSpace: 'pre-wrap' }}>{msg.content}</Box>
              ) : msg.content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content}
                </ReactMarkdown>
              ) : isStreaming && isLast ? (
                <Box
                  component="span"
                  sx={{
                    display: 'inline-block',
                    width: 8,
                    height: 16,
                    bgcolor: 'text.primary',
                    animation: 'blink 1s step-end infinite',
                    verticalAlign: 'text-bottom',
                    ...blink,
                  }}
                />
              ) : null}
            </Box>
            {showCitations && <CitationsPanel citations={citations} />}
          </Box>
        );
      })}
    </Box>
  );
};