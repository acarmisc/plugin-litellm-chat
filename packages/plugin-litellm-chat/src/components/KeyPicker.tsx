import React, { useState } from 'react';
import { Button, Box, Typography, CircularProgress, Tooltip, IconButton } from '@mui/material';
import KeyIcon from '@mui/icons-material/VpnKey';
import DeleteIcon from '@mui/icons-material/Delete';
import { useApi } from '@backstage/core-plugin-api';
import { liteLlmChatApiRef } from '../api';

export interface KeyPickerProps {
  value: { alias: string; token: string };
  onChange: (val: { alias: string; token: string }) => void;
  onDelete?: () => void;
}

export const KeyPicker: React.FC<KeyPickerProps> = ({ value, onChange, onDelete }) => {
  const chatApi = useApi(liteLlmChatApiRef);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    try {
      const keyInfo = await chatApi.mintChatKey();
      onChange({ alias: keyInfo.key_alias, token: keyInfo.key });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!value.token) return;
    try {
      await chatApi.deleteChatKey(value.token);
    } catch {
      // best-effort cleanup
    }
    onDelete?.();
    onChange({ alias: '', token: '' });
  };

  if (value.token) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 200 }}>
        <KeyIcon fontSize="small" color="success" />
        <Typography variant="body2" sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value.alias || 'chat key'}
        </Typography>
        <Tooltip title="Delete chat key">
          <IconButton edge="end" size="small" onClick={handleDelete}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  return (
    <Box sx={{ minWidth: 200 }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={loading ? <CircularProgress size={16} /> : <KeyIcon />}
        onClick={handleGenerate}
        disabled={loading}
      >
        {loading ? 'Minting…' : 'Generate chat key'}
      </Button>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
};