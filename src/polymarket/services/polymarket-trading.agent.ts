import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MarketPricingSnapshot } from './polymarket-clob.service';
import { MarketFixtureMatch } from './polymarket-matcher.service';

/**
 * A trading candidate — enriched with prediction data and pricing.
 */
export interface TradingCandidate {
  match: MarketFixtureMatch;
  pricing: MarketPricingSnapshot; // Pricing for the "Yes" token
  pricingNo?: MarketPricingSnapshot; // Pricing for the "No" token (if available)

  // From our prediction pipeline
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

  // Calculated edge
  ensembleProbability: number; // Our model's probability for the outcome this market tracks
  polymarketProbability: number; // Polymarket's midpoint price
  rawEdge: number; // ensembleProbability - polymarketProbability
}

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

const TRADING_SYSTEM_PROMPT = `You are an autonomous sports betting trading agent. Your job is to analyze soccer market opportunities on Polymarket and make disciplined trading decisions.

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
- Polymarket is often efficient. A 5% edge is meaningful. A 15%+ edge should make you suspicious — either we know something the market doesn't, or we're wrong

### Step 2: Assess Market Quality
- Liquidity: Can we actually fill at the displayed price? Check order book depth
- Spread: Wide spreads (>5%) eat into edge. Effective edge = raw edge - (spread / 2)
- Volume: Low volume markets may have stale prices — the "edge" might be an illusion
- Time to resolution: Markets close to expiry are less risky (shorter time for adverse movement)

### Step 3: Position Sizing (Kelly Criterion)
- Kelly fraction = (edge * (payout - 1) - (1 - edge)) / (payout - 1)
- For Polymarket binary tokens: payout = 1/price, so Kelly simplifies to: (edge / (1 - price))
- Apply the Kelly fraction modifier from config (typically 0.25 = quarter-Kelly for safety)
- Cap at max position size (typically 10% of bankroll)
- REDUCE size when:
  - Bankroll is below starting point (preserve capital)
  - You have many open positions (correlation risk)
  - Confidence in the prediction is moderate (6-7)
  - Market liquidity is thin

### Step 4: Risk Assessment
- Correlation: Don't overload on the same league/day/outcome type
- Drawdown: If in drawdown, size down or skip marginal opportunities
- Stop loss: If bankroll has dropped below the stop threshold, recommend SKIP
- Narrative risk: Consider what could make the market right and us wrong

### Step 5: Decision
- BET only when:
  - Edge is real and significant (effective edge > 3% after spread)
  - Market quality is adequate (sufficient liquidity, reasonable spread)
  - Position size makes sense given bankroll state
  - No excessive correlation with existing positions
- SKIP when:
  - Edge is small or uncertain
  - Market is illiquid or has wide spreads
  - We're in drawdown and this isn't a high-conviction opportunity
  - Too much correlation with existing positions
  - Something feels off — the market may know something we don't

## COMMON TRAPS TO AVOID
- **Phantom edge**: A "mispricing" might be because the market has newer information (last-minute injury, team news)
- **Illiquidity premium**: Thin markets show edges that disappear when you try to fill
- **Overtrading**: Not every prediction needs a bet. Quality over quantity
- **Revenge trading**: Don't increase size after losses to "make it back"
- **Correlated bets**: 5 bets on Premier League home wins this weekend is really 1 bet on home advantage

## OUTPUT FORMAT

Respond with ONLY valid JSON:
{
  "action": "bet" | "skip",
  "outcomeIndex": <0 or 1>,
  "outcomeName": "<the outcome name you're betting on>",
  "positionSizeUsd": <number, 0 if skip>,
  "entryPrice": <number, the price you'd enter at>,
  "kellyFraction": <number, calculated Kelly>,
  "edgePercent": <number, effective edge after spread>,
  "reasoning": "<2-4 paragraphs explaining your decision>",
  "riskAssessment": "<1-2 paragraphs on what could go wrong>",
  "confidenceInEdge": <1-10, how confident you are the edge is real>
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
      fixtureId: number;
      positionSizeUsd: number;
    }>,
  ): Promise<TradingDecision> {
    const prompt = this.buildPrompt(candidate, bankroll, openPositions);

    this.logger.log(
      `Evaluating trade: ${candidate.match.homeTeamName} vs ${candidate.match.awayTeamName} ` +
        `(edge: ${(candidate.rawEdge * 100).toFixed(1)}%, midpoint: ${candidate.pricing.midpoint.toFixed(3)})`,
    );

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      temperature: 0.1, // Very low — we want consistent, disciplined decisions
      system: TRADING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const rawText = textBlock?.text ?? '';

    return this.parseDecision(rawText, candidate);
  }

  // ─── Prompt construction ────────────────────────────────────────────

  private buildPrompt(
    candidate: TradingCandidate,
    bankroll: BankrollContext,
    openPositions: Array<{
      outcomeName: string;
      fixtureId: number;
      positionSizeUsd: number;
    }>,
  ): string {
    const sections: string[] = [];
    const { match, pricing, prediction } = candidate;

    // Config
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
      `- Current balance: $${bankroll.currentBalance}`,
      `- Target: ${bankroll.targetMultiplier}x ($${bankroll.initialBudget * bankroll.targetMultiplier})`,
      `- Realized P&L: $${bankroll.realizedPnl}`,
      `- Win rate: ${bankroll.totalTrades > 0 ? (bankroll.winRate * 100).toFixed(1) : 'N/A'}% (${bankroll.totalTrades} trades)`,
      `- Peak balance: $${bankroll.peakBalance}`,
      `- Current drawdown: ${(bankroll.currentDrawdownPct * 100).toFixed(1)}%`,
      `- Max drawdown: ${(bankroll.maxDrawdownPct * 100).toFixed(1)}%`,
      `- Stop loss threshold: ${(stopLossPct * 100).toFixed(0)}% of initial`,
      `- Open positions: ${bankroll.openPositionsCount} ($${bankroll.openPositionsValue} at risk)`,
      `- Kelly fraction: ${kellyFraction} (${kellyFraction === 0.25 ? 'quarter' : kellyFraction === 0.5 ? 'half' : 'custom'}-Kelly)`,
      `- Max single position: ${(maxPositionPct * 100).toFixed(0)}% of bankroll ($${(bankroll.currentBalance * maxPositionPct).toFixed(2)})`,
    );

    // Open positions
    if (openPositions.length > 0) {
      sections.push(`\n# CURRENT OPEN POSITIONS`);
      for (const pos of openPositions) {
        sections.push(
          `- ${pos.outcomeName} (fixture ${pos.fixtureId}): $${pos.positionSizeUsd}`,
        );
      }
    }

    // Match info
    sections.push(`\n# MATCH`);
    sections.push(
      `- ${match.homeTeamName} vs ${match.awayTeamName}`,
      `- Fixture ID: ${match.fixtureId}`,
      `- Match confidence: ${(match.matchScore * 100).toFixed(0)}% (market-to-fixture linking)`,
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
      `- Total Volume: $${Number(match.event.volume).toLocaleString()}`,
    );

    // CLOB pricing details
    sections.push(`\n# CLOB PRICING (Primary Token)`);
    sections.push(
      `- Midpoint: ${pricing.midpoint.toFixed(4)}`,
      `- Buy price: ${pricing.buyPrice.toFixed(4)}`,
      `- Sell price: ${pricing.sellPrice.toFixed(4)}`,
      `- Spread: ${pricing.spread.toFixed(4)} (${(pricing.spread * 100).toFixed(2)}%)`,
      `- Book depth — Bids: $${pricing.bookDepth.totalBidSize.toFixed(0)} (top: $${pricing.bookDepth.topBidSize.toFixed(0)})`,
      `- Book depth — Asks: $${pricing.bookDepth.totalAskSize.toFixed(0)} (top: $${pricing.bookDepth.topAskSize.toFixed(0)})`,
    );

    // Our prediction
    sections.push(`\n# OUR ENSEMBLE PREDICTION`);
    sections.push(
      `- Home Win: ${(prediction.homeWinProb * 100).toFixed(1)}%`,
      `- Draw: ${(prediction.drawProb * 100).toFixed(1)}%`,
      `- Away Win: ${(prediction.awayWinProb * 100).toFixed(1)}%`,
      `- Predicted Score: ${prediction.predictedHomeGoals} - ${prediction.predictedAwayGoals}`,
      `- Confidence: ${prediction.confidence}/10`,
      `- Model: ensemble (Claude 40% + Poisson 25% + Bookmaker 35%)`,
    );

    // Edge calculation
    sections.push(`\n# EDGE ANALYSIS`);
    sections.push(
      `- Our probability for this outcome: ${(candidate.ensembleProbability * 100).toFixed(1)}%`,
      `- Polymarket midpoint: ${(candidate.polymarketProbability * 100).toFixed(1)}%`,
      `- Raw edge: ${(candidate.rawEdge * 100).toFixed(1)}%`,
      `- Effective edge (after half-spread): ${((candidate.rawEdge - pricing.spread / 2) * 100).toFixed(1)}%`,
    );

    // Key factors from prediction
    if (prediction.keyFactors.length > 0) {
      sections.push(`\n# KEY FACTORS`);
      for (const factor of prediction.keyFactors) {
        sections.push(`- ${factor}`);
      }
    }

    if (prediction.riskFactors.length > 0) {
      sections.push(`\n# RISK FACTORS`);
      for (const factor of prediction.riskFactors) {
        sections.push(`- ${factor}`);
      }
    }

    // Existing value bets from the prediction
    if (prediction.valueBets.length > 0) {
      sections.push(`\n# VALUE BETS (from prediction pipeline)`);
      for (const vb of prediction.valueBets) {
        sections.push(
          `- ${vb.market}: ${vb.selection} — edge ${vb.edgePercent}% — ${vb.reasoning}`,
        );
      }
    }

    // Brief analysis context
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
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);

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

      // Default to skip on parse failure
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
