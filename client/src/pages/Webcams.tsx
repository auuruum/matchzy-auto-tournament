import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, Container, Paper, Stack, Typography } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import { api } from '../utils/api';
import { TopNavBar } from '../components/layout/TopNavBar';
import { PlayerWebcamControl } from '../components/player/PlayerWebcamControl';

type WebcamMeResponse = {
  settings: { enabled: boolean };
  player: { exists: boolean; eligible: boolean; blocked: boolean; live: boolean };
};

export default function Webcams() {
  const { playerSteamId } = useAuth();
  const [data, setData] = useState<WebcamMeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!playerSteamId) {
      setLoading(false);
      return;
    }
    try {
      setData(await api.get<WebcamMeResponse>('/api/webcams/me'));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [playerSteamId]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(load, 20_000);
    return () => window.clearInterval(interval);
  }, [load]);

  return (
    <Box minHeight="100vh" bgcolor="background.default">
      <TopNavBar />
      <Container maxWidth="md">
        <Stack spacing={3} py={{ xs: 4, md: 7 }}>
          <Box>
            <Typography variant="h4" fontWeight={700}>Webcams</Typography>
            <Typography color="text.secondary" mt={1}>
              Enable your player camera for the live JTs-Hud broadcast.
            </Typography>
          </Box>

          {!playerSteamId ? (
            <Alert severity="info">Sign in with Steam to configure your webcam.</Alert>
          ) : loading ? (
            <Paper sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={28} />
            </Paper>
          ) : !data?.settings.enabled ? (
            <Alert severity="info">
              Player webcams are currently disabled by the tournament administrator.
            </Alert>
          ) : !data.player.exists ? (
            <Alert severity="info">
              Your Steam account is not registered as a player in this MAT instance.
            </Alert>
          ) : data.player.blocked ? (
            <Alert severity="warning">
              Webcam access has been disabled for your player account by an administrator.
            </Alert>
          ) : (
            <PlayerWebcamControl live={data.player.live} />
          )}
        </Stack>
      </Container>
    </Box>
  );
}
