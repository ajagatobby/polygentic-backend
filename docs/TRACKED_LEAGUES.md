# Tracked Leagues

All leagues tracked by the Polygentic prediction system. These are defined in `src/football/football.service.ts` as `TRACKED_LEAGUES` and used across fixture sync, predictions, odds, injuries, standings, and live monitoring.

## Domestic Leagues

| API ID | League                       | Country     | Teams | Format                |
| ------ | ---------------------------- | ----------- | ----- | --------------------- |
| 39     | Premier League               | England     | 20    | 38 matchdays, Aug–May |
| 140    | La Liga                      | Spain       | 20    | 38 matchdays, Aug–May |
| 141    | La Liga 2 (Segunda Division) | Spain       | 22    | 42 matchdays, Aug–Jun |
| 135    | Serie A                      | Italy       | 20    | 38 matchdays, Aug–May |
| 78     | Bundesliga                   | Germany     | 18    | 34 matchdays, Aug–May |
| 61     | Ligue 1                      | France      | 18    | 34 matchdays, Aug–May |
| 88     | Eredivisie                   | Netherlands | 18    | 34 matchdays, Aug–May |
| 94     | Primeira Liga                | Portugal    | 18    | 34 matchdays, Aug–May |

## International Club Competitions

| API ID | League                 | Region | Teams | Format                            |
| ------ | ---------------------- | ------ | ----- | --------------------------------- |
| 2      | UEFA Champions League  | Europe | 36    | League phase + knockouts, Sep–Jun |
| 3      | UEFA Europa League     | Europe | 36    | League phase + knockouts, Sep–May |
| 848    | UEFA Conference League | Europe | 36    | League phase + knockouts, Sep–May |

## Americas

| API ID | League              | Country    | Teams | Format                             |
| ------ | ------------------- | ---------- | ----- | ---------------------------------- |
| 253    | MLS                 | USA/Canada | 29    | Regular season + playoffs, Feb–Dec |
| 262    | Liga MX             | Mexico     | 18    | Apertura + Clausura, Jul–May       |
| 71     | Brasileirao Serie A | Brazil     | 20    | 38 matchdays, Apr–Dec              |
| 128    | Liga Profesional    | Argentina  | 28    | 27 matchdays, Jan–Dec              |

## Other

| API ID | League           | Country      | Teams | Format                |
| ------ | ---------------- | ------------ | ----- | --------------------- |
| 307    | Saudi Pro League | Saudi Arabia | 18    | 34 matchdays, Aug–May |

## Domestic Cups

| API ID | Cup          | Country | Format                |
| ------ | ------------ | ------- | --------------------- |
| 45     | FA Cup       | England | Knockout, rounds vary |
| 143    | Copa del Rey | Spain   | Knockout, rounds vary |
| 81     | DFB Pokal    | Germany | Knockout, rounds vary |

## International Tournaments

These are periodic tournaments -- they produce zero fixtures during off-periods so there is no API cost when inactive.

| API ID | Tournament            | Region        | Format                 |
| ------ | --------------------- | ------------- | ---------------------- |
| 1      | FIFA World Cup        | Global        | Every 4 years, Jun–Jul |
| 15     | FIFA Club World Cup   | Global        | Annual, Jun–Jul        |
| 4      | Euro Championship     | Europe        | Every 4 years, Jun–Jul |
| 6      | Africa Cup of Nations | Africa        | Every 2 years, Jan–Feb |
| 9      | Copa America          | South America | Every 4 years, Jun–Jul |
| 29     | AFC Asian Cup         | Asia          | Every 4 years          |
| 5      | UEFA Nations League   | Europe        | Biennial, Sep–Jun      |
| 13     | CONCACAF Gold Cup     | North America | Every 2 years, Jun–Jul |

## World Cup Qualifiers

| API ID | Tournament                                | Region        | Format                     |
| ------ | ----------------------------------------- | ------------- | -------------------------- |
| 32     | FIFA World Cup Qualifiers - Europe        | Europe        | Group stage + playoffs     |
| 34     | FIFA World Cup Qualifiers - South America | South America | Round-robin (18 matchdays) |
| 36     | FIFA World Cup Qualifiers - Africa        | Africa        | Group stage + playoffs     |

## How Tracking Works

Adding a league ID to the `TRACKED_LEAGUES` array automatically includes it in:

- **Fixture sync** — upcoming and completed fixtures are fetched and stored
- **Standings sync** — league tables are updated periodically
- **Injuries sync** — player injuries and suspensions are tracked
- **Odds sync** — bookmaker odds are collected for upcoming fixtures
- **Prediction pipeline** — daily and pre-match predictions are generated
- **Live monitoring** — in-progress matches are polled and events are broadcast via WebSocket
- **Prediction resolution** — completed fixtures trigger prediction accuracy scoring

## Adding a New League

1. Find the league ID on [API-Football](https://www.api-football.com/documentation-v3#tag/Leagues)
2. Add the ID to `TRACKED_LEAGUES` in `src/football/football.service.ts`
3. Deploy — the next sync cycle will pick up the new league automatically
