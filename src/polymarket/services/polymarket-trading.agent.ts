import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MarketPricingSnapshot } from './polymarket-clob.service';
import {
  MarketMatch,
  OutrightMarketMatch,
  FixtureMarketMatch,
} from './polymarket-matcher.service';

// ─── Shared types ─────────────────────────────────────────────────────

/**
 * The agent's trading decision output.
 */
export interface TradingDecision {
  action: 'bet' | 'skip';
  outcomeIndex: number; // Which outcome to bet on (0 = Yes, 1 = No, etc.)
  outcomeName: string;
  positionSizeUsd: number;
  entryPrice: number;
  kellyFraction: number;
  edgePercent: number;
  reasoning: string; // Claude's full reasoning
  riskAssessment: string;
  confidenceInEdge: number; // 1-10, how confident the agent is in the edge being real
}

/**
 * Bankroll state passed to the agent for context.
 */
export interface BankrollContext {
  initialBudget: number;
  currentBalance: number;
  targetMultiplier: number;
  realizedPnl: number;
  openPositionsCount: number;
  openPositionsValue: number;
  winRate: number;
  totalTrades: number;
  currentDrawdownPct: number;
  maxDrawdownPct: number;
  peakBalance: number;
}

// ─── Outright trading candidate ───────────────────────────────────────

/**
 * Standings/form data for the team this outright market is about.
 */
export interface TeamStandingsContext {
  leaguePosition: number;
  totalTeams: number; // Total teams in the league
  points: number;
  pointsFromTop: number; // How many points behind the leader (0 if leading)
  formString: string; // e.g. "WWDLW"
  last5: {
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
  };
  home: { wins: number; draws: number; losses: number };
  away: { wins: number; draws: number; losses: number };
  goalsForAvg: number;
  goalsAgainstAvg: number;
  attackRating: number;
  defenseRating: number;
  gamesPlayed: number;
  gamesRemaining: number; // Estimated
}

/**
 * A trading candidate for outright markets (league/tournament winner, qualification).
 */
export interface OutrightTradingCandidate {
  type: 'outright';
  match: OutrightMarketMatch;
  pricing: MarketPricingSnapshot;

  // Our estimated probability for this outcome
  estimatedProbability: number;
  polymarketProbability: number;
  rawEdge: number;

  // Standings context
  teamStandings: TeamStandingsContext;

  // Top competitors for context
  topCompetitors: Array<{
    teamName: string;
    position: number;
    points: number;
    formString: string;
  }>;
}

// ─── Match outcome trading candidate ──────────────────────────────────

/**
 * A trading candidate for match outcome markets.
 */
export interface FixtureTradingCandidate {
  type: 'fixture';
  match: FixtureMarketMatch;
  pricing: MarketPricingSnapshot;
  pricingNo?: MarketPricingSnapshot;

  prediction: {
    id: number;
    homeWinProb: number;
    drawProb: number;
    awayWinProb: number;
    predictedHomeGoals: number;
    predictedAwayGoals: number;
    confidence: number;
    keyFactors: string[];
    riskFactors: string[];
    valueBets: any[];
    detailedAnalysis: string;
  };

  ensembleProbability: number;
  polymarketProbability: number;
  rawEdge: number;
}

export type TradingCandidate =
  | OutrightTradingCandidate
  | FixtureTradingCandidate;

// ─── System prompts ───────────────────────────────────────────────────

