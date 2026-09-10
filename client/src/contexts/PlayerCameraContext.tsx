/* global MediaRecorder, MediaStream, RTCPeerConnection, RTCIceServer */
import React from 'react';
import { Box, Button, Card, Chip, Stack, Typography } from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

export type PlayerCameraConfig = {
  enabled: boolean;
  transport: 'p2p' | 'relay';
  iceServers: RTCIceServer[];
};

type PlayerCameraContextValue = {
  config: PlayerCameraConfig | null;
  active: boolean;
  error: string;
  peerCount: number;
  stream: MediaStream | null;
  start: (testPattern: boolean) => Promise<void>;
  stop: (message?: string) => void;
};

const PlayerCameraContext = React.createContext<PlayerCameraContextValue | undefined>(undefined);

function createTestPattern(): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  let frame = 0;
  const timer = window.setInterval(() => {
    if (!context) return;
    const hue = (frame++ * 2) % 360;
    context.fillStyle = `hsl(${hue} 45% 18%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = 'bold 64px sans-serif';
    context.textAlign = 'center';
    context.fillText('MAT PLAYER CAMERA TEST', canvas.width / 2, 300);
    context.font = '36px monospace';
    context.fillText(new Date().toLocaleTimeString(), canvas.width / 2, 390);
  }, 100);
  const stream = canvas.captureStream(10);
  return {
    stream,
    stop: () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

export function PlayerCameraProvider({ children }: { children: React.ReactNode }) {
  const { playerSteamId } = useAuth();
  const [config, setConfig] = React.useState<PlayerCameraConfig | null>(null);
  const [active, setActive] = React.useState(false);
  const [error, setError] = React.useState('');
  const [peerCount, setPeerCount] = React.useState(0);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const configRef = React.useRef<PlayerCameraConfig | null>(null);
  const socketRef = React.useRef<Socket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const stopSourceRef = React.useRef<(() => void) | null>(null);
  const peersRef = React.useRef(new Map<string, RTCPeerConnection>());
  const recorderRef = React.useRef<MediaRecorder | null>(null);

  React.useEffect(() => {
    fetch('/api/player-cameras/config')
      .then((response) => response.json())
      .then((value: PlayerCameraConfig) => {
        configRef.current = value;
        setConfig(value);
      })
      .catch(() => {
        const value = { enabled: false, transport: 'p2p' as const, iceServers: [] };
        configRef.current = value;
        setConfig(value);
      });
  }, []);

  const stop = React.useCallback((message = '') => {
    socketRef.current?.emit('camera:stop');
    socketRef.current?.disconnect();
    socketRef.current = null;
    recorderRef.current?.stop();
    recorderRef.current = null;
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    setPeerCount(0);
    stopSourceRef.current?.();
    stopSourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setActive(false);
    if (message) setError(message);
  }, []);

  React.useEffect(() => () => stop(), [stop]);

  const start = React.useCallback(async (testPattern: boolean) => {
    const currentConfig = configRef.current;
    if (!currentConfig || !currentConfig.enabled || !playerSteamId || streamRef.current) return;
    setError('');
    try {
      const test = testPattern ? createTestPattern() : null;
      const nextStream = test?.stream ||
        (await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
          audio: false,
        }));
      streamRef.current = nextStream;
      stopSourceRef.current = test?.stop || null;
      setStream(nextStream);

      const socket = io();
      socketRef.current = socket;
      socket.on('camera:forced-stop', (payload?: { reason?: string }) =>
        stop(payload?.reason || 'Camera stopped by administrator')
      );
      socket.on('camera:policy', (policy: PlayerCameraConfig) => {
        configRef.current = policy;
        setConfig(policy);
        if (!policy.enabled) stop('Player cameras were disabled by administrator');
      });

      socket.on('camera:create-peer', async ({ hudId, viewerId }: { hudId: string; viewerId: string }) => {
        const key = `${hudId}:${viewerId}`;
        peersRef.current.get(key)?.close();
        const peer = new RTCPeerConnection({ iceServers: currentConfig.iceServers });
        peersRef.current.set(key, peer);
        setPeerCount(peersRef.current.size);
        nextStream.getVideoTracks().forEach((track) => peer.addTrack(track, nextStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) socket.emit('camera:ice-from-player', { hudId, viewerId, candidate: event.candidate });
        };
        peer.onconnectionstatechange = () => {
          if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
            peer.close();
            peersRef.current.delete(key);
            setPeerCount(peersRef.current.size);
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('camera:offer', { hudId, viewerId, description: peer.localDescription });
      });
      socket.on('camera:create-admin-peer', async ({ adminId, steamId }: { adminId: string; steamId: string }) => {
        const key = `admin:${adminId}:${steamId}`;
        peersRef.current.get(key)?.close();
        const peer = new RTCPeerConnection({ iceServers: currentConfig.iceServers });
        peersRef.current.set(key, peer);
        setPeerCount(peersRef.current.size);
        nextStream.getVideoTracks().forEach((track) => peer.addTrack(track, nextStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) socket.emit('camera:admin-ice-from-player', { adminId, steamId, candidate: event.candidate });
        };
        peer.onconnectionstatechange = () => {
          if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
            peer.close();
            peersRef.current.delete(key);
            setPeerCount(peersRef.current.size);
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('camera:admin-offer', { adminId, steamId, description: peer.localDescription });
      });
      socket.on('camera:answer', async ({ hudId, viewerId, description }) => {
        await peersRef.current.get(`${hudId}:${viewerId}`)?.setRemoteDescription(description);
      });
      socket.on('camera:admin-answer', async ({ adminId, steamId, description }) => {
        await peersRef.current.get(`admin:${adminId}:${steamId}`)?.setRemoteDescription(description);
      });
      socket.on('camera:ice-from-hud', async ({ hudId, viewerId, candidate }) => {
        await peersRef.current.get(`${hudId}:${viewerId}`)?.addIceCandidate(candidate).catch(() => undefined);
      });
      socket.on('camera:admin-ice-from-admin', async ({ adminId, steamId, candidate }) => {
        await peersRef.current.get(`admin:${adminId}:${steamId}`)?.addIceCandidate(candidate).catch(() => undefined);
      });

      await new Promise<void>((resolve, reject) => {
        socket.emit('camera:publish', {}, (result: { ok?: boolean; error?: string }) =>
          result?.ok ? resolve() : reject(new Error(result?.error || 'Camera publish failed'))
        );
      });

      if (currentConfig.transport === 'relay') {
        const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(MediaRecorder.isTypeSupported);
        const recorder = new MediaRecorder(nextStream, {
          ...(mimeType ? { mimeType } : {}),
          videoBitsPerSecond: 1_500_000,
        });
        let sequence = 0;
        recorder.ondataavailable = async (event) => {
          if (event.data.size > 0 && socket.connected) {
            socket.emit('camera:relay-chunk', {
              chunk: await event.data.arrayBuffer(),
              mimeType: recorder.mimeType,
              sequence: sequence++,
            });
          }
        };
        recorder.start(1000);
        recorderRef.current = recorder;
      }
      setActive(true);
    } catch (caught) {
      stop(caught instanceof Error ? caught.message : 'Could not start camera');
    }
  }, [playerSteamId, stop]);

  const value = React.useMemo(() => ({ config, active, error, peerCount, stream, start, stop }), [
    config,
    active,
    error,
    peerCount,
    stream,
    start,
    stop,
  ]);

  return (
    <PlayerCameraContext.Provider value={value}>
      {children}
      <PlayerCameraStatusDock />
    </PlayerCameraContext.Provider>
  );
}

export function usePlayerCamera(): PlayerCameraContextValue {
  const context = React.useContext(PlayerCameraContext);
  if (!context) throw new Error('usePlayerCamera must be used within PlayerCameraProvider');
  return context;
}

function PlayerCameraStatusDock() {
  const { active, peerCount, stop } = usePlayerCamera();

  if (!active) return null;
  return (
    <Card sx={{ position: 'fixed', right: 20, bottom: 20, zIndex: 1300, width: 280, p: 1.25, boxShadow: 8 }}>
      <Stack spacing={1}>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
          <Typography variant="subtitle2" fontWeight={700}>Player camera</Typography>
          <Chip size="small" color="success" icon={<VideocamIcon />} label="Live" />
        </Box>
        <Box display="flex" alignItems="center" gap={1.5} sx={{ px: 1, py: 1.5, bgcolor: 'rgba(76, 175, 80, .12)', borderRadius: 1 }}>
          <VideocamIcon color="success" />
          <Typography variant="body2">Your camera is sending video</Typography>
        </Box>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
          <Typography variant="caption" color="text.secondary">
            Continues while browsing MAT · {peerCount} viewer{peerCount === 1 ? '' : 's'}
          </Typography>
          <Button size="small" color="error" onClick={() => stop()}>Stop</Button>
        </Box>
      </Stack>
    </Card>
  );
}
