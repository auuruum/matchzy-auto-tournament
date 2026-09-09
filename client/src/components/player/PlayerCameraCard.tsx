/* global HTMLVideoElement, MediaRecorder, MediaStream, RTCPeerConnection, RTCIceServer */
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
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../../contexts/AuthContext';

type Config = {
  enabled: boolean;
  transport: 'p2p' | 'relay';
  iceServers: RTCIceServer[];
};

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

export function PlayerCameraCard({ profileSteamId }: { profileSteamId: string }) {
  const { playerSteamId, impersonation } = useAuth();
  const [config, setConfig] = React.useState<Config | null>(null);
  const [active, setActive] = React.useState(false);
  const [error, setError] = React.useState('');
  const [peerCount, setPeerCount] = React.useState(0);
  const previewRef = React.useRef<HTMLVideoElement>(null);
  const socketRef = React.useRef<Socket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const stopSourceRef = React.useRef<(() => void) | null>(null);
  const peersRef = React.useRef(new Map<string, RTCPeerConnection>());
  const recorderRef = React.useRef<MediaRecorder | null>(null);

  React.useEffect(() => {
    fetch('/api/player-cameras/config')
      .then((response) => response.json())
      .then(setConfig)
      .catch(() => setConfig({ enabled: false, transport: 'p2p', iceServers: [] }));
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
    if (previewRef.current) previewRef.current.srcObject = null;
    setActive(false);
    if (message) setError(message);
  }, []);

  React.useEffect(() => stop, [stop]);

  const start = async (testPattern: boolean) => {
    if (!config) return;
    setError('');
    try {
      const test = testPattern ? createTestPattern() : null;
      const stream = test?.stream ||
        (await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
          audio: false,
        }));
      streamRef.current = stream;
      stopSourceRef.current = test?.stop || null;
      if (previewRef.current) previewRef.current.srcObject = stream;

      const socket = io();
      socketRef.current = socket;
      socket.on('camera:forced-stop', (payload?: { reason?: string }) =>
        stop(payload?.reason || 'Camera stopped by administrator')
      );
      socket.on('camera:policy', (policy: Config) => {
        setConfig(policy);
        if (!policy.enabled) stop('Player cameras were disabled by administrator');
      });

      socket.on('camera:create-peer', async ({ hudId, viewerId }: { hudId: string; viewerId: string }) => {
        const key = `${hudId}:${viewerId}`;
        peersRef.current.get(key)?.close();
        const peer = new RTCPeerConnection({ iceServers: config.iceServers });
        peersRef.current.set(key, peer);
        setPeerCount(peersRef.current.size);
        stream.getVideoTracks().forEach((track) => peer.addTrack(track, stream));
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
      socket.on('camera:answer', async ({ hudId, viewerId, description }) => {
        await peersRef.current.get(`${hudId}:${viewerId}`)?.setRemoteDescription(description);
      });
      socket.on('camera:ice-from-hud', async ({ hudId, viewerId, candidate }) => {
        await peersRef.current.get(`${hudId}:${viewerId}`)?.addIceCandidate(candidate).catch(() => undefined);
      });

      await new Promise<void>((resolve, reject) => {
        socket.emit('camera:publish', {}, (result: { ok?: boolean; error?: string }) =>
          result?.ok ? resolve() : reject(new Error(result?.error || 'Camera publish failed'))
        );
      });

      if (config.transport === 'relay') {
        const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(MediaRecorder.isTypeSupported);
        const recorder = new MediaRecorder(stream, {
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
  };

  if (!config?.enabled || playerSteamId !== profileSteamId) return null;

  return (
    <Card data-testid="player-camera-card">
      <CardContent>
        <Stack spacing={2}>
          <Box display="flex" alignItems="center" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="h6" fontWeight={700}>Player camera</Typography>
              <Typography variant="body2" color="text.secondary">
                Video only. Visible in JTs-Hud while this player is observed in a live match.
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
            {active && <Chip color="success" label={`Live · ${peerCount} P2P viewer${peerCount === 1 ? '' : 's'}`} />}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Remote camera access requires HTTPS. localhost works over HTTP. No audio or recording is sent.
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
