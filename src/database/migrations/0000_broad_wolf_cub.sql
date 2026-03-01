CREATE TABLE "polymarket_events" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"slug" varchar(500) NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"start_date" timestamp,
	"end_date" timestamp,
	"active" boolean DEFAULT true,
	"closed" boolean DEFAULT false,
	"liquidity" numeric(18, 2),
	"volume" numeric(18, 2),
	"volume_24hr" numeric(18, 2),
	"tags" jsonb,
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "polymarket_events_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "polymarket_markets" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"event_id" varchar(255) NOT NULL,
	"question" text NOT NULL,
	"slug" varchar(500),
	"condition_id" varchar(255),
	"question_id" varchar(255),
	"outcomes" jsonb NOT NULL,
	"outcome_prices" jsonb NOT NULL,
	"clob_token_ids" jsonb NOT NULL,
	"volume" numeric(18, 2),
	"volume_24hr" numeric(18, 2),
	"liquidity" numeric(18, 2),
	"spread" numeric(8, 4),
	"active" boolean DEFAULT true,
	"closed" boolean DEFAULT false,
	"market_type" varchar(50),
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "polymarket_markets_condition_id_unique" UNIQUE("condition_id")
);
--> statement-breakpoint
CREATE TABLE "polymarket_price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"market_id" varchar(255) NOT NULL,
	"yes_price" numeric(8, 4) NOT NULL,
	"no_price" numeric(8, 4) NOT NULL,
	"midpoint" numeric(8, 4),
	"spread" numeric(8, 4),
	"volume_24hr" numeric(18, 2),
	"liquidity" numeric(18, 2),
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixture_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"player_id" integer,
	"player_name" varchar(255),
	"assist_id" integer,
	"assist_name" varchar(255),
	"type" varchar(50) NOT NULL,
	"detail" varchar(100),
	"elapsed" integer NOT NULL,
	"extra_time" integer,
	"comments" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fixture_statistics" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"shots_on_goal" integer,
	"shots_off_goal" integer,
	"total_shots" integer,
	"blocked_shots" integer,
	"shots_inside_box" integer,
	"shots_outside_box" integer,
	"fouls" integer,
	"corner_kicks" integer,
	"offsides" integer,
	"possession" numeric(5, 2),
	"yellow_cards" integer,
	"red_cards" integer,
	"goalkeeper_saves" integer,
	"total_passes" integer,
	"passes_accurate" integer,
	"passes_pct" numeric(5, 2),
	"expected_goals" numeric(5, 2),
	"recorded_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"id" integer PRIMARY KEY NOT NULL,
	"league_id" integer NOT NULL,
	"league_name" varchar(255),
	"league_country" varchar(100),
	"season" integer,
	"round" varchar(100),
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"date" timestamp NOT NULL,
	"timestamp" bigint,
	"venue_name" varchar(255),
	"venue_city" varchar(100),
	"referee" varchar(255),
	"status" varchar(10) NOT NULL,
	"status_long" varchar(50),
	"elapsed" integer,
	"goals_home" integer,
	"goals_away" integer,
	"score_halftime_home" integer,
	"score_halftime_away" integer,
	"score_fulltime_home" integer,
	"score_fulltime_away" integer,
	"score_extratime_home" integer,
	"score_extratime_away" integer,
	"score_penalty_home" integer,
	"score_penalty_away" integer,
	"raw_data" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "injuries" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"player_name" varchar(255) NOT NULL,
	"team_id" integer NOT NULL,
	"fixture_id" integer,
	"league_id" integer,
	"type" varchar(100),
	"reason" varchar(255),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "team_form" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"league_id" integer NOT NULL,
	"season" integer NOT NULL,
	"form_string" varchar(20),
	"last_5_wins" integer,
	"last_5_draws" integer,
	"last_5_losses" integer,
	"last_5_goals_for" integer,
	"last_5_goals_against" integer,
	"home_wins" integer,
	"home_draws" integer,
	"home_losses" integer,
	"away_wins" integer,
	"away_draws" integer,
	"away_losses" integer,
	"goals_for_avg" numeric(5, 2),
	"goals_against_avg" numeric(5, 2),
	"clean_sheets" integer,
	"failed_to_score" integer,
	"attack_rating" varchar(10),
	"defense_rating" varchar(10),
	"league_position" integer,
	"points" integer,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"short_name" varchar(50),
	"logo" varchar(500),
	"country" varchar(100),
	"founded" integer,
	"venue_name" varchar(255),
	"venue_capacity" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bookmaker_odds" (
	"id" serial PRIMARY KEY NOT NULL,
	"odds_api_event_id" varchar(255) NOT NULL,
	"sport_key" varchar(100) NOT NULL,
	"home_team" varchar(255) NOT NULL,
	"away_team" varchar(255) NOT NULL,
	"commence_time" timestamp NOT NULL,
	"bookmaker_key" varchar(100) NOT NULL,
	"bookmaker_name" varchar(255),
	"market_key" varchar(100) NOT NULL,
	"outcomes" jsonb NOT NULL,
	"implied_probabilities" jsonb,
	"true_probabilities" jsonb,
	"overround" numeric(8, 4),
	"last_update" timestamp,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consensus_odds" (
	"id" serial PRIMARY KEY NOT NULL,
	"odds_api_event_id" varchar(255) NOT NULL,
	"sport_key" varchar(100) NOT NULL,
	"home_team" varchar(255) NOT NULL,
	"away_team" varchar(255) NOT NULL,
	"commence_time" timestamp NOT NULL,
	"market_key" varchar(100) NOT NULL,
	"consensus_home_win" numeric(8, 4),
	"consensus_draw" numeric(8, 4),
	"consensus_away_win" numeric(8, 4),
	"consensus_over" numeric(8, 4),
	"consensus_under" numeric(8, 4),
	"consensus_point" numeric(5, 2),
	"pinnacle_home_win" numeric(8, 4),
	"pinnacle_draw" numeric(8, 4),
	"pinnacle_away_win" numeric(8, 4),
	"num_bookmakers" integer,
	"calculated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"prediction_id" integer NOT NULL,
	"type" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"title" varchar(500) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"acknowledged" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_fixture_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"polymarket_market_id" varchar(255) NOT NULL,
	"fixture_id" integer,
	"odds_api_event_id" varchar(255),
	"league_id" integer,
	"team_id" integer,
	"match_type" varchar(50) NOT NULL,
	"match_confidence" numeric(5, 2),
	"match_method" varchar(50),
	"mapped_outcome" varchar(100),
	"verified" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"polymarket_market_id" varchar(255) NOT NULL,
	"fixture_id" integer,
	"polymarket_price" numeric(8, 4) NOT NULL,
	"bookmaker_consensus" numeric(8, 4),
	"pinnacle_probability" numeric(8, 4),
	"statistical_model_prob" numeric(8, 4),
	"api_football_prediction" numeric(8, 4),
	"predicted_probability" numeric(8, 4) NOT NULL,
	"mispricing_gap" numeric(8, 4),
	"mispricing_pct" numeric(8, 4),
	"confidence_score" integer,
	"recommendation" varchar(20),
	"reasoning" text,
	"signals" jsonb,
	"is_live" boolean DEFAULT false,
	"status" varchar(20) DEFAULT 'active',
	"resolved_outcome" varchar(10),
	"was_correct" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(50) NOT NULL,
	"task" varchar(100) NOT NULL,
	"status" varchar(20) NOT NULL,
	"records_processed" integer,
	"error_message" text,
	"api_requests_used" integer,
	"duration_ms" integer,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "polymarket_markets" ADD CONSTRAINT "polymarket_markets_event_id_polymarket_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."polymarket_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polymarket_price_history" ADD CONSTRAINT "polymarket_price_history_market_id_polymarket_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."polymarket_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_events" ADD CONSTRAINT "fixture_events_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_events" ADD CONSTRAINT "fixture_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_statistics" ADD CONSTRAINT "fixture_statistics_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_statistics" ADD CONSTRAINT "fixture_statistics_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injuries" ADD CONSTRAINT "injuries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "injuries" ADD CONSTRAINT "injuries_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_form" ADD CONSTRAINT "team_form_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_prediction_id_predictions_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_fixture_links" ADD CONSTRAINT "market_fixture_links_polymarket_market_id_polymarket_markets_id_fk" FOREIGN KEY ("polymarket_market_id") REFERENCES "public"."polymarket_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_fixture_links" ADD CONSTRAINT "market_fixture_links_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_fixture_links" ADD CONSTRAINT "market_fixture_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_polymarket_market_id_polymarket_markets_id_fk" FOREIGN KEY ("polymarket_market_id") REFERENCES "public"."polymarket_markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_polymarket_events_slug" ON "polymarket_events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_polymarket_events_active" ON "polymarket_events" USING btree ("active","closed");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_event_id" ON "polymarket_markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_condition_id" ON "polymarket_markets" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_active" ON "polymarket_markets" USING btree ("active","closed");--> statement-breakpoint
