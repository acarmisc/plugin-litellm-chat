import React, { useState } from 'react';
import {
  Collapse,
  IconButton,
  Box,
  Typography,
  Chip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Citation } from '../types';

export interface CitationsPanelProps {
  citations: Citation[];
}

export const CitationsPanel: React.FC<CitationsPanelProps> = ({ citations }) => {
  const [expanded, setExpanded] = useState(false);

  if (!citations.length) return null;

  return (
    <Box sx={{ mt: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          px: 1,
          py: 0.5,
        }}
        onClick={() => setExpanded(v => !v)}
      >
        <IconButton size="small" sx={{ p: 0.5, transform: expanded ? 'rotate(180deg)' : 'none' }}>
          <ExpandMoreIcon fontSize="small" />
        </IconButton>
        <Typography variant="caption" color="text.secondary">
          {citations.length} source{citations.length > 1 ? 's' : ''}
        </Typography>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ px: 1, pb: 1 }}>
          {citations.map((c, i) => (
            <Box key={i} sx={{ mb: 1 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Typography variant="body2" fontWeight={500}>
                  {c.filename}
                </Typography>
                <Chip
                  size="small"
                  label={c.score.toFixed(3)}
                  color="primary"
                  variant="outlined"
                />
              </Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  mt: 0.5,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 120,
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                }}
              >
                {c.snippet}
              </Typography>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
};