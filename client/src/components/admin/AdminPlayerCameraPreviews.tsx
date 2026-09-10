/* global HTMLVideoElement, MediaSource, SourceBuffer, RTCIceServer, RTCSessionDescriptionInit, RTCIceCandidateInit, RTCPeerConnection */
import React from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import { io, type Socket } from 'socket.io-client';

type Transport = 'p2p' | 'relay';
type Props = { steamIds: string[]; transport: Transport; iceServers: RTCIceServer[] };
type Offer = { adminId: string; steamId: string; description: RTCSessionDescriptionInit };
type Candidate = { steamId: string; candidate: RTCIceCandidateInit };
type RelayChunk = { steamId: string; chunk: unknown; mimeType?: string };
type RelayState = { source: MediaSource; buffer: SourceBuffer | null; queue: ArrayBuffer[]; mimeType: string };

function asBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (value && typeof value === 'object' && 'data' in value) return asBuffer((value as { data?: unknown }).data);
  return null;
}

export function AdminPlayerCameraPreviews({ steamIds, transport, iceServers }: Props) {
  const socketRef = React.useRef<Socket | null>(null);
  const idsRef = React.useRef(steamIds);
  const videosRef = React.useRef(new Map<string, HTMLVideoElement | null>());
  const peersRef = React.useRef(new Map<string, RTCPeerConnection>());
  const relaysRef = React.useRef(new Map<string, RelayState>());
  const [states, setStates] = React.useState<Record<string, string>>({});
  const [connected, setConnected] = React.useState(false);
  const idsKey = steamIds.join(',');
  const iceServersKey = JSON.stringify(iceServers);

  React.useEffect(() => { idsRef.current = steamIds; }, [idsKey, steamIds]);

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
      setState(steamId, 'connecting');
      peer.ontrack = (event) => {
        const video = videosRef.current.get(steamId);
        const stream = event.streams[0];
        if (!video || !stream) return;
        video.srcObject = stream;
        setState(steamId, 'live');
        void video.play().catch(() => undefined);
      };
      peer.onicecandidate = (event) => {
        if (event.candidate && socket.id) {
          socket.emit('camera:admin-ice-from-admin', { adminId: socket.id, steamId, candidate: event.candidate });
        }
      };
      peer.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) setState(steamId, 'offline');
      };
      try {
        await peer.setRemoteDescription(description);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket.emit('camera:admin-answer', { adminId, steamId, description: peer.localDescription });
      } catch {
        setState(steamId, 'offline');
      }
    });
    socket.on('camera:admin-ice-from-player', async ({ steamId, candidate }: Candidate) => {
      await peersRef.current.get(steamId)?.addIceCandidate(candidate).catch(() => undefined);
    });
    socket.on('camera:admin-stopped', ({ steamId }: { steamId: string }) => {
      peersRef.current.get(steamId)?.close();
      setState(steamId, 'offline');
      const video = videosRef.current.get(steamId);
      if (video) video.srcObject = null;
    });
    socket.on('camera:admin-relay-chunk', ({ steamId, chunk, mimeType }: RelayChunk) => {
      const bytes = asBuffer(chunk);
      if (!bytes || !mimeType) return;
      let relay = relaysRef.current.get(steamId);
      if (!relay) {
        const source = new MediaSource();
        relay = { source, buffer: null, queue: [bytes], mimeType };
        relaysRef.current.set(steamId, relay);
        const video = videosRef.current.get(steamId);
        if (video) {
          video.srcObject = null;
          video.src = URL.createObjectURL(source);
          void video.play().catch(() => undefined);
        }
        source.addEventListener('sourceopen', () => {
          try {
            relay!.buffer = source.addSourceBuffer(mimeType);
            relay!.buffer.addEventListener('updateend', () => {
              if (relay!.buffer && !relay!.buffer.updating && relay!.queue.length) {
                relay!.buffer.appendBuffer(relay!.queue.shift()!);
                setState(steamId, 'live');
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
      setState(steamId, 'live');
    });
    const peers = peersRef.current;
    const relays = relaysRef.current;
    const videos = videosRef.current;
    return () => {
      socket.emit('camera:admin-watch', { steamId: null });
      socket.disconnect();
      socketRef.current = null;
      peers.forEach((peer) => peer.close());
      peers.clear();
      relays.forEach((relay) => relay.source.readyState === 'open' && relay.source.endOfStream());
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
    steamIds.forEach((steamId) => socket.emit('camera:admin-watch', { steamId }));
  }, [idsKey, steamIds]);

  if (!steamIds.length) return <Typography variant="body2" color="text.secondary">None</Typography>;
  return (
    <Box display="grid" gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))" gap={1.5}>
      {steamIds.map((steamId) => (
        <Box key={steamId} sx={{ position: 'relative', bgcolor: '#111', borderRadius: 1, overflow: 'hidden', minHeight: 150 }}>
          <Box
            component="video"
            ref={(element: HTMLVideoElement | null) => videosRef.current.set(steamId, element)}
            autoPlay muted playsInline
            sx={{ display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', bgcolor: '#050505' }}
          />
          <Stack direction="row" spacing={1} alignItems="center" sx={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
            <Chip size="small" label={steamId} sx={{ bgcolor: 'rgba(0,0,0,.7)', color: '#fff' }} />
            <Chip size="small" color={states[steamId] === 'live' ? 'success' : 'default'} label={states[steamId] || (connected ? 'waiting' : 'connecting')} />
          </Stack>
        </Box>
      ))}
    </Box>
  );
}
