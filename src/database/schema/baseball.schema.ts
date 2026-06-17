import {
  pgTable,
  varchar,
  text,
  numeric,
  timestamp,
  jsonb,
  serial,
  integer,
  bigint,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── baseball_teams ────────────────────────────────────────────────────
// API-Sports baseball teams (league 1 = MLB).

export const baseballTeams = pgTable(
  'baseball_teams',
  {
    id: integer('id').primaryKey(), // API-Sports baseball team ID
    name: varchar('name', { length: 255 }).notNull(),
    shortName: varchar('short_name', { length: 50 }),
    logo: varchar('logo', { length: 500 }),
    country: varchar('country', { length: 100 }),
    leagueId: integer('league_id'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [index('idx_baseball_teams_name').on(table.name)],
);

// ─── baseball_team_map ─────────────────────────────────────────────────
// Static 30-team bridge between API-Sports IDs and MLB StatsAPI (MLBAM)
// IDs, with canonical naming + park factors. Highest-risk integration
// point — seeded once and unit-tested.

export const baseballTeamMap = pgTable(
  'baseball_team_map',
  {
    id: serial('id').primaryKey(),
    apiSportsTeamId: integer('api_sports_team_id'),
    mlbamTeamId: integer('mlbam_team_id').notNull(), // MLB StatsAPI team id
    abbrev: varchar('abbrev', { length: 8 }).notNull(), // e.g. "NYY"
    canonicalName: varchar('canonical_name', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 255 }),
    venueName: varchar('venue_name', { length: 255 }),
    // Handedness-aware park factors (1.0 = neutral). Seeded with known
    // values; refreshed weekly from Statcast/FanGraphs.
    parkRunFactor: numeric('park_run_factor', { precision: 5, scale: 3 }),
    parkHrFactorL: numeric('park_hr_factor_l', { precision: 5, scale: 3 }),
    parkHrFactorR: numeric('park_hr_factor_r', { precision: 5, scale: 3 }),
    parkOrientationDeg: integer('park_orientation_deg'), // home-plate→CF bearing
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_baseball_team_map_mlbam').on(table.mlbamTeamId),
    uniqueIndex('uq_baseball_team_map_apisports').on(table.apiSportsTeamId),
    index('idx_baseball_team_map_abbrev').on(table.abbrev),
  ],
);

// ─── baseball_games ────────────────────────────────────────────────────

export const baseballGames = pgTable(
  'baseball_games',
  {
    id: integer('id').primaryKey(), // API-Sports baseball game ID
    leagueId: integer('league_id').notNull(),
    leagueName: varchar('league_name', { length: 255 }),
    season: integer('season'),
    homeTeamId: integer('home_team_id')
      .notNull()
      .references(() => baseballTeams.id),
    awayTeamId: integer('away_team_id')
      .notNull()
      .references(() => baseballTeams.id),
    date: timestamp('date').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }),
    venueName: varchar('venue_name', { length: 255 }),
    venueCity: varchar('venue_city', { length: 100 }),
    status: varchar('status', { length: 10 }).notNull(), // "NS","IN","FT", etc.
    statusLong: varchar('status_long', { length: 50 }),
    // ── Result ───────────────────────────────────────────────────────
    runsHome: integer('runs_home'),
    runsAway: integer('runs_away'),
    inningScores: jsonb('inning_scores'), // [{inning, home, away}]
    // ── MLB StatsAPI linkage (probables / weather) ───────────────────
    gamePk: integer('game_pk'), // MLB StatsAPI gamePk
    homeProbablePitcherId: integer('home_probable_pitcher_id'), // MLBAM
    awayProbablePitcherId: integer('away_probable_pitcher_id'), // MLBAM
    lineupsConfirmed: boolean('lineups_confirmed').default(false),
    weather: jsonb('weather'), // {tempF, windMph, windDir, condition}
    rawData: jsonb('raw_data'),
    oddsApiEventId: varchar('odds_api_event_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_baseball_games_date').on(table.date),
    index('idx_baseball_games_league').on(table.leagueId, table.season),
    index('idx_baseball_games_teams').on(table.homeTeamId, table.awayTeamId),
    index('idx_baseball_games_status').on(table.status),
    index('idx_baseball_games_gamepk').on(table.gamePk),
  ],
);

// ─── baseball_pitchers ─────────────────────────────────────────────────
// True-talent snapshot per pitcher (Statcast + FanGraphs + projections).

