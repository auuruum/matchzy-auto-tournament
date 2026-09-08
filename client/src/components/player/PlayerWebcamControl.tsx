/* eslint-disable no-undef -- browser media/WebRTC APIs are provided by the page. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { io, type Socket } from 'socket.io-client';
import { api } from '../../utils/api';

type Props = { live: boolean };
type CameraDevice = { deviceId: string; label: string };

const DEVICE_STORAGE_KEY = 'mat.webcam.deviceId';
const CAMERA_REQUEST_TIMEOUT_MS = 10_000;

function requestCameraStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Camera permission request timed out. Check browser camera permissions.'));
    }, CAMERA_REQUEST_TIMEOUT_MS);

    navigator.mediaDevices.getUserMedia(constraints).then((localStream) => {
      if (settled) {
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      resolve(localStream);
    }).catch((cause) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(cause);
    });
  });
}

export function PlayerWebcamControl({ live }: Props) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [hudConnected, setHudConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const socket = useRef<Socket | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());

  const closeHudConnection = useCallback(() => {
    peers.current.forEach((peer) => peer.close());
    peers.current.clear();
    socket.current?.disconnect();
    socket.current = null;
    setHudConnected(false);
  }, []);

  const stopPreview = useCallback(() => {
    closeHudConnection();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setPreviewReady(false);
  }, [closeHudConnection]);

  const refreshDevices = useCallback(async () => {
    const listed = await navigator.mediaDevices.enumerateDevices();
    const cameras = listed
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
    setDevices(cameras);
    return cameras;
  }, []);

  const startPreview = useCallback(async (requestedDeviceId = selectedDeviceId): Promise<boolean> => {
    setBusy(true);
    setError('');
    setPreviewReady(false);
    closeHudConnection();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;

    try {
      const videoConstraints = requestedDeviceId
        ? { deviceId: { exact: requestedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } };
      let localStream: MediaStream;
      try {
        localStream = await requestCameraStream({ video: videoConstraints, audio: false });
      } catch (cause) {
        if (!requestedDeviceId) throw cause;
        localStream = await requestCameraStream({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      }

      stream.current = localStream;
      const actualDeviceId = localStream.getVideoTracks()[0]?.getSettings().deviceId || requestedDeviceId;
      if (actualDeviceId) {
        setSelectedDeviceId(actualDeviceId);
        window.localStorage.setItem(DEVICE_STORAGE_KEY, actualDeviceId);
      }
      await refreshDevices();
      setPreviewReady(true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to access the selected camera');
      return false;
    } finally {
      setBusy(false);
    }
  }, [closeHudConnection, refreshDevices, selectedDeviceId]);

  const connectToHud = useCallback(async () => {
    if (!live || !available || !enabled || !previewReady || !stream.current || socket.current) return;
    const nextSocket = io('/webcam', { withCredentials: true, transports: ['websocket'] });
    socket.current = nextSocket;
    nextSocket.on('connect', () => setHudConnected(true));
    nextSocket.on('disconnect', () => setHudConnected(false));
    nextSocket.on('webcam:hud-list', async (ids: string[]) => {
      for (const id of ids) {
        if (peers.current.has(id) || !stream.current) continue;
        const peer = new RTCPeerConnection({
          iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] },
          ],
        });
        peers.current.set(id, peer);
        stream.current.getTracks().forEach((track) => peer.addTrack(track, stream.current!));
        peer.onicecandidate = () => undefined;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await new Promise<void>((resolve) => {
          if (peer.iceGatheringState === 'complete') return resolve();
          const onState = () => {
            if (peer.iceGatheringState === 'complete') {
              peer.removeEventListener('icegatheringstatechange', onState);
              resolve();
            }
          };
          peer.addEventListener('icegatheringstatechange', onState);
          window.setTimeout(() => {
            peer.removeEventListener('icegatheringstatechange', onState);
            resolve();
          }, 3000);
        });
        nextSocket.emit('offerFromPlayer', id, peer.localDescription, undefined);
      }
    });
    nextSocket.on('offerFromHUD', async (id: string, payload: { offer?: RTCSessionDescriptionInit }) => {
      const peer = peers.current.get(id);
      if (peer && payload?.offer) await peer.setRemoteDescription(payload.offer);
    });
    nextSocket.on('webcam:revoked', () => {
      setAvailable(false);
      setEnabled(false);
      stopPreview();
    });
    nextSocket.emit('webcam:announce');
  }, [available, enabled, live, previewReady, stopPreview]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ settings: { enabled: boolean }; player: { eligible: boolean; enabled: boolean } }>('/api/webcams/me')
      .then((data) => {
        if (cancelled) return;
        setAvailable(data.player.eligible);
        setEnabled(data.player.enabled);
        if (data.player.enabled) {
          const storedDeviceId = window.localStorage.getItem(DEVICE_STORAGE_KEY) || '';
          setSelectedDeviceId(storedDeviceId);
          void startPreview(storedDeviceId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stopPreview();
    };
  }, [startPreview, stopPreview]);

  useEffect(() => {
    if (live && enabled && previewReady) {
      void connectToHud();
    } else if (!live) {
      closeHudConnection();
    }
  }, [closeHudConnection, connectToHud, enabled, live, previewReady]);

  useEffect(() => {
    if (videoRef.current && stream.current) {
      videoRef.current.srcObject = stream.current;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [previewReady]);

  const toggleCamera = async (nextEnabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api.put('/api/webcams/me', { enabled: nextEnabled });
      setEnabled(nextEnabled);
      if (nextEnabled) {
        const started = await startPreview();
        if (!started) {
          await api.put('/api/webcams/me', { enabled: false }).catch(() => undefined);
          setEnabled(false);
        }
      } else {
        stopPreview();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update webcam');
    } finally {
      setBusy(false);
    }
  };

  const changeDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    window.localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    void startPreview(deviceId);
  };

  if (!available) return null;
  return (
    <Box sx={{ p: { xs: 2, sm: 2.5 }, border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} gap={1}>
          <Box>
            <Typography variant="h6" fontWeight={700}>Player webcam</Typography>
            <Typography variant="body2" color="text.secondary">
              Configure and preview your camera. Video is sent to JTs-Hud only during a live match.
            </Typography>
          </Box>
          <Stack direction="row" alignItems="center" gap={1}>
            <Chip size="small" label={live && hudConnected ? 'Sending to HUD' : 'Preview only'} color={live && hudConnected ? 'success' : 'default'} />
            <FormControlLabel
              control={<Switch checked={enabled} disabled={busy} onChange={(event) => void toggleCamera(event.target.checked)} />}
              label={enabled ? 'On' : 'Off'}
            />
          </Stack>
        </Stack>

        {enabled && (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <Box sx={{ width: { xs: '100%', md: 360 }, aspectRatio: '16 / 9', bgcolor: '#111', borderRadius: 1.5, overflow: 'hidden' }}>
              <video ref={videoRef} muted autoPlay playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </Box>
            <Stack spacing={2} flex={1} justifyContent="center">
              <FormControl fullWidth size="small" disabled={busy || devices.length === 0}>
                <InputLabel id="webcam-device-label">Camera device</InputLabel>
                <Select labelId="webcam-device-label" value={selectedDeviceId} label="Camera device" onChange={(event) => changeDevice(event.target.value)}>
                  {devices.map((device) => <MenuItem key={device.deviceId} value={device.deviceId}>{device.label}</MenuItem>)}
                </Select>
              </FormControl>
              <Typography variant="body2" color="text.secondary">
                {live
                  ? hudConnected
                    ? 'The selected video is currently available to the live HUD.'
                    : 'Your local preview is active. The HUD connection will start when it is available.'
                  : 'Your preview stays in this browser. No video is uploaded before the match goes live.'}
              </Typography>
            </Stack>
          </Stack>
        )}

        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </Box>
  );
}
