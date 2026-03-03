# Polygentic Architecture

## Overview

Polygentic is a soccer prediction backend that uses a 3-agent AI pipeline to generate match predictions for 30 tracked football competitions worldwide. The system:

1. **Syncs data** from API-Football (fixtures, stats, injuries, standings, lineups, live scores)
2. **Collects odds** from The Odds API (60+ bookmakers, consensus probabilities)
3. **Generates AI predictions** using a pipeline: Data Collection -> Perplexity research -> Claude analysis
4. **Monitors live matches** via adaptive polling with WebSocket broadcast
5. **Resolves predictions** automatically after matches complete (accuracy scoring, Brier scores)

---

## Tech Stack

| Layer             | Technology                              | Purpose                                                  |
| ----------------- | --------------------------------------- | -------------------------------------------------------- |
| Framework         | **NestJS 11**                           | Modular backend with DI, cron, WebSockets                |
| Language          | **TypeScript 5**                        | Type safety across the entire codebase                   |
| Database          | **PostgreSQL** (Supabase)               | Match data, predictions, alerts, lineups                 |
| ORM               | **Drizzle ORM**                         | Type-safe, SQL-like query builder                        |
| Durable Execution | **Trigger.dev**                         | Prediction pipeline, sync+resolve workflows with retries |
| Scheduler         | **@nestjs/schedule**                    | Lightweight cron-based data sync                         |
| AI - Research     | **Perplexity Sonar**                    | Real-time web research for match context                 |
| AI - Analysis     | **Anthropic Claude**                    | Structured match prediction generation                   |
| WebSocket         | **Socket.IO**                           | Live score broadcast to clients                          |
| HTTP Client       | **Axios**                               | API requests to external data sources                    |
| Validation        | **class-validator + class-transformer** | Request/response validation                              |
| Documentation     | **@nestjs/swagger**                     | Auto-generated API docs                                  |

---

## System Architecture (5 Layers)

```
+-----------------------------------------------------------+
|  Layer 5: API Layer (NestJS Controllers)                  |
|  /api/fixtures, /api/predictions, /api/alerts, /api/live  |
|  /api/teams, /api/leagues, /api/odds, /api/health         |
+-----------------------------------------------------------+
|  Layer 4: AI Prediction Pipeline (3-Agent System)         |
|  +-- DataCollectorAgent (stats, form, injuries, lineups)  |
|  +-- ResearchAgent (Perplexity Sonar web research)        |
|  +-- AnalysisAgent (Claude structured prediction)         |
|  +-- Prediction Resolver (Brier score, wasCorrect)        |
+-----------------------------------------------------------+
|  Layer 3: Live Monitoring & Event Handling                |
|  +-- LiveScoreService (adaptive polling)                  |
|  +-- LiveEventHandler (goal, red card, match end)         |
|  +-- LiveScoreGateway (WebSocket broadcast)               |
+-----------------------------------------------------------+
|  Layer 2: Data Ingestion Services                         |
|  +-- FootballService (API-Football: 30 leagues)           |
|  +-- OddsService (The Odds API: 60+ bookmakers)           |
|  +-- SyncScheduler (NestJS cron jobs)                     |
|  +-- Trigger.dev Schedules (prediction pipeline crons)    |
+-----------------------------------------------------------+
|  Layer 1: Database (PostgreSQL + Drizzle ORM)             |
|  +-- Fixtures, Teams, Statistics, Events, Lineups         |
|  +-- Injuries, Team Form, Standings                       |
|  +-- Predictions, Alerts                                  |
|  +-- Bookmaker Odds, Consensus Odds                       |
|  +-- Sync Logs                                            |
+-----------------------------------------------------------+
```

---

## NestJS Module Structure

