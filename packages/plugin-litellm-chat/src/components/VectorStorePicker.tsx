import React, { useEffect, useState } from 'react';
import { Select, MenuItem, FormControl, InputLabel } from '@mui/material';
import { useApi } from '@backstage/core-plugin-api';
import { liteLlmChatApiRef } from '../api';
import type { VectorStore } from '../types';

export interface VectorStorePickerProps {
  value: string | null;
  onChange: (id: string | null) => void;
  defaultVectorStoreId?: string | null;
}

export const VectorStorePicker: React.FC<VectorStorePickerProps> = ({
  value,
  onChange,
  defaultVectorStoreId,
}) => {
  const chatApi = useApi(liteLlmChatApiRef);
  const [stores, setStores] = useState<VectorStore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    chatApi
      .listVectorStores()
      .then(s => {
        if (!alive) return;
        setStores(s);
        if (value === null && s.length) {
          const def =
            (defaultVectorStoreId &&
              s.find(x => x.id === defaultVectorStoreId)?.id) ||
            null;
          onChange(def);
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel>Knowledge base</InputLabel>
      <Select
        value={value ?? ''}
        label="Knowledge base"
        onChange={e => onChange(e.target.value === '' ? null : (e.target.value as string))}
        disabled={loading}
      >
        <MenuItem value="">
          <em>None (no grounding)</em>
        </MenuItem>
        {stores.map(s => (
          <MenuItem key={s.id} value={s.id}>
            {s.name} {s.file_count != null ? `(${s.file_count})` : ''}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};