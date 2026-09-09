import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { resolveViewerIdentity } from '../utils/viewerIdentity';
import {
  getPlayerCameraPolicy,
  setPlayerCameraBlocked,
  updatePlayerCameraPolicy,
  type PlayerCameraTransport,
} from '../services/playerCameraService';
import {
  getPlayerCameraRuntimeStatus,
  refreshPlayerCameraPolicy,
} from '../services/socketService';
import { log } from '../utils/logger';

const router = Router();

router.get('/config', async (_req: Request, res: Response) => {
  const policy = await getPlayerCameraPolicy();
  res.json({
    enabled: policy.enabled,
    transport: policy.transport,
    iceServers: policy.iceServers,
    secureContextRequired: true,
  });
});

router.get('/me', async (req: Request, res: Response) => {
  const [identity, policy] = await Promise.all([
    resolveViewerIdentity(req),
    getPlayerCameraPolicy(),
  ]);
  if (!identity.effectiveSteamId) {
    res.status(401).json({ success: false, error: 'Steam sign-in required' });
    return;
  }
  res.json({
    success: true,
    steamId: identity.effectiveSteamId,
    impersonating: identity.isImpersonating,
    blocked: policy.blockedSteamIds.includes(identity.effectiveSteamId),
  });
});

router.get('/admin', requireAuth, async (_req: Request, res: Response) => {
  res.json(await getPlayerCameraRuntimeStatus());
});

router.put('/admin', requireAuth, async (req: Request, res: Response) => {
  const body = (req.body || {}) as { enabled?: unknown; transport?: unknown };
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  if (body.transport !== undefined && body.transport !== 'p2p' && body.transport !== 'relay') {
    res.status(400).json({ error: 'transport must be p2p or relay' });
    return;
  }
  const policy = await updatePlayerCameraPolicy({
    enabled: body.enabled as boolean | undefined,
    transport: body.transport as PlayerCameraTransport | undefined,
  });
  await refreshPlayerCameraPolicy('Camera policy changed by administrator', true);
  log.info('Player camera policy updated', {
    enabled: policy.enabled,
    transport: policy.transport,
  });
  res.json(await getPlayerCameraRuntimeStatus());
});

router.put('/admin/players/:steamId/block', requireAuth, async (req: Request, res: Response) => {
  const steamId = req.params.steamId.trim();
  const blocked = (req.body as { blocked?: unknown } | undefined)?.blocked;
  if (!/^\d{17}$/.test(steamId) || typeof blocked !== 'boolean') {
    res.status(400).json({ error: 'A 17-digit Steam ID and boolean blocked value are required' });
    return;
  }
  await setPlayerCameraBlocked(steamId, blocked);
  await refreshPlayerCameraPolicy(
    blocked ? 'Camera disabled by administrator' : 'Camera unblocked by administrator'
  );
  log.warn(`Player camera ${blocked ? 'blocked' : 'unblocked'} by administrator`, { steamId });
  res.json(await getPlayerCameraRuntimeStatus());
});

export default router;
