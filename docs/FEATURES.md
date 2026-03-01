# Features & Implementation Phases

## Overview

The project is broken into 7 phases, each building on the previous. Phases 1-4 deliver core value. Phases 5-7 add advanced capabilities.

---

## Phase 1: Foundation

**Goal:** Set up the project infrastructure and database.

### Features

- [ ] **NestJS project setup** — Configure modules, middleware, exception filters, logging
- [ ] **PostgreSQL + Drizzle ORM setup** — Connection, schema definitions, migration system
- [ ] **Database schema creation** — All 15 tables as defined in DATABASE_SCHEMA.md
- [ ] **Environment configuration** — Validated config module for all API keys and settings
- [ ] **Health check endpoint** — `GET /api/health` returning system status
- [ ] **Swagger API documentation** — Auto-generated OpenAPI docs at `/api/docs`
- [ ] **Redis + Bull queue setup** — For background job processing

### Deliverables

- Working NestJS application with database connection
- All tables created via migration
- Health check returning OK
- Swagger UI accessible

---

## Phase 2: Polymarket Integration

**Goal:** Fetch and store soccer markets from Polymarket.

### Features

- [ ] **PolymarketService** — HTTP client for Gamma API and CLOB API
- [ ] **Event discovery** — Fetch active soccer events by tags (soccer, football, league-specific)
- [ ] **Market data sync** — Store events and markets in database
- [ ] **Price fetching** — Get current prices, midpoints, spreads from CLOB API
- [ ] **Price history tracking** — Periodic snapshots stored in polymarket_price_history
- [ ] **Market type classification** — Classify markets as match_outcome, league_winner, transfer, etc.
- [ ] **Cron job: sync markets** — Every 15 minutes, refresh Polymarket data
- [ ] **API endpoints:**
  - `GET /api/markets` — List all tracked soccer markets
  - `GET /api/markets/:id` — Market detail with price history
  - `GET /api/markets/search?q=arsenal` — Search markets

### Deliverables

- Polymarket soccer markets stored and updating every 15 minutes
- API endpoints returning market data
- Price history accumulating over time

---

## Phase 3: API-Football Integration

**Goal:** Fetch match data, team stats, injuries, and built-in predictions.

### Features

- [ ] **FootballService** — HTTP client for API-Football v3
- [ ] **League tracking** — Configure which leagues to monitor (top 20+ leagues)
- [ ] **Fixture sync** — Fetch upcoming fixtures for tracked leagues
- [ ] **Team data sync** — Store team profiles and season statistics
- [ ] **Injury sync** — Fetch current injuries per league
- [ ] **H2H data** — Fetch head-to-head history for upcoming matches
- [ ] **Predictions fetch** — Get API-Football's built-in predictions per fixture
- [ ] **Team form calculation** — Compute rolling form from recent results
- [ ] **Standings sync** — Current league tables
- [ ] **Cron jobs:**
  - Fixture sync: every 30 minutes
  - Injury sync: every 2 hours
  - Team stats sync: every 6 hours
  - Standings sync: every 2 hours
- [ ] **API endpoints:**
  - `GET /api/fixtures` — Upcoming fixtures
  - `GET /api/fixtures/:id` — Fixture detail with stats, injuries, predictions
  - `GET /api/teams/:id` — Team profile with form and stats
  - `GET /api/leagues` — Tracked leagues with standings

### Deliverables

- Fixture data for all tracked leagues
- Injuries, team stats, H2H data populated
- API-Football predictions stored
- Cron jobs running on schedule

---

## Phase 4: The Odds API Integration

**Goal:** Fetch bookmaker odds, calculate consensus probabilities, detect mispricings.

### Features

- [ ] **OddsService** — HTTP client for The Odds API v4
- [ ] **Sport key mapping** — Map soccer leagues to Odds API sport keys
- [ ] **Odds fetching** — Fetch h2h, totals, spreads for tracked leagues
- [ ] **Probability conversion** — Convert decimal odds to implied probabilities
- [ ] **Vig removal** — Normalize probabilities by removing overround
- [ ] **Weighted consensus calculation** — Compute consensus using bookmaker sharpness weights
- [ ] **Consensus odds storage** — Pre-calculated consensus probabilities in consensus_odds table
- [ ] **Quota tracking** — Monitor credit usage via response headers, pause if low
- [ ] **Cron jobs:**
  - Odds sync for top 5 leagues: every 6 hours
  - Odds sync for other leagues: every 12 hours
  - Outright/futures: daily
- [ ] **API endpoints:**
  - `GET /api/odds/:eventId` — Odds for a specific event with all bookmakers
  - `GET /api/odds/consensus/:eventId` — Consensus probability for an event

### Deliverables

- Bookmaker odds for all tracked soccer leagues
- Consensus probabilities calculated and stored
- Quota management preventing overspend

---

## Phase 5: Market Matching & Prediction Engine

**Goal:** Link Polymarket markets to real fixtures and generate predictions.

### Features

