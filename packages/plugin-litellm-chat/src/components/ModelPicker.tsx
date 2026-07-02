import React, { useEffect, useState } from 'react';
import { Select, MenuItem, FormControl, InputLabel } from '@mui/material';
import { useApi } from '@backstage/core-plugin-api';
import { liteLlmApiRef } from '@acarmisc/backstage-plugin-litellm';
import type { ModelInfo } from '@acarmisc/backstage-plugin-litellm';

export interface ModelPickerProps {
  value: string;
  onChange: (model: string) => void;
  defaultModel?: string | null;
}

export const ModelPicker: React.FC<ModelPickerProps> = ({
  value,
  onChange,
  defaultModel,
}) => {
  const liteLlmApi = useApi(liteLlmApiRef);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    liteLlmApi
      .listModels()
      .then(m => {
        if (!alive) return;
        setModels(m);
        if (!value && m.length) {
          const def =
            (defaultModel && m.find(x => x.model_name === defaultModel)?.model_name) ||
            m[0].model_name;
          onChange(def);
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <FormControl size="small" sx={{ minWidth: 200 }}>
      <InputLabel>Model</InputLabel>
      <Select
        value={value}
        label="Model"
        onChange={e => onChange(e.target.value as string)}
        disabled={loading}
      >
        {models.map(m => (
          <MenuItem key={m.model_name} value={m.model_name}>
            {m.model_name}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};