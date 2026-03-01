import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as schema from '../database/schema';
import { PolymarketService } from '../polymarket/polymarket.service';
import { FootballService, TRACKED_LEAGUES } from '../football/football.service';
import { OddsService } from '../odds/odds.service';
import { MatcherService } from '../matcher/matcher.service';
import { PredictionService } from '../prediction/prediction.service';
import { desc, sql } from 'drizzle-orm';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject('DRIZZLE') private db: any,
    private readonly configService: ConfigService,
    private readonly polymarketService: PolymarketService,
    private readonly footballService: FootballService,
    private readonly oddsService: OddsService,
    private readonly matcherService: MatcherService,
    private readonly predictionService: PredictionService,
  ) {}

  async syncPolymarket(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting Polymarket sync...');
      const eventsResult: any = await this.polymarketService.syncSoccerEvents();
      await this.polymarketService.syncPrices();

      await this.logSync(
        'polymarket',
        'sync_events_and_prices',
        'completed',
        startedAt,
        {
          recordsProcessed:
            eventsResult?.eventsCount || eventsResult?.events || 0,
        },
      );
      this.logger.log('Polymarket sync completed');
    } catch (error) {
      this.logger.error(`Polymarket sync failed: ${error.message}`);
      await this.logSync(
        'polymarket',
        'sync_events_and_prices',
        'failed',
        startedAt,
        {
          errorMessage: error.message,
        },
      );
    }
  }

  async syncFixtures(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting fixtures sync...');
      const currentSeason = new Date().getFullYear();
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        try {
          const result: any = await this.footballService.syncFixtures([
            leagueId,
          ]);
          totalProcessed += result?.count || result?.length || 0;
        } catch (error) {
          this.logger.warn(
            `Failed to sync fixtures for league ${leagueId}: ${error.message}`,
          );
        }
      }

      await this.logSync(
        'api_football',
        'sync_fixtures',
        'completed',
        startedAt,
        {
          recordsProcessed: totalProcessed,
        },
      );
      this.logger.log(
        `Fixtures sync completed. ${totalProcessed} fixtures processed.`,
      );
    } catch (error) {
      this.logger.error(`Fixtures sync failed: ${error.message}`);
      await this.logSync('api_football', 'sync_fixtures', 'failed', startedAt, {
        errorMessage: error.message,
      });
    }
  }

  async syncInjuries(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting injuries sync...');
      const currentSeason = new Date().getFullYear();
      let totalProcessed = 0;

      for (const leagueId of TRACKED_LEAGUES) {
        try {
          const result: any = await this.footballService.syncInjuries(
            leagueId,
            currentSeason,
          );
          totalProcessed += result?.count || result?.length || 0;
        } catch (error) {
          this.logger.warn(
            `Failed to sync injuries for league ${leagueId}: ${error.message}`,
          );
        }
      }

      await this.logSync(
        'api_football',
        'sync_injuries',
        'completed',
        startedAt,
        {
          recordsProcessed: totalProcessed,
        },
      );
      this.logger.log(
        `Injuries sync completed. ${totalProcessed} records processed.`,
      );
    } catch (error) {
      this.logger.error(`Injuries sync failed: ${error.message}`);
      await this.logSync('api_football', 'sync_injuries', 'failed', startedAt, {
        errorMessage: error.message,
      });
    }
  }

  async syncStandings(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting standings sync...');
      const currentSeason = new Date().getFullYear();

      for (const leagueId of TRACKED_LEAGUES) {
        try {
          await this.footballService.syncStandings(leagueId, currentSeason);
        } catch (error) {
          this.logger.warn(
            `Failed to sync standings for league ${leagueId}: ${error.message}`,
          );
        }
      }

      await this.logSync(
        'api_football',
        'sync_standings',
        'completed',
        startedAt,
      );
      this.logger.log('Standings sync completed.');
    } catch (error) {
      this.logger.error(`Standings sync failed: ${error.message}`);
      await this.logSync(
        'api_football',
        'sync_standings',
        'failed',
        startedAt,
        {
          errorMessage: error.message,
        },
      );
    }
  }

  async syncOdds(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting odds sync...');
      await this.oddsService.syncAllSoccerOdds();

      await this.logSync('odds_api', 'sync_odds', 'completed', startedAt);
      this.logger.log('Odds sync completed.');
    } catch (error) {
      this.logger.error(`Odds sync failed: ${error.message}`);
      await this.logSync('odds_api', 'sync_odds', 'failed', startedAt, {
        errorMessage: error.message,
      });
    }
  }

  async matchMarkets(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting market matching...');
      const result = await this.matcherService.matchAllMarkets();

      await this.logSync('system', 'match_markets', 'completed', startedAt, {
        recordsProcessed: result?.matched || 0,
      });
      this.logger.log(
        `Market matching completed. ${result?.matched || 0} markets matched.`,
      );
    } catch (error) {
      this.logger.error(`Market matching failed: ${error.message}`);
      await this.logSync('system', 'match_markets', 'failed', startedAt, {
        errorMessage: error.message,
      });
    }
  }

  async generatePredictions(): Promise<void> {
    const startedAt = new Date();
    try {
      this.logger.log('Starting prediction generation...');
      const result = await this.predictionService.generatePredictions();

      await this.logSync(
        'system',
        'generate_predictions',
        'completed',
        startedAt,
        {
          recordsProcessed: result?.predictionsGenerated || 0,
        },
      );
      this.logger.log(
        `Prediction generation completed. ${result?.predictionsGenerated || 0} predictions.`,
      );
    } catch (error) {
      this.logger.error(`Prediction generation failed: ${error.message}`);
      await this.logSync(
        'system',
        'generate_predictions',
        'failed',
        startedAt,
        {
          errorMessage: error.message,
        },
      );
    }
  }

  async runFullSync(): Promise<{ results: Record<string, string> }> {
    this.logger.log('=== Starting full sync cycle ===');
    const results: Record<string, string> = {};

    const steps = [
      { name: 'polymarket', fn: () => this.syncPolymarket() },
      { name: 'fixtures', fn: () => this.syncFixtures() },
      { name: 'odds', fn: () => this.syncOdds() },
      { name: 'match_markets', fn: () => this.matchMarkets() },
      { name: 'predictions', fn: () => this.generatePredictions() },
    ];

    for (const step of steps) {
      try {
        await step.fn();
        results[step.name] = 'completed';
      } catch (error) {
        results[step.name] = `failed: ${error.message}`;
      }
    }

    this.logger.log('=== Full sync cycle finished ===');
    return { results };
  }

  async getSyncHistory(limit = 50): Promise<any[]> {
    return this.db
      .select()
      .from(schema.syncLog)
      .orderBy(desc(schema.syncLog.startedAt))
      .limit(limit);
  }

  private async logSync(
    source: string,
    task: string,
    status: 'started' | 'completed' | 'failed',
    startedAt: Date,
    extra?: {
      recordsProcessed?: number;
      errorMessage?: string;
      apiRequestsUsed?: number;
    },
  ): Promise<void> {
    try {
      const completedAt = status !== 'started' ? new Date() : null;
      const durationMs = completedAt
        ? completedAt.getTime() - startedAt.getTime()
        : null;

      await this.db.insert(schema.syncLog).values({
        source,
        task,
        status,
        recordsProcessed: extra?.recordsProcessed || null,
        errorMessage: extra?.errorMessage || null,
        apiRequestsUsed: extra?.apiRequestsUsed || null,
        durationMs,
        startedAt,
        completedAt,
      });
    } catch (error) {
      this.logger.error(`Failed to log sync: ${error.message}`);
    }
  }
}
