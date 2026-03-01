# Polygentic Architecture

## Overview

Polygentic is a soccer prediction backend that combines data from three sources to identify mispriced markets on Polymarket:

1. **Polymarket** — Prediction market prices (the target)
2. **API-Football** — Match data, stats, injuries, live scores, built-in predictions
3. **The Odds API** — Aggregated bookmaker odds from 60+ sportsbooks

The core thesis: Polymarket soccer markets are thinner and slower to update than traditional bookmakers. By comparing Polymarket prices against bookmaker consensus and our own statistical model, we can identify mispricings.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | **NestJS 10** | Modular backend with DI, cron, WebSockets, queues |
| Language | **TypeScript 5** | Type safety across the entire codebase |
| Database | **PostgreSQL** | Time-series price data, market metadata, predictions |
| ORM | **Drizzle ORM** | Type-safe, SQL-like query builder |
| Queue | **Bull (Redis)** | Background job processing for data sync and alerts |
| Scheduler | **@nestjs/schedule** | Cron-based polling for API data |
| WebSocket | **ws** | Polymarket live price stream listener |
| HTTP Client | **Axios** | API requests to all three data sources |
| Validation | **class-validator + class-transformer** | Request/response validation |
| Documentation | **@nestjs/swagger** | Auto-generated API docs |

---

## System Architecture (5 Layers)

```
+-----------------------------------------------------------+
|  Layer 5: API Layer (NestJS Controllers)                  |
|  /api/markets, /api/predictions, /api/fixtures, /api/live |
+-----------------------------------------------------------+
|  Layer 4: Prediction Engine                               |
|  +-- Mispricing Detector (Polymarket vs Bookmakers)       |
|  +-- Statistical Model (form, H2H, injuries)              |
|  +-- Confidence Scorer                                    |
|  +-- Live Alert System                                    |
+-----------------------------------------------------------+
|  Layer 3: Data Processing & Matching                      |
|  +-- Market Matcher (Polymarket <-> real fixtures)        |
|  +-- Probability Normalizer (odds -> probabilities)       |
|  +-- Data Aggregator                                      |
+-----------------------------------------------------------+
|  Layer 2: Data Ingestion Services                         |
|  +-- PolymarketService (Gamma + CLOB + WebSocket)         |
|  +-- FootballService (API-Football)                       |
|  +-- OddsService (The Odds API)                           |
+-----------------------------------------------------------+
|  Layer 1: Database (PostgreSQL + Drizzle ORM)             |
|  +-- Markets, Fixtures, Odds Snapshots                    |
|  +-- Price History, Predictions                           |
|  +-- Sync State, Logs, Alerts                             |
+-----------------------------------------------------------+
```

---

## NestJS Module Structure

```
src/
+-- app.module.ts                    # Root module
+-- main.ts                          # Bootstrap
|
+-- common/                          # Shared utilities
|   +-- config/                      # Environment configuration
|   +-- decorators/                  # Custom decorators
|   +-- filters/                     # Exception filters
|   +-- interceptors/                # Logging, transform interceptors
|   +-- utils/                       # Helpers (probability math, text matching)
|
+-- database/                        # Database module
|   +-- database.module.ts
|   +-- schema/                      # Drizzle schema definitions
|   |   +-- polymarket.schema.ts     # Polymarket events & markets tables
|   |   +-- fixtures.schema.ts       # Fixtures, statistics, injuries tables
|   |   +-- odds.schema.ts           # Bookmaker odds tables
|   |   +-- predictions.schema.ts    # Predictions & alerts tables
|   |   +-- sync.schema.ts           # Sync log tables
|   +-- migrations/                  # Drizzle migrations
|   +-- drizzle.provider.ts          # Drizzle connection provider
|
+-- polymarket/                      # Polymarket data module
|   +-- polymarket.module.ts
|   +-- polymarket.service.ts        # Gamma + CLOB API client
|   +-- polymarket.websocket.ts      # WebSocket price stream listener
|   +-- polymarket.controller.ts     # API endpoints for market data
|   +-- dto/                         # Data transfer objects
|
+-- football/                        # API-Football data module
|   +-- football.module.ts
|   +-- football.service.ts          # API-Football client
|   +-- football.controller.ts       # API endpoints for fixture data
|   +-- live/
|   |   +-- live-score.service.ts    # Live match monitoring
|   |   +-- live-score.gateway.ts    # WebSocket gateway for live updates to clients
|   +-- dto/
|
+-- odds/                            # The Odds API module
|   +-- odds.module.ts
|   +-- odds.service.ts              # Odds API client
|   +-- odds.controller.ts           # API endpoints for odds data
|   +-- probability.util.ts          # Odds-to-probability conversion, vig removal
|   +-- dto/
|
+-- matcher/                         # Market matching module
|   +-- matcher.module.ts
|   +-- matcher.service.ts           # Links Polymarket markets to fixtures
|   +-- fuzzy-match.util.ts          # Text similarity / fuzzy matching
|
+-- prediction/                      # Prediction engine module
|   +-- prediction.module.ts
|   +-- prediction.service.ts        # Main prediction orchestrator
|   +-- mispricing.service.ts        # Mispricing detection (Polymarket vs bookmakers)
|   +-- statistical-model.service.ts # Form, H2H, injury-based model
|   +-- confidence.service.ts        # Confidence scoring
|   +-- prediction.controller.ts     # API endpoints for predictions
|   +-- dto/
|
+-- sync/                            # Data synchronization module
|   +-- sync.module.ts
|   +-- sync.service.ts              # Orchestrates all sync jobs
|   +-- sync.scheduler.ts            # Cron job definitions
|
+-- alerts/                          # Alert system module
|   +-- alerts.module.ts
|   +-- alerts.service.ts            # Generate and manage alerts
|   +-- alerts.controller.ts         # API endpoints for alerts
```

