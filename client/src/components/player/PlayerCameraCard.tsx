/* global HTMLVideoElement */
import React from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import ScienceIcon from '@mui/icons-material/Science';
import { useAuth } from '../../contexts/AuthContext';
import { usePlayerCamera } from '../../contexts/PlayerCameraContext';

export function PlayerCameraCard({ profileSteamId }: { profileSteamId: string }) {
  const { playerSteamId, impersonation } = useAuth();
  const { config, active, error, peerCount, stream, start, stop } = usePlayerCamera();
  const previewRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
    return () => { video.srcObject = null; };
  }, [stream]);

  if (!config?.enabled || playerSteamId !== profileSteamId) return null;

  return (
    <Card data-testid="player-camera-card">
      <CardContent>
        <Stack spacing={2}>
          <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="h6" fontWeight={700}>Player camera</Typography>
              <Typography variant="body2" color="text.secondary">
                Video only. Your camera continues while you browse MAT and stops when you disable it or close this site.
              </Typography>
            </Box>
            <Chip label={config.transport === 'p2p' ? 'P2P WebRTC' : 'MAT relay'} color="primary" variant="outlined" />
          </Box>
          {impersonation && <Alert severity="info">Debug: publishing as {profileSteamId} through View as player.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <Box
            component="video"
            ref={previewRef}
            autoPlay
            muted
            playsInline
            sx={{ width: '100%', maxHeight: 360, bgcolor: '#050505', borderRadius: 1, transform: 'scaleX(-1)' }}
          />
          <Box display="flex" gap={1} flexWrap="wrap">
            {!active ? (
              <>
                <Button variant="contained" startIcon={<VideocamIcon />} onClick={() => void start(false)}>
                  Enable camera
                </Button>
                <Button variant="outlined" startIcon={<ScienceIcon />} onClick={() => void start(true)}>
                  Test pattern
                </Button>
              </>
            ) : (
              <Button color="error" variant="contained" onClick={() => stop()}>Disable camera</Button>
            )}
            {active && <Chip color="success" label={`Live · ${peerCount} viewer${peerCount === 1 ? '' : 's'}`} />}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Remote camera access requires HTTPS. localhost works over HTTP. No audio or recording is sent.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
