CREATE TYPE "public"."subscription_status" AS ENUM('none', 'active', 'canceled', 'past_due', 'trialing');--> statement-breakpoint
CREATE TYPE "public"."subscription_tier" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "fixture_lineups" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"formation" varchar(20),
	"coach_id" integer,
	"coach_name" varchar(255),
	"coach_photo" varchar(500),
	"start_xi" jsonb,
	"substitutes" jsonb,
	"team_colors" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "basketball_fixture_statistics" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"field_goals_made" integer,
	"field_goals_attempted" integer,
	"field_goals_pct" numeric(5, 2),
	"three_point_made" integer,
	"three_point_attempted" integer,
	"three_point_pct" numeric(5, 2),
	"free_throws_made" integer,
	"free_throws_attempted" integer,
	"free_throws_pct" numeric(5, 2),
	"offensive_rebounds" integer,
	"defensive_rebounds" integer,
	"total_rebounds" integer,
	"assists" integer,
	"turnovers" integer,
	"steals" integer,
	"blocks" integer,
	"personal_fouls" integer,
	"points_in_paint" integer,
	"second_chance_points" integer,
	"fast_break_points" integer,
	"bench_points" integer,
	"recorded_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "basketball_fixtures" (
	"id" integer PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"league_name" varchar(255),
	"league_country" varchar(100),
	"league_season" varchar(20),
	"season" integer,
	"stage" varchar(255),
	"week" varchar(100),
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"date" timestamp NOT NULL,
	"timestamp" bigint,
	"venue_name" varchar(255),
	"venue_city" varchar(100),
	"status" varchar(10) NOT NULL,
	"status_long" varchar(50),
	"timer" varchar(10),
	"score_home" integer,
	"score_away" integer,
	"score_q1_home" integer,
	"score_q1_away" integer,
	"score_q2_home" integer,
	"score_q2_away" integer,
	"score_q3_home" integer,
	"score_q3_away" integer,
	"score_q4_home" integer,
	"score_q4_away" integer,
	"score_ot_home" integer,
	"score_ot_away" integer,
	"score_halftime_home" integer,
	"score_halftime_away" integer,
	"raw_data" jsonb,
	"odds_api_event_id" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "basketball_injuries" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"player_name" varchar(255) NOT NULL,
	"team_id" integer NOT NULL,
	"fixture_id" integer,
	"league_id" integer NOT NULL,
	"type" varchar(100),
	"reason" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "basketball_team_form" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"season" integer NOT NULL,
	"form_string" varchar(20),
	"wins" integer,
	"losses" integer,
	"win_pct" numeric(5, 3),
	"home_wins" integer,
	"home_losses" integer,
	"away_wins" integer,
	"away_losses" integer,
	"streak" integer,
	"streak_type" varchar(5),
	"last_10_wins" integer,
	"last_10_losses" integer,
	"points_per_game" numeric(6, 2),
	"opponent_points_per_game" numeric(6, 2),
	"points_diff" numeric(6, 2),
	"league_position" integer,
	"conference_name" varchar(100),
	"conference_rank" integer,
	"division_name" varchar(100),
	"division_rank" integer,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "basketball_teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"short_name" varchar(50),
	"logo" varchar(500),
	"country" varchar(100),
	"league_id" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "prediction_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"prediction_type" varchar(20) NOT NULL,
	"baseline_prediction_id" integer,
	"retest_prediction_id" integer,
	"actual_result" varchar(20) NOT NULL,
	"baseline_predicted_result" varchar(20),
	"baseline_was_correct" boolean,
	"baseline_home_win_prob" numeric(5, 4),
	"baseline_draw_prob" numeric(5, 4),
	"baseline_away_win_prob" numeric(5, 4),
	"baseline_brier" numeric(8, 6),
	"retest_predicted_result" varchar(20),
	"retest_was_correct" boolean,
	"retest_home_win_prob" numeric(5, 4),
	"retest_draw_prob" numeric(5, 4),
	"retest_away_win_prob" numeric(5, 4),
	"retest_brier" numeric(8, 6),
	"improved" boolean,
	"run_status" varchar(20) DEFAULT 'completed',
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polymarket_bankroll" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" varchar(20) NOT NULL,
	"initial_budget" numeric(14, 2) NOT NULL,
	"current_balance" numeric(14, 2) NOT NULL,
	"total_deposited" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_withdrawn" numeric(14, 2) DEFAULT '0' NOT NULL,
	"realized_pnl" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unrealized_pnl" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_trades" integer DEFAULT 0 NOT NULL,
	"winning_trades" integer DEFAULT 0 NOT NULL,
	"losing_trades" integer DEFAULT 0 NOT NULL,
	"win_rate" numeric(5, 4),
	"avg_edge" numeric(8, 4),
	"max_drawdown_pct" numeric(8, 4),
	"peak_balance" numeric(14, 2),
	"current_drawdown_pct" numeric(8, 4),
	"is_stopped" boolean DEFAULT false,
	"stopped_reason" text,
	"open_positions_count" integer DEFAULT 0 NOT NULL,
	"open_positions_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "polymarket_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" varchar(20) NOT NULL,
	"live_trading_enabled" boolean DEFAULT false,
	"min_edge" numeric(5, 4) DEFAULT '0.05',
	"min_liquidity" numeric(14, 2) DEFAULT '1000',
	"min_confidence" integer DEFAULT 6,
	"kelly_fraction" numeric(5, 4) DEFAULT '0.25',
	"max_position_pct" numeric(5, 4) DEFAULT '0.10',
	"stop_loss_pct" numeric(5, 4) DEFAULT '0.30',
	"target_multiplier" numeric(5, 2) DEFAULT '3',
	"max_consecutive_losses" integer DEFAULT 5,
	"default_budget" numeric(14, 2) DEFAULT '500',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "polymarket_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"polymarket_market_id" integer NOT NULL,
	"prediction_id" integer,
	"fixture_id" integer,
	"league_id" integer,
	"team_id" integer,
	"mode" varchar(20) NOT NULL,
	"side" varchar(10) NOT NULL,
	"outcome_index" integer NOT NULL,
	"outcome_name" varchar(255) NOT NULL,
	"entry_price" numeric(10, 6) NOT NULL,
	"midpoint_at_entry" numeric(10, 6),
	"spread_at_entry" numeric(10, 6),
	"position_size_usd" numeric(14, 2) NOT NULL,
	"token_quantity" numeric(14, 6),
	"ensemble_probability" numeric(5, 4) NOT NULL,
	"polymarket_probability" numeric(5, 4) NOT NULL,
	"edge_percent" numeric(8, 4) NOT NULL,
	"kelly_fraction" numeric(8, 6),
	"confidence_at_entry" integer,
	"agent_reasoning" text,
	"risk_assessment" text,
	"bankroll_at_entry" numeric(14, 2),
	"open_positions_count" integer,
	"order_id" varchar(255),
	"order_status" varchar(50),
	"fill_price" numeric(10, 6),
	"fill_timestamp" timestamp,
	"exit_price" numeric(10, 6),
	"pnl_usd" numeric(14, 2),
	"pnl_percent" numeric(8, 4),
	"resolved_at" timestamp,
	"resolution_outcome" varchar(50),
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"uid" varchar(128) PRIMARY KEY NOT NULL,
	"email" varchar(320),
	"email_verified" boolean DEFAULT false,
	"display_name" varchar(255),
	"photo_url" text,
	"provider" varchar(50),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"subscription_tier" "subscription_tier" DEFAULT 'free' NOT NULL,
	"stripe_customer_id" varchar(255),
	"stripe_subscription_id" varchar(255),
	"subscription_status" "subscription_status" DEFAULT 'none' NOT NULL,
	"subscription_period_end" timestamp,
	"request_count" integer DEFAULT 0 NOT NULL,
	"last_active_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "polymarket_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "polymarket_price_history" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "market_fixture_links" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "polymarket_events" CASCADE;--> statement-breakpoint