---

## Data Flow

### 1. Periodic Sync (every 15-30 minutes)

```
Cron Trigger
    |
    +-> PolymarketService.syncMarkets()
    |       -> Fetch active soccer events from Gamma API
    |       -> Fetch current prices from CLOB API
    |       -> Store in polymarket_events + polymarket_markets + price_history
    |
    +-> FootballService.syncFixtures()
    |       -> Fetch upcoming fixtures from API-Football
    |       -> Fetch predictions, injuries, team stats
    |       -> Store in fixtures + fixture_statistics + injuries + team_form
    |
    +-> OddsService.syncOdds()
    |       -> Fetch odds for active soccer leagues
    |       -> Convert to implied probabilities, remove vig
    |       -> Store in bookmaker_odds
    |
    +-> MatcherService.matchMarkets()
    |       -> Link Polymarket markets to real fixtures
    |       -> Store in market_fixture_links
    |
    +-> PredictionService.generatePredictions()
            -> Run mispricing detection
            -> Run statistical model
            -> Calculate confidence scores
            -> Store in predictions table
            -> Generate alerts for significant mispricings
```

### 2. Live Match Flow (during active matches)

```
Match Start Detected
    |
    +-> LiveScoreService.startMonitoring(fixtureId)
    |       -> Poll API-Football /fixtures?live=all every 30 seconds
    |       -> Detect events: goals, red cards, penalties
    |
    +-> PolymarketWebSocket.subscribe(marketTokenIds)
    |       -> Listen for real-time price changes
    |
    +-> On Significant Event (goal, red card):
            -> Fetch updated bookmaker odds (The Odds API)
            -> Compare with current Polymarket price
            -> If gap > threshold: generate LIVE alert
            -> Update prediction with new data
```

### 3. API Request Flow

```
Client Request -> Controller -> Service -> Database
                                       -> External API (if cache miss)
```

---

## Key Design Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| **Sync strategy** | Cron-based polling | API rate limits make real-time impractical for most data; 15-30 min intervals sufficient for prediction markets |
| **Live scores** | API-Football Pro plan polling | 30-second polling during live matches; Pro plan (7,500 req/day) supports ~10 concurrent matches |
| **Market matching** | Fuzzy text matching + manual overrides | Polymarket titles are human-written with no standard format |
| **Sharp book weighting** | Pinnacle > Betfair > rest | Pinnacle is the industry standard for true odds |
| **Queue system** | Bull + Redis | Handles async processing for data sync, prevents API rate limit violations |
| **Database** | PostgreSQL | Excellent for time-series data, complex joins, and the relational nature of our data model |

---

## Rate Limit Budget (Pro Plans)

| API | Budget | Allocation |
|---|---|---|
| **API-Football** | 7,500 req/day, 300/min | ~5,000 for periodic sync, ~2,500 for live match monitoring |
| **The Odds API** | Paid plan credits | Batch by sport key to minimize credit usage |
| **Polymarket** | 500 events/10s | Very generous; no concern |

---

## Deployment Considerations

- **Runtime:** Node.js with NestJS (long-running process, not serverless)
- **Database:** PostgreSQL (managed service recommended: Neon, Supabase, or AWS RDS)
- **Redis:** Required for Bull queue (managed Redis recommended)
- **Process manager:** PM2 or Docker for production
- **Monitoring:** Health check endpoint + sync log table for observability
