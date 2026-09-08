export type HudMatchFormat = 'bo1' | 'bo3' | 'bo5';
export type HudMatchStatus =
  'queued' | 'veto' | 'prepared' | 'live' | 'completed' | 'held' | 'postponed';

export interface HudPlayerProjection {
  id: string;
  steamId: string;
  nickname: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  photoUrl: string | null;
  countryCode: string | null;
  teamId: string;
  webcamEnabled?: boolean;
}

export interface HudWebcamProjection {
  enabled: boolean;
  delaySeconds: number;
  players: string[];
}

export interface HudPlayerStatProjection {
  steamId: string;
  name: string;
  kills: number;
  deaths: number;
  assists: number;
  flashAssists: number;
  enemiesFlashed: number;
  damage: number;
  utilityDamage: number;
  headshotKills: number;
  kast: number;
  mvps: number;
  score: number;
  roundsPlayed: number;
}

export interface HudMapPlayerStatsProjection {
  team1: HudPlayerStatProjection[];
  team2: HudPlayerStatProjection[];
}

export interface HudTeamProjection {
  id: string;
  name: string;
  tag: string;
  countryCode: string | null;
  logoUrl: string | null;
  players: HudPlayerProjection[];
}

export interface HudVetoActionProjection {
  step: number;
  teamId: string | null;
  type: 'ban' | 'pick' | 'side' | 'decider';
  mapName: string;
  side: 'CT' | 'T' | null;
}

export interface HudMapProjection {
  number: number;
  name: string;
  pickedByTeamId: string | null;
  startingSideTeam1: 'CT' | 'T' | null;
  score: { team1: number; team2: number } | null;
  winnerTeamId: string | null;
  completedAt: string | null;
  playerStats: HudMapPlayerStatsProjection | null;
}

export interface HudMatchProjection {
  id: string;
  numericId: number;
  slug: string;
  round: number;
  roundLabel: string;
  bracket: string | null;
  format: HudMatchFormat;
  status: HudMatchStatus;
  operatorState: 'queued' | 'held' | 'postponed' | null;
  currentMap: string | null;
  currentMapNumber: number | null;
  team1: HudTeamProjection;
  team2: HudTeamProjection;
  seriesScore: { team1: number; team2: number };
  veto: {
    status: 'not_started' | 'in_progress' | 'completed';
    actions: HudVetoActionProjection[];
  };
  maps: HudMapProjection[];
  simulation: boolean;
  confirmedWinnerTeamId: string | null;
}

export interface HudProjectionV1 {
  contract: 'bebraland-mat-hud';
  version: 1;
  revision: string;
  generatedAt: string;
  tournament: {
    id: string;
    name: string;
    type: string;
    status: string;
  };
  match: HudMatchProjection;
  webcams: HudWebcamProjection;
}

export interface HudCurrentResponseV1 {
  contract: 'bebraland-mat-hud';
  version: 1;
  revision: string;
  generatedAt: string;
  tournament: HudProjectionV1['tournament'] | null;
  match: HudMatchProjection | null;
  webcams: HudWebcamProjection;
}
