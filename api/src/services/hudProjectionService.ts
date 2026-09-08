import { createHash } from 'crypto';
import { db } from '../config/database';
import { getMapResults } from './matchMapResultService';
import type { PlayerRecord } from './playerService';
import type { VetoState } from '../types/veto.types';
import type { MatchConfig, MatchTeam } from '../types/match.types';
import { normalizeConfigPlayers } from '../utils/playerTransform';
import type {
  HudCurrentResponseV1,
  HudMapProjection,
  HudMatchFormat,
  HudMatchProjection,
  HudMatchStatus,
  HudPlayerProjection,
  HudProjectionV1,
  HudTeamProjection,
  HudVetoActionProjection,
} from '../types/hudProjection.types';
import { webcamService } from './webcamService';

const BROADCAST_MATCH_SETTING = 'jts_hud_broadcast_match_slug';

type MatchRow = {
  id: number;
  slug: string;
  tournament_id?: number | null;
  round: number;
  match_number: number;
  bracket?: string | null;
  team1_id?: string | null;
  team2_id?: string | null;
  winner_id?: string | null;
  status: string;
  operator_state?: string | null;
  veto_opened_at?: number | null;
  veto_state?: string | null;
  config?: string | null;
  current_map?: string | null;
  map_number?: number | null;
  created_at?: number | null;
  loaded_at?: number | null;
  completed_at?: number | null;
};

type TournamentRow = {
  id: number;
  name: string;
  type: string;
  format: string;
  status: string;
  settings?: string | null;
};

type TeamRow = {
  id: string;
  name: string;
  tag?: string | null;
  country_code?: string | null;
  logo_url?: string | null;
  players: string;
};

type RosterPlayer = { steamId: string; name: string; avatar?: string; elo?: number };

