import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import { log } from '../utils/logger';
import type {
  TournamentUpdateEvent,
  BracketUpdateEvent,
  MatchUpdateEvent,
  MatchEventData,
  ServerEvent,
  VetoUpdateEvent,
} from '../types/socket.types';
import { hudTokenService } from './hudTokenService';
import { resolveViewerIdentity } from '../utils/viewerIdentity';
import { getPlayerCameraPolicy } from './playerCameraService';

let io: SocketIOServer | null = null;
let hudNamespace: ReturnType<SocketIOServer['of']> | null = null;
const cameraPublishers = new Map<string, Socket>();
const cameraHudWatchers = new Map<string, Map<string, string>>();
const cameraRelayInitChunks = new Map<
  string,
  { chunk: Buffer | ArrayBuffer; mimeType?: string; sequence?: number }
>();

async function cameraState() {
  const policy = await getPlayerCameraPolicy();
  return {
    enabled: policy.enabled,
    transport: policy.transport,
    iceServers: policy.iceServers,
    availablePlayers: policy.enabled
      ? [...cameraPublishers.keys()].filter((id) => !policy.blockedSteamIds.includes(id))
      : [],
  };
}

async function emitCameraState(): Promise<void> {
  const state = await cameraState();
  hudNamespace?.emit('camera:state', state);
  io?.emit('camera:policy', state);
}

function requestCameraPeer(hudId: string, viewerId: string, steamId: string): void {
  cameraPublishers.get(steamId)?.emit('camera:create-peer', { hudId, viewerId });
}

function registerPlayerCameraSocket(socket: Socket): void {
  const identityPromise = resolveViewerIdentity(
    socket.request as unknown as Parameters<typeof resolveViewerIdentity>[0]
  ).catch(() => null);

  socket.on('camera:publish', async (_input, acknowledge?: (value: unknown) => void) => {
    const steamId = (await identityPromise)?.effectiveSteamId || null;
    const policy = await getPlayerCameraPolicy();
    if (!steamId) {
      acknowledge?.({ ok: false, error: 'Steam sign-in required' });
      return;
    }
    if (!policy.enabled || policy.blockedSteamIds.includes(steamId)) {
      acknowledge?.({ ok: false, error: policy.enabled ? 'Camera blocked by administrator' : 'Player cameras are disabled' });
      return;
    }

    const previous = cameraPublishers.get(steamId);
    if (previous && previous.id !== socket.id) previous.emit('camera:forced-stop', { reason: 'Camera opened in another tab' });
    cameraPublishers.set(steamId, socket);
    socket.data.playerCameraSteamId = steamId;
    acknowledge?.({ ok: true, steamId, transport: policy.transport, iceServers: policy.iceServers });
    await emitCameraState();

    if (policy.transport === 'p2p') {
      for (const [hudId, viewers] of cameraHudWatchers) {
        for (const [viewerId, watchedSteamId] of viewers) {
          if (watchedSteamId === steamId) requestCameraPeer(hudId, viewerId, steamId);
        }
      }
    }
  });

  socket.on('camera:offer', async (payload: { hudId?: string; viewerId?: string; description?: unknown }) => {
    const steamId = (await identityPromise)?.effectiveSteamId || null;
    if (!steamId || cameraPublishers.get(steamId)?.id !== socket.id) return;
    const { hudId, viewerId, description } = payload || {};
    if (!hudId || !viewerId || !description || cameraHudWatchers.get(hudId)?.get(viewerId) !== steamId) return;
    hudNamespace?.to(hudId).emit('camera:offer', { viewerId, steamId, description });
  });

  socket.on('camera:ice-from-player', async (payload: { hudId?: string; viewerId?: string; candidate?: unknown }) => {
    const steamId = (await identityPromise)?.effectiveSteamId || null;
    if (!steamId || cameraPublishers.get(steamId)?.id !== socket.id) return;
    const { hudId, viewerId, candidate } = payload || {};
    if (!hudId || !viewerId || !candidate || cameraHudWatchers.get(hudId)?.get(viewerId) !== steamId) return;
    hudNamespace?.to(hudId).emit('camera:ice-from-player', { viewerId, steamId, candidate });
  });

  socket.on('camera:relay-chunk', async (payload: { chunk?: Buffer | ArrayBuffer; mimeType?: string; sequence?: number }) => {
    const steamId = (await identityPromise)?.effectiveSteamId || null;
    if (!steamId || cameraPublishers.get(steamId)?.id !== socket.id) return;
    const policy = await getPlayerCameraPolicy();
    if (!policy.enabled || policy.transport !== 'relay' || policy.blockedSteamIds.includes(steamId)) return;
    const chunk = payload?.chunk;
    const size = Buffer.isBuffer(chunk) ? chunk.length : chunk instanceof ArrayBuffer ? chunk.byteLength : 0;
    if (!chunk || size === 0 || size > 2_000_000) return;
    if (payload.sequence === 0) {
      cameraRelayInitChunks.set(steamId, {
        chunk,
        mimeType: payload.mimeType,
        sequence: payload.sequence,
      });
    }
    for (const [hudId, viewers] of cameraHudWatchers) {
      for (const [viewerId, watchedSteamId] of viewers) {
        if (watchedSteamId === steamId) {
          hudNamespace?.to(hudId).emit('camera:relay-chunk', {
            viewerId,
            steamId,
            chunk,
            mimeType: payload.mimeType,
            sequence: payload.sequence,
          });
        }
      }
    }
  });

  const stopPublishing = async () => {
    const steamId = (await identityPromise)?.effectiveSteamId || null;
    if (steamId && cameraPublishers.get(steamId)?.id === socket.id) {
      cameraPublishers.delete(steamId);
      cameraRelayInitChunks.delete(steamId);
      hudNamespace?.emit('camera:player-stopped', { steamId });
      await emitCameraState();
    }
  };
  socket.on('camera:stop', stopPublishing);
  socket.on('disconnect', stopPublishing);
}

