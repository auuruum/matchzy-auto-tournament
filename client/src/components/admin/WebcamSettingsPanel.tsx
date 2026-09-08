import { useEffect, useState } from 'react';
import { Alert, Box, Divider, Stack, Switch, TextField, Typography } from '@mui/material';
import { api } from '../../utils/api';

export function WebcamSettingsPanel() {
  const [enabled, setEnabled] = useState(false);
  const [delay, setDelay] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ settings: { enabled: boolean; delaySeconds: number } }>('/api/webcams/settings')
      .then(({ settings }) => { setEnabled(settings.enabled); setDelay(settings.delaySeconds); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Failed to load webcam settings'));
  }, []);

  const save = async (next: { enabled?: boolean; delaySeconds?: number }) => {
    const previous = { enabled, delay };
    const optimistic = {
      enabled: next.enabled ?? enabled,
      delaySeconds: next.delaySeconds ?? delay,
    };
    setEnabled(optimistic.enabled);
    setDelay(optimistic.delaySeconds);
    setSaving(true);
    setError('');

    try {
      const { settings } = await api.put<{ settings: { enabled: boolean; delaySeconds: number } }>('/api/webcams/settings', next);
      setEnabled(settings.enabled);
      setDelay(settings.delaySeconds);
    } catch (cause) {
      setEnabled(previous.enabled);
      setDelay(previous.delay);
      setError(cause instanceof Error ? cause.message : 'Failed to save webcam settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ p: 2.5, border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'action.hover' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={2}>
        <Box>
          <Typography variant="h6" fontWeight={600}>Player webcams</Typography>
          <Typography variant="body2" color="text.secondary">
            Optional video for registered players in a live match.
          </Typography>
        </Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Typography variant="body2" fontWeight={600} color={enabled ? 'success.main' : 'text.secondary'}>
            {enabled ? 'Enabled' : 'Disabled'}
          </Typography>
          <Switch
            checked={enabled}
            disabled={saving}
            onChange={(event) => void save({ enabled: event.target.checked })}
            inputProps={{ 'aria-label': 'Enable player webcams globally' }}
          />
        </Stack>
      </Stack>
      <Divider sx={{ my: 2 }} />
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} gap={2}>
        <TextField
          label="HUD delay"
          type="number"
          size="small"
          value={delay}
          sx={{ width: { xs: '100%', sm: 180 } }}
          inputProps={{ min: 0, max: 600, step: 1 }}
          disabled={!enabled || saving}
          onChange={(event) => setDelay(Number(event.target.value))}
          onBlur={() => void save({ delaySeconds: delay })}
          helperText="Seconds · 0 = realtime"
        />
        <Typography variant="body2" color="text.secondary">
          The delay affects only the HUD feed. It does not stop a player’s camera.
        </Typography>
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}
