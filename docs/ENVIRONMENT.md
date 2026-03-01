# Environment Configuration

## Overview

All configuration is managed through environment variables. The NestJS `ConfigModule` validates these at startup — missing required variables will prevent the application from starting.

---

## Required Environment Variables

### Application

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | Environment: `development`, `production`, `test` |
| `PORT` | No | `3000` | Application port |
| `APP_NAME` | No | `polygentic` | Application name (used in logs) |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |

### Database (PostgreSQL)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_HOST` | Yes | — | PostgreSQL host |
| `DATABASE_PORT` | No | `5432` | PostgreSQL port |
| `DATABASE_NAME` | Yes | — | Database name |
| `DATABASE_USER` | Yes | — | Database username |
| `DATABASE_PASSWORD` | Yes | — | Database password |
| `DATABASE_URL` | Yes* | — | Full connection string (alternative to individual vars) |
| `DATABASE_SSL` | No | `false` | Enable SSL for database connection |

*Either `DATABASE_URL` or individual `DATABASE_HOST/PORT/NAME/USER/PASSWORD` must be provided.

### Redis (for Bull Queue)

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_HOST` | Yes | — | Redis host |
| `REDIS_PORT` | No | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis password (if auth enabled) |
| `REDIS_URL` | Yes* | — | Full Redis URL (alternative to individual vars) |

*Either `REDIS_URL` or `REDIS_HOST` must be provided.

### API-Football

| Variable | Required | Default | Description |
|---|---|---|---|
| `API_FOOTBALL_KEY` | Yes | — | API key from api-sports.io dashboard |
| `API_FOOTBALL_BASE_URL` | No | `https://v3.football.api-sports.io` | API base URL |
| `API_FOOTBALL_DAILY_LIMIT` | No | `7500` | Daily request limit (Pro plan) |
| `API_FOOTBALL_RATE_LIMIT` | No | `300` | Requests per minute limit |

### The Odds API

| Variable | Required | Default | Description |
|---|---|---|---|
| `ODDS_API_KEY` | Yes | — | API key from the-odds-api.com |
| `ODDS_API_BASE_URL` | No | `https://api.the-odds-api.com` | API base URL |
| `ODDS_API_REGIONS` | No | `uk,eu` | Regions to fetch odds from |
| `ODDS_API_MONTHLY_CREDIT_LIMIT` | No | `20000` | Monthly credit budget |
| `ODDS_API_CREDIT_PAUSE_THRESHOLD` | No | `0.10` | Pause syncing when credits drop below this % |

### Polymarket

| Variable | Required | Default | Description |
|---|---|---|---|
| `POLYMARKET_GAMMA_URL` | No | `https://gamma-api.polymarket.com` | Gamma API base URL |
| `POLYMARKET_CLOB_URL` | No | `https://clob.polymarket.com` | CLOB API base URL |
| `POLYMARKET_WS_URL` | No | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | WebSocket URL |
| `POLYMARKET_DATA_URL` | No | `https://data-api.polymarket.com` | Data API base URL |

### Sync Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SYNC_POLYMARKET_INTERVAL` | No | `*/15 * * * *` | Cron expression for Polymarket sync (every 15 min) |
| `SYNC_FIXTURES_INTERVAL` | No | `*/30 * * * *` | Cron for fixture sync (every 30 min) |
| `SYNC_INJURIES_INTERVAL` | No | `0 */2 * * *` | Cron for injury sync (every 2 hours) |
| `SYNC_TEAM_STATS_INTERVAL` | No | `0 */6 * * *` | Cron for team stats (every 6 hours) |
| `SYNC_STANDINGS_INTERVAL` | No | `0 */2 * * *` | Cron for standings (every 2 hours) |
| `SYNC_ODDS_TOP_LEAGUES_INTERVAL` | No | `0 */6 * * *` | Cron for top league odds (every 6 hours) |
| `SYNC_ODDS_OTHER_INTERVAL` | No | `0 */12 * * *` | Cron for other league odds (every 12 hours) |
| `SYNC_PREDICTIONS_INTERVAL` | No | `*/20 * * * *` | Cron for prediction generation (every 20 min) |

