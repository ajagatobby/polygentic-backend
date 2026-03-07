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
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── basketball_teams ──────────────────────────────────────────────────

export const basketballTeams = pgTable(
  'basketball_teams',
  {
    id: integer('id').primaryKey(), // API-Basketball team ID
    name: varchar('name', { length: 255 }).notNull(),
    shortName: varchar('short_name', { length: 50 }),
    logo: varchar('logo', { length: 500 }),
    country: varchar('country', { length: 100 }),
    leagueId: integer('league_id'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [index('idx_basketball_teams_name').on(table.name)],
);

// ─── basketball_fixtures ───────────────────────────────────────────────

export const basketballFixtures = pgTable(
  'basketball_fixtures',
  {
    id: integer('id').primaryKey(), // API-Basketball game ID
    leagueId: integer('league_id').notNull(),
    leagueName: varchar('league_name', { length: 255 }),
    leagueCountry: varchar('league_country', { length: 100 }),
    leagueSeason: varchar('league_season', { length: 20 }), // e.g. "2025-2026"
    season: integer('season'),
    stage: varchar('stage', { length: 255 }), // e.g. "Regular Season", "Playoffs"
    week: varchar('week', { length: 100 }),
    homeTeamId: integer('home_team_id')
      .notNull()
      .references(() => basketballTeams.id),
    awayTeamId: integer('away_team_id')
      .notNull()
      .references(() => basketballTeams.id),
    date: timestamp('date').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }),
    venueName: varchar('venue_name', { length: 255 }),
    venueCity: varchar('venue_city', { length: 100 }),
    status: varchar('status', { length: 10 }).notNull(),
    statusLong: varchar('status_long', { length: 50 }),
    timer: varchar('timer', { length: 10 }), // game clock
    // ── Scores ─────────────────────────────────────────────────────────
    scoreHome: integer('score_home'),
    scoreAway: integer('score_away'),
    scoreQ1Home: integer('score_q1_home'),
    scoreQ1Away: integer('score_q1_away'),
    scoreQ2Home: integer('score_q2_home'),
    scoreQ2Away: integer('score_q2_away'),
    scoreQ3Home: integer('score_q3_home'),
    scoreQ3Away: integer('score_q3_away'),
    scoreQ4Home: integer('score_q4_home'),
    scoreQ4Away: integer('score_q4_away'),
    scoreOTHome: integer('score_ot_home'),
    scoreOTAway: integer('score_ot_away'),
    scoreHalftimeHome: integer('score_halftime_home'),
    scoreHalftimeAway: integer('score_halftime_away'),
    rawData: jsonb('raw_data'),
    /** The Odds API event ID — linked during odds sync via team name + date matching */
    oddsApiEventId: varchar('odds_api_event_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_basketball_fixtures_date').on(table.date),
    index('idx_basketball_fixtures_league').on(table.leagueId, table.season),
    index('idx_basketball_fixtures_teams').on(
      table.homeTeamId,
      table.awayTeamId,
    ),
    index('idx_basketball_fixtures_status').on(table.status),
    index('idx_basketball_fixtures_odds_event').on(table.oddsApiEventId),
  ],
);

// ─── basketball_fixture_statistics ─────────────────────────────────────

export const basketballFixtureStatistics = pgTable(
  'basketball_fixture_statistics',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => basketballFixtures.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => basketballTeams.id),
    // ── Shooting ───────────────────────────────────────────────────────
    fieldGoalsMade: integer('field_goals_made'),
    fieldGoalsAttempted: integer('field_goals_attempted'),
    fieldGoalsPct: numeric('field_goals_pct', { precision: 5, scale: 2 }),
    threePointMade: integer('three_point_made'),
    threePointAttempted: integer('three_point_attempted'),
    threePointPct: numeric('three_point_pct', { precision: 5, scale: 2 }),
    freeThrowsMade: integer('free_throws_made'),
    freeThrowsAttempted: integer('free_throws_attempted'),
    freeThrowsPct: numeric('free_throws_pct', { precision: 5, scale: 2 }),
    // ── Rebounds ───────────────────────────────────────────────────────
    offensiveRebounds: integer('offensive_rebounds'),
    defensiveRebounds: integer('defensive_rebounds'),
    totalRebounds: integer('total_rebounds'),
    // ── Playmaking ────────────────────────────────────────────────────
    assists: integer('assists'),
    turnovers: integer('turnovers'),
    // ── Defense ────────────────────────────────────────────────────────
    steals: integer('steals'),
    blocks: integer('blocks'),
    personalFouls: integer('personal_fouls'),
    // ── Bench / Other ─────────────────────────────────────────────────
    pointsInPaint: integer('points_in_paint'),
    secondChancePoints: integer('second_chance_points'),
    fastBreakPoints: integer('fast_break_points'),
    benchPoints: integer('bench_points'),
    recordedAt: timestamp('recorded_at').defaultNow(),
  },
  (table) => [
    index('idx_basketball_fixture_stats_fixture').on(table.fixtureId),
    index('idx_basketball_fixture_stats_team').on(table.teamId),
    uniqueIndex('uq_basketball_fixture_stats_fixture_team').on(
      table.fixtureId,
      table.teamId,
    ),
  ],
);