function registerHudCameraSocket(socket: Socket): void {
  cameraHudWatchers.set(socket.id, new Map());
  void cameraState().then((state) => socket.emit('camera:state', state));

  socket.on('camera:hud-watch', async (payload: { viewerId?: string; steamId?: string | null }) => {
    const viewerId = payload?.viewerId?.trim();
    if (!viewerId) return;
    const watchers = cameraHudWatchers.get(socket.id);
    if (!watchers) return;
    const steamId = payload?.steamId?.trim();
    if (!steamId) {
      watchers.delete(viewerId);
      return;
    }
    watchers.set(viewerId, steamId);
    const policy = await getPlayerCameraPolicy();
    if (policy.enabled && policy.transport === 'p2p' && !policy.blockedSteamIds.includes(steamId)) {
      requestCameraPeer(socket.id, viewerId, steamId);
    } else if (policy.enabled && policy.transport === 'relay' && !policy.blockedSteamIds.includes(steamId)) {
      const initialChunk = cameraRelayInitChunks.get(steamId);
      if (initialChunk) socket.emit('camera:relay-chunk', { viewerId, steamId, ...initialChunk });
    }
  });

  socket.on('camera:answer', (payload: { viewerId?: string; steamId?: string; description?: unknown }) => {
    const { viewerId, steamId, description } = payload || {};
    if (!viewerId || !steamId || !description || cameraHudWatchers.get(socket.id)?.get(viewerId) !== steamId) return;
    cameraPublishers.get(steamId)?.emit('camera:answer', { hudId: socket.id, viewerId, description });
  });

  socket.on('camera:ice-from-hud', (payload: { viewerId?: string; steamId?: string; candidate?: unknown }) => {
    const { viewerId, steamId, candidate } = payload || {};
    if (!viewerId || !steamId || !candidate || cameraHudWatchers.get(socket.id)?.get(viewerId) !== steamId) return;
    cameraPublishers.get(steamId)?.emit('camera:ice-from-hud', { hudId: socket.id, viewerId, candidate });
  });

  socket.on('disconnect', () => cameraHudWatchers.delete(socket.id));
}

export async function getPlayerCameraRuntimeStatus() {
  const policy = await getPlayerCameraPolicy();
  return {
    ...policy,
    publishers: [...cameraPublishers.keys()],
    huds: cameraHudWatchers.size,
  };
}