export const baseballPitchers = pgTable(
  'baseball_pitchers',
  {
    mlbamId: integer('mlbam_id').primaryKey(), // MLB StatsAPI person id
    name: varchar('name', { length: 255 }).notNull(),
    throws: varchar('throws', { length: 1 }), // "L" | "R"
    teamMlbamId: integer('team_mlbam_id'),
    role: varchar('role', { length: 10 }), // "SP" | "RP"
    // Season actuals
    ip: numeric('ip', { precision: 6, scale: 1 }),
    era: numeric('era', { precision: 5, scale: 2 }),
    fip: numeric('fip', { precision: 5, scale: 2 }),
    // Expected / true-talent (the predictive signal)
    xera: numeric('xera', { precision: 5, scale: 2 }),
    siera: numeric('siera', { precision: 5, scale: 2 }),
    xwobaAgainst: numeric('xwoba_against', { precision: 5, scale: 3 }),
    kPct: numeric('k_pct', { precision: 5, scale: 3 }),
    bbPct: numeric('bb_pct', { precision: 5, scale: 3 }),
    barrelPct: numeric('barrel_pct', { precision: 5, scale: 3 }),
    hrPer9: numeric('hr_per_9', { precision: 5, scale: 2 }),
    // Projection (true-talent prior, e.g. Steamer/ZiPS rest-of-season)
    projEra: numeric('proj_era', { precision: 5, scale: 2 }),
    projSiera: numeric('proj_siera', { precision: 5, scale: 2 }),
    // Recent-form splits + raw payloads
    last30: jsonb('last_30'),
    rawStatcast: jsonb('raw_statcast'),
    rawProjection: jsonb('raw_projection'),
    statcastFetchedAt: timestamp('statcast_fetched_at'),
    projectionFetchedAt: timestamp('projection_fetched_at'),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [index('idx_baseball_pitchers_team').on(table.teamMlbamId)],
);

// ─── baseball_team_batting ─────────────────────────────────────────────
// Team offense quality with handedness splits (vs LHP / RHP).

export const baseballTeamBatting = pgTable(
  'baseball_team_batting',
  {
    id: serial('id').primaryKey(),
    teamMlbamId: integer('team_mlbam_id').notNull(),
    season: integer('season').notNull(),
    split: varchar('split', { length: 10 }).notNull(), // "all" | "vsL" | "vsR"
    runsPerGame: numeric('runs_per_game', { precision: 5, scale: 3 }),
    woba: numeric('woba', { precision: 5, scale: 3 }),
    xwoba: numeric('xwoba', { precision: 5, scale: 3 }),
    wrcPlus: integer('wrc_plus'),
    kPct: numeric('k_pct', { precision: 5, scale: 3 }),
    bbPct: numeric('bb_pct', { precision: 5, scale: 3 }),
    iso: numeric('iso', { precision: 5, scale: 3 }),
    raw: jsonb('raw'),
    fetchedAt: timestamp('fetched_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_baseball_team_batting').on(
      table.teamMlbamId,
      table.season,
      table.split,
    ),
  ],
);

// ─── baseball_market_lines ─────────────────────────────────────────────
// Sharp totals snapshots (The Odds API) for blend + open→close drift + CLV.

export const baseballMarketLines = pgTable(
  'baseball_market_lines',
  {
    id: serial('id').primaryKey(),
    gameId: integer('game_id')
      .notNull()
      .references(() => baseballGames.id),
    bookmaker: varchar('bookmaker', { length: 50 }).notNull(),
    totalLine: numeric('total_line', { precision: 5, scale: 2 }).notNull(),
    overPrice: numeric('over_price', { precision: 8, scale: 4 }), // decimal odds
    underPrice: numeric('under_price', { precision: 8, scale: 4 }),
    overImpliedProb: numeric('over_implied_prob', { precision: 5, scale: 4 }), // vig-removed
    isOpening: boolean('is_opening').default(false),
    isClosing: boolean('is_closing').default(false),
    capturedAt: timestamp('captured_at').defaultNow(),
  },
  (table) => [
    index('idx_baseball_market_lines_game').on(table.gameId),
    index('idx_baseball_market_lines_book').on(table.bookmaker),
  ],
);

// ─── baseball_predictions ──────────────────────────────────────────────
// One over/under prediction per game (overwritten in place on re-run).

export const baseballPredictions = pgTable(
  'baseball_predictions',
  {
    id: serial('id').primaryKey(),
    gameId: integer('game_id')
      .notNull()
      .references(() => baseballGames.id),
    homeTeamId: integer('home_team_id').references(() => baseballTeams.id),
    awayTeamId: integer('away_team_id').references(() => baseballTeams.id),
    // ── Model output ─────────────────────────────────────────────────
    expectedHomeRuns: numeric('expected_home_runs', { precision: 5, scale: 2 }),
    expectedAwayRuns: numeric('expected_away_runs', { precision: 5, scale: 2 }),
    expectedTotal: numeric('expected_total', { precision: 5, scale: 2 }),
    dispersion: numeric('dispersion', { precision: 6, scale: 3 }),
    // Per-line calibrated probabilities:
    // [{ line, pOverRaw, pOverCalibrated, pUnder, push }]
    lineProbs: jsonb('line_probs'),
    primaryLine: numeric('primary_line', { precision: 5, scale: 2 }),
    primaryPOver: numeric('primary_p_over', { precision: 5, scale: 4 }),
    // ── Per-predictor traces (for honest blender refit) ──────────────
    // { model: {...}, agent: {...}, market: {...} } keyed by line
    predictorProbs: jsonb('predictor_probs'),
    marketTotal: numeric('market_total', { precision: 5, scale: 2 }),
    marketPOver: numeric('market_p_over', { precision: 5, scale: 4 }),
    // ── Meta ─────────────────────────────────────────────────────────
    confidence: integer('confidence'), // 1-10
    predictionType: varchar('prediction_type', { length: 20 }).notNull(), // 'daily' | 'pre_game' | 'on_demand'
    modelVersion: varchar('model_version', { length: 50 }),
    keyFactors: jsonb('key_factors'),
    riskFactors: jsonb('risk_factors'),
    researchContext: jsonb('research_context'),
    detailedAnalysis: text('detailed_analysis'),
    // ── Resolution ───────────────────────────────────────────────────
    predictionStatus: varchar('prediction_status', { length: 20 }).default(
      'pending',
    ), // 'pending' | 'resolved' | 'void'
    actualTotalRuns: integer('actual_total_runs'),
    perLineResults: jsonb('per_line_results'), // [{line, outcome:'over'|'under'|'push'}]
    brier: numeric('brier', { precision: 8, scale: 6 }), // Brier on primary line
    resolvedAt: timestamp('resolved_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_baseball_predictions_game').on(table.gameId),
    index('idx_baseball_predictions_status').on(table.predictionStatus),
    index('idx_baseball_predictions_type').on(table.predictionType),
  ],
);

// ─── baseball_model_params ─────────────────────────────────────────────
// Learned parameters for binary calibration (PAV isotonic) and the
// over/under meta-blender. `kind` distinguishes them; `key` is the
// line-bucket (calibration) or 'global' (blender).

export const baseballModelParams = pgTable(
  'baseball_model_params',
  {
    id: serial('id').primaryKey(),
    kind: varchar('kind', { length: 20 }).notNull(), // 'calibration' | 'blender'
    key: varchar('key', { length: 40 }).notNull(), // line bucket or 'global'
    params: jsonb('params').notNull(), // breakpoints[] or {weights,bias,order}
    sampleSize: integer('sample_size').notNull().default(0),
    fittedAt: timestamp('fitted_at').defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_baseball_model_params_kind_key').on(table.kind, table.key),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const baseballTeamsRelations = relations(baseballTeams, ({ many }) => ({
  homeGames: many(baseballGames, { relationName: 'mlbHomeTeam' }),
  awayGames: many(baseballGames, { relationName: 'mlbAwayTeam' }),
}));

export const baseballGamesRelations = relations(
  baseballGames,
  ({ one, many }) => ({
    homeTeam: one(baseballTeams, {
      fields: [baseballGames.homeTeamId],
      references: [baseballTeams.id],
      relationName: 'mlbHomeTeam',
    }),
    awayTeam: one(baseballTeams, {
      fields: [baseballGames.awayTeamId],
      references: [baseballTeams.id],
      relationName: 'mlbAwayTeam',
    }),
    marketLines: many(baseballMarketLines),
    prediction: one(baseballPredictions, {
      fields: [baseballGames.id],
      references: [baseballPredictions.gameId],
    }),
  }),
);

export const baseballPredictionsRelations = relations(
  baseballPredictions,
  ({ one }) => ({
    game: one(baseballGames, {
      fields: [baseballPredictions.gameId],
      references: [baseballGames.id],
    }),
  }),
);

export const baseballMarketLinesRelations = relations(
  baseballMarketLines,
  ({ one }) => ({
    game: one(baseballGames, {
      fields: [baseballMarketLines.gameId],
      references: [baseballGames.id],
    }),
  }),
);
