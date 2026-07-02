import React from 'react';
import { Alert, AlertTitle } from '@mui/material';

export interface ErrorBannerProps {
  error?: string;
  onDismiss?: () => void;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({ error, onDismiss }) => {
  if (!error) return null;
  return (
    <Alert severity="error" onClose={onDismiss} sx={{ mb: 1 }}>
      <AlertTitle>Chat error</AlertTitle>
      {error}
    </Alert>
  );
};