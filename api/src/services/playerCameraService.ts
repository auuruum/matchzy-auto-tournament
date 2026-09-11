import { db } from '../config/database';

export type PlayerCameraTransport = 'p2p' | 'relay';
export type PlayerCameraIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export interface PlayerCameraPolicy {
  enabled: boolean;
  transport: PlayerCameraTransport;
  prewarmEnabled: boolean;
  blockedSteamIds: string[];
  iceServers: PlayerCameraIceServer[];
}

const ENABLED_KEY = 'player_cameras_enabled';
const TRANSPORT_KEY = 'player_cameras_transport';
const BLOCKED_KEY = 'player_cameras_blocked';
const PREWARM_KEY = 'player_cameras_prewarm';

function parseBlocked(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function iceServers(): PlayerCameraIceServer[] {
  const configured = process.env.PLAYER_CAMERA_ICE_SERVERS;
  if (configured) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed)) return parsed as PlayerCameraIceServer[];
    } catch {
      // Invalid optional config falls back to public STUN.
    }
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

export async function getPlayerCameraPolicy(): Promise<PlayerCameraPolicy> {
  const [enabled, transport, prewarm, blocked] = await Promise.all([
    db.getAppSettingAsync(ENABLED_KEY),
    db.getAppSettingAsync(TRANSPORT_KEY),
    db.getAppSettingAsync(PREWARM_KEY),
    db.getAppSettingAsync(BLOCKED_KEY),
  ]);
  return {
    enabled: enabled === '1',
    transport: transport === 'relay' ? 'relay' : 'p2p',
    prewarmEnabled: prewarm !== '0',
    blockedSteamIds: parseBlocked(blocked),
    iceServers: iceServers(),
  };
}

export async function updatePlayerCameraPolicy(input: {
  enabled?: boolean;
  transport?: PlayerCameraTransport;
  prewarmEnabled?: boolean;
}): Promise<PlayerCameraPolicy> {
  if (input.enabled !== undefined) {
    await db.setAppSettingAsync(ENABLED_KEY, input.enabled ? '1' : '0');
  }
  if (input.prewarmEnabled !== undefined) {
    await db.setAppSettingAsync(PREWARM_KEY, input.prewarmEnabled ? '1' : '0');
  }
  if (input.transport !== undefined) {
    if (input.transport !== 'p2p' && input.transport !== 'relay') {
      throw new Error('Camera transport must be p2p or relay');
    }
    await db.setAppSettingAsync(TRANSPORT_KEY, input.transport);
  }
  return getPlayerCameraPolicy();
}

export async function setPlayerCameraBlocked(
  steamId: string,
  blocked: boolean
): Promise<PlayerCameraPolicy> {
  const policy = await getPlayerCameraPolicy();
  const ids = new Set(policy.blockedSteamIds);
  if (blocked) ids.add(steamId);
  else ids.delete(steamId);
  await db.setAppSettingAsync(BLOCKED_KEY, JSON.stringify([...ids].sort()));
  return getPlayerCameraPolicy();
}
