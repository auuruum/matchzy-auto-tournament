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
import { getVerifiedPlayerSteamId } from '../utils/signedPlayerCookie';
import { webcamService, type WebcamSettings } from './webcamService';

let io: SocketIOServer | null = null;
let hudNamespace: ReturnType<SocketIOServer['of']> | null = null;
let webcamNamespace: ReturnType<SocketIOServer['of']> | null = null;
const webcamHuds = new Map<string, Socket>();

function emitCameraHudList(): void {
  const ids = Array.from(webcamHuds.keys());
  webcamNamespace?.emit('webcam:hud-list', ids);
}

function emitCameraStatus(): void {
  void webcamService.getSettings().then(() => {
    hudNamespace?.emit('playersCameraStatus', []);
    emitCameraHudList();
  });
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
    socket.on('registerAsHUD', (uuid: unknown) => {
      if (typeof uuid !== 'string' || !uuid.trim()) return;
      socket.data.webcamUuid = uuid.trim();
      webcamHuds.set(socket.data.webcamUuid, socket);
      emitCameraStatus();
      socket.once('disconnect', () => {
        if (webcamHuds.get(socket.data.webcamUuid) === socket) webcamHuds.delete(socket.data.webcamUuid);
        emitCameraHudList();
      });
    });
    socket.on('offerFromHUD', (uuid: unknown, signal: unknown, steamid: unknown) => {
      if (socket.data.webcamUuid !== uuid || typeof steamid !== 'string') return;
      webcamNamespace?.to(`player:${steamid}`).emit('offerFromHUD', uuid, signal, steamid);
    });
  });

  webcamNamespace = io.of('/webcam');
  webcamNamespace.use(async (socket, next) => {
    const steamId = getVerifiedPlayerSteamId(socket.handshake.headers.cookie);
    if (!steamId || !(await webcamService.getPlayerState(steamId)).exists) {
      next(new Error('Registered MAT player login required'));
      return;
    }
    socket.data.steamId = steamId;
    next();
  });
  webcamNamespace.on('connection', (socket) => {
    const steamId = socket.data.steamId as string;
    socket.join(`player:${steamId}`);
    socket.emit('webcam:hud-list', Array.from(webcamHuds.keys()));
    socket.on('webcam:announce', async () => {
      const settings = await webcamService.getSettings();
      const state = await webcamService.getPlayerState(steamId);
      if (settings.enabled && state.enabled && !state.blocked) {
        socket.emit('webcam:hud-list', Array.from(webcamHuds.keys()));
      }
    });
    socket.on('offerFromPlayer', async (uuid: unknown, signal: unknown, playerSteamId: unknown) => {
      if ((playerSteamId !== undefined && playerSteamId !== steamId) || typeof uuid !== 'string') return;
      const [settings, state] = await Promise.all([
        webcamService.getSettings(),
        webcamService.getPlayerState(steamId),
      ]);
      if (!settings.enabled || !state.enabled || state.blocked) return;
      webcamHuds.get(uuid)?.emit('offerFromPlayer', uuid, signal, steamId);
    });
    socket.on('disconnect', () => socket.removeAllListeners());
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

export function emitWebcamSettingsChanged(settings: WebcamSettings): void {
  if (!settings.enabled) webcamNamespace?.emit('webcam:revoked', { reason: 'globally-disabled' });
  emitCameraStatus();
  hudNamespace?.emit('webcam:settings', settings);
  emitHudProjectionInvalidated('webcam-settings-changed');
}

export function emitWebcamPlayerRevoked(steamId: string): void {
  webcamNamespace?.to(`player:${steamId}`).emit('webcam:revoked', { steamId });
  hudNamespace?.emit('webcam:revoked', { steamId });
  emitCameraStatus();
}

export function disconnectHudIntegrationClients(): void {
  hudNamespace?.disconnectSockets(true);
}