DROP TABLE "polymarket_price_history" CASCADE;--> statement-breakpoint
DROP TABLE "market_fixture_links" CASCADE;--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP CONSTRAINT "polymarket_markets_condition_id_unique";--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP CONSTRAINT "polymarket_markets_event_id_polymarket_events_id_fk";
--> statement-breakpoint
ALTER TABLE "predictions" DROP CONSTRAINT "predictions_polymarket_market_id_polymarket_markets_id_fk";
--> statement-breakpoint
DROP INDEX "idx_polymarket_markets_event_id";--> statement-breakpoint
DROP INDEX "idx_polymarket_markets_condition_id";--> statement-breakpoint
DROP INDEX "uq_injuries_player_team_fixture_type";--> statement-breakpoint
DROP INDEX "idx_predictions_market";--> statement-breakpoint
DROP INDEX "idx_predictions_recommendation";--> statement-breakpoint
DROP INDEX "idx_predictions_confidence";--> statement-breakpoint
DROP INDEX "idx_predictions_status";--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "id" SET DATA TYPE serial;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "outcome_prices" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "volume" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "volume_24hr" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "liquidity" SET DATA TYPE numeric(14, 2);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "market_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "injuries" ALTER COLUMN "league_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "prediction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ALTER COLUMN "fixture_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "market_id" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "event_slug" varchar(500);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "event_title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "market_question" text NOT NULL;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "midpoints" jsonb;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "spreads" jsonb;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "accepting_orders" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "start_date" timestamp;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "end_date" timestamp;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "fixture_id" integer;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "league_id" integer;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "league_name" varchar(255);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "team_id" integer;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "team_name" varchar(255);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "season" integer;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "match_score" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD COLUMN "last_synced_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "fixtures" ADD COLUMN "odds_api_event_id" varchar(255);--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "fixture_id" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "home_team_id" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "away_team_id" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "home_win_prob" numeric(5, 4) NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "draw_prob" numeric(5, 4) NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "away_win_prob" numeric(5, 4) NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "predicted_home_goals" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "predicted_away_goals" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "confidence" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "prediction_type" varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "key_factors" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "risk_factors" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "value_bets" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "match_context" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "research_context" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "detailed_analysis" text;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "predicted_result" varchar(20);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "model_version" varchar(50);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "prediction_status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "actual_home_goals" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "actual_away_goals" integer;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "actual_result" varchar(20);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "probability_accuracy" numeric(8, 6);--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_fixture_statistics" ADD CONSTRAINT "basketball_fixture_statistics_fixture_id_basketball_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."basketball_fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_fixture_statistics" ADD CONSTRAINT "basketball_fixture_statistics_team_id_basketball_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."basketball_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_fixtures" ADD CONSTRAINT "basketball_fixtures_home_team_id_basketball_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."basketball_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_fixtures" ADD CONSTRAINT "basketball_fixtures_away_team_id_basketball_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."basketball_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_injuries" ADD CONSTRAINT "basketball_injuries_team_id_basketball_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."basketball_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_injuries" ADD CONSTRAINT "basketball_injuries_fixture_id_basketball_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."basketball_fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basketball_team_form" ADD CONSTRAINT "basketball_team_form_team_id_basketball_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."basketball_teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_tests" ADD CONSTRAINT "prediction_tests_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_tests" ADD CONSTRAINT "prediction_tests_baseline_prediction_id_predictions_id_fk" FOREIGN KEY ("baseline_prediction_id") REFERENCES "public"."predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_tests" ADD CONSTRAINT "prediction_tests_retest_prediction_id_predictions_id_fk" FOREIGN KEY ("retest_prediction_id") REFERENCES "public"."predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_trades" ADD CONSTRAINT "polymarket_trades_polymarket_market_id_polymarket_markets_id_fk" FOREIGN KEY ("polymarket_market_id") REFERENCES "public"."polymarket_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_trades" ADD CONSTRAINT "polymarket_trades_prediction_id_predictions_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_trades" ADD CONSTRAINT "polymarket_trades_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_trades" ADD CONSTRAINT "polymarket_trades_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fixture_lineups_fixture" ON "fixture_lineups" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_fixture_lineups_team" ON "fixture_lineups" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fixture_lineups_fixture_team" ON "fixture_lineups" USING btree ("fixture_id","team_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixture_stats_fixture" ON "basketball_fixture_statistics" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixture_stats_team" ON "basketball_fixture_statistics" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basketball_fixture_stats_fixture_team" ON "basketball_fixture_statistics" USING btree ("fixture_id","team_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixtures_date" ON "basketball_fixtures" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixtures_league" ON "basketball_fixtures" USING btree ("league_id","season");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixtures_teams" ON "basketball_fixtures" USING btree ("home_team_id","away_team_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixtures_status" ON "basketball_fixtures" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_basketball_fixtures_odds_event" ON "basketball_fixtures" USING btree ("odds_api_event_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_injuries_team" ON "basketball_injuries" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_basketball_injuries_fixture" ON "basketball_injuries" USING btree ("fixture_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basketball_injuries_player_team_league_type" ON "basketball_injuries" USING btree ("player_id","team_id","league_id","type");--> statement-breakpoint
CREATE INDEX "idx_basketball_team_form_team_league" ON "basketball_team_form" USING btree ("team_id","league_id","season");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basketball_team_form_team_league_season" ON "basketball_team_form" USING btree ("team_id","league_id","season");--> statement-breakpoint
CREATE INDEX "idx_basketball_teams_name" ON "basketball_teams" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_prediction_tests_fixture" ON "prediction_tests" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_prediction_tests_type" ON "prediction_tests" USING btree ("prediction_type");--> statement-breakpoint
CREATE INDEX "idx_prediction_tests_created" ON "prediction_tests" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_prediction_tests_status" ON "prediction_tests" USING btree ("run_status");--> statement-breakpoint
CREATE INDEX "idx_polymarket_bankroll_mode" ON "polymarket_bankroll" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "idx_polymarket_bankroll_snapshot" ON "polymarket_bankroll" USING btree ("snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_polymarket_config_mode" ON "polymarket_config" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_market" ON "polymarket_trades" USING btree ("polymarket_market_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_prediction" ON "polymarket_trades" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_fixture" ON "polymarket_trades" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_mode" ON "polymarket_trades" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_status" ON "polymarket_trades" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_created" ON "polymarket_trades" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_polymarket_trades_resolved" ON "polymarket_trades" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_users_last_active" ON "users" USING btree ("last_active_at");--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD CONSTRAINT "polymarket_markets_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD CONSTRAINT "polymarket_markets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_polymarket_markets_market_id" ON "polymarket_markets" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_event" ON "polymarket_markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_fixture" ON "polymarket_markets" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_league" ON "polymarket_markets" USING btree ("league_id","season");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_team" ON "polymarket_markets" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_synced" ON "polymarket_markets" USING btree ("last_synced_at");--> statement-breakpoint
CREATE INDEX "idx_fixtures_odds_event" ON "fixtures" USING btree ("odds_api_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_injuries_player_team_league_type" ON "injuries" USING btree ("player_id","team_id","league_id","type");--> statement-breakpoint
CREATE INDEX "idx_alerts_fixture" ON "alerts" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_predictions_fixture" ON "predictions" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_predictions_type" ON "predictions" USING btree ("prediction_type");--> statement-breakpoint
CREATE INDEX "idx_predictions_resolved" ON "predictions" USING btree ("resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_predictions_fixture_type" ON "predictions" USING btree ("fixture_id","prediction_type");--> statement-breakpoint
CREATE INDEX "idx_predictions_confidence" ON "predictions" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "idx_predictions_status" ON "predictions" USING btree ("prediction_status");--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP COLUMN "question";--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP COLUMN "question_id";--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP COLUMN "spread";--> statement-breakpoint
ALTER TABLE "polymarket_markets" DROP COLUMN "raw_data";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "polymarket_market_id";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "polymarket_price";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "bookmaker_consensus";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "pinnacle_probability";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "statistical_model_prob";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "api_football_prediction";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "predicted_probability";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "mispricing_gap";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "mispricing_pct";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "confidence_score";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "recommendation";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "reasoning";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "signals";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "is_live";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "predictions" DROP COLUMN "resolved_outcome";