```
src/
+-- app.module.ts                    # Root module
+-- main.ts                          # Bootstrap (port 8080)
|
+-- common/                          # Shared utilities
|   +-- config/                      # Environment configuration
|   +-- decorators/                  # Custom decorators
|   +-- filters/                     # Exception filters
|   +-- interceptors/                # Logging, transform interceptors
|
+-- database/                        # Database module
|   +-- database.module.ts
|   +-- schema/
|   |   +-- fixtures.schema.ts       # teams, fixtures, fixture_statistics,
|   |   |                            # fixture_events, injuries, fixture_lineups, team_form
|   |   +-- predictions.schema.ts    # predictions, alerts
|   |   +-- odds.schema.ts           # bookmaker_odds, consensus_odds
|   |   +-- sync.schema.ts           # sync_log
|   |   +-- index.ts                 # Barrel export
|   +-- migrations/
|   +-- drizzle.provider.ts          # Drizzle connection provider
|
+-- football/                        # Football data module
|   +-- football.module.ts
|   +-- football.service.ts          # API-Football client, data sync, season logic
|   +-- football.controller.ts       # REST endpoints for fixtures, teams, leagues, lineups
|   +-- live/
|   |   +-- live-score.service.ts    # Adaptive live match polling
|   |   +-- live-score.gateway.ts    # WebSocket gateway for live updates
|   |   +-- live-event-handler.ts    # Event-driven DB persistence + resolution trigger
|   +-- dto/
|       +-- fixture-query.dto.ts     # FixtureQueryDto, MatchState enum
|
+-- odds/                            # The Odds API module
|   +-- odds.module.ts
|   +-- odds.service.ts              # Odds API client
|   +-- odds.controller.ts           # Odds endpoints
|   +-- probability.util.ts          # Odds-to-probability, vig removal
|   +-- dto/
|
+-- agents/                          # AI Prediction Pipeline
|   +-- agents.module.ts
|   +-- agents.service.ts            # Pipeline orchestration, resolvePredictions()
|   +-- data-collector.agent.ts      # Collects all match data (reads DB lineups first)
|   +-- research.agent.ts            # Perplexity Sonar web research
|   +-- analysis.agent.ts            # Claude structured prediction generation
|
+-- alerts/                          # Alert system module
|   +-- alerts.module.ts
|   +-- alerts.service.ts            # Alert CRUD, createLineupAlert(), createLiveEventAlert()
|   +-- alerts.controller.ts         # Alert endpoints
|
+-- sync/                            # Data synchronization module
|   +-- sync.module.ts
|   +-- sync.service.ts              # Orchestrates sync operations
|   +-- sync.scheduler.ts            # NestJS @Cron jobs (fixtures, injuries, standings, odds)
|
+-- health/                          # Health check module
|   +-- health.module.ts
|   +-- health.controller.ts         # GET /api/health
|
+-- trigger/                         # Trigger.dev tasks (runs outside NestJS DI)
|   +-- init.ts                      # Standalone service bootstrapper
|   +-- generate-prediction.ts       # Single fixture 3-agent pipeline
|   +-- generate-daily-predictions.ts # Batch daily + pre-match predictions
|   +-- lineup-prediction.ts         # Lineup-aware prediction regeneration
|   +-- sync-and-resolve.ts          # Sync completed fixtures + resolve predictions
|   +-- schedules.ts                 # Trigger.dev cron schedule definitions
|
+-- scripts/                         # CLI scripts
    +-- backfill-historical.ts       # 6-month historical data backfill
    +-- sync-fixtures.ts             # Manual fixture/standings/injuries sync
```

---

## Data Flow

### 1. Periodic Data Sync (NestJS Cron)

Lightweight, idempotent data sync that runs in-process.

```
Cron Trigger
    |
    +-> FootballService.syncFixtures()          [every 30 min]
    |       -> Fetch upcoming fixtures for all 30 tracked leagues
    |       -> Auto-detect season per league (calendar-year aware)
    |       -> Upsert into fixtures table
    |
    +-> FootballService.syncInjuries()          [every 2 hours]
    |       -> Fetch injuries for all tracked leagues
    |       -> Auto-detect season, handle FK constraints
    |       -> Upsert into injuries table
    |
    +-> FootballService.syncStandings()         [every 2 hours]
    |       -> Fetch league tables, team form, records
    |       -> Auto-detect season (calendar-year leagues try both)
    |       -> Upsert into team_form table
    |
    +-> OddsService.syncOdds()                  [every 6 hours]
            -> Fetch bookmaker odds from The Odds API
            -> Convert to probabilities, remove vig
            -> Calculate weighted consensus
            -> Upsert into bookmaker_odds + consensus_odds
```

### 2. AI Prediction Pipeline (Trigger.dev)

Durable, retryable prediction workloads.

