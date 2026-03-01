# Polymarket API Integration

## Overview

Polymarket exposes three APIs for different purposes:

1. **Gamma API** — Market/event discovery (read-only, no auth)
2. **CLOB API** — Prices, orderbook, trading (read-only is free, trading requires auth)
3. **Data API** — Positions, trades, activity (read-only, no auth)

We also use **WebSocket connections** for real-time price updates during live matches.

---

## 1. Gamma API (Market Discovery)

**Base URL:** `https://gamma-api.polymarket.com`
**Authentication:** None required

### Fetch Soccer Events

```
GET /events?tag=soccer&active=true&closed=false&limit=100&offset=0
GET /events?tag=football&active=true&closed=false&limit=100
```

**Note:** Polymarket may tag soccer markets as "soccer", "football", or under specific league/tournament tags. We should search multiple tags.

**Response structure:**

```json
[
  {
    "id": "12345",
    "slug": "will-arsenal-win-the-premier-league-2025-26",
    "title": "Will Arsenal win the Premier League 2025/26?",
    "description": "This market resolves to Yes if Arsenal finishes first in the Premier League...",
    "startDate": "2025-08-01T00:00:00Z",
    "endDate": "2026-05-31T00:00:00Z",
    "active": true,
    "closed": false,
    "archived": false,
    "new": false,
    "featured": false,
    "restricted": false,
    "liquidity": 125000.5,
    "volume": 890000.0,
    "volume24hr": 12500.0,
    "competitive": 0.95,
    "tags": [
      { "id": "soccer", "slug": "soccer", "label": "Soccer" },
      {
        "id": "premier-league",
        "slug": "premier-league",
        "label": "Premier League"
      }
    ],
    "markets": [
      {
        "id": "67890",
        "question": "Will Arsenal win the Premier League 2025/26?",
        "conditionId": "0xabc123...",
        "questionId": "0xdef456...",
        "slug": "will-arsenal-win-the-premier-league-2025-26",
        "outcomes": "[\"Yes\",\"No\"]",
        "outcomePrices": "[\"0.3500\",\"0.6500\"]",
        "clobTokenIds": "[\"token_yes_id\",\"token_no_id\"]",
        "volume": 890000.0,
        "volume24hr": 12500.0,
        "liquidity": 125000.5,
        "active": true,
        "closed": false,
        "acceptingOrders": true,
        "enableOrderBook": true
      }
    ]
  }
]
```

### Search Events

```
GET /public-search?query=premier+league&limit=20
```

Useful for finding markets by keyword when tag-based search isn't sufficient.

### Get Sports Metadata

```
GET /sports
```

Returns sport categories with tag IDs for discovering how Polymarket categorizes soccer events.

### Get Tags

```
GET /tags
```

Returns all available tags. Search for soccer-related tags: `soccer`, `football`, `premier-league`, `la-liga`, `champions-league`, `world-cup`, etc.

---

## 2. CLOB API (Prices & Orderbook)

**Base URL:** `https://clob.polymarket.com`
**Authentication:** None for read-only price data

### Get Current Price

```
GET /price?token_id={tokenId}&side=buy
GET /price?token_id={tokenId}&side=sell
```

**Response:**

```json
{
  "price": "0.3500"
}
```

### Get Prices (Batch)

```
GET /prices?token_ids={tokenId1},{tokenId2}
```

**Response:**

```json
{
  "token_id_1": { "buy": "0.3500", "sell": "0.3450" },
  "token_id_2": { "buy": "0.6500", "sell": "0.6450" }
}
```

### Get Midpoint

```
GET /midpoint?token_id={tokenId}
```

**Response:**

```json
{
  "mid": "0.3475"
}
```

The midpoint is the average of best bid and best ask — often the most accurate current probability estimate.

### Get Spread

```
GET /spread?token_id={tokenId}
```

**Response:**

```json
{
  "spread": "0.0050"
}
```

The bid-ask spread indicates liquidity. Tight spreads = liquid market = more reliable price. Wide spreads = thin market = potential opportunity but also risk.

### Get Order Book

```
GET /book?token_id={tokenId}
```

**Response:**

```json
{
  "market": "0x...",
  "asset_id": "token_id",
  "bids": [
    { "price": "0.3450", "size": "500.00" },
    { "price": "0.3400", "size": "1200.00" },
    { "price": "0.3350", "size": "800.00" }
  ],
  "asks": [
    { "price": "0.3500", "size": "750.00" },
    { "price": "0.3550", "size": "1000.00" },
    { "price": "0.3600", "size": "600.00" }
  ]
}
```

Order book depth helps assess:

- **Liquidity** — How much can be traded without moving the price
- **Market confidence** — Large orders near midpoint suggest strong conviction

### Get Price History

```
GET /prices-history?market={conditionId}&interval=max&fidelity=60
```

**Parameters:**

| Param      | Values                              | Description            |
| ---------- | ----------------------------------- | ---------------------- |
| `interval` | `1d`, `1w`, `1m`, `3m`, `6m`, `max` | Time range             |
| `fidelity` | `1`, `5`, `15`, `60`, `1440`        | Candle size in minutes |

**Response:**

```json
{
  "history": [
    { "t": 1710000000, "p": 0.32 },
    { "t": 1710003600, "p": 0.335 },
    { "t": 1710007200, "p": 0.35 }
  ]
}
```

**Usage:** Track price movements over time to identify trends, momentum, and reaction speed to events.

---

## 3. WebSocket (Live Price Stream)

**URL:** `wss://ws-subscriptions-clob.polymarket.com/ws/market`

### Connection

