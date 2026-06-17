/**
 * Static MLB team reference: MLB StatsAPI (MLBAM) team ids + canonical
 * naming + seed park factors. The 30 teams are fixed, so this is the
 * authoritative bridge for joining API-Sports games to MLB StatsAPI
 * (probable pitchers, weather) and Statcast/FanGraphs stats.
 *
 * `apiSportsTeamId` is intentionally null here — API-Sports baseball team
 * ids are reconciled at sync time by matching canonical/alias names
 * (see BaseballTeamMapService.reconcileApiSportsIds), which keeps this
 * file free of a second provider's churn-prone ids.
 *
 * Park factors are multiplicative (1.0 = neutral), seeded from public
 * multi-year Statcast values and refreshed weekly by StatcastService.
 */
export interface MlbTeamSeed {
  mlbamTeamId: number;
  abbrev: string;
  canonicalName: string; // short name used for fuzzy matching, e.g. "Yankees"
  fullName: string;
  aliases: string[]; // extra strings API-Sports / Polymarket may use
  venueName: string;
  parkRunFactor: number;
  parkHrFactorL: number;
  parkHrFactorR: number;
  parkOrientationDeg: number; // home plate → center field bearing
}

export const MLB_TEAMS: MlbTeamSeed[] = [
  { mlbamTeamId: 108, abbrev: 'LAA', canonicalName: 'Angels', fullName: 'Los Angeles Angels', aliases: ['LA Angels', 'Anaheim'], venueName: 'Angel Stadium', parkRunFactor: 1.0, parkHrFactorL: 1.0, parkHrFactorR: 1.01, parkOrientationDeg: 45 },
  { mlbamTeamId: 109, abbrev: 'ARI', canonicalName: 'Diamondbacks', fullName: 'Arizona Diamondbacks', aliases: ['D-backs', 'Dbacks'], venueName: 'Chase Field', parkRunFactor: 1.01, parkHrFactorL: 1.02, parkHrFactorR: 1.02, parkOrientationDeg: 0 },
  { mlbamTeamId: 110, abbrev: 'BAL', canonicalName: 'Orioles', fullName: 'Baltimore Orioles', aliases: [], venueName: 'Oriole Park at Camden Yards', parkRunFactor: 1.01, parkHrFactorL: 1.02, parkHrFactorR: 1.0, parkOrientationDeg: 30 },
  { mlbamTeamId: 111, abbrev: 'BOS', canonicalName: 'Red Sox', fullName: 'Boston Red Sox', aliases: ['Boston'], venueName: 'Fenway Park', parkRunFactor: 1.04, parkHrFactorL: 0.96, parkHrFactorR: 1.03, parkOrientationDeg: 45 },
  { mlbamTeamId: 112, abbrev: 'CHC', canonicalName: 'Cubs', fullName: 'Chicago Cubs', aliases: ['Chi Cubs'], venueName: 'Wrigley Field', parkRunFactor: 1.0, parkHrFactorL: 1.0, parkHrFactorR: 1.0, parkOrientationDeg: 30 },
  { mlbamTeamId: 113, abbrev: 'CIN', canonicalName: 'Reds', fullName: 'Cincinnati Reds', aliases: [], venueName: 'Great American Ball Park', parkRunFactor: 1.03, parkHrFactorL: 1.06, parkHrFactorR: 1.05, parkOrientationDeg: 30 },
  { mlbamTeamId: 114, abbrev: 'CLE', canonicalName: 'Guardians', fullName: 'Cleveland Guardians', aliases: ['Indians'], venueName: 'Progressive Field', parkRunFactor: 0.98, parkHrFactorL: 0.98, parkHrFactorR: 0.98, parkOrientationDeg: 0 },
  { mlbamTeamId: 115, abbrev: 'COL', canonicalName: 'Rockies', fullName: 'Colorado Rockies', aliases: [], venueName: 'Coors Field', parkRunFactor: 1.12, parkHrFactorL: 1.08, parkHrFactorR: 1.08, parkOrientationDeg: 0 },
  { mlbamTeamId: 116, abbrev: 'DET', canonicalName: 'Tigers', fullName: 'Detroit Tigers', aliases: [], venueName: 'Comerica Park', parkRunFactor: 0.97, parkHrFactorL: 0.96, parkHrFactorR: 0.95, parkOrientationDeg: 30 },
  { mlbamTeamId: 117, abbrev: 'HOU', canonicalName: 'Astros', fullName: 'Houston Astros', aliases: [], venueName: 'Daikin Park', parkRunFactor: 1.0, parkHrFactorL: 1.01, parkHrFactorR: 1.03, parkOrientationDeg: 345 },
  { mlbamTeamId: 118, abbrev: 'KC', canonicalName: 'Royals', fullName: 'Kansas City Royals', aliases: ['KC Royals'], venueName: 'Kauffman Stadium', parkRunFactor: 1.02, parkHrFactorL: 0.95, parkHrFactorR: 0.95, parkOrientationDeg: 45 },
  { mlbamTeamId: 119, abbrev: 'LAD', canonicalName: 'Dodgers', fullName: 'Los Angeles Dodgers', aliases: ['LA Dodgers'], venueName: 'Dodger Stadium', parkRunFactor: 0.98, parkHrFactorL: 1.02, parkHrFactorR: 1.02, parkOrientationDeg: 25 },
  { mlbamTeamId: 120, abbrev: 'WSH', canonicalName: 'Nationals', fullName: 'Washington Nationals', aliases: ['Nats'], venueName: 'Nationals Park', parkRunFactor: 1.0, parkHrFactorL: 1.01, parkHrFactorR: 1.0, parkOrientationDeg: 30 },
  { mlbamTeamId: 121, abbrev: 'NYM', canonicalName: 'Mets', fullName: 'New York Mets', aliases: ['NY Mets'], venueName: 'Citi Field', parkRunFactor: 0.97, parkHrFactorL: 0.97, parkHrFactorR: 0.96, parkOrientationDeg: 25 },
  { mlbamTeamId: 133, abbrev: 'ATH', canonicalName: 'Athletics', fullName: 'Athletics', aliases: ['Oakland', 'A’s', "A's", 'OAK'], venueName: 'Sutter Health Park', parkRunFactor: 0.98, parkHrFactorL: 0.99, parkHrFactorR: 0.99, parkOrientationDeg: 60 },
  { mlbamTeamId: 134, abbrev: 'PIT', canonicalName: 'Pirates', fullName: 'Pittsburgh Pirates', aliases: [], venueName: 'PNC Park', parkRunFactor: 0.98, parkHrFactorL: 0.96, parkHrFactorR: 0.97, parkOrientationDeg: 0 },
  { mlbamTeamId: 135, abbrev: 'SD', canonicalName: 'Padres', fullName: 'San Diego Padres', aliases: ['SD Padres'], venueName: 'Petco Park', parkRunFactor: 0.94, parkHrFactorL: 0.95, parkHrFactorR: 0.94, parkOrientationDeg: 0 },
  { mlbamTeamId: 136, abbrev: 'SEA', canonicalName: 'Mariners', fullName: 'Seattle Mariners', aliases: [], venueName: 'T-Mobile Park', parkRunFactor: 0.95, parkHrFactorL: 0.97, parkHrFactorR: 0.95, parkOrientationDeg: 0 },
  { mlbamTeamId: 137, abbrev: 'SF', canonicalName: 'Giants', fullName: 'San Francisco Giants', aliases: ['SF Giants'], venueName: 'Oracle Park', parkRunFactor: 0.95, parkHrFactorL: 0.9, parkHrFactorR: 0.97, parkOrientationDeg: 90 },
  { mlbamTeamId: 138, abbrev: 'STL', canonicalName: 'Cardinals', fullName: 'St. Louis Cardinals', aliases: ['St Louis'], venueName: 'Busch Stadium', parkRunFactor: 0.98, parkHrFactorL: 0.96, parkHrFactorR: 0.96, parkOrientationDeg: 60 },
  { mlbamTeamId: 139, abbrev: 'TB', canonicalName: 'Rays', fullName: 'Tampa Bay Rays', aliases: ['Tampa'], venueName: 'George M. Steinbrenner Field', parkRunFactor: 0.97, parkHrFactorL: 0.98, parkHrFactorR: 0.98, parkOrientationDeg: 45 },
  { mlbamTeamId: 140, abbrev: 'TEX', canonicalName: 'Rangers', fullName: 'Texas Rangers', aliases: [], venueName: 'Globe Life Field', parkRunFactor: 1.02, parkHrFactorL: 1.0, parkHrFactorR: 1.0, parkOrientationDeg: 0 },
  { mlbamTeamId: 141, abbrev: 'TOR', canonicalName: 'Blue Jays', fullName: 'Toronto Blue Jays', aliases: ['Toronto'], venueName: 'Rogers Centre', parkRunFactor: 1.01, parkHrFactorL: 1.02, parkHrFactorR: 1.02, parkOrientationDeg: 0 },
  { mlbamTeamId: 142, abbrev: 'MIN', canonicalName: 'Twins', fullName: 'Minnesota Twins', aliases: [], venueName: 'Target Field', parkRunFactor: 1.0, parkHrFactorL: 1.0, parkHrFactorR: 0.99, parkOrientationDeg: 0 },
  { mlbamTeamId: 143, abbrev: 'PHI', canonicalName: 'Phillies', fullName: 'Philadelphia Phillies', aliases: ['Philly'], venueName: 'Citizens Bank Park', parkRunFactor: 1.02, parkHrFactorL: 1.05, parkHrFactorR: 1.04, parkOrientationDeg: 15 },
  { mlbamTeamId: 144, abbrev: 'ATL', canonicalName: 'Braves', fullName: 'Atlanta Braves', aliases: [], venueName: 'Truist Park', parkRunFactor: 1.0, parkHrFactorL: 1.01, parkHrFactorR: 1.01, parkOrientationDeg: 30 },
  { mlbamTeamId: 145, abbrev: 'CWS', canonicalName: 'White Sox', fullName: 'Chicago White Sox', aliases: ['Chi White Sox', 'ChiSox'], venueName: 'Rate Field', parkRunFactor: 1.0, parkHrFactorL: 1.03, parkHrFactorR: 1.03, parkOrientationDeg: 30 },
  { mlbamTeamId: 146, abbrev: 'MIA', canonicalName: 'Marlins', fullName: 'Miami Marlins', aliases: ['Florida'], venueName: 'loanDepot park', parkRunFactor: 0.97, parkHrFactorL: 0.95, parkHrFactorR: 0.96, parkOrientationDeg: 30 },
  { mlbamTeamId: 147, abbrev: 'NYY', canonicalName: 'Yankees', fullName: 'New York Yankees', aliases: ['NY Yankees'], venueName: 'Yankee Stadium', parkRunFactor: 1.01, parkHrFactorL: 1.08, parkHrFactorR: 1.0, parkOrientationDeg: 0 },
  { mlbamTeamId: 158, abbrev: 'MIL', canonicalName: 'Brewers', fullName: 'Milwaukee Brewers', aliases: [], venueName: 'American Family Field', parkRunFactor: 0.99, parkHrFactorL: 1.02, parkHrFactorR: 1.01, parkOrientationDeg: 0 },
];

/** Normalize a team string for fuzzy matching (lowercase, strip punctuation/city). */
export function normalizeTeamName(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve an arbitrary team string (from API-Sports or Polymarket) to a
 * seed entry via canonical name, full name, abbrev, or alias substring.
 */
export function findTeamSeed(raw: string): MlbTeamSeed | null {
  const n = normalizeTeamName(raw);
  if (!n) return null;
  for (const t of MLB_TEAMS) {
    const candidates = [
      t.canonicalName,
      t.fullName,
      t.abbrev,
      ...t.aliases,
    ].map(normalizeTeamName);
    if (candidates.some((c) => c && (n === c || n.includes(c) || c.includes(n)))) {
      return t;
    }
  }
  return null;
}
