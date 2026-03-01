import {
  pgTable,
  varchar,
  text,
  boolean,
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

// ─── teams ─────────────────────────────────────────────────────────────

export const teams = pgTable(
  'teams',
  {
    id: integer('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    shortName: varchar('short_name', { length: 50 }),
    logo: varchar('logo', { length: 500 }),
    country: varchar('country', { length: 100 }),
    founded: integer('founded'),
    venueName: varchar('venue_name', { length: 255 }),
    venueCapacity: integer('venue_capacity'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [index('idx_teams_name').on(table.name)],
);

// ─── fixtures ──────────────────────────────────────────────────────────

export const fixtures = pgTable(
  'fixtures',
  {
    id: integer('id').primaryKey(),
    leagueId: integer('league_id').notNull(),
    leagueName: varchar('league_name', { length: 255 }),
    leagueCountry: varchar('league_country', { length: 100 }),
    season: integer('season'),
    round: varchar('round', { length: 100 }),
    homeTeamId: integer('home_team_id')
      .notNull()
      .references(() => teams.id),
    awayTeamId: integer('away_team_id')
      .notNull()
      .references(() => teams.id),
    date: timestamp('date').notNull(),
    timestamp: bigint('timestamp', { mode: 'number' }),
    venueName: varchar('venue_name', { length: 255 }),
    venueCity: varchar('venue_city', { length: 100 }),
    referee: varchar('referee', { length: 255 }),
    status: varchar('status', { length: 10 }).notNull(),
    statusLong: varchar('status_long', { length: 50 }),
    elapsed: integer('elapsed'),
    goalsHome: integer('goals_home'),
    goalsAway: integer('goals_away'),
    scoreHalftimeHome: integer('score_halftime_home'),
    scoreHalftimeAway: integer('score_halftime_away'),
    scoreFulltimeHome: integer('score_fulltime_home'),
    scoreFulltimeAway: integer('score_fulltime_away'),
    scoreExtratimeHome: integer('score_extratime_home'),
    scoreExtratimeAway: integer('score_extratime_away'),
    scorePenaltyHome: integer('score_penalty_home'),
    scorePenaltyAway: integer('score_penalty_away'),
    rawData: jsonb('raw_data'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_fixtures_date').on(table.date),
    index('idx_fixtures_league').on(table.leagueId, table.season),
    index('idx_fixtures_teams').on(table.homeTeamId, table.awayTeamId),
    index('idx_fixtures_status').on(table.status),
  ],
);

// ─── fixture_statistics ────────────────────────────────────────────────

export const fixtureStatistics = pgTable(
  'fixture_statistics',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => fixtures.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    shotsOnGoal: integer('shots_on_goal'),
    shotsOffGoal: integer('shots_off_goal'),
    totalShots: integer('total_shots'),
    blockedShots: integer('blocked_shots'),
    shotsInsideBox: integer('shots_inside_box'),
    shotsOutsideBox: integer('shots_outside_box'),
    fouls: integer('fouls'),
    cornerKicks: integer('corner_kicks'),
    offsides: integer('offsides'),
    possession: numeric('possession', { precision: 5, scale: 2 }),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    goalkeeperSaves: integer('goalkeeper_saves'),
    totalPasses: integer('total_passes'),
    passesAccurate: integer('passes_accurate'),
    passesPct: numeric('passes_pct', { precision: 5, scale: 2 }),
    expectedGoals: numeric('expected_goals', { precision: 5, scale: 2 }),
    recordedAt: timestamp('recorded_at').defaultNow(),
  },
  (table) => [
    index('idx_fixture_stats_fixture').on(table.fixtureId),
    index('idx_fixture_stats_team').on(table.teamId),
    uniqueIndex('uq_fixture_stats_fixture_team').on(
      table.fixtureId,
      table.teamId,
    ),
  ],
);

// ─── fixture_events ────────────────────────────────────────────────────

export const fixtureEvents = pgTable(
  'fixture_events',
  {
    id: serial('id').primaryKey(),
    fixtureId: integer('fixture_id')
      .notNull()
      .references(() => fixtures.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    playerId: integer('player_id'),
    playerName: varchar('player_name', { length: 255 }),
    assistId: integer('assist_id'),
    assistName: varchar('assist_name', { length: 255 }),
    type: varchar('type', { length: 50 }).notNull(),
    detail: varchar('detail', { length: 100 }),
    elapsed: integer('elapsed').notNull(),
    extraTime: integer('extra_time'),
    comments: text('comments'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_fixture_events_fixture').on(table.fixtureId),
    index('idx_fixture_events_type').on(table.type),
  ],
);

// ─── injuries ──────────────────────────────────────────────────────────

export const injuries = pgTable(
  'injuries',
  {
    id: serial('id').primaryKey(),
    playerId: integer('player_id').notNull(),
    playerName: varchar('player_name', { length: 255 }).notNull(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    fixtureId: integer('fixture_id').references(() => fixtures.id),
    leagueId: integer('league_id'),
    type: varchar('type', { length: 100 }),
    reason: varchar('reason', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_injuries_team').on(table.teamId),
    index('idx_injuries_fixture').on(table.fixtureId),
  ],
);

// ─── team_form ─────────────────────────────────────────────────────────

export const teamForm = pgTable(
  'team_form',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    leagueId: integer('league_id').notNull(),
    season: integer('season').notNull(),
    formString: varchar('form_string', { length: 20 }),
    last5Wins: integer('last_5_wins'),
    last5Draws: integer('last_5_draws'),
    last5Losses: integer('last_5_losses'),
    last5GoalsFor: integer('last_5_goals_for'),
    last5GoalsAgainst: integer('last_5_goals_against'),
    homeWins: integer('home_wins'),
    homeDraws: integer('home_draws'),
    homeLosses: integer('home_losses'),
    awayWins: integer('away_wins'),
    awayDraws: integer('away_draws'),
    awayLosses: integer('away_losses'),
    goalsForAvg: numeric('goals_for_avg', { precision: 5, scale: 2 }),
    goalsAgainstAvg: numeric('goals_against_avg', { precision: 5, scale: 2 }),
    cleanSheets: integer('clean_sheets'),
    failedToScore: integer('failed_to_score'),
    attackRating: varchar('attack_rating', { length: 10 }),
    defenseRating: varchar('defense_rating', { length: 10 }),
    leaguePosition: integer('league_position'),
    points: integer('points'),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [
    index('idx_team_form_team_league').on(
      table.teamId,
      table.leagueId,
      table.season,
    ),
    uniqueIndex('uq_team_form_team_league_season').on(
      table.teamId,
      table.leagueId,
      table.season,
    ),
  ],
);

// ─── RELATIONS ─────────────────────────────────────────────────────────

export const teamsRelations = relations(teams, ({ many }) => ({
  homeFixtures: many(fixtures, { relationName: 'homeTeam' }),
  awayFixtures: many(fixtures, { relationName: 'awayTeam' }),
  fixtureStatistics: many(fixtureStatistics),
  fixtureEvents: many(fixtureEvents),
  injuries: many(injuries),
  teamForm: many(teamForm),
}));

export const fixturesRelations = relations(fixtures, ({ one, many }) => ({
  homeTeam: one(teams, {
    fields: [fixtures.homeTeamId],
    references: [teams.id],
    relationName: 'homeTeam',
  }),
  awayTeam: one(teams, {
    fields: [fixtures.awayTeamId],
    references: [teams.id],
    relationName: 'awayTeam',
  }),
  statistics: many(fixtureStatistics),
  events: many(fixtureEvents),
  injuries: many(injuries),
}));

export const fixtureStatisticsRelations = relations(
  fixtureStatistics,
  ({ one }) => ({
    fixture: one(fixtures, {
      fields: [fixtureStatistics.fixtureId],
      references: [fixtures.id],
    }),
    team: one(teams, {
      fields: [fixtureStatistics.teamId],
      references: [teams.id],
    }),
  }),
);

export const fixtureEventsRelations = relations(fixtureEvents, ({ one }) => ({
  fixture: one(fixtures, {
    fields: [fixtureEvents.fixtureId],
    references: [fixtures.id],
  }),
  team: one(teams, {
    fields: [fixtureEvents.teamId],
    references: [teams.id],
  }),
}));

export const injuriesRelations = relations(injuries, ({ one }) => ({
  team: one(teams, {
    fields: [injuries.teamId],
    references: [teams.id],
  }),
  fixture: one(fixtures, {
    fields: [injuries.fixtureId],
    references: [fixtures.id],
  }),
}));

export const teamFormRelations = relations(teamForm, ({ one }) => ({
  team: one(teams, {
    fields: [teamForm.teamId],
    references: [teams.id],
  }),
}));