// ─── basketball_injuries ───────────────────────────────────────────────

export const basketballInjuries = pgTable(
  'basketball_injuries',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id').notNull(),
    playerName: varchar('player_name', { length: 255 }).notNull(),
    teamId: integer('team_id')
      .notNull()
      .references(() => basketballTeams.id),
    fixtureId: integer('fixture_id').references(() => basketballFixtures.id),
    leagueId: integer('league_id').notNull(),
    type: varchar('type', { length: 100 }), // e.g. "Out", "Day-To-Day", "Questionable"
    reason: varchar('reason', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_basketball_injuries_team').on(table.teamId),
    index('idx_basketball_injuries_fixture').on(table.fixtureId),
    uniqueIndex('uq_basketball_injuries_player_team_league_type').on(
      table.playerId,
      table.teamId,
      table.leagueId,
      table.type,
    ),
  ],
);

// ─── basketball_team_form ──────────────────────────────────────────────

export const basketballTeamForm = pgTable(
  'basketball_team_form',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id')
      .notNull()
      .references(() => basketballTeams.id),
    leagueId: integer('league_id').notNull(),
    season: integer('season').notNull(),
    formString: varchar('form_string', { length: 20 }), // e.g. "WWLWL"
    wins: integer('wins'),
    losses: integer('losses'),
    winPct: numeric('win_pct', { precision: 5, scale: 3 }),
    homeWins: integer('home_wins'),
    homeLosses: integer('home_losses'),
    awayWins: integer('away_wins'),
    awayLosses: integer('away_losses'),
    streak: integer('streak'), // positive = win streak, negative = loss streak
    streakType: varchar('streak_type', { length: 5 }), // "W" or "L"
    last10Wins: integer('last_10_wins'),
    last10Losses: integer('last_10_losses'),
    pointsPerGame: numeric('points_per_game', { precision: 6, scale: 2 }),
    opponentPointsPerGame: numeric('opponent_points_per_game', {
      precision: 6,
      scale: 2,
    }),
    pointsDiff: numeric('points_diff', { precision: 6, scale: 2 }),
    leaguePosition: integer('league_position'),
    conferenceName: varchar('conference_name', { length: 100 }),
    conferenceRank: integer('conference_rank'),
    divisionName: varchar('division_name', { length: 100 }),
    divisionRank: integer('division_rank'),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_basketball_team_form_team_league').on(
      table.teamId,
      table.leagueId,
      table.season,
    ),
    uniqueIndex('uq_basketball_team_form_team_league_season').on(
      table.teamId,
      table.leagueId,
      table.season,
    ),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const basketballTeamsRelations = relations(
  basketballTeams,
  ({ many }) => ({
    homeFixtures: many(basketballFixtures, { relationName: 'bbHomeTeam' }),
    awayFixtures: many(basketballFixtures, { relationName: 'bbAwayTeam' }),
    fixtureStatistics: many(basketballFixtureStatistics),
    injuries: many(basketballInjuries),
    teamForm: many(basketballTeamForm),
  }),
);

export const basketballFixturesRelations = relations(
  basketballFixtures,
  ({ one, many }) => ({
    homeTeam: one(basketballTeams, {
      fields: [basketballFixtures.homeTeamId],
      references: [basketballTeams.id],
      relationName: 'bbHomeTeam',
    }),
    awayTeam: one(basketballTeams, {
      fields: [basketballFixtures.awayTeamId],
      references: [basketballTeams.id],
      relationName: 'bbAwayTeam',
    }),
    statistics: many(basketballFixtureStatistics),
    injuries: many(basketballInjuries),
  }),
);

export const basketballFixtureStatisticsRelations = relations(
  basketballFixtureStatistics,
  ({ one }) => ({
    fixture: one(basketballFixtures, {
      fields: [basketballFixtureStatistics.fixtureId],
      references: [basketballFixtures.id],
    }),
    team: one(basketballTeams, {
      fields: [basketballFixtureStatistics.teamId],
      references: [basketballTeams.id],
    }),
  }),
);

export const basketballInjuriesRelations = relations(
  basketballInjuries,
  ({ one }) => ({
    team: one(basketballTeams, {
      fields: [basketballInjuries.teamId],
      references: [basketballTeams.id],
    }),
    fixture: one(basketballFixtures, {
      fields: [basketballInjuries.fixtureId],
      references: [basketballFixtures.id],
    }),
  }),
);

export const basketballTeamFormRelations = relations(
  basketballTeamForm,
  ({ one }) => ({
    team: one(basketballTeams, {
      fields: [basketballTeamForm.teamId],
      references: [basketballTeams.id],
    }),
  }),
);