export async function refreshPlayerCameraPolicy(
  reason = 'Policy changed',
  restartAll = false
): Promise<void> {
  const policy = await getPlayerCameraPolicy();
  io?.emit('camera:policy', await cameraState());
  for (const [steamId, socket] of cameraPublishers) {
    if (restartAll || !policy.enabled || policy.blockedSteamIds.includes(steamId)) {
      socket.emit('camera:forced-stop', { reason });
      cameraPublishers.delete(steamId);
      cameraRelayInitChunks.delete(steamId);
      hudNamespace?.emit('camera:player-stopped', { steamId });
    }
  }
  await emitCameraState();
}

export function initializeSocket(httpServer: HTTPServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    log.debug(`Socket client connected: ${socket.id}`);
    registerPlayerCameraSocket(socket);

    socket.on('disconnect', () => {
      log.debug(`Socket client disconnected: ${socket.id}`);
    });
  });

  hudNamespace = io.of('/jts-hud');
  hudNamespace.use(async (socket, next) => {
    const authToken =
      typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    const authorization = socket.handshake.headers.authorization;
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (await hudTokenService.verifyToken(authToken || bearerToken)) {
      next();
      return;
    }
    next(new Error('Invalid MAT HUD token'));
  });
  hudNamespace.on('connection', (socket) => {
    log.debug(`Authenticated JTs-Hud client connected: ${socket.id}`);
    registerHudCameraSocket(socket);
  });

  log.success('Socket.io initialized');
  return io;
}

export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initializeSocket first.');
  }
  return io;
}

/**
 * Emit tournament update
 */
export function emitTournamentUpdate(tournament: TournamentUpdateEvent): void {
  if (io) {
    io.emit('tournament:update', tournament);
    log.debug('Emitted tournament update', { tournamentId: tournament.id });
  }
}

/**
 * Emit bracket update
 */
export function emitBracketUpdate(bracket: BracketUpdateEvent): void {
  if (io) {
    io.emit('bracket:update', bracket);
    log.debug('Emitted bracket update');
  }
}

/**
 * Emit match update
 */
export function emitMatchUpdate(match: MatchUpdateEvent): void {
  if (io) {
    io.emit('match:update', match);

    const slug = (match as { slug?: string }).slug;
    if (slug) {
      io.emit(`match:update:${slug}`, match);
    }

    log.debug('Emitted match update', { matchId: match.id, slug });
    emitHudProjectionInvalidated('match-updated');
  }
}

/**
 * Emit match event (live stats)
 */
export function emitMatchEvent(matchSlug: string, event: MatchEventData['event']): void {
  if (io) {
    io.emit('match:event', { matchSlug, event });
    io.emit(`match:event:${matchSlug}`, event);
    log.debug('Emitted match event', { matchSlug, eventType: event.event });
  }
}

/**
 * Emit server status update
 */
export function emitServerStatus(serverId: string, status: 'online' | 'offline'): void {
  if (io) {
    io.emit('server:status', { serverId, status });
    log.debug('Emitted server status', { serverId, status });
  }
}

/**
 * Emit server event for debugging/monitoring
 */
export function emitServerEvent(serverId: string, event: Omit<ServerEvent, 'serverId'>): void {
  if (io) {
    io.emit('server:event', { serverId, ...event });
    io.emit(`server:event:${serverId}`, event);
    log.debug('Emitted server event for monitoring', { serverId });
  }
}

/**
 * Emit veto update
 */
export function emitVetoUpdate(matchSlug: string, vetoState: VetoUpdateEvent['veto']): void {
  if (io) {
    io.emit('veto:update', { matchSlug, veto: vetoState });
    io.emit(`veto:update:${matchSlug}`, vetoState);
    log.debug('Emitted veto update', { matchSlug });
    emitHudProjectionInvalidated('veto-updated');
  }
}

export function emitHudProjectionInvalidated(reason: string): void {
  if (hudNamespace) {
    hudNamespace.emit('hud:projection-invalidated', {
      reason,
      at: new Date().toISOString(),
    });
  }
}

export function disconnectHudIntegrationClients(): void {
  hudNamespace?.disconnectSockets(true);
}