type CurrentProjectionOptions = {
  automatic?: boolean;
  steamIds?: string[];
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function absoluteUrl(value: string | null | undefined, publicBaseUrl: string): string | null {
  if (!value) return null;
  try {
    return new URL(value, `${publicBaseUrl.replace(/\/$/, '')}/`).toString();
  } catch {
    return null;
  }
}

function getRoundLabel(match: MatchRow): string {
  const bracket = match.bracket?.toUpperCase();
  if (bracket === 'GF') return 'Grand Final';
  if (bracket === 'GF_RESET') return 'Grand Final Reset';
  if (bracket === 'WB') return `Winners Bracket Round ${match.round}`;
  if (bracket === 'LB') return `Lower Bracket Round ${match.round}`;
  return match.round > 0 ? `Round ${match.round}` : 'Manual Match';
}

function getFormat(
  match: MatchRow,
  tournament: TournamentRow,
  veto: VetoState | null
): HudMatchFormat {
  if (veto?.format) return veto.format;
  const config = parseJson<Partial<MatchConfig>>(match.config, {});
  if (config.num_maps === 5) return 'bo5';
  if (config.num_maps === 3) return 'bo3';
  if (config.num_maps === 1) return 'bo1';
  return tournament.format === 'bo5' || tournament.format === 'bo3' ? tournament.format : 'bo1';
}

function getStatus(match: MatchRow, veto: VetoState | null): HudMatchStatus {
  if (match.operator_state === 'held') return 'held';
  if (match.operator_state === 'postponed') return 'postponed';
  if (match.status === 'completed') return 'completed';
  if (match.status === 'live') return 'live';
  if (match.status === 'loaded') return 'prepared';
  if (veto?.status === 'in_progress' || match.veto_opened_at) return 'veto';
  return 'queued';
}

function teamIdForVetoValue(value: string | undefined, match: MatchRow): string | null {
  if (!value) return null;
  if (value === 'team1' || value === match.team1_id) return match.team1_id || null;
  if (value === 'team2' || value === match.team2_id) return match.team2_id || null;
  return null;
}

class HudProjectionService {
  async getBroadcastMatchSlug(): Promise<string | null> {
    const slug = await db.getAppSettingAsync(BROADCAST_MATCH_SETTING);
    if (!slug) return null;

    const match = await db.queryOneAsync<Pick<MatchRow, 'status' | 'operator_state'>>(
      `SELECT status, operator_state FROM matches
       WHERE slug = ?
         AND status IN ('pending', 'ready', 'loaded', 'live')
         AND COALESCE(operator_state, 'queued') NOT IN ('held', 'postponed')`,
      [slug]
    );
    return match ? slug : null;
  }

  async setBroadcastMatch(slug: string | null): Promise<string | null> {
    if (!slug) {
      await db.setAppSettingAsync(BROADCAST_MATCH_SETTING, null);
      return null;
    }
    const match = await db.queryOneAsync<MatchRow>('SELECT * FROM matches WHERE slug = ?', [slug]);
    if (!match) throw new Error(`Match '${slug}' not found`);
    const config = parseJson<Partial<MatchConfig>>(match.config, {});
    if (!(match.team1_id || config.team1) || !(match.team2_id || config.team2)) {
      throw new Error('Broadcast match must have two assigned teams');
    }
    if (!['pending', 'ready', 'loaded', 'live'].includes(match.status)) {
      throw new Error('Completed or cancelled match cannot be selected for broadcast');
    }
    if (match.operator_state === 'held' || match.operator_state === 'postponed') {
      throw new Error('Held or postponed match cannot be selected for broadcast');
    }
    await db.setAppSettingAsync(BROADCAST_MATCH_SETTING, slug);
    return slug;
  }

  private async resolveAutomaticMatch(steamIds: string[]): Promise<MatchRow | null> {
    if (steamIds.length < 2) return null;

    const candidates = await db.queryAsync<MatchRow>(
      `SELECT * FROM matches
       WHERE status IN ('pending', 'ready', 'loaded', 'live', 'completed')
         AND COALESCE(operator_state, 'queued') NOT IN ('held', 'postponed')
       ORDER BY CASE status
                  WHEN 'live' THEN 0
                  WHEN 'loaded' THEN 1
                  WHEN 'ready' THEN 2
                  WHEN 'pending' THEN 3
                  ELSE 4
                END,
                loaded_at DESC NULLS LAST, id DESC`
    );
    if (candidates.length === 0) return null;

    const teamIds = Array.from(
      new Set(
        candidates.flatMap((match) => {
          const config = parseJson<Partial<MatchConfig>>(match.config, {});
          return [match.team1_id || config.team1?.id, match.team2_id || config.team2?.id].filter(
            (id): id is string => Boolean(id)
          );
        })
      )
    );
    const teams = teamIds.length
      ? await db.queryAsync<TeamRow>(
          `SELECT * FROM teams WHERE id IN (${teamIds.map(() => '?').join(',')})`,
          teamIds
        )
      : [];
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    const observed = new Set(steamIds);

    const ranked = candidates
      .map((match) => {
        const config = parseJson<Partial<MatchConfig>>(match.config, {});
        const roster = [
          { id: match.team1_id || config.team1?.id, fallback: config.team1 },
          { id: match.team2_id || config.team2?.id, fallback: config.team2 },
        ].flatMap(({ id, fallback }) => {
          const team = id ? teamsById.get(id) : undefined;
          return team
            ? parseJson<RosterPlayer[]>(team.players, []).map((player) => player.steamId)
            : normalizeConfigPlayers(fallback?.players).map((player) => player.steamid);
        });
        const overlap = new Set(roster.filter((steamId) => observed.has(steamId))).size;
        return { match, overlap };
      })
      .sort((left, right) => right.overlap - left.overlap || right.match.id - left.match.id);

    // An automatic HUD follows the current game. Completed matches are kept
    // only for demo/replay sessions, so they must not make a live match look
    // ambiguous when both have the same roster.
    const eligible = ranked.some(({ match }) => match.status !== 'completed')
      ? ranked.filter(({ match }) => match.status !== 'completed')
      : ranked;
    const best = eligible[0];
    const second = eligible[1];
    // ponytail: SteamID overlap is deterministic and cheap; ambiguous matches stay empty.
    if (!best || best.overlap < 2 || (second && second.overlap === best.overlap)) return null;
    return best.match;
  }

  private async resolveCurrentMatch(
    options: CurrentProjectionOptions = {}
  ): Promise<MatchRow | null> {
    if (options.automatic) return this.resolveAutomaticMatch(options.steamIds || []);
    const selected = await this.getBroadcastMatchSlug();
    if (selected) {
      const match = await db.queryOneAsync<MatchRow>(
        `SELECT * FROM matches
         WHERE slug = ?
           AND status IN ('pending', 'ready', 'loaded', 'live')
           AND COALESCE(operator_state, 'queued') NOT IN ('held', 'postponed')`,
        [selected]
      );
      if (match) return match;
      return null;
    }

    return (
      (await db.queryOneAsync<MatchRow>(
        `SELECT * FROM matches
       WHERE status IN ('live', 'loaded')
         AND COALESCE(operator_state, 'queued') NOT IN ('held', 'postponed')
       ORDER BY CASE status WHEN 'live' THEN 0 ELSE 1 END, loaded_at DESC NULLS LAST, id DESC
       LIMIT 1`
      )) ?? null
    );
  }

  private async projectTeam(
    teamId: string,
    publicBaseUrl: string,
    playerRecords: Map<string, PlayerRecord>,
    fallbackTeam?: MatchTeam
  ): Promise<HudTeamProjection> {
    const team = await db.queryOneAsync<TeamRow>('SELECT * FROM teams WHERE id = ?', [teamId]);
    if (!team && !fallbackTeam) throw new Error(`Team '${teamId}' not found`);
    const roster = team
      ? parseJson<RosterPlayer[]>(team.players, [])
      : normalizeConfigPlayers(fallbackTeam?.players).map((player) => ({
          steamId: player.steamid,
          name: player.name,
          avatar: player.avatar,
        }));
    const players: HudPlayerProjection[] = roster.map((entry) => {
      const profile = playerRecords.get(entry.steamId);
      return {
        id: entry.steamId,
        steamId: entry.steamId,
        nickname: profile?.name || entry.name,
        firstName: profile?.first_name || null,
        lastName: profile?.last_name || null,
        avatarUrl: absoluteUrl(profile?.avatar_url || entry.avatar, publicBaseUrl),
        photoUrl: absoluteUrl(profile?.photo_url, publicBaseUrl),
        countryCode: profile?.country_code || null,
        teamId,
      };
    });

    return {
      id: team?.id || teamId,
      name: team?.name || fallbackTeam?.name || teamId,
      tag:
        team?.tag ||
        fallbackTeam?.tag ||
        (team?.name || fallbackTeam?.name || teamId).slice(0, 4).toUpperCase(),
      countryCode: team?.country_code || fallbackTeam?.flag || null,
      logoUrl: absoluteUrl(team?.logo_url || fallbackTeam?.logo, publicBaseUrl),
      players,
    };
  }

  private async getPlayerRecords(
    teamIds: string[],
    fallbackTeams: MatchTeam[] = []
  ): Promise<Map<string, PlayerRecord>> {
    const teams =
      teamIds.length > 0
        ? await db.queryAsync<TeamRow>(
            `SELECT * FROM teams WHERE id IN (${teamIds.map(() => '?').join(',')})`,
            teamIds
          )
        : [];
    const steamIds = Array.from(
      new Set([
        ...teams.flatMap((team) =>
          parseJson<RosterPlayer[]>(team.players, []).map((p) => p.steamId)
        ),
        ...fallbackTeams.flatMap((team) =>
          normalizeConfigPlayers(team.players).map((player) => player.steamid)
        ),
      ])
    );
    if (steamIds.length === 0) return new Map();
    const players = await db.queryAsync<PlayerRecord>(
      `SELECT * FROM players WHERE id IN (${steamIds.map(() => '?').join(',')})`,
      steamIds
    );
    return new Map(players.map((player) => [player.id, player]));
  }

  private projectVeto(veto: VetoState | null, match: MatchRow): HudVetoActionProjection[] {
    if (!veto) return [];
    const actions: HudVetoActionProjection[] = veto.actions.map((action) => ({
      step: action.step,
      teamId: teamIdForVetoValue(action.team, match),
      type: action.action === 'side_pick' ? 'side' : action.action === 'pick' ? 'pick' : 'ban',
      mapName: action.mapName || 'unknown',
      side: action.side === 'CT' || action.side === 'T' ? action.side : null,
    }));

    const pickedNames = new Set(
      actions.filter((action) => action.type === 'pick').map((action) => action.mapName)
    );
    for (const picked of veto.pickedMaps) {
      if (!pickedNames.has(picked.mapName)) {
        actions.push({
          step: actions.length + 1,
          teamId: null,
          type: 'decider',
          mapName: picked.mapName,
          side: picked.sideTeam1 || null,
        });
      }
    }
    return actions.sort((a, b) => a.step - b.step);
  }

  private async projectMaps(
    match: MatchRow,
    veto: VetoState | null,
    config: Partial<MatchConfig>
  ): Promise<HudMapProjection[]> {
    const results = await getMapResults(match.slug);
    const resultByNumber = new Map(results.map((result) => [result.mapNumber + 1, result]));
    const pickActions = new Map(
      (veto?.actions || [])
        .filter((action) => action.action === 'pick' && action.mapName)
        .map((action) => [action.mapName as string, action.team])
    );
    const mapNames =
      veto?.pickedMaps?.map((picked) => picked.mapName) ||
      config.maplist ||
      results.map((result) => result.mapName || `map-${result.mapNumber + 1}`);

    return mapNames.map((name, index) => {
      const number = index + 1;
      const picked = veto?.pickedMaps.find((entry) => entry.mapName === name);
      const result = resultByNumber.get(number);
      let winnerTeamId: string | null = null;
      if (result?.winnerTeam === 'team1') winnerTeamId = match.team1_id || null;
      if (result?.winnerTeam === 'team2') winnerTeamId = match.team2_id || null;
      return {
        number,
        name,
        pickedByTeamId: teamIdForVetoValue(pickActions.get(name), match),
        startingSideTeam1: picked?.sideTeam1 || null,
        score: result ? { team1: result.team1Score, team2: result.team2Score } : null,
        winnerTeamId,
        completedAt: result ? new Date(result.completedAt * 1000).toISOString() : null,
        playerStats: result?.playerStats
          ? {
              team1: result.playerStats.team1.map((player) => ({
                steamId: player.steamId,
                name: player.name,
                kills: player.kills,
                deaths: player.deaths,
                assists: player.assists,
                flashAssists: player.flashAssists,
                enemiesFlashed: player.enemiesFlashed,
                damage: player.damage,
                utilityDamage: player.utilityDamage,
                headshotKills: player.headshotKills,
                kast: player.kast,
                mvps: player.mvps,
                score: player.score,
                roundsPlayed: player.roundsPlayed,
              })),
              team2: result.playerStats.team2.map((player) => ({
                steamId: player.steamId,
                name: player.name,
                kills: player.kills,
                deaths: player.deaths,
                assists: player.assists,
                flashAssists: player.flashAssists,
                enemiesFlashed: player.enemiesFlashed,
                damage: player.damage,
                utilityDamage: player.utilityDamage,
                headshotKills: player.headshotKills,
                kast: player.kast,
                mvps: player.mvps,
                score: player.score,
                roundsPlayed: player.roundsPlayed,
              })),
            }
          : null,
      };
    });
  }

  async getProjectionForMatch(
    slug: string,
    publicBaseUrl: string
  ): Promise<HudProjectionV1 | null> {
    const match = await db.queryOneAsync<MatchRow>('SELECT * FROM matches WHERE slug = ?', [slug]);
    if (!match) return null;

    const config = parseJson<Partial<MatchConfig>>(match.config, {});
    const configTeam1 = config.team1;
    const configTeam2 = config.team2;
    const team1Id = match.team1_id || configTeam1?.id || `${slug}:team1`;
    const team2Id = match.team2_id || configTeam2?.id || `${slug}:team2`;
    if ((!configTeam1 && !match.team1_id) || (!configTeam2 && !match.team2_id)) return null;
    const projectionMatch = { ...match, team1_id: team1Id, team2_id: team2Id };

    const tournament = match.tournament_id
      ? await db.queryOneAsync<TournamentRow>('SELECT * FROM tournament WHERE id = ?', [
          match.tournament_id,
        ])
      : {
          id: 0,
          name: 'Manual Matches',
          type: 'manual',
          format: 'bo1',
          status: match.status === 'completed' ? 'completed' : 'in_progress',
          settings: null,
        };
    if (!tournament) return null;

    const veto = parseJson<VetoState | null>(match.veto_state, null);
    const fallbackTeams = [configTeam1, configTeam2].filter((team): team is MatchTeam =>
      Boolean(team)
    );
    const playerRecords = await this.getPlayerRecords([team1Id, team2Id], fallbackTeams);
    const [projectedTeam1, projectedTeam2, maps] = await Promise.all([
      this.projectTeam(team1Id, publicBaseUrl, playerRecords, config.team1),
      this.projectTeam(team2Id, publicBaseUrl, playerRecords, config.team2),
      this.projectMaps(projectionMatch, veto, config),
    ]);
    const webcamSettings = await webcamService.getSettings();
    const rosterIds = [...projectedTeam1.players, ...projectedTeam2.players].map(
      (player) => player.steamId
    );
    const webcamPlayers =
      getStatus(match, veto) === 'live' && webcamSettings.enabled
        ? await webcamService.getEnabledPlayerIds(rosterIds)
        : [];
    for (const player of [...projectedTeam1.players, ...projectedTeam2.players]) {
      player.webcamEnabled = webcamPlayers.includes(player.steamId);
    }
    const seriesScore = maps.reduce(
      (score, map) => {
        if (map.winnerTeamId === projectedTeam1.id) score.team1 += 1;
        if (map.winnerTeamId === projectedTeam2.id) score.team2 += 1;
        return score;
      },
      { team1: 0, team2: 0 }
    );
    const tournamentSettings = parseJson<Record<string, unknown>>(tournament.settings, {});

    const projectedMatch: HudMatchProjection = {
      id: String(match.id),
      numericId: match.id,
      slug: match.slug,
      round: match.round,
      roundLabel: getRoundLabel(match),
      bracket: match.bracket || null,
      format: getFormat(match, tournament, veto),
      status: getStatus(match, veto),
      operatorState:
        match.operator_state === 'held' ||
        match.operator_state === 'postponed' ||
        match.operator_state === 'queued'
          ? match.operator_state
          : null,
      currentMap: match.current_map || null,
      currentMapNumber: typeof match.map_number === 'number' ? match.map_number + 1 : null,
      team1: projectedTeam1,
      team2: projectedTeam2,
      seriesScore,
      veto: {
        status: veto?.status || (match.veto_opened_at ? 'in_progress' : 'not_started'),
        actions: this.projectVeto(veto, projectionMatch),
      },
      maps,
      simulation: Boolean(config.simulation || tournamentSettings.simulation),
      confirmedWinnerTeamId: match.status === 'completed' ? match.winner_id || null : null,
    };

    const core = {
      contract: 'bebraland-mat-hud' as const,
      version: 1 as const,
      tournament: {
        id: String(tournament.id),
        name: tournament.name,
        type: tournament.type,
        status: tournament.status,
      },
      match: projectedMatch,
      webcams: {
        enabled: webcamSettings.enabled,
        delaySeconds: webcamSettings.delaySeconds,
        players: webcamPlayers,
      },
    };
    const revision = createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
    return { ...core, revision, generatedAt: new Date().toISOString() };
  }

  async getCurrentProjection(
    publicBaseUrl: string,
    options: CurrentProjectionOptions = {}
  ): Promise<HudCurrentResponseV1> {
    const match = await this.resolveCurrentMatch(options);
    if (!match) {
      return {
        contract: 'bebraland-mat-hud',
        version: 1,
        revision: 'empty',
        generatedAt: new Date().toISOString(),
        tournament: null,
        match: null,
        webcams: { enabled: false, delaySeconds: 0, players: [] },
      };
    }
    const projection = await this.getProjectionForMatch(match.slug, publicBaseUrl);
    if (!projection) {
      return {
        contract: 'bebraland-mat-hud',
        version: 1,
        revision: 'empty',
        generatedAt: new Date().toISOString(),
        tournament: null,
        match: null,
        webcams: { enabled: false, delaySeconds: 0, players: [] },
      };
    }
    return projection;
  }

  async getTournamentMatches(tournamentId: number): Promise<Array<Record<string, unknown>>> {
    const rows = await db.queryAsync<MatchRow>(
      `SELECT * FROM matches WHERE tournament_id = ? ORDER BY round, match_number, id`,
      [tournamentId]
    );
    return rows.map((match) => ({
      id: String(match.id),
      slug: match.slug,
      round: match.round,
      roundLabel: getRoundLabel(match),
      bracket: match.bracket || null,
      team1Id: match.team1_id || null,
      team2Id: match.team2_id || null,
      status: getStatus(match, parseJson<VetoState | null>(match.veto_state, null)),
      operatorState: match.operator_state || null,
    }));
  }
}

export const hudProjectionService = new HudProjectionService();
