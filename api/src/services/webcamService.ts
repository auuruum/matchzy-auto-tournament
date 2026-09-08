import { db } from '../config/database';
import { settingsService } from './settingsService';

export type WebcamSettings = {
  enabled: boolean;
  delaySeconds: number;
};

const DEFAULT_DELAY_SECONDS = 0;
const MAX_DELAY_SECONDS = 600;

const asBoolean = (value: string | null): boolean =>
  value === '1' || ['true', 'yes', 'on', 'enabled'].includes(value?.trim().toLowerCase() || '');

export const webcamService = {
  async getSettings(): Promise<WebcamSettings> {
    const [enabled, delay] = await Promise.all([
      settingsService.getSetting('webcams_enabled'),
      settingsService.getSetting('webcam_delay_seconds'),
    ]);
    const parsedDelay = Number(delay);
    return {
      enabled: asBoolean(enabled),
      delaySeconds: Number.isFinite(parsedDelay)
        ? Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(parsedDelay)))
        : DEFAULT_DELAY_SECONDS,
    };
  },

  async setSettings(input: Partial<WebcamSettings>): Promise<WebcamSettings> {
    if (input.enabled !== undefined) {
      await settingsService.setSetting('webcams_enabled', input.enabled ? '1' : '0');
    }
    if (input.delaySeconds !== undefined) {
      if (!Number.isInteger(input.delaySeconds) || input.delaySeconds < 0 || input.delaySeconds > MAX_DELAY_SECONDS) {
        throw new Error(`Webcam delay must be an integer from 0 to ${MAX_DELAY_SECONDS} seconds`);
      }
      await settingsService.setSetting('webcam_delay_seconds', String(input.delaySeconds));
    }
    return this.getSettings();
  },

  async getPlayerState(steamId: string): Promise<{ exists: boolean; enabled: boolean; blocked: boolean }> {
    const player = await db.queryOneAsync<{ id: string; webcam_enabled?: number; webcam_blocked?: number }>(
      'SELECT id, webcam_enabled, webcam_blocked FROM players WHERE id = ?',
      [steamId]
    );
    return {
      exists: Boolean(player),
      enabled: player?.webcam_enabled === 1,
      blocked: player?.webcam_blocked === 1,
    };
  },

  async setPlayerEnabled(steamId: string, enabled: boolean): Promise<void> {
    await db.queryAsync('UPDATE players SET webcam_enabled = ?, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ?', [enabled ? 1 : 0, steamId]);
  },

  async setPlayerBlocked(steamId: string, blocked: boolean): Promise<void> {
    await db.queryAsync(
      'UPDATE players SET webcam_blocked = ?, webcam_enabled = CASE WHEN ? = 1 THEN 0 ELSE webcam_enabled END, updated_at = EXTRACT(EPOCH FROM NOW())::INTEGER WHERE id = ?',
      [blocked ? 1 : 0, blocked ? 1 : 0, steamId]
    );
  },

  async getEnabledPlayerIds(steamIds: string[]): Promise<string[]> {
    if (steamIds.length === 0) return [];
    const rows = await db.queryAsync<{ id: string }>(
      `SELECT id FROM players WHERE id IN (${steamIds.map(() => '?').join(',')}) AND webcam_enabled = 1 AND webcam_blocked = 0`,
      steamIds
    );
    return rows.map((row) => row.id);
  },
};