### Live Match Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `LIVE_POLLING_INTERVAL_MS` | No | `30000` | Live score polling interval (30 seconds) |
| `LIVE_HALFTIME_POLLING_MS` | No | `60000` | Polling interval during halftime (60 seconds) |
| `LIVE_PENALTY_POLLING_MS` | No | `15000` | Polling interval during penalties (15 seconds) |
| `LIVE_MAX_CONCURRENT_MATCHES` | No | `10` | Max matches to monitor simultaneously |
| `LIVE_API_BUDGET_DAILY` | No | `2500` | Max API requests allocated to live monitoring per day |

### Prediction Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PREDICTION_MISPRICING_THRESHOLD` | No | `0.05` | Minimum gap to flag as mispricing (5%) |
| `PREDICTION_HIGH_CONFIDENCE_THRESHOLD` | No | `60` | Minimum confidence for recommendation |
| `PREDICTION_SIGNAL_WEIGHT_MISPRICING` | No | `0.40` | Weight for mispricing signal |
| `PREDICTION_SIGNAL_WEIGHT_STATISTICAL` | No | `0.35` | Weight for statistical model |
| `PREDICTION_SIGNAL_WEIGHT_API_FOOTBALL` | No | `0.25` | Weight for API-Football prediction |

---

## Example .env File

```env
# Application
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# Database
DATABASE_URL=postgresql://polygentic:your_password@localhost:5432/polygentic_db
DATABASE_SSL=false

# Redis
REDIS_URL=redis://localhost:6379

# API-Football (Pro Plan)
API_FOOTBALL_KEY=your_api_football_key_here
API_FOOTBALL_DAILY_LIMIT=7500

# The Odds API
ODDS_API_KEY=your_odds_api_key_here
ODDS_API_REGIONS=uk,eu
ODDS_API_MONTHLY_CREDIT_LIMIT=20000

# Polymarket (defaults are fine, no auth needed for read-only)
# POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
# POLYMARKET_CLOB_URL=https://clob.polymarket.com

# Sync Intervals (cron expressions - defaults are fine for development)
# SYNC_POLYMARKET_INTERVAL=*/15 * * * *
# SYNC_FIXTURES_INTERVAL=*/30 * * * *

# Live Match Monitoring
LIVE_POLLING_INTERVAL_MS=30000
LIVE_MAX_CONCURRENT_MATCHES=10

# Prediction Tuning
PREDICTION_MISPRICING_THRESHOLD=0.05
PREDICTION_HIGH_CONFIDENCE_THRESHOLD=60
```

---

## Setup Instructions

### 1. PostgreSQL

**Option A: Docker (Recommended for development)**

```bash
docker run -d \
  --name polygentic-postgres \
  -e POSTGRES_DB=polygentic_db \
  -e POSTGRES_USER=polygentic \
  -e POSTGRES_PASSWORD=your_password \
  -p 5432:5432 \
  postgres:16-alpine
```

**Option B: Managed PostgreSQL**

Use Neon (neon.tech), Supabase, or AWS RDS. Set `DATABASE_URL` with the connection string they provide. Enable SSL with `DATABASE_SSL=true`.

### 2. Redis

**Option A: Docker**

```bash
docker run -d \
  --name polygentic-redis \
  -p 6379:6379 \
  redis:7-alpine
```

**Option B: Managed Redis**

Use Upstash, Redis Cloud, or AWS ElastiCache. Set `REDIS_URL` with the connection string.

### 3. Docker Compose (Both Services)

```yaml
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: polygentic_db
      POSTGRES_USER: polygentic
      POSTGRES_PASSWORD: your_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

```bash
docker compose up -d
```

### 4. API Keys

1. **API-Football:** Sign up at https://dashboard.api-football.com/register, get key from Profile > API Key
2. **The Odds API:** Sign up at https://the-odds-api.com, get key from dashboard
3. **Polymarket:** No API key needed for read-only access

### 5. Running the Application

```bash
# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env
# Edit .env with your values

# Run database migrations
pnpm run db:migrate

# Start development server
pnpm run start:dev

# Verify
curl http://localhost:3000/api/health
```

---

## Security Notes

- **Never commit `.env` files** — `.env` is in `.gitignore`
- **Never expose API keys** in client-facing responses
- **Rotate API keys** periodically
- **Use read-only database credentials** for the application where possible
- **Enable SSL** for database connections in production
