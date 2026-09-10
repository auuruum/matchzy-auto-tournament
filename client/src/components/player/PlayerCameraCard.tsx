/* global HTMLVideoElement, MediaDeviceInfo */
import React from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import ScienceIcon from '@mui/icons-material/Science';
import { useAuth } from '../../contexts/AuthContext';
import { usePlayerCamera } from '../../contexts/PlayerCameraContext';

export function PlayerCameraCard({ profileSteamId }: { profileSteamId: string }) {
  const { playerSteamId, impersonation } = useAuth();
  const { config, active, error, peerCount, stream, previewStream, preparePreview, start, stop } = usePlayerCamera();
  const previewRef = React.useRef<HTMLVideoElement>(null);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState(() =>
    typeof window === 'undefined' ? '' : window.localStorage.getItem('mat-player-camera-device') || ''
  );

  const refreshDevices = React.useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const cameras = allDevices.filter((device) => device.kind === 'videoinput');
    setDevices(cameras);
    if (selectedDeviceId && !cameras.some((device) => device.deviceId === selectedDeviceId)) {
      setSelectedDeviceId('');
      window.localStorage.removeItem('mat-player-camera-device');
    }
  }, [selectedDeviceId]);

  React.useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  const selectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    if (deviceId) window.localStorage.setItem('mat-player-camera-device', deviceId);
    else window.localStorage.removeItem('mat-player-camera-device');
    if (previewStream) void preparePreview(deviceId || undefined);
  };

  const previewSelectedCamera = async () => {
    await preparePreview(selectedDeviceId || undefined);
    void refreshDevices();
  };

  React.useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    const nextStream = previewStream || stream;
    video.srcObject = nextStream;
    if (nextStream) void video.play().catch(() => undefined);
    return () => { video.srcObject = null; };
  }, [previewStream, stream]);

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
          <TextField
            select
            fullWidth
            size="small"
            label="Webcam"
            value={selectedDeviceId}
            onChange={(event) => selectDevice(event.target.value)}
            disabled={active}
            helperText={active ? 'Stop the camera to change the selected device.' : previewStream ? 'Preview only — nothing is sent to MAT yet.' : 'Select a camera, then preview it before publishing.'}
          >
            <MenuItem value="">Default camera</MenuItem>
            {devices.map((device, index) => (
              <MenuItem key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </MenuItem>
            ))}
          </TextField>
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
                {previewStream ? (
                  <Button variant="contained" startIcon={<VideocamIcon />} onClick={() => void start(false)}>
                    Enable camera
                  </Button>
                ) : (
                  <Button variant="contained" startIcon={<VideocamIcon />} onClick={() => void previewSelectedCamera()}>
                    Preview camera
                  </Button>
                )}
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
