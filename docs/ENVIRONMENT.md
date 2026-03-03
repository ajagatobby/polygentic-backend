# Environment Configuration

## Overview

All configuration is managed through environment variables. The NestJS `ConfigModule` validates these at startup — missing required variables will prevent the application from starting.

---

## Required Environment Variables

### Application

| Variable    | Required | Default       | Description                                      |
| ----------- | -------- | ------------- | ------------------------------------------------ |
| `NODE_ENV`  | No       | `development` | Environment: `development`, `production`, `test` |
| `PORT`      | No       | `8080`        | Application port                                 |
| `APP_NAME`  | No       | `polygentic`  | Application name (used in logs)                  |
| `LOG_LEVEL` | No       | `info`        | Logging level: `debug`, `info`, `warn`, `error`  |

### Database (PostgreSQL)

| Variable       | Required | Default | Description                                           |
| -------------- | -------- | ------- | ----------------------------------------------------- |
| `DATABASE_URL` | Yes      | —       | Full PostgreSQL connection string (Supabase or local) |
| `DATABASE_SSL` | No       | `false` | Enable SSL for database connection                    |

### AI Services

| Variable             | Required | Default | Description                                   |
| -------------------- | -------- | ------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY`  | Yes      | —       | Anthropic API key for Claude (analysis agent) |
| `PERPLEXITY_API_KEY` | Yes      | —       | Perplexity API key for Sonar (research agent) |

### Trigger.dev

| Variable             | Required | Default | Description                    |
| -------------------- | -------- | ------- | ------------------------------ |
| `TRIGGER_SECRET_KEY` | Yes      | —       | Trigger.dev project secret key |

The Trigger.dev project ID is configured in `trigger.config.ts`, not via environment variable.

### API-Football

| Variable                   | Required | Default                             | Description                          |
| -------------------------- | -------- | ----------------------------------- | ------------------------------------ |
| `API_FOOTBALL_KEY`         | Yes      | —                                   | API key from api-sports.io dashboard |
| `API_FOOTBALL_BASE_URL`    | No       | `https://v3.football.api-sports.io` | API base URL                         |
| `API_FOOTBALL_DAILY_LIMIT` | No       | `7500`                              | Daily request limit (Pro plan)       |
| `API_FOOTBALL_RATE_LIMIT`  | No       | `300`                               | Requests per minute limit            |

### The Odds API

| Variable                          | Required | Default                        | Description                                  |
| --------------------------------- | -------- | ------------------------------ | -------------------------------------------- |
| `ODDS_API_KEY`                    | Yes      | —                              | API key from the-odds-api.com                |
| `ODDS_API_BASE_URL`               | No       | `https://api.the-odds-api.com` | API base URL                                 |
| `ODDS_API_REGIONS`                | No       | `uk,eu`                        | Regions to fetch odds from                   |
| `ODDS_API_MONTHLY_CREDIT_LIMIT`   | No       | `20000`                        | Monthly credit budget                        |
| `ODDS_API_CREDIT_PAUSE_THRESHOLD` | No       | `0.10`                         | Pause syncing when credits drop below this % |

### Polymarket

| Variable               | Required | Default                                                | Description        |
| ---------------------- | -------- | ------------------------------------------------------ | ------------------ |
| `POLYMARKET_GAMMA_URL` | No       | `https://gamma-api.polymarket.com`                     | Gamma API base URL |
| `POLYMARKET_CLOB_URL`  | No       | `https://clob.polymarket.com`                          | CLOB API base URL  |
| `POLYMARKET_WS_URL`    | No       | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | WebSocket URL      |
| `POLYMARKET_DATA_URL`  | No       | `https://data-api.polymarket.com`                      | Data API base URL  |

### Live Match Configuration

| Variable                      | Required | Default | Description                                           |
| ----------------------------- | -------- | ------- | ----------------------------------------------------- |
| `LIVE_POLLING_INTERVAL_MS`    | No       | `30000` | Live score polling interval (30 seconds)              |
| `LIVE_HALFTIME_POLLING_MS`    | No       | `60000` | Polling interval during halftime (60 seconds)         |
| `LIVE_PENALTY_POLLING_MS`     | No       | `15000` | Polling interval during penalties (15 seconds)        |
| `LIVE_MAX_CONCURRENT_MATCHES` | No       | `10`    | Max matches to monitor simultaneously                 |
| `LIVE_API_BUDGET_DAILY`       | No       | `2500`  | Max API requests allocated to live monitoring per day |

---

## Example .env File

```env
# Application
NODE_ENV=development
PORT=8080
LOG_LEVEL=debug

# Database (Supabase)
DATABASE_URL=postgresql://postgres.xxxx:password@aws-0-region.pooler.supabase.com:6543/postgres
DATABASE_SSL=true

# AI Services
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
PERPLEXITY_API_KEY=pplx-xxxxx

# Trigger.dev
TRIGGER_SECRET_KEY=tr_dev_xxxxx

# API-Football (Pro Plan)
API_FOOTBALL_KEY=your_api_football_key_here
API_FOOTBALL_DAILY_LIMIT=7500

# The Odds API
ODDS_API_KEY=your_odds_api_key_here
ODDS_API_REGIONS=uk,eu
ODDS_API_MONTHLY_CREDIT_LIMIT=20000

# Polymarket (defaults are fine, no auth needed for read-only)
# POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com

# Live Match Monitoring
LIVE_POLLING_INTERVAL_MS=30000
LIVE_MAX_CONCURRENT_MATCHES=10
```

---

## Setup Instructions

### 1. PostgreSQL

**Option A: Supabase (Recommended)**

Use [Supabase](https://supabase.com). Set `DATABASE_URL` with the connection string from your project settings. Enable SSL with `DATABASE_SSL=true`.

**Option B: Docker (Local development)**

```bash
docker run -d \
  --name polygentic-postgres \
  -e POSTGRES_DB=polygentic_db \
  -e POSTGRES_USER=polygentic \
  -e POSTGRES_PASSWORD=your_password \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. API Keys

1. **API-Football:** Sign up at https://dashboard.api-football.com/register, get key from Profile > API Key
2. **The Odds API:** Sign up at https://the-odds-api.com, get key from dashboard
3. **Anthropic:** Get API key from https://console.anthropic.com
4. **Perplexity:** Get API key from https://www.perplexity.ai/settings/api
5. **Trigger.dev:** Sign up at https://trigger.dev, create a project, get the secret key
6. **Polymarket:** No API key needed for read-only access

### 3. Trigger.dev Setup

```bash
# Login to Trigger.dev CLI
npx trigger.dev login

# Start development mode (connects local tasks to Trigger.dev cloud)
pnpm run trigger:dev

# Deploy tasks to production
pnpm run trigger:deploy
```

### 4. Running the Application

```bash
# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env
# Edit .env with your values

# Push database schema
pnpm run db:push

# Start development server
pnpm run start:dev

# In a separate terminal, start Trigger.dev dev mode
pnpm run trigger:dev

# Verify
curl http://localhost:8080/api/health
```

### 5. Running the Backfill (Optional)

```bash
# Dry run to estimate API calls
npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --all --dry-run

# Full 6-month backfill
npx ts-node -r tsconfig-paths/register scripts/backfill-historical.ts --all
```

---

## Security Notes

- **Never commit `.env` files** — `.env` is in `.gitignore`
- **Never expose API keys** in client-facing responses
- **Rotate API keys** periodically
- **Enable SSL** for database connections in production (`DATABASE_SSL=true`)
