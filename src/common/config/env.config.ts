import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
  validateSync,
} from 'class-validator';
import { Type, plainToInstance } from 'class-transformer';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

export class EnvConfig {
  // ─── APP ─────────────────────────────────────────────────────────────

  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT: number = 3000;

  @IsString()
  @IsOptional()
  APP_NAME: string = 'polygentic';

  @IsEnum(LogLevel)
  @IsOptional()
  LOG_LEVEL: LogLevel = LogLevel.Info;

  // ─── DATABASE ────────────────────────────────────────────────────────

  @ValidateIf((o) => !o.DATABASE_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_HOST: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  DATABASE_PORT: number = 5432;

  @ValidateIf((o) => !o.DATABASE_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_NAME: string;

  @ValidateIf((o) => !o.DATABASE_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_USER: string;

  @ValidateIf((o) => !o.DATABASE_URL)
  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD: string;

  @ValidateIf(
    (o) =>
      !o.DATABASE_HOST ||
      !o.DATABASE_NAME ||
      !o.DATABASE_USER ||
      !o.DATABASE_PASSWORD,
  )
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsOptional()
  DATABASE_SSL: string = 'false';

  // ─── REDIS ───────────────────────────────────────────────────────────

  @ValidateIf((o) => !o.REDIS_URL)
  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  REDIS_PORT: number = 6379;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD: string;

  @ValidateIf((o) => !o.REDIS_HOST)
  @IsString()
  @IsNotEmpty()
  REDIS_URL: string;

  // ─── API-FOOTBALL ────────────────────────────────────────────────────

  @IsString()
  @IsNotEmpty()
  API_FOOTBALL_KEY: string;

  @IsString()
  @IsOptional()
  API_FOOTBALL_BASE_URL: string = 'https://v3.football.api-sports.io';

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  API_FOOTBALL_DAILY_LIMIT: number = 7500;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  API_FOOTBALL_RATE_LIMIT: number = 300;

  // ─── ODDS API ────────────────────────────────────────────────────────

  @IsString()
  @IsNotEmpty()
  ODDS_API_KEY: string;

  @IsString()
  @IsOptional()
  ODDS_API_BASE_URL: string = 'https://api.the-odds-api.com';

  @IsString()
  @IsOptional()
  ODDS_API_REGIONS: string = 'uk,eu';

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  ODDS_API_MONTHLY_CREDIT_LIMIT: number = 20000;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  ODDS_API_CREDIT_PAUSE_THRESHOLD: number = 0.1;

  // ─── AI / PREDICTION ──────────────────────────────────────────────────

  @IsString()
  @IsNotEmpty()
  ANTHROPIC_API_KEY: string;

  @IsString()
  @IsNotEmpty()
  PERPLEXITY_API_KEY: string;

  @IsString()
  @IsOptional()
  PREDICTION_MODEL: string = 'claude-sonnet-4-20250514';

  // ─── SYNC INTERVALS ─────────────────────────────────────────────────

  @IsString()
  @IsOptional()
  SYNC_FIXTURES_INTERVAL: string = '*/30 * * * *';

  @IsString()
  @IsOptional()
  SYNC_INJURIES_INTERVAL: string = '0 */2 * * *';

  @IsString()
  @IsOptional()
  SYNC_TEAM_STATS_INTERVAL: string = '0 */6 * * *';

  @IsString()
  @IsOptional()
  SYNC_STANDINGS_INTERVAL: string = '0 */2 * * *';

  @IsString()
  @IsOptional()
  SYNC_ODDS_TOP_LEAGUES_INTERVAL: string = '0 */6 * * *';

  @IsString()
  @IsOptional()
  SYNC_ODDS_OTHER_INTERVAL: string = '0 */12 * * *';

  @IsString()
  @IsOptional()
  SYNC_DAILY_PREDICTIONS_CRON: string = '0 6 * * *'; // 6 AM UTC

  @IsString()
  @IsOptional()
  SYNC_PRE_MATCH_PREDICTIONS_CRON: string = '*/15 * * * *'; // Check every 15 min for fixtures starting within 1hr

  // ─── LIVE MATCH CONFIG ───────────────────────────────────────────────

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  LIVE_POLLING_INTERVAL_MS: number = 30000;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  LIVE_HALFTIME_POLLING_MS: number = 60000;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  LIVE_PENALTY_POLLING_MS: number = 15000;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  LIVE_MAX_CONCURRENT_MATCHES: number = 10;

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  LIVE_API_BUDGET_DAILY: number = 2500;

  // ─── PREDICTION CONFIG ───────────────────────────────────────────────

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  PREDICTION_HIGH_CONFIDENCE_THRESHOLD: number = 7; // 1-10 scale, alerts above this

  @Type(() => Number)
  @IsInt()
  @IsOptional()
  PREDICTION_MAX_CONCURRENT: number = 5; // Max concurrent prediction pipelines

  get databaseUrl(): string {
    if (this.DATABASE_URL) {
      return this.DATABASE_URL;
    }
    return `postgresql://${this.DATABASE_USER}:${this.DATABASE_PASSWORD}@${this.DATABASE_HOST}:${this.DATABASE_PORT}/${this.DATABASE_NAME}`;
  }

  get redisUrl(): string {
    if (this.REDIS_URL) {
      return this.REDIS_URL;
    }
    const auth = this.REDIS_PASSWORD ? `:${this.REDIS_PASSWORD}@` : '';
    return `redis://${auth}${this.REDIS_HOST}:${this.REDIS_PORT}`;
  }

  get databaseSsl(): boolean {
    return this.DATABASE_SSL === 'true';
  }
}

export function validate(config: Record<string, unknown>): EnvConfig {
  const validatedConfig = plainToInstance(EnvConfig, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
    whitelist: true,
    forbidNonWhitelisted: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((error) => {
        const constraints = error.constraints
          ? Object.values(error.constraints).join(', ')
          : 'unknown error';
        return `  - ${error.property}: ${constraints}`;
      })
      .join('\n');

    throw new Error(`Environment validation failed:\n${messages}`);
  }

  return validatedConfig;
}