- [ ] **MatcherService** — Links Polymarket markets to API-Football fixtures and Odds API events
- [ ] **Fuzzy text matching** — Extract team names, dates, league names from Polymarket titles
- [ ] **Match type routing** — Different matching logic per market type
- [ ] **Manual override support** — Admin can manually link markets to fixtures
- [ ] **MispricingService** — Compare Polymarket prices against bookmaker consensus
- [ ] **StatisticalModelService** — Heuristic model combining form, H2H, injuries, goals
- [ ] **PredictionService** — Combine all signals into final prediction
- [ ] **ConfidenceService** — Score prediction confidence (0-100)
- [ ] **RecommendationEngine** — Generate BUY_YES / BUY_NO / HOLD / NO_SIGNAL
- [ ] **Cron job: generate predictions** — After each data sync cycle
- [ ] **API endpoints:**
  - `GET /api/predictions` — All current predictions, sorted by confidence
  - `GET /api/predictions/mispricings` — Only markets with significant mispricings
  - `GET /api/predictions/:id` — Prediction detail with all signals
  - `GET /api/predictions/history` — Past predictions with outcomes

### Deliverables

- Polymarket markets linked to real fixtures
- Predictions generated with mispricing detection
- Confidence scores and recommendations
- API serving prediction data

---

## Phase 6: Live Match Monitoring

**Goal:** Real-time monitoring during live matches with live mispricing detection.

### Features

- [ ] **LiveScoreService** — Poll API-Football for live match data every 30 seconds
- [ ] **Live event detection** — Detect goals, red cards, penalties in real-time
- [ ] **PolymarketWebSocket** — Persistent WebSocket connection to Polymarket price streams
- [ ] **Live mispricing detection** — Compare live bookmaker odds shifts vs Polymarket price reactions
- [ ] **Live prediction updates** — Recalculate predictions on significant events
- [ ] **Alert generation** — Create alerts for live mispricings
- [ ] **Match lifecycle management** — Auto-start monitoring when matches begin, stop when they end
- [ ] **Rate limit management** — Dynamic polling frequency based on match state and API budget
- [ ] **Lineup sync** — Fetch confirmed lineups ~1 hour before kickoff, adjust predictions
- [ ] **WebSocket gateway** — Expose live data to clients via WebSocket
- [ ] **API endpoints:**
  - `GET /api/live` — All currently live matches with real-time data
  - `GET /api/live/:fixtureId` — Live match detail with events and price movement
  - `WS /ws/live` — WebSocket for real-time updates to clients

### Deliverables

- Live match monitoring during active games
- Real-time Polymarket price tracking via WebSocket
- Live mispricing alerts when Polymarket lags behind bookmaker adjustments
- WebSocket gateway for client consumption

---

## Phase 7: Alerts, Backtesting & Optimization

**Goal:** Alert system, historical analysis, and model calibration.

### Features

- [ ] **AlertService** — Generate and manage alerts across all severity levels
- [ ] **Alert types:**
  - `mispricing` — Significant gap detected between Polymarket and bookmaker consensus
  - `live_event` — Goal/red card detected with Polymarket price lag
  - `price_movement` — Unusual Polymarket price movement (potential informed trading)
  - `lineup_change` — Key player dropped from lineup before match
- [ ] **Backtesting framework** — After markets resolve, compare predictions against outcomes
- [ ] **Accuracy tracking** — Brier scores, calibration curves, ROI calculations
- [ ] **Model calibration** — Adjust signal weights based on historical accuracy
- [ ] **Prediction history** — Full audit trail of every prediction with resolution data
- [ ] **Daily report generation** — Summary of active predictions, hit rate, opportunities
- [ ] **API endpoints:**
  - `GET /api/alerts` — Active alerts
  - `GET /api/alerts/unread` — Unacknowledged alerts
  - `POST /api/alerts/:id/acknowledge` — Mark alert as read
  - `GET /api/analytics/accuracy` — Prediction accuracy metrics
  - `GET /api/analytics/calibration` — Calibration data
  - `GET /api/analytics/roi` — ROI tracking

### Deliverables

- Full alert system with severity levels
- Backtesting tracking resolved predictions
- Accuracy metrics and calibration analysis
- Analytics dashboard API

---

## Summary Timeline

| Phase | Name | Dependencies | Estimated Effort |
|---|---|---|---|
| Phase 1 | Foundation | None | 1-2 days |
| Phase 2 | Polymarket Integration | Phase 1 | 2-3 days |
| Phase 3 | API-Football Integration | Phase 1 | 2-3 days |
| Phase 4 | The Odds API Integration | Phase 1 | 1-2 days |
| Phase 5 | Market Matching & Predictions | Phases 2, 3, 4 | 3-4 days |
| Phase 6 | Live Match Monitoring | Phases 3, 5 | 3-4 days |
| Phase 7 | Alerts & Backtesting | Phases 5, 6 | 2-3 days |

**Note:** Phases 2, 3, and 4 can be developed in parallel since they're independent data ingestion modules that all depend only on Phase 1.

---

## MVP (Minimum Viable Product)

Phases 1-5 constitute the MVP:
- Data from all 3 sources being synced
- Markets matched to fixtures
- Predictions generated with mispricing detection
- API serving predictions

Phases 6-7 are enhancements that add live capabilities and historical analysis.
