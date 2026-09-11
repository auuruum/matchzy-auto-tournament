/* global MediaRecorder, MediaStream, RTCPeerConnection, RTCIceServer, RTCIceCandidateInit */
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
  previewStream: MediaStream | null;
  preparePreview: (deviceId?: string) => Promise<void>;
  start: (testPattern: boolean) => Promise<void>;
  stop: (message?: string) => void;
};

const PlayerCameraContext = React.createContext<PlayerCameraContextValue | undefined>(undefined);

async function setPeerQuality(sender: RTCRtpSender, quality: 'preview' | 'full'): Promise<void> {
  const parameters = sender.getParameters();
  const encoding = parameters.encodings?.[0];
  if (!encoding) return;
  encoding.scaleResolutionDownBy = quality === 'preview' ? 2 : 1;
  encoding.maxBitrate = quality === 'preview' ? 240_000 : 1_500_000;
  encoding.maxFramerate = quality === 'preview' ? 12 : 30;
  await sender.setParameters(parameters).catch(() => undefined);
}

function createTestPattern(label: string): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  const identityHue = [...label].reduce((sum, character) => sum + Number(character), 0) * 23;
  let frame = 0;
  const timer = window.setInterval(() => {
    if (!context) return;
    const hue = (identityHue + frame++ * 2) % 360;
    context.fillStyle = `hsl(${hue} 45% 18%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = 'bold 64px sans-serif';
    context.textAlign = 'center';
    context.fillText('MAT PLAYER CAMERA TEST', canvas.width / 2, 300);
    context.font = '36px monospace';
    context.fillText(new Date().toLocaleTimeString(), canvas.width / 2, 390);
    context.fillText(`STEAM ${label}`, canvas.width / 2, 450);
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
  const [previewStream, setPreviewStream] = React.useState<MediaStream | null>(null);
  const configRef = React.useRef<PlayerCameraConfig | null>(null);
  const socketRef = React.useRef<Socket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const previewStreamRef = React.useRef<MediaStream | null>(null);
  const stopSourceRef = React.useRef<(() => void) | null>(null);
  const peersRef = React.useRef(new Map<string, RTCPeerConnection>());
  const countViewers = () => new Set([...peersRef.current.keys()].map((key) => key.split(':').slice(0, 2).join(':'))).size;
  const videoSendersRef = React.useRef(new Map<string, RTCRtpSender>());
  const pendingIceRef = React.useRef(new Map<string, RTCIceCandidateInit[]>());
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
    videoSendersRef.current.clear();
    pendingIceRef.current.clear();
    setPeerCount(0);
    stopSourceRef.current?.();
    stopSourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    previewStreamRef.current = null;
    setPreviewStream(null);
    setStream(null);
    setActive(false);
    if (message) setError(message);
  }, []);

  React.useEffect(() => () => stop(), [stop]);

  const preparePreview = React.useCallback(async (deviceId?: string) => {
    const currentConfig = configRef.current;
    if (!currentConfig?.enabled || !playerSteamId || streamRef.current) return;
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    previewStreamRef.current = null;
    setPreviewStream(null);
    setError('');
    try {
      const nextPreview = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      previewStreamRef.current = nextPreview;
      setPreviewStream(nextPreview);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not preview camera');
    }
  }, [playerSteamId]);

  const start = React.useCallback(async (testPattern: boolean) => {
    const currentConfig = configRef.current;
    if (!currentConfig || !currentConfig.enabled || !playerSteamId || streamRef.current) return;
    setError('');
    try {
      const test = testPattern ? createTestPattern(playerSteamId) : null;
      const prepared = testPattern ? null : previewStreamRef.current;
      if (testPattern) {
        previewStreamRef.current?.getTracks().forEach((track) => track.stop());
        previewStreamRef.current = null;
        setPreviewStream(null);
      }
      const nextStream = test?.stream || prepared ||
        (await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
          audio: false,
        }));
      streamRef.current = nextStream;
      if (prepared) {
        previewStreamRef.current = null;
        setPreviewStream(null);
      }
      stopSourceRef.current = test?.stop || null;
      setStream(nextStream);

      const socket = io();
      socketRef.current = socket;
      const resetConnections = () => {
        if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
        recorderRef.current = null;
        peersRef.current.forEach((peer) => peer.close());
        peersRef.current.clear();
        videoSendersRef.current.clear();
        pendingIceRef.current.clear();
        setPeerCount(0);
      };
      const startRelayRecorder = () => {
        if (currentConfig.transport !== 'relay' || recorderRef.current?.state === 'recording') return;
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
        recorder.start(250);
        recorderRef.current = recorder;
      };
      socket.on('camera:forced-stop', (payload?: { reason?: string }) =>
        stop(payload?.reason || 'Camera stopped by administrator')
      );
      socket.on('camera:policy', (policy: PlayerCameraConfig) => {
        configRef.current = policy;
        setConfig(policy);
        if (!policy.enabled) stop('Player cameras were disabled by administrator');
      });

      socket.on(
        'camera:create-peer',
        async ({
          hudId,
          viewerId,
          steamId,
          quality = 'preview',
        }: {
          hudId: string;
          viewerId: string;
          steamId: string;
          quality?: 'preview' | 'full';
        }) => {
          const key = hudId + ':' + viewerId + ':' + steamId;
          peersRef.current.get(key)?.close();
          videoSendersRef.current.delete(key);
          const peer = new RTCPeerConnection({ iceServers: currentConfig.iceServers });
          peersRef.current.set(key, peer);
          pendingIceRef.current.set(key, []);
          setPeerCount(countViewers());
          const track = nextStream.getVideoTracks()[0];
          if (track) {
            const sender = peer.addTrack(track, nextStream);
            videoSendersRef.current.set(key, sender);
            await setPeerQuality(sender, quality);
          }
          peer.onicecandidate = (event) => {
            if (event.candidate) {
              socket.emit('camera:ice-from-player', { hudId, viewerId, steamId, candidate: event.candidate });
            }
          };
          peer.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(peer.connectionState) && peersRef.current.get(key) === peer) {
              peer.close();
              peersRef.current.delete(key);
              videoSendersRef.current.delete(key);
              pendingIceRef.current.delete(key);
              setPeerCount(countViewers());
            }
          };
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          if (peersRef.current.get(key) !== peer) return;
          socket.emit('camera:offer', { hudId, viewerId, steamId, description: peer.localDescription });
        }
      );
      socket.on('camera:create-admin-peer', async ({ adminId, steamId }: { adminId: string; steamId: string }) => {
        const key = `admin:${adminId}:${steamId}`;
        peersRef.current.get(key)?.close();
        const peer = new RTCPeerConnection({ iceServers: currentConfig.iceServers });
        peersRef.current.set(key, peer);
        pendingIceRef.current.set(key, []);
        setPeerCount(countViewers());
        nextStream.getVideoTracks().forEach((track) => peer.addTrack(track, nextStream));
        peer.onicecandidate = (event) => {
          if (event.candidate) socket.emit('camera:admin-ice-from-player', { adminId, steamId, candidate: event.candidate });
        };
        peer.onconnectionstatechange = () => {
          if (['failed', 'closed'].includes(peer.connectionState) && peersRef.current.get(key) === peer) {
            peer.close();
            peersRef.current.delete(key);
            pendingIceRef.current.delete(key);
            setPeerCount(countViewers());
          }
        };
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (peersRef.current.get(key) !== peer) return;
        socket.emit('camera:admin-offer', { adminId, steamId, description: peer.localDescription });
      });
      socket.on('camera:viewer-stopped', ({ hudId, viewerId, steamId }: { hudId: string; viewerId: string; steamId?: string }) => {
        const prefix = hudId + ':' + viewerId + ':';
        for (const [key, peer] of peersRef.current) {
          if (key.startsWith(prefix) && (!steamId || key === prefix + steamId)) {
            peer.close();
            peersRef.current.delete(key);
            videoSendersRef.current.delete(key);
            pendingIceRef.current.delete(key);
          }
        }
        setPeerCount(countViewers());
      });
      socket.on('camera:set-quality', ({ hudId, viewerId, steamId, quality }: { hudId: string; viewerId: string; steamId: string; quality: 'preview' | 'full' }) => {
        const key = hudId + ':' + viewerId + ':' + steamId;
        const sender = videoSendersRef.current.get(key);
        if (sender) void setPeerQuality(sender, quality);
      });
      socket.on('camera:answer', async ({ hudId, viewerId, steamId, description }) => {
        const key = hudId + ':' + viewerId + ':' + steamId;
        const peer = peersRef.current.get(key);
        if (!peer) return;
        await peer.setRemoteDescription(description);
        if (peersRef.current.get(key) !== peer) return;
        const candidates = pendingIceRef.current.get(key) || [];
        pendingIceRef.current.set(key, []);
        for (const candidate of candidates) await peer.addIceCandidate(candidate).catch(() => undefined);
      });
      socket.on('camera:admin-answer', async ({ adminId, steamId, description }) => {
        const key = `admin:${adminId}:${steamId}`;
        const peer = peersRef.current.get(key);
        if (!peer) return;
        await peer.setRemoteDescription(description);
        if (peersRef.current.get(key) !== peer) return;
        const candidates = pendingIceRef.current.get(key) || [];
        pendingIceRef.current.set(key, []);
        for (const candidate of candidates) await peer.addIceCandidate(candidate).catch(() => undefined);
      });
      socket.on('camera:ice-from-hud', async ({ hudId, viewerId, steamId, candidate }) => {
        const key = hudId + ':' + viewerId + ':' + steamId;
        const peer = peersRef.current.get(key);
        if (!peer) return;
        if (peer.remoteDescription) await peer.addIceCandidate(candidate).catch(() => undefined);
        else pendingIceRef.current.get(key)?.push(candidate);
      });
      socket.on('camera:admin-ice-from-admin', async ({ adminId, steamId, candidate }) => {
        const key = `admin:${adminId}:${steamId}`;
        const peer = peersRef.current.get(key);
        if (!peer) return;
        if (peer.remoteDescription) await peer.addIceCandidate(candidate).catch(() => undefined);
        else pendingIceRef.current.get(key)?.push(candidate);
      });

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const publish = () => socket.emit('camera:publish', {}, (result: { ok?: boolean; error?: string }) => {
          if (result?.ok) {
            startRelayRecorder();
            if (!settled) {
              settled = true;
              resolve();
            }
          } else {
            const issue = result?.error || 'Camera publish failed';
            if (!settled) {
              settled = true;
              reject(new Error(issue));
            } else stop(issue);
          }
        });
        socket.on('disconnect', resetConnections);
        socket.on('connect', publish);
        if (socket.connected) publish();
      });
      setActive(true);
    } catch (caught) {
      stop(caught instanceof Error ? caught.message : 'Could not start camera');
    }
  }, [playerSteamId, stop]);

  const value = React.useMemo(() => ({ config, active, error, peerCount, stream, previewStream, preparePreview, start, stop }), [
    config,
    active,
    error,
    peerCount,
    stream,
    previewStream,
    preparePreview,
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
  const { active, peerCount, previewStream, stop } = usePlayerCamera();

  if (!active && !previewStream) return null;
  return (
    <Card sx={{ position: 'fixed', right: 20, bottom: 20, zIndex: 1300, width: 280, p: 1.25, boxShadow: 8 }}>
      <Stack spacing={1}>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
          <Typography variant="subtitle2" fontWeight={700}>Player camera</Typography>
          <Chip size="small" color={active ? 'success' : 'warning'} icon={<VideocamIcon />} label={active ? 'Live' : 'Preview'} />
        </Box>
        <Box display="flex" alignItems="center" gap={1.5} sx={{ px: 1, py: 1.5, bgcolor: active ? 'rgba(76, 175, 80, .12)' : 'rgba(255, 152, 0, .12)', borderRadius: 1 }}>
          <VideocamIcon color="success" />
          <Typography variant="body2">{active ? 'Your camera is sending video' : 'Preview only — nothing is sent'}</Typography>
        </Box>
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1}>
          <Typography variant="caption" color="text.secondary">
            {active ? `Continues while browsing MAT · ${peerCount} viewer${peerCount === 1 ? '' : 's'}` : 'Choose Enable camera when ready'}
          </Typography>
          <Button size="small" color="error" onClick={() => stop()}>Stop</Button>
        </Box>
      </Stack>
    </Card>
  );
}