```typescript
import WebSocket from 'ws';

const ws = new WebSocket(
  'wss://ws-subscriptions-clob.polymarket.com/ws/market',
);

ws.on('open', () => {
  // Subscribe to specific markets
  ws.send(
    JSON.stringify({
      type: 'market',
      assets_id: ['token_yes_id', 'token_no_id'],
    }),
  );
});

ws.on('message', (data: string) => {
  const parsed = JSON.parse(data);
  // Handle real-time price updates, trades, orderbook changes
});
```

### Message Types

**Price update:**

```json
{
  "type": "price_change",
  "asset_id": "token_yes_id",
  "price": "0.3600",
  "timestamp": 1710014400
}
```

**Trade:**

```json
{
  "type": "trade",
  "asset_id": "token_yes_id",
  "price": "0.3550",
  "size": "250.00",
  "side": "buy",
  "timestamp": 1710014400
}
```

**Usage during live matches:**

1. API-Football detects a goal or red card event
2. We check if Polymarket price has moved
3. We fetch updated bookmaker odds from The Odds API
4. If Polymarket price hasn't adjusted but bookmaker odds have: **mispricing alert**

---

## 4. Data API (Activity)

**Base URL:** `https://data-api.polymarket.com`
**Authentication:** None required

### Get Market Trades

```
GET /trades?market={conditionId}&limit=100
```

Useful for analyzing trading activity patterns — sudden volume spikes may indicate informed trading.

---

## Key Data Fields We Extract

### From Each Polymarket Market

| Field                   | Type     | Use                                       |
| ----------------------- | -------- | ----------------------------------------- |
| `id`                    | string   | Unique market identifier                  |
| `title` / `question`    | string   | Human-readable — input for market matcher |
| `slug`                  | string   | URL-friendly identifier                   |
| `conditionId`           | string   | CTF contract identifier                   |
| `clobTokenIds`          | string[] | Token IDs for Yes/No outcomes             |
| `outcomePrices`         | string[] | Current implied probabilities             |
| `volume`                | number   | Total volume traded ($)                   |
| `volume24hr`            | number   | 24-hour volume ($)                        |
| `liquidity`             | number   | Current liquidity available               |
| `active`                | boolean  | Whether market is accepting trades        |
| `closed`                | boolean  | Whether market has resolved               |
| `tags`                  | object[] | Categories (soccer, league names, etc.)   |
| `startDate` / `endDate` | string   | Market time boundaries                    |

### Derived Metrics We Calculate

| Metric         | Formula                         | Use                       |
| -------------- | ------------------------------- | ------------------------- |
| Midpoint price | (best_bid + best_ask) / 2       | Most accurate probability |
| Bid-ask spread | best_ask - best_bid             | Liquidity indicator       |
| Price momentum | price_now - price_24h_ago       | Trend detection           |
| Volume ratio   | volume_24hr / volume            | Activity level            |
| Book depth     | sum(bid_sizes) + sum(ask_sizes) | Liquidity depth           |

---

## Rate Limits

| Endpoint Group         | Limit                   |
| ---------------------- | ----------------------- |
| General                | 15,000 req / 10 seconds |
| Gamma API general      | 4,000 req / 10 seconds  |
| `/events`              | 500 req / 10 seconds    |
| `/markets`             | 300 req / 10 seconds    |
| `/public-search`       | 350 req / 10 seconds    |
| CLOB `/book`           | 1,500 req / 10 seconds  |
| CLOB `/prices-history` | 1,000 req / 10 seconds  |
| Data API general       | 1,000 req / 10 seconds  |

Rate limits are enforced via **Cloudflare throttling** — requests are queued (slowed), not immediately rejected. Sliding time windows. These limits are extremely generous for our use case.

---

## Market Resolution

### How Polymarket Soccer Markets Resolve

1. The event occurs (match finishes, season ends, transfer deadline passes)
2. Anyone can **propose a resolution** by posting a bond (~$750 USDC.e)
3. **2-hour challenge period** begins
4. If no dispute: market resolves as proposed
5. If disputed: new proposal round (escalation)
6. Final escalation: UMA DVM token holder vote

### Resolution Outcomes

| Outcome         | Payout                              |
| --------------- | ----------------------------------- |
| Yes wins        | Yes token = $1.00, No token = $0.00 |
| No wins         | Yes token = $0.00, No token = $1.00 |
| Unknown/Invalid | Both tokens = $0.50 (rare)          |

### Sports-Specific Behavior

- Outstanding **limit orders are auto-cancelled at game start time**
- Markets for specific matches typically close when the match begins
- Season-long markets (league winner) remain open until the season ends
- Postponed/cancelled matches: resolution depends on market description rules

---

## Market Types We Encounter

| Type               | Example                                      | Matching Strategy                              |
| ------------------ | -------------------------------------------- | ---------------------------------------------- |
| Match outcome      | "Will Arsenal beat Man United on March 15?"  | Match to specific fixture by team names + date |
| League winner      | "Will Arsenal win the Premier League?"       | Match to league outright market                |
| Top 4 / Relegation | "Will Man City finish in the top 4?"         | Match to league standings + outright odds      |
| Transfer           | "Will Mbappe join Arsenal before September?" | No direct odds equivalent — news-based         |
| Tournament         | "Will Brazil win the 2026 World Cup?"        | Match to tournament outright market            |
| Player props       | "Will Haaland score 30+ league goals?"       | Match to player prop odds if available         |
| Manager            | "Will Ten Hag be sacked before December?"    | No direct odds equivalent — news-based         |

Our system classifies each Polymarket market into one of these types to determine which data sources and prediction models apply.