const OUTRIGHT_TRADING_SYSTEM_PROMPT = `You are an autonomous sports betting trading agent. Your job is to analyze soccer OUTRIGHT market opportunities on Polymarket and make disciplined trading decisions.

## CONTEXT

Outright markets on Polymarket are season-long/tournament-long bets, such as:
- "Will Liverpool win the Premier League 2025-26?"
- "Will Barcelona win the Champions League 2025-26?"
- "Will Italy qualify for the 2026 World Cup?"

These are fundamentally different from match-by-match bets. Key differences:
1. **Time horizon**: Months, not days. Prices fluctuate with each matchday
2. **Information**: League standings, form, injuries, and remaining schedule matter more than any single match
3. **Pricing**: These markets are often inefficient because fewer traders specialize in soccer outrights
4. **Resolution**: Binary — the team either wins or doesn't

## YOUR ROLE

You receive:
1. The team's current league standings and form data
2. Top competitors' standings (to assess relative strength)
3. Polymarket's current pricing
4. Your bankroll state and open positions

You must decide: BET or SKIP, and if betting, how much.

## DECISION FRAMEWORK

### Step 1: Estimate True Probability
Use the standings data to estimate the team's true probability of winning:
- **League position & points gap**: A team 10 points clear with 10 games left is very likely to win. A team 15 points behind is very unlikely
- **Form**: Recent form (last 5 matches) shows trajectory — improving or declining?
- **Season stage**: Early season (much uncertainty) vs late season (standings more predictive)
- **Historical base rates**: In the Premier League, the team leading at the halfway point wins the title ~70-80% of the time
- For tournament winners: Consider the draw, remaining opponents, and knockout format
- For qualification: Consider how many spots are available and the team's position relative to the cutoff

### Step 2: Compare to Polymarket Price
- The Polymarket price IS the market's implied probability
- Your edge = your estimated probability - Polymarket's probability
- Be humble: Polymarket aggregates many opinions. If you see a large edge, ask yourself WHY
- Small edges (3-8%) on clear situations are more reliable than large edges (>15%) which often indicate you're wrong

### Step 3: Assess Market Quality
- Liquidity: Can you fill at the displayed price?
- Spread: Wide spreads eat into edge
- Volume: Low volume = potentially stale prices

### Step 4: Position Sizing (Kelly Criterion)
- Kelly = (edge / (1 - price)) * kellyModifier
- For outrights with long resolution times, use EXTRA conservative sizing (max quarter-Kelly)
- Why: Your capital is locked up for months. Opportunity cost is real
- Cap positions at the configured max

### Step 5: Risk Assessment
- **Correlation**: Multiple bets in the same league are correlated
- **Time risk**: Season-long bets can go sideways before recovering
- **Injury risk**: A key player injury can drastically change title odds
- **Drawdown**: If in drawdown, be extra selective

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "action": "bet" | "skip",
  "outcomeIndex": <0 or 1>,
  "outcomeName": "<the outcome name>",
  "positionSizeUsd": <number, 0 if skip>,
  "entryPrice": <number>,
  "kellyFraction": <number>,
  "edgePercent": <number, effective edge after spread>,
  "reasoning": "<2-4 paragraphs explaining your decision>",
  "riskAssessment": "<1-2 paragraphs on what could go wrong>",
  "confidenceInEdge": <1-10>
}`;

const FIXTURE_TRADING_SYSTEM_PROMPT = `You are an autonomous sports betting trading agent. Your job is to analyze soccer market opportunities on Polymarket and make disciplined trading decisions.

## YOUR ROLE

You receive:
1. A prediction from our ensemble model (Claude analysis + Poisson statistics + bookmaker consensus)
2. Polymarket's current market pricing (midpoint, spread, order book depth)
3. Your current bankroll state and open positions

You must decide: BET or SKIP, and if betting, how much.

## DECISION FRAMEWORK

### Step 1: Validate the Edge
- Compare our ensemble probability against Polymarket's midpoint price
- An edge ONLY exists if our probability differs significantly from Polymarket's price
- Consider: Is our model likely right, or is Polymarket pricing in information we don't have?
- Polymarket is often efficient. A 5% edge is meaningful. A 15%+ edge should make you suspicious

### Step 2: Assess Market Quality
- Liquidity: Can we actually fill at the displayed price? Check order book depth
- Spread: Wide spreads (>5%) eat into edge. Effective edge = raw edge - (spread / 2)
- Volume: Low volume markets may have stale prices
- Time to resolution: Markets close to expiry are less risky

### Step 3: Position Sizing (Kelly Criterion)
- Kelly fraction = (edge / (1 - price)) * kellyModifier
- Cap at max position size
- REDUCE size when in drawdown, many open positions, or moderate confidence

### Step 4: Risk Assessment
- Correlation: Don't overload on the same league/day/outcome type
- Drawdown: Size down or skip marginal opportunities
- Narrative risk: What could make the market right and us wrong?

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "action": "bet" | "skip",
  "outcomeIndex": <0 or 1>,
  "outcomeName": "<the outcome name>",
  "positionSizeUsd": <number, 0 if skip>,
  "entryPrice": <number>,
  "kellyFraction": <number>,
  "edgePercent": <number, effective edge after spread>,
  "reasoning": "<2-4 paragraphs explaining your decision>",
  "riskAssessment": "<1-2 paragraphs on what could go wrong>",
  "confidenceInEdge": <1-10>
}`;

