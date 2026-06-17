-- Baseball model params: learned binary calibration (PAV isotonic) + the
-- over/under meta-blender weights, keyed by kind + line-bucket/global.

CREATE TABLE IF NOT EXISTS "baseball_model_params" (
  "id" serial PRIMARY KEY NOT NULL,
  "kind" varchar(20) NOT NULL,
  "key" varchar(40) NOT NULL,
  "params" jsonb NOT NULL,
  "sample_size" integer NOT NULL DEFAULT 0,
  "fitted_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_baseball_model_params_kind_key"
  ON "baseball_model_params" ("kind", "key");
