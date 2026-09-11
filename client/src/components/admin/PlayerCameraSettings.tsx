/* global RTCIceServer */
import React from 'react';
import { AdminPlayerCameraPreviews } from './AdminPlayerCameraPreviews';

import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';

type Status = {
  enabled: boolean;
  transport: 'p2p' | 'relay';
  prewarmEnabled: boolean;
  publishers: string[];
  blockedSteamIds: string[];
  huds: number;
  adminViewers?: number;
  iceServers: RTCIceServer[];
};

async function readError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return body.error || `HTTP ${response.status}`;
}

export function PlayerCameraSettings() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [steamId, setSteamId] = React.useState('');
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    const response = await fetch('/api/player-cameras/admin', { credentials: 'include' });
    if (!response.ok) throw new Error(await readError(response));
    setStatus(await response.json());
  }, []);

  React.useEffect(() => {
    void refresh().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const update = async (body: Partial<Pick<Status, 'enabled' | 'transport' | 'prewarmEnabled'>>) => {
    setError('');
    const response = await fetch('/api/player-cameras/admin', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await readError(response));
    setStatus(await response.json());
  };

  const block = async (id: string, blocked: boolean) => {
    setError('');
    const response = await fetch(`/api/player-cameras/admin/players/${encodeURIComponent(id)}/block`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocked }),
    });
    if (!response.ok) throw new Error(await readError(response));
    setStatus(await response.json());
    setSteamId('');
  };

  if (!status) return error ? <Alert severity="error">{error}</Alert> : null;

  return (
    <Stack spacing={2} data-testid="player-camera-admin-settings">
      <Box>
        <Typography variant="h6" fontWeight={600}>Player cameras</Typography>
        <Typography variant="body2" color="text.secondary">
          Disabled by default. Turning this off removes player controls and stops every active camera.
        </Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <FormControlLabel
        control={
          <Switch
            checked={status.enabled}
            onChange={(event) => void update({ enabled: event.target.checked }).catch((caught) => setError(String(caught)))}
          />
        }
        label="Enable player cameras globally"
      />
      <FormControlLabel
        control={
          <Switch
            checked={status.prewarmEnabled}
            disabled={status.transport === 'relay'}
            onChange={(event) => void update({ prewarmEnabled: event.target.checked }).catch((caught) => setError(String(caught)))}
          />
        }
        label="Prewarm player previews (P2P)"
      />
      <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
        <Typography variant="body2">Transport</Typography>
        <Select
          size="small"
          value={status.transport}
          onChange={(event) => void update({ transport: event.target.value as Status['transport'] }).catch((caught) => setError(String(caught)))}
        >
          <MenuItem value="p2p">P2P WebRTC (default)</MenuItem>
          <MenuItem value="relay">MAT relay</MenuItem>
        </Select>
        <Chip label={`${status.publishers.length} live`} color={status.publishers.length ? 'success' : 'default'} />
        <Chip label={`${status.huds} HUD connection${status.huds === 1 ? '' : 's'}`} variant="outlined" />
        <Chip label={`${status.adminViewers || 0} admin preview${status.adminViewers === 1 ? '' : 's'}`} variant="outlined" />
      </Box>
      {status.transport === 'relay' && (
        <Alert severity="warning">Relay sends video through MAT Socket.IO. Use only when P2P fails; server bandwidth grows per HUD.</Alert>
      )}
      <Box>
        <Typography variant="subtitle2" gutterBottom>Active cameras</Typography>
        <AdminPlayerCameraPreviews steamIds={status.publishers} transport={status.transport} iceServers={status.iceServers || []} />
        <Box display="flex" gap={1} flexWrap="wrap" mt={1.5}>
          {status.publishers.map((id) => (
            <Button key={id} size="small" color="error" variant="outlined" onClick={() => void block(id, true).catch((caught) => setError(String(caught)))}>
              Disable {id}
            </Button>
          ))}
        </Box>
      </Box>
      <Box display="flex" gap={1}>
        <TextField
          size="small"
          label="Steam ID to block"
          value={steamId}
          onChange={(event) => setSteamId(event.target.value)}
          inputProps={{ inputMode: 'numeric', pattern: '[0-9]{17}' }}
        />
        <Button variant="outlined" color="error" disabled={!/^\d{17}$/.test(steamId)} onClick={() => void block(steamId, true).catch((caught) => setError(String(caught)))}>
          Block
        </Button>
      </Box>
      {status.blockedSteamIds.length > 0 && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>Administrator-blocked</Typography>
          <Box display="flex" gap={1} flexWrap="wrap">
            {status.blockedSteamIds.map((id) => (
              <Chip key={id} label={id} onDelete={() => void block(id, false).catch((caught) => setError(String(caught)))} />
            ))}
          </Box>
        </Box>
      )}
    </Stack>
  );
}
