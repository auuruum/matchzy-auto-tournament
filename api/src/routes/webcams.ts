import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { getEffectiveViewerSteamId } from '../utils/viewerIdentity';
import { hudProjectionService } from '../services/hudProjectionService';
import { webcamService } from '../services/webcamService';
import {
  emitHudProjectionInvalidated,
  emitWebcamPlayerRevoked,
  emitWebcamSettingsChanged,
} from '../services/socketService';

const router = Router();

function publicBaseUrl(req: Request): string {
  const configured = process.env.PUBLIC_BASE_URL || process.env.FRONTEND_BASE_URL;
  return (configured || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

async function livePlayerIds(req: Request): Promise<Set<string>> {
  const projection = await hudProjectionService.getCurrentProjection(publicBaseUrl(req));
  if (projection.match?.status !== 'live') return new Set();
  return new Set([
    ...projection.match.team1.players.map((player) => player.steamId),
    ...projection.match.team2.players.map((player) => player.steamId),
  ]);
}

router.get('/settings', requireAuth, async (_req, res) => {
  return res.json({ success: true, settings: await webcamService.getSettings() });
});

router.put('/settings', requireAuth, async (req, res) => {
  try {
    const settings = await webcamService.setSettings({
      enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
      delaySeconds: req.body?.delaySeconds === undefined ? undefined : Number(req.body.delaySeconds),
    });
    emitWebcamSettingsChanged(settings);
    return res.json({ success: true, settings });
  } catch (error) {
    return res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Invalid webcam settings' });
  }
});

router.put('/players/:playerId/block', requireAuth, async (req, res) => {
  const playerId = req.params.playerId;
  const state = await webcamService.getPlayerState(playerId);
  if (!state.exists) return res.status(404).json({ success: false, error: 'Player not found' });
  await webcamService.setPlayerBlocked(playerId, req.body?.blocked === true);
  if (req.body?.blocked === true) emitWebcamPlayerRevoked(playerId);
  emitHudProjectionInvalidated('webcam-player-block-changed');
  return res.json({ success: true, player: await webcamService.getPlayerState(playerId) });
});

router.get('/me', async (req, res) => {
  const steamId = await getEffectiveViewerSteamId(req);
  if (!steamId) return res.status(401).json({ success: false, error: 'Steam login required' });
  const [settings, player, liveIds] = await Promise.all([
    webcamService.getSettings(),
    webcamService.getPlayerState(steamId),
    livePlayerIds(req),
  ]);
  return res.json({
    success: true,
    settings,
    player: {
      ...player,
      eligible: settings.enabled && player.exists && !player.blocked,
      live: liveIds.has(steamId),
    },
  });
});

router.put('/me', async (req, res) => {
  const steamId = await getEffectiveViewerSteamId(req);
  if (!steamId) return res.status(401).json({ success: false, error: 'Steam login required' });
  const enabled = req.body?.enabled === true;
  const [settings, state] = await Promise.all([
    webcamService.getSettings(),
    webcamService.getPlayerState(steamId),
  ]);
  if (!state.exists) return res.status(403).json({ success: false, error: 'Player is not registered in MAT' });
  if (enabled && (!settings.enabled || state.blocked)) {
    return res.status(409).json({ success: false, error: 'Webcam is unavailable for this player right now' });
  }
  await webcamService.setPlayerEnabled(steamId, enabled);
  if (!enabled) emitWebcamPlayerRevoked(steamId);
  emitWebcamSettingsChanged(await webcamService.getSettings());
  return res.json({ success: true, player: await webcamService.getPlayerState(steamId) });
});

export default router;
