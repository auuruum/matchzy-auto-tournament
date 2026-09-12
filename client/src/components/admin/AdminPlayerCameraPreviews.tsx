/* global HTMLVideoElement, MediaSource, SourceBuffer, RTCIceServer, RTCSessionDescriptionInit, RTCIceCandidateInit, RTCPeerConnection */
import React from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import { io, type Socket } from 'socket.io-client';

type Transport = 'p2p' | 'relay';
type Props = {
  steamIds: string[];
  transport: Transport;
  iceServers: RTCIceServer[];
  playerNames: Record<string, string>;
  onBlock: (steamId: string) => void;
};
type Offer = { adminId: string; steamId: string; description: RTCSessionDescriptionInit };
type Candidate = { steamId: string; candidate: RTCIceCandidateInit };
type RelayChunk = { steamId: string; chunk: unknown; mimeType?: string; sequence?: number };
type RelayState = { source: MediaSource; url: string; buffer: SourceBuffer | null; queue: ArrayBuffer[]; mimeType: string };

function asBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (value && typeof value === 'object' && 'data' in value) return asBuffer((value as { data?: unknown }).data);
  return null;
}

export function AdminPlayerCameraPreviews({ steamIds, transport, iceServers, playerNames, onBlock }: Props) {
  const socketRef = React.useRef<Socket | null>(null);
  const idsRef = React.useRef(steamIds);
  const videosRef = React.useRef(new Map<string, HTMLVideoElement | null>());
  const peersRef = React.useRef(new Map<string, RTCPeerConnection>());
  const pendingIceRef = React.useRef(new Map<string, RTCIceCandidateInit[]>());
  const relaysRef = React.useRef(new Map<string, RelayState>());
  const [states, setStates] = React.useState<Record<string, string>>({});
  const [connected, setConnected] = React.useState(false);
  const idsKey = steamIds.join(',');
  const iceServersKey = JSON.stringify(iceServers);

  idsRef.current = idsKey ? idsKey.split(',') : [];

  const setState = React.useCallback((steamId: string, value: string) => {
    setStates((current) => ({ ...current, [steamId]: value }));
  }, []);

  React.useEffect(() => {
    const socket = io();
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      idsRef.current.forEach((steamId) => socket.emit('camera:admin-watch', { steamId }));
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('camera:admin-offer', async ({ steamId, adminId, description }: Offer) => {
      const previous = peersRef.current.get(steamId);
      previous?.close();
      const peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set(steamId, peer);
      pendingIceRef.current.set(steamId, []);
      setState(steamId, 'connecting');
      peer.ontrack = (event) => {
        if (peersRef.current.get(steamId) !== peer) return;
        const video = videosRef.current.get(steamId);
        const stream = event.streams[0];
        if (!video || !stream) return;
        video.srcObject = stream;
        void video.play().catch(() => undefined);
      };
      peer.onicecandidate = (event) => {
        if (event.candidate && socket.id) {
          socket.emit('camera:admin-ice-from-admin', { adminId: socket.id, steamId, candidate: event.candidate });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'disconnected') setState(steamId, 'reconnecting');
        if (['failed', 'closed'].includes(peer.connectionState) && peersRef.current.get(steamId) === peer) {
          setState(steamId, 'offline');
        }
      };
      try {
        await peer.setRemoteDescription(description);
        if (peersRef.current.get(steamId) !== peer) return;
        const candidates = pendingIceRef.current.get(steamId) || [];
        pendingIceRef.current.set(steamId, []);
        for (const candidate of candidates) await peer.addIceCandidate(candidate).catch(() => undefined);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        if (peersRef.current.get(steamId) !== peer) return;
        socket.emit('camera:admin-answer', { adminId, steamId, description: peer.localDescription });
      } catch {
        setState(steamId, 'offline');
      }
    });
    socket.on('camera:admin-ice-from-player', async ({ steamId, candidate }: Candidate) => {
      const peer = peersRef.current.get(steamId);
      if (!peer) return;
      if (peer.remoteDescription) await peer.addIceCandidate(candidate).catch(() => undefined);
      else pendingIceRef.current.get(steamId)?.push(candidate);
    });
    socket.on('camera:admin-stopped', ({ steamId }: { steamId: string }) => {
      peersRef.current.get(steamId)?.close();
      peersRef.current.delete(steamId);
      pendingIceRef.current.delete(steamId);
      setState(steamId, 'offline');
      const video = videosRef.current.get(steamId);
      if (video) video.srcObject = null;
    });
    socket.on('camera:admin-relay-chunk', ({ steamId, chunk, mimeType, sequence }: RelayChunk) => {
      const bytes = asBuffer(chunk);
      if (!bytes || !mimeType) return;
      let relay = relaysRef.current.get(steamId);
      if (sequence === 0 && relay) {
        if (relay.source.readyState === 'open') relay.source.endOfStream();
        URL.revokeObjectURL(relay.url);
        relaysRef.current.delete(steamId);
        relay = undefined;
      }
      if (!relay) {
        const source = new MediaSource();
        const url = URL.createObjectURL(source);
        relay = { source, url, buffer: null, queue: [bytes], mimeType };
        relaysRef.current.set(steamId, relay);
        const video = videosRef.current.get(steamId);
        if (video) {
          video.srcObject = null;
          video.src = url;
          void video.play().catch(() => undefined);
        }
        source.addEventListener('sourceopen', () => {
          try {
            relay!.buffer = source.addSourceBuffer(mimeType);
            relay!.buffer.addEventListener('updateend', () => {
              const video = videosRef.current.get(steamId);
              if (video) void video.play().catch(() => undefined);
              setState(steamId, 'live');
              if (relay!.buffer && !relay!.buffer.updating && relay!.queue.length) {
                relay!.buffer.appendBuffer(relay!.queue.shift()!);
              }
            });
            relay!.buffer.appendBuffer(relay!.queue.shift()!);
          } catch {
            setState(steamId, 'offline');
          }
        }, { once: true });
        return;
      }
      relay.queue.push(bytes);
      if (relay.buffer && !relay.buffer.updating && relay.queue.length) relay.buffer.appendBuffer(relay.queue.shift()!);
    });
    const peers = peersRef.current;
    const pendingIce = pendingIceRef.current;
    const relays = relaysRef.current;
    const videos = videosRef.current;
    return () => {
      socket.emit('camera:admin-watch', { steamId: null });
      socket.disconnect();
      socketRef.current = null;
      peers.forEach((peer) => peer.close());
      peers.clear();
      pendingIce.clear();
      relays.forEach((relay) => relay.source.readyState === 'open' && relay.source.endOfStream());
      relays.forEach((relay) => URL.revokeObjectURL(relay.url));
      relays.clear();
      videos.forEach((video) => { if (video) { video.srcObject = null; video.removeAttribute('src'); } });
    };
  // iceServersKey prevents reconnecting on every admin status poll.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, iceServersKey, setState]);

  React.useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit('camera:admin-watch', { steamId: null });
    idsKey.split(',').filter(Boolean).forEach((steamId) => socket.emit('camera:admin-watch', { steamId }));
  }, [idsKey]);

  if (!steamIds.length) return <Typography variant="body2" color="text.secondary">None</Typography>;
  return (
    <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap={1.5}>
      {steamIds.map((steamId) => (
        <Box key={steamId} sx={{ position: 'relative', bgcolor: '#111', borderRadius: 1, overflow: 'hidden', minHeight: 150 }}>
          <Box
            component="video"
            ref={(element: HTMLVideoElement | null) => videosRef.current.set(steamId, element)}
            autoPlay muted playsInline
            onPlaying={() => setState(steamId, 'live')}
            sx={{ display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', bgcolor: '#050505' }}
          />
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              p: 1,
              pt: 4,
              background: 'linear-gradient(transparent, rgba(0,0,0,.88))',
            }}
          >
            <Box minWidth={0} flex={1}>
              <Typography color="common.white" fontWeight={700} noWrap>
                {playerNames[steamId] || 'Unknown player'}
              </Typography>
              <Typography variant="caption" color="rgba(255,255,255,.72)" noWrap display="block">
                {steamId}
              </Typography>
            </Box>
            <Chip size="small" color={states[steamId] === 'live' ? 'success' : 'default'} label={states[steamId] || (connected ? 'waiting' : 'connecting')} />
            <Button
              size="small"
              color="error"
              variant="contained"
              aria-label={`Block camera for ${playerNames[steamId] || steamId}`}
              onClick={() => onBlock(steamId)}
              sx={{ whiteSpace: 'nowrap' }}
            >
              Block camera
            </Button>
          </Stack>
        </Box>
      ))}
    </Box>
  );
}
