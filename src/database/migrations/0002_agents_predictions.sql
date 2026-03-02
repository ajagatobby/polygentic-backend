-- Migration: Replace old Polymarket-based predictions + alerts with new agentic predictions system
-- Drop old tables that are no longer in the schema

-- Drop old tables (CASCADE handles FK deps automatically)
DROP TABLE IF EXISTS "market_fixture_links" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "polymarket_price_history" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "polymarket_markets" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "polymarket_events" CASCADE;--> statement-breakpoint

-- Drop old predictions and alerts tables (will be recreated)
DROP TABLE IF EXISTS "alerts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "predictions" CASCADE;--> statement-breakpoint

-- Create new predictions table
CREATE TABLE "predictions" (
  "id" serial PRIMARY KEY NOT NULL,
  "fixture_id" integer NOT NULL,
  "home_team_id" integer,
  "away_team_id" integer,
  "home_win_prob" numeric(5, 4) NOT NULL,
  "draw_prob" numeric(5, 4) NOT NULL,
  "away_win_prob" numeric(5, 4) NOT NULL,
  "predicted_home_goals" numeric(3, 1),
  "predicted_away_goals" numeric(3, 1),
  "confidence" integer,
  "prediction_type" varchar(20) NOT NULL,
  "key_factors" jsonb,
  "risk_factors" jsonb,
  "value_bets" jsonb,
  "match_context" jsonb,
  "research_context" jsonb,
  "detailed_analysis" text,
  "model_version" varchar(50),
  "actual_home_goals" integer,
  "actual_away_goals" integer,
  "actual_result" varchar(20),
  "was_correct" boolean,
  "probability_accuracy" numeric(8, 6),
  "resolved_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now()
);--> statement-breakpoint

-- Create new alerts table
CREATE TABLE "alerts" (
  "id" serial PRIMARY KEY NOT NULL,
  "prediction_id" integer,
  "fixture_id" integer,
  "type" varchar(50) NOT NULL,
  "severity" varchar(20) NOT NULL,
  "title" varchar(500) NOT NULL,
  "message" text NOT NULL,
  "data" jsonb,
  "acknowledged" boolean DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Add foreign keys for predictions
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_home_team_id_teams_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_away_team_id_teams_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Add foreign keys for alerts
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_prediction_id_predictions_id_fk" FOREIGN KEY ("prediction_id") REFERENCES "public"."predictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Indexes for predictions
CREATE INDEX "idx_predictions_fixture" ON "predictions" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_predictions_type" ON "predictions" USING btree ("prediction_type");--> statement-breakpoint
CREATE INDEX "idx_predictions_confidence" ON "predictions" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "idx_predictions_created" ON "predictions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_predictions_resolved" ON "predictions" USING btree ("resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_predictions_fixture_type" ON "predictions" USING btree ("fixture_id", "prediction_type");--> statement-breakpoint

-- Indexes for alerts
CREATE INDEX "idx_alerts_prediction" ON "alerts" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_fixture" ON "alerts" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "idx_alerts_type" ON "alerts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_alerts_severity" ON "alerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_alerts_created" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_alerts_unacknowledged" ON "alerts" USING btree ("acknowledged");
