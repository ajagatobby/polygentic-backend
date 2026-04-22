CREATE TABLE "copied_trader_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"proxy_wallet" varchar(255) NOT NULL,
	"condition_id" varchar(255) NOT NULL,
	"outcome_index" integer NOT NULL,
	"asset" varchar(255),
	"market_question" text,
	"slug" varchar(500),
	"event_slug" varchar(500),
	"size" numeric(18, 4),
	"avg_price" numeric(10, 6),
	"total_bought" numeric(14, 2),
	"current_value" numeric(14, 2),
	"last_size" numeric(18, 4),
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copied_trader_trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"proxy_wallet" varchar(255) NOT NULL,
	"nickname" varchar(255),
	"condition_id" varchar(255) NOT NULL,
	"outcome_index" integer NOT NULL,
	"outcome_name" varchar(100),
	"market_question" text,
	"slug" varchar(500),
	"event_slug" varchar(500),
	"followed_size" numeric(18, 4),
	"followed_avg_price" numeric(10, 6),
	"size_delta" numeric(18, 4),
	"trade_type" varchar(20),
	"execution_status" varchar(20),
	"execution_reason" text,
	"our_position_size_usd" numeric(14, 2),
	"our_trade_id" integer,
	"our_clob_order_id" varchar(255),
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"executed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copied_traders" (
	"id" serial PRIMARY KEY NOT NULL,
	"proxy_wallet" varchar(255) NOT NULL,
	"nickname" varchar(255),
	"active" boolean DEFAULT true NOT NULL,
	"copy_enabled" boolean DEFAULT false NOT NULL,
	"sizing_mode" varchar(20) DEFAULT 'fraction' NOT NULL,
	"sizing_value" numeric(10, 6) DEFAULT '0.005' NOT NULL,
	"max_position_usd" numeric(14, 2) DEFAULT '50' NOT NULL,
	"min_last_10_wins" integer,
	"min_lifetime_pnl" numeric(14, 2),
	"min_lifetime_roi" numeric(5, 4),
	"notes" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "copy_trader_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" varchar(50) DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_interval_minutes" integer DEFAULT 10 NOT NULL,
	"default_sizing_mode" varchar(20) DEFAULT 'fraction' NOT NULL,
	"default_sizing_value" numeric(10, 6) DEFAULT '0.005' NOT NULL,
	"default_max_position_usd" numeric(14, 2) DEFAULT '50' NOT NULL,
	"max_daily_trades" integer DEFAULT 50 NOT NULL,
	"max_daily_spend_usd" numeric(14, 2) DEFAULT '500' NOT NULL,
	"price_slippage_tolerance" numeric(5, 4) DEFAULT '0.05' NOT NULL,
	"max_consecutive_losses" integer DEFAULT 5 NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_run_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "polymarket_holder_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"condition_id" varchar(255) NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"total_holders" integer DEFAULT 0 NOT NULL,
	"total_dollars" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polymarket_price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"market_id" varchar(255) NOT NULL,
	"condition_id" varchar(255),
	"snapshot_at" timestamp DEFAULT now() NOT NULL,
	"outcome_prices" jsonb,
	"volume" numeric(14, 2),
	"volume_24hr" numeric(14, 2),
	"liquidity" numeric(14, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_money_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile" varchar(50) DEFAULT 'default' NOT NULL,
	"min_lifetime_pnl" numeric(14, 2),
	"min_lifetime_pnl_with_streak" numeric(14, 2),
	"min_lifetime_roi" numeric(5, 4),
	"min_resolved_bets" integer,
	"min_sharp_count" integer,
	"min_position_multiple" numeric(5, 4),
	"correlation_threshold" numeric(5, 4),
	"min_last_10_win_rate" numeric(5, 4),
	"min_current_streak" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "smart_money_predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"fixture_id" integer NOT NULL,
	"home_team_id" integer,
	"away_team_id" integer,
	"home_win_prob" numeric(5, 4) NOT NULL,
	"draw_prob" numeric(5, 4) NOT NULL,
	"away_win_prob" numeric(5, 4) NOT NULL,
	"predicted_result" varchar(20),
	"confidence" integer,
	"source" varchar(20),
	"threshold_mode" varchar(20),
	"model_version" varchar(50),
	"smart_money_signal" jsonb,
	"market_signal" jsonb,
	"prediction_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"actual_home_goals" integer,
	"actual_away_goals" integer,
	"actual_result" varchar(20),
	"was_correct" boolean,
	"probability_accuracy" numeric(8, 6),
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "smart_money_signal" jsonb;--> statement-breakpoint
ALTER TABLE "smart_money_predictions" ADD CONSTRAINT "smart_money_predictions_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_money_predictions" ADD CONSTRAINT "smart_money_predictions_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_money_predictions" ADD CONSTRAINT "smart_money_predictions_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copied_trader_positions_wallet_market_outcome" ON "copied_trader_positions" USING btree ("proxy_wallet","condition_id","outcome_index");--> statement-breakpoint
CREATE INDEX "idx_copied_trader_positions_wallet" ON "copied_trader_positions" USING btree ("proxy_wallet");--> statement-breakpoint
CREATE INDEX "idx_copied_trader_trades_wallet" ON "copied_trader_trades" USING btree ("proxy_wallet","detected_at");--> statement-breakpoint
CREATE INDEX "idx_copied_trader_trades_status" ON "copied_trader_trades" USING btree ("execution_status");--> statement-breakpoint
CREATE INDEX "idx_copied_trader_trades_detected" ON "copied_trader_trades" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copied_traders_wallet" ON "copied_traders" USING btree ("proxy_wallet");--> statement-breakpoint
CREATE INDEX "idx_copied_traders_active" ON "copied_traders" USING btree ("active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_copy_trader_config_profile" ON "copy_trader_config" USING btree ("profile");--> statement-breakpoint
CREATE INDEX "idx_pm_holder_snapshots_condition" ON "polymarket_holder_snapshots" USING btree ("condition_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_pm_holder_snapshots_taken" ON "polymarket_holder_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_pm_price_snapshots_market" ON "polymarket_price_snapshots" USING btree ("market_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_pm_price_snapshots_condition" ON "polymarket_price_snapshots" USING btree ("condition_id","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_pm_price_snapshots_taken" ON "polymarket_price_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_smart_money_config_profile" ON "smart_money_config" USING btree ("profile");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_smart_money_predictions_fixture" ON "smart_money_predictions" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_smart_money_predictions_created" ON "smart_money_predictions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_smart_money_predictions_status" ON "smart_money_predictions" USING btree ("prediction_status");--> statement-breakpoint
CREATE INDEX "idx_smart_money_predictions_confidence" ON "smart_money_predictions" USING btree ("confidence");