@Injectable()
export class PolymarketTradingAgent {
  private readonly logger = new Logger(PolymarketTradingAgent.name);
  private readonly anthropic: Anthropic;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.anthropic = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
    this.model =
      this.config.get<string>('PREDICTION_MODEL') || 'claude-sonnet-4-20250514';
  }

  /**
   * Evaluate a trading candidate and decide whether to bet.
   */
  async evaluate(
    candidate: TradingCandidate,
    bankroll: BankrollContext,
    openPositions: Array<{
      outcomeName: string;
      fixtureId?: number;
      leagueId?: number;
      positionSizeUsd: number;
    }>,
  ): Promise<TradingDecision> {
    const systemPrompt =
      candidate.type === 'outright'
        ? OUTRIGHT_TRADING_SYSTEM_PROMPT
        : FIXTURE_TRADING_SYSTEM_PROMPT;

    const prompt =
      candidate.type === 'outright'
        ? this.buildOutrightPrompt(candidate, bankroll, openPositions)
        : this.buildFixturePrompt(candidate, bankroll, openPositions);

    const logLabel =
      candidate.type === 'outright'
        ? `${candidate.match.teamName} to win ${candidate.match.leagueName}`
        : `${candidate.match.homeTeamName} vs ${candidate.match.awayTeamName}`;

    this.logger.log(
      `Evaluating trade: ${logLabel} ` +
        `(edge: ${(candidate.rawEdge * 100).toFixed(1)}%)`,
    );

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      temperature: 0.1,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content:
            prompt +
            '\n\nIMPORTANT: Your ENTIRE response must be a single valid JSON object. Do NOT include any text, explanation, or markdown before or after the JSON. Start your response with { and end with }.',
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock?.text ?? '';

    return this.parseDecision(rawText, candidate);
  }

  // ─── Outright prompt construction ───────────────────────────────────

  private buildOutrightPrompt(
    candidate: OutrightTradingCandidate,
    bankroll: BankrollContext,
    openPositions: Array<{
      outcomeName: string;
      fixtureId?: number;
      leagueId?: number;
      positionSizeUsd: number;
    }>,
  ): string {
    const sections: string[] = [];
    const {
      match,
      pricing,
      teamStandings: standings,
      topCompetitors,
    } = candidate;

    const kellyFraction =
      this.config.get<number>('POLYMARKET_KELLY_FRACTION') || 0.25;
    const maxPositionPct =
      this.config.get<number>('POLYMARKET_MAX_POSITION_PCT') || 0.1;
    const stopLossPct =
      this.config.get<number>('POLYMARKET_STOP_LOSS_PCT') || 0.3;

    // Bankroll state
    sections.push(`# BANKROLL STATE`);
    sections.push(
      `- Initial budget: $${bankroll.initialBudget}`,
      `- Current balance: $${bankroll.currentBalance.toFixed(2)}`,
      `- Target: ${bankroll.targetMultiplier}x ($${(bankroll.initialBudget * bankroll.targetMultiplier).toFixed(0)})`,
      `- Realized P&L: $${bankroll.realizedPnl.toFixed(2)}`,
      `- Win rate: ${bankroll.totalTrades > 0 ? (bankroll.winRate * 100).toFixed(1) : 'N/A'}% (${bankroll.totalTrades} trades)`,
      `- Current drawdown: ${(bankroll.currentDrawdownPct * 100).toFixed(1)}%`,
      `- Open positions: ${bankroll.openPositionsCount} ($${bankroll.openPositionsValue.toFixed(0)} at risk)`,
      `- Kelly fraction: ${kellyFraction} (quarter-Kelly)`,
      `- Max position: ${(maxPositionPct * 100).toFixed(0)}% of bankroll ($${(bankroll.currentBalance * maxPositionPct).toFixed(2)})`,
    );

    // Open positions
    if (openPositions.length > 0) {
      sections.push(`\n# CURRENT OPEN POSITIONS`);
      const sameLeague = openPositions.filter(
        (p) => p.leagueId === match.leagueId,
      );
      for (const pos of openPositions) {
        const leagueNote =
          pos.leagueId === match.leagueId ? ' [SAME LEAGUE]' : '';
        sections.push(
          `- ${pos.outcomeName}: $${pos.positionSizeUsd.toFixed(2)}${leagueNote}`,
        );
      }
      if (sameLeague.length > 0) {
        sections.push(
          `  ⚠ ${sameLeague.length} position(s) in the SAME league — high correlation risk`,
        );
      }
    }

    // Market info
    sections.push(`\n# POLYMARKET MARKET`);
    sections.push(
      `- Type: ${match.marketType}`,
      `- Event: ${match.event.title}`,
      `- Market: ${match.market.question}`,
      `- Team: ${match.teamName}`,
      `- League: ${match.leagueName} (${match.season}-${match.season + 1} season)`,
      `- Outcomes: ${match.market.outcomes.join(' / ')}`,
      `- Current prices: ${match.market.outcomes.map((o, i) => `${o}: ${match.market.outcomePrices[i]?.toFixed(3) ?? '?'}`).join(', ')}`,
      `- Liquidity: $${Number(match.event.liquidity).toLocaleString()}`,
      `- 24h Volume: $${Number(match.event.volume24hr).toLocaleString()}`,
      `- Total Volume: $${Number(match.event.volume).toLocaleString()}`,
    );

    // CLOB pricing
    sections.push(`\n# CLOB PRICING`);
    sections.push(
      `- Midpoint: ${pricing.midpoint.toFixed(4)}`,
      `- Buy price: ${pricing.buyPrice.toFixed(4)}`,
      `- Sell price: ${pricing.sellPrice.toFixed(4)}`,
      `- Spread: ${pricing.spread.toFixed(4)} (${(pricing.spread * 100).toFixed(2)}%)`,
      `- Book depth — Bids: $${pricing.bookDepth.totalBidSize.toFixed(0)} | Asks: $${pricing.bookDepth.totalAskSize.toFixed(0)}`,
    );

    // Team standings
    sections.push(`\n# ${match.teamName.toUpperCase()} — CURRENT STANDINGS`);
    sections.push(
      `- League position: ${standings.leaguePosition} / ${standings.totalTeams}`,
      `- Points: ${standings.points} (${standings.pointsFromTop === 0 ? 'LEADING' : `${standings.pointsFromTop} behind leader`})`,
      `- Games played: ${standings.gamesPlayed} | Remaining: ~${standings.gamesRemaining}`,
      `- Form (last 5): ${standings.formString} (W${standings.last5.wins} D${standings.last5.draws} L${standings.last5.losses})`,
      `- Last 5 goals: ${standings.last5.goalsFor}F ${standings.last5.goalsAgainst}A`,
      `- Home record: W${standings.home.wins} D${standings.home.draws} L${standings.home.losses}`,
      `- Away record: W${standings.away.wins} D${standings.away.draws} L${standings.away.losses}`,
      `- Goals avg: ${standings.goalsForAvg.toFixed(2)} for / ${standings.goalsAgainstAvg.toFixed(2)} against`,
      `- Ratings: Attack ${standings.attackRating.toFixed(1)} | Defense ${standings.defenseRating.toFixed(1)}`,
    );

    // Top competitors
    if (topCompetitors.length > 0) {
      sections.push(`\n# TOP COMPETITORS`);
      for (const comp of topCompetitors.slice(0, 5)) {
        sections.push(
          `- #${comp.position} ${comp.teamName}: ${comp.points} pts (form: ${comp.formString})`,
        );
      }
    }

    // Edge analysis
    sections.push(`\n# EDGE ANALYSIS`);
    sections.push(
      `- Our estimated probability: ${(candidate.estimatedProbability * 100).toFixed(1)}%`,
      `- Polymarket price: ${(candidate.polymarketProbability * 100).toFixed(1)}%`,
      `- Raw edge: ${(candidate.rawEdge * 100).toFixed(1)}%`,
      `- Effective edge (after half-spread): ${((candidate.rawEdge - pricing.spread / 2) * 100).toFixed(1)}%`,
    );

    return sections.join('\n');
  }

  // ─── Fixture prompt construction ────────────────────────────────────

  private buildFixturePrompt(
    candidate: FixtureTradingCandidate,
    bankroll: BankrollContext,
    openPositions: Array<{
      outcomeName: string;
      fixtureId?: number;
      leagueId?: number;
      positionSizeUsd: number;
    }>,
  ): string {
    const sections: string[] = [];
    const { match, pricing, prediction } = candidate;

    const kellyFraction =
      this.config.get<number>('POLYMARKET_KELLY_FRACTION') || 0.25;
    const maxPositionPct =
      this.config.get<number>('POLYMARKET_MAX_POSITION_PCT') || 0.1;
    const stopLossPct =
      this.config.get<number>('POLYMARKET_STOP_LOSS_PCT') || 0.3;

    // Bankroll state
    sections.push(`# BANKROLL STATE`);
    sections.push(
      `- Initial budget: $${bankroll.initialBudget}`,
      `- Current balance: $${bankroll.currentBalance.toFixed(2)}`,
      `- Target: ${bankroll.targetMultiplier}x ($${(bankroll.initialBudget * bankroll.targetMultiplier).toFixed(0)})`,
      `- Realized P&L: $${bankroll.realizedPnl.toFixed(2)}`,
      `- Win rate: ${bankroll.totalTrades > 0 ? (bankroll.winRate * 100).toFixed(1) : 'N/A'}% (${bankroll.totalTrades} trades)`,
      `- Current drawdown: ${(bankroll.currentDrawdownPct * 100).toFixed(1)}%`,
      `- Open positions: ${bankroll.openPositionsCount} ($${bankroll.openPositionsValue.toFixed(0)} at risk)`,
      `- Kelly fraction: ${kellyFraction}`,
      `- Max position: ${(maxPositionPct * 100).toFixed(0)}% of bankroll ($${(bankroll.currentBalance * maxPositionPct).toFixed(2)})`,
    );

    // Open positions
    if (openPositions.length > 0) {
      sections.push(`\n# CURRENT OPEN POSITIONS`);
      for (const pos of openPositions) {
        sections.push(
          `- ${pos.outcomeName}: $${pos.positionSizeUsd.toFixed(2)}`,
        );
      }
    }

    // Match info
    sections.push(`\n# MATCH`);
    sections.push(
      `- ${match.homeTeamName} vs ${match.awayTeamName}`,
      `- Fixture ID: ${match.fixtureId}`,
      `- Match confidence: ${(match.matchScore * 100).toFixed(0)}%`,
    );

    // Polymarket market
    sections.push(`\n# POLYMARKET MARKET`);
    sections.push(
      `- Event: ${match.event.title}`,
      `- Market: ${match.market.question}`,
      `- Outcomes: ${match.market.outcomes.join(' / ')}`,
      `- Current prices: ${match.market.outcomes.map((o, i) => `${o}: ${match.market.outcomePrices[i]?.toFixed(3) ?? '?'}`).join(', ')}`,
      `- Liquidity: $${Number(match.event.liquidity).toLocaleString()}`,
      `- 24h Volume: $${Number(match.event.volume24hr).toLocaleString()}`,
    );

    // CLOB pricing
    sections.push(`\n# CLOB PRICING (Primary Token)`);
    sections.push(
      `- Midpoint: ${pricing.midpoint.toFixed(4)}`,
      `- Buy price: ${pricing.buyPrice.toFixed(4)}`,
      `- Sell price: ${pricing.sellPrice.toFixed(4)}`,
      `- Spread: ${pricing.spread.toFixed(4)} (${(pricing.spread * 100).toFixed(2)}%)`,
      `- Book depth — Bids: $${pricing.bookDepth.totalBidSize.toFixed(0)} | Asks: $${pricing.bookDepth.totalAskSize.toFixed(0)}`,
    );

    // Our prediction
    sections.push(`\n# OUR ENSEMBLE PREDICTION`);
    sections.push(
      `- Home Win: ${(prediction.homeWinProb * 100).toFixed(1)}%`,
      `- Draw: ${(prediction.drawProb * 100).toFixed(1)}%`,
      `- Away Win: ${(prediction.awayWinProb * 100).toFixed(1)}%`,
      `- Predicted Score: ${prediction.predictedHomeGoals} - ${prediction.predictedAwayGoals}`,
      `- Confidence: ${prediction.confidence}/10`,
    );

    // Edge
    sections.push(`\n# EDGE ANALYSIS`);
    sections.push(
      `- Our probability: ${(candidate.ensembleProbability * 100).toFixed(1)}%`,
      `- Polymarket midpoint: ${(candidate.polymarketProbability * 100).toFixed(1)}%`,
      `- Raw edge: ${(candidate.rawEdge * 100).toFixed(1)}%`,
      `- Effective edge (after half-spread): ${((candidate.rawEdge - pricing.spread / 2) * 100).toFixed(1)}%`,
    );

    // Key/risk factors
    if (prediction.keyFactors.length > 0) {
      sections.push(`\n# KEY FACTORS`);
      prediction.keyFactors.forEach((f) => sections.push(`- ${f}`));
    }
    if (prediction.riskFactors.length > 0) {
      sections.push(`\n# RISK FACTORS`);
      prediction.riskFactors.forEach((f) => sections.push(`- ${f}`));
    }

    if (prediction.detailedAnalysis) {
      sections.push(
        `\n# PREDICTION ANALYSIS SUMMARY`,
        prediction.detailedAnalysis.substring(0, 1500),
      );
    }

    return sections.join('\n');
  }

  // ─── Response parsing ───────────────────────────────────────────────

  private parseDecision(
    rawText: string,
    candidate: TradingCandidate,
  ): TradingDecision {
    let cleaned = rawText.trim();

    // Strip markdown fences
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // If direct parse fails, try to extract JSON object from the text
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Look for a JSON object anywhere in the text
      const jsonMatch = cleaned.match(
        /\{[\s\S]*"action"\s*:\s*"(bet|skip)"[\s\S]*\}/,
      );
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          // Try to find the largest balanced { } block
          const start = cleaned.indexOf('{');
          if (start >= 0) {
            let depth = 0;
            let end = start;
            for (let i = start; i < cleaned.length; i++) {
              if (cleaned[i] === '{') depth++;
              if (cleaned[i] === '}') depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
            try {
              parsed = JSON.parse(cleaned.substring(start, end + 1));
            } catch {
              // Give up
            }
          }
        }
      }
    }

    try {
      if (!parsed) throw new Error('No valid JSON found in response');

      return {
        action: parsed.action === 'bet' ? 'bet' : 'skip',
        outcomeIndex: Number(parsed.outcomeIndex) || 0,
        outcomeName: String(
          parsed.outcomeName || candidate.match.market.outcomes[0] || 'Unknown',
        ),
        positionSizeUsd: Math.max(0, Number(parsed.positionSizeUsd) || 0),
        entryPrice: Number(parsed.entryPrice) || candidate.pricing.buyPrice,
        kellyFraction: Number(parsed.kellyFraction) || 0,
        edgePercent: Number(parsed.edgePercent) || candidate.rawEdge * 100,
        reasoning: String(parsed.reasoning || 'No reasoning provided'),
        riskAssessment: String(parsed.riskAssessment || 'No risk assessment'),
        confidenceInEdge: Math.max(
          1,
          Math.min(10, Math.round(Number(parsed.confidenceInEdge) || 5)),
        ),
      };
    } catch (error) {
      this.logger.error(
        `Failed to parse trading agent response: ${error.message}`,
      );
      this.logger.debug(`Raw response: ${rawText.substring(0, 500)}`);

      return {
        action: 'skip',
        outcomeIndex: 0,
        outcomeName: 'Unknown',
        positionSizeUsd: 0,
        entryPrice: 0,
        kellyFraction: 0,
        edgePercent: 0,
        reasoning: `Trading agent returned unparseable response: ${error.message}`,
        riskAssessment: 'Skipped due to parse error',
        confidenceInEdge: 1,
      };
    }
  }
}