```
Trigger.dev Schedule
    |
    +-> Daily at 6 AM UTC: generate-daily-predictions
    |       -> Query fixtures in next 48 hours
    |       -> Fan out: generate-prediction per fixture
    |           |
    |           +-> DataCollectorAgent.collect()
    |           |       -> Fixture data, team form, H2H, injuries
    |           |       -> DB lineups (or API fallback)
    |           |       -> Bookmaker odds + consensus
    |           |
    |           +-> ResearchAgent.research()
    |           |       -> Perplexity Sonar web search
    |           |       -> Recent news, team updates, tactical analysis
    |           |
    |           +-> AnalysisAgent.analyze()
    |           |       -> Claude generates structured prediction
    |           |       -> Probabilities, confidence, key factors, value bets
    |           |
    |           +-> Store prediction + create alert if high confidence
    |
    +-> Every 15 min: generate-pre-match-predictions
    |       -> Fixtures kicking off within 1 hour
    |       -> Latest data capture before match starts
    |
    +-> Every 5 min: lineup-aware-prediction
    |       -> Check for newly published lineups (~60min before kickoff)
    |       -> Persist lineups to fixture_lineups table
    |       -> Re-run full pipeline with confirmed XI/formation
    |       -> Create lineup_change alert
    |
    +-> Every hour: sync-and-resolve
            -> Step 1: syncCompletedFixtures() — fetch final scores
            -> Step 2: resolvePredictions() — compute wasCorrect, Brier score
```

### 3. Live Match Flow

```
Server Boot -> OnModuleInit -> LiveScoreService.startMonitoring()
    |
    +-> Adaptive Polling (API-Football /fixtures?live=all)
    |       -> 15s during penalty shootout
    |       -> 30s during normal play
    |       -> 60s during halftime
    |
    +-> Event Detection (diff against previous state)
    |       -> Goals, red cards, match start/end, status changes
    |
    +-> LiveEventHandler (event-driven)
    |       -> goal: update score in DB, create alert
    |       -> red-card: create alert
    |       -> match-start: update status to 1H
    |       -> match-end: persist final score, trigger immediate
    |       |              Trigger.dev sync+resolve for instant resolution
    |       -> status-change: update status in DB
    |
    +-> LiveScoreGateway (WebSocket broadcast)
            -> Every 30s: broadcast full match state to /live namespace
            -> Individual events emitted as they occur
```

### 4. API Request Flow

```
Client Request -> Controller -> Service -> Database
                                       -> External API (if no DB data)
```

---

## Key Design Decisions

| Decision              | Choice                                         | Reasoning                                                                      |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| **Prediction engine** | 3-agent AI pipeline (Perplexity + Claude)      | Richer analysis than heuristic models; web research captures real-time context |
| **Durable execution** | Trigger.dev for prediction workloads           | Automatic retries, observability dashboard, handles AI API failures gracefully |
| **Lightweight sync**  | NestJS @Cron for data sync                     | Simple, idempotent operations that don't need retry infrastructure             |
| **Live scores**       | Adaptive polling (15-60s)                      | API-Football Pro plan supports ~10 concurrent matches; adaptive saves budget   |
| **Season detection**  | `getCurrentSeason()` + `CALENDAR_YEAR_LEAGUES` | Single source of truth; handles MLS/Brasileirao/Liga MX/Argentina correctly    |
| **Lineup strategy**   | Persist to DB, read DB first                   | Avoids redundant API calls; lineups available even after API cache expires     |
| **Database**          | PostgreSQL (Supabase)                          | Excellent for relational data, JSONB for flexible fields, managed hosting      |
| **No Redis/Bull**     | Removed in favor of Trigger.dev                | Trigger.dev provides better retry, observability, and doesn't require Redis    |

---

## Rate Limit Budget (Pro Plans)

| API                  | Budget                 | Allocation                                                             |
| -------------------- | ---------------------- | ---------------------------------------------------------------------- |
| **API-Football**     | 7,500 req/day, 300/min | ~4,500 for periodic sync, ~2,500 for live monitoring, ~500 for lineups |
| **The Odds API**     | 20,000 credits/month   | ~4,600 credits/month across all leagues                                |
| **Perplexity Sonar** | Per-request (paid)     | ~50-100 predictions/day                                                |
| **Anthropic Claude** | Per-token (paid)       | ~50-100 predictions/day                                                |

---

## Deployment Considerations

- **Runtime:** Node.js with NestJS (long-running process, not serverless)
- **Database:** PostgreSQL (Supabase managed instance)
- **Trigger.dev:** Cloud workers for prediction pipeline (external to main server)
- **Process manager:** PM2 or Docker for production
- **Monitoring:** Health check endpoint + Trigger.dev dashboard + sync_log table
- **Port:** 8080 (default)