CREATE INDEX "idx_polymarket_markets_type" ON "polymarket_markets" USING btree ("market_type");--> statement-breakpoint
CREATE INDEX "idx_price_history_market_time" ON "polymarket_price_history" USING btree ("market_id","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_price_history_recorded_at" ON "polymarket_price_history" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_fixture_events_fixture" ON "fixture_events" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_fixture_events_type" ON "fixture_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_fixture_stats_fixture" ON "fixture_statistics" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_fixture_stats_team" ON "fixture_statistics" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fixture_stats_fixture_team" ON "fixture_statistics" USING btree ("fixture_id","team_id");--> statement-breakpoint
CREATE INDEX "idx_fixtures_date" ON "fixtures" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_fixtures_league" ON "fixtures" USING btree ("league_id","season");--> statement-breakpoint
CREATE INDEX "idx_fixtures_teams" ON "fixtures" USING btree ("home_team_id","away_team_id");--> statement-breakpoint
CREATE INDEX "idx_fixtures_status" ON "fixtures" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_injuries_team" ON "injuries" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_injuries_fixture" ON "injuries" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_team_form_team_league" ON "team_form" USING btree ("team_id","league_id","season");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_team_form_team_league_season" ON "team_form" USING btree ("team_id","league_id","season");--> statement-breakpoint
CREATE INDEX "idx_teams_name" ON "teams" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_bookmaker_odds_event" ON "bookmaker_odds" USING btree ("odds_api_event_id");--> statement-breakpoint
CREATE INDEX "idx_bookmaker_odds_sport" ON "bookmaker_odds" USING btree ("sport_key","commence_time");--> statement-breakpoint
CREATE INDEX "idx_bookmaker_odds_bookmaker" ON "bookmaker_odds" USING btree ("bookmaker_key");--> statement-breakpoint
CREATE INDEX "idx_bookmaker_odds_recorded" ON "bookmaker_odds" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_consensus_event_market" ON "consensus_odds" USING btree ("odds_api_event_id","market_key");--> statement-breakpoint
CREATE INDEX "idx_consensus_time" ON "consensus_odds" USING btree ("calculated_at");--> statement-breakpoint
CREATE INDEX "idx_alerts_prediction" ON "alerts" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_type" ON "alerts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_alerts_severity" ON "alerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_alerts_created" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_alerts_unacknowledged" ON "alerts" USING btree ("acknowledged");--> statement-breakpoint
CREATE INDEX "idx_links_polymarket" ON "market_fixture_links" USING btree ("polymarket_market_id");--> statement-breakpoint
CREATE INDEX "idx_links_fixture" ON "market_fixture_links" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_links_type" ON "market_fixture_links" USING btree ("match_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_links_market_fixture" ON "market_fixture_links" USING btree ("polymarket_market_id","fixture_id");--> statement-breakpoint
CREATE INDEX "idx_predictions_market" ON "predictions" USING btree ("polymarket_market_id");--> statement-breakpoint
CREATE INDEX "idx_predictions_confidence" ON "predictions" USING btree ("confidence_score");--> statement-breakpoint
CREATE INDEX "idx_predictions_recommendation" ON "predictions" USING btree ("recommendation");--> statement-breakpoint
CREATE INDEX "idx_predictions_status" ON "predictions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_predictions_created" ON "predictions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sync_log_source" ON "sync_log" USING btree ("source","task");--> statement-breakpoint
CREATE INDEX "idx_sync_log_started" ON "sync_log" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_sync_log_status" ON "sync_log" USING btree ("status");