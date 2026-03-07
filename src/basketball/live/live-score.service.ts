import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BasketballService,
  TRACKED_BASKETBALL_LEAGUES,
} from '../basketball.service';

/**
 * Represents a snapshot of a live basketball game state used for change detection.
 */
export interface LiveBasketballGameState {
  fixtureId: number;
  homeTeamId: number;
  homeTeamName: string;
  awayTeamId: number;
  awayTeamName: string;
  leagueId: number;
  leagueName: string;
  status: string;
  timer: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  raw: any;
}

/**
 * Describes a detected event during live basketball game monitoring.
 */
export interface BasketballDetectedEvent {
  type: 'game-start' | 'game-end' | 'quarter-change' | 'score-update';
  fixtureId: number;
  homeTeamId: number;
  homeTeamName: string;
  awayTeamId: number;
  awayTeamName: string;
  leagueId: number;
  leagueName: string;
  detail: string;
  timestamp: Date;
  data: any;
}

/** Callback type for event listeners. */
export type BasketballLiveEventListener = (
  event: BasketballDetectedEvent,
) => void;

@Injectable()
export class BasketballLiveScoreService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BasketballLiveScoreService.name);

  /** Currently tracked live game states, keyed by fixture ID. */
  private readonly gameStates = new Map<number, LiveBasketballGameState>();

  /** Polling timer reference. */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether monitoring is actively running. */
  private isMonitoring = false;

  /** Registered event listeners. */
  private readonly listeners: BasketballLiveEventListener[] = [];

  /** Polling intervals in ms. */
  private readonly normalIntervalMs: number;
  private readonly overtimeIntervalMs: number;

  /** Whether live monitoring is enabled (disabled by default on free plan). */
  private readonly liveMonitoringEnabled: boolean;

  constructor(
    private readonly basketballService: BasketballService,
    private readonly config: ConfigService,
  ) {
    this.normalIntervalMs = this.config.get<number>(
      'BASKETBALL_LIVE_POLLING_INTERVAL_MS',
      30_000,
    );
    this.overtimeIntervalMs = this.config.get<number>(
      'BASKETBALL_LIVE_OT_POLLING_MS',
      15_000,
    );
    // ConfigService returns strings from env vars, so "false" is truthy.
    // Explicitly check for the string "true" to enable.
    const rawEnabled = this.config.get<string>(
      'BASKETBALL_LIVE_MONITORING_ENABLED',
      'false',
    );
    this.liveMonitoringEnabled = String(rawEnabled) === 'true';
  }

  onModuleInit(): void {
    if (!this.liveMonitoringEnabled) {
      this.logger.log(
        'Basketball live monitoring is DISABLED (free plan default). ' +
          'Set BASKETBALL_LIVE_MONITORING_ENABLED=true in .env to enable.',
      );
      return;
    }

    this.logger.log(
      'BasketballLiveScoreService initialized — starting live monitoring',
    );
    this.startMonitoring();
  }

  onModuleDestroy(): void {
    this.stopMonitoring();
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────

  onEvent(listener: BasketballLiveEventListener): void {
    this.listeners.push(listener);
  }

  startMonitoring(): void {
    if (this.isMonitoring) {
      this.logger.warn('Basketball live monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.logger.log(
      `Starting basketball live monitoring (normal=${this.normalIntervalMs}ms, ot=${this.overtimeIntervalMs}ms)`,
    );

    this.poll();
    this.scheduleNextPoll();
  }

  stopMonitoring(): void {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.logger.log(
      `Basketball live monitoring stopped. Was tracking ${this.gameStates.size} games.`,
    );
    this.gameStates.clear();
  }

  getActiveGames(): LiveBasketballGameState[] {
    return Array.from(this.gameStates.values());
  }

  detectEvents(
    previousState: LiveBasketballGameState | undefined,
    currentState: LiveBasketballGameState,
  ): BasketballDetectedEvent[] {
    const detected: BasketballDetectedEvent[] = [];
    const base = {
      fixtureId: currentState.fixtureId,
      homeTeamId: currentState.homeTeamId,
      homeTeamName: currentState.homeTeamName,
      awayTeamId: currentState.awayTeamId,
      awayTeamName: currentState.awayTeamName,
      leagueId: currentState.leagueId,
      leagueName: currentState.leagueName,
      timestamp: new Date(),
    };

    // Game just started
    if (!previousState || previousState.status === 'NS') {
      if (['Q1', 'Q2', 'Q3', 'Q4', 'OT'].includes(currentState.status)) {
        detected.push({
          ...base,
          type: 'game-start',
          detail: `${currentState.homeTeamName} vs ${currentState.awayTeamName} has started`,
          data: { status: currentState.status },
        });
      }
    }

    // Game ended
    if (previousState && !['FT', 'AOT'].includes(previousState.status)) {
      if (['FT', 'AOT'].includes(currentState.status)) {
        detected.push({
          ...base,
          type: 'game-end',
          detail: `${currentState.homeTeamName} ${currentState.scoreHome} - ${currentState.scoreAway} ${currentState.awayTeamName} (${currentState.status})`,
          data: {
            status: currentState.status,
            scoreHome: currentState.scoreHome,
            scoreAway: currentState.scoreAway,
          },
        });
      }
    }

    // Score change detection
    if (previousState) {
      const prevHome = previousState.scoreHome ?? 0;
      const prevAway = previousState.scoreAway ?? 0;
      const currHome = currentState.scoreHome ?? 0;
      const currAway = currentState.scoreAway ?? 0;

      if (currHome !== prevHome || currAway !== prevAway) {
        detected.push({
          ...base,
          type: 'score-update',
          detail: `Score update: ${currentState.homeTeamName} ${currHome} - ${currAway} ${currentState.awayTeamName}`,
          data: {
            scoreHome: currHome,
            scoreAway: currAway,
            previousScoreHome: prevHome,
            previousScoreAway: prevAway,
            timer: currentState.timer,
          },
        });
      }
    }

    // Quarter/period change
    if (
      previousState &&
      previousState.status !== currentState.status &&
      !detected.some((d) => d.type === 'game-start' || d.type === 'game-end')
    ) {
      detected.push({
        ...base,
        type: 'quarter-change',
        detail: `Period changed: ${previousState.status} -> ${currentState.status}`,
        data: {
          previousStatus: previousState.status,
          currentStatus: currentState.status,
        },
      });
    }

    return detected;
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.isMonitoring) return;

    try {
      const liveGames = await this.basketballService.fetchLiveGames();

      const tracked = liveGames.filter((g: any) =>
        TRACKED_BASKETBALL_LEAGUES.includes(g.league?.id),
      );

      this.logger.debug(
        `Basketball live poll: ${liveGames.length} total, ${tracked.length} tracked`,
      );

      const currentGameIds = new Set<number>();

      for (const raw of tracked) {
        const state = this.mapToState(raw);
        currentGameIds.add(state.fixtureId);

        const previous = this.gameStates.get(state.fixtureId);
        const events = this.detectEvents(previous, state);

        this.gameStates.set(state.fixtureId, state);

        for (const event of events) {
          this.emitEvent(event);
        }
      }

      // Detect games that ended
      for (const [fixtureId, prevState] of this.gameStates) {
        if (!currentGameIds.has(fixtureId)) {
          if (!['FT', 'AOT'].includes(prevState.status)) {
            this.emitEvent({
              type: 'game-end',
              fixtureId: prevState.fixtureId,
              homeTeamId: prevState.homeTeamId,
              homeTeamName: prevState.homeTeamName,
              awayTeamId: prevState.awayTeamId,
              awayTeamName: prevState.awayTeamName,
              leagueId: prevState.leagueId,
              leagueName: prevState.leagueName,
              detail: `${prevState.homeTeamName} ${prevState.scoreHome} - ${prevState.scoreAway} ${prevState.awayTeamName} (ended)`,
              timestamp: new Date(),
              data: {
                scoreHome: prevState.scoreHome,
                scoreAway: prevState.scoreAway,
              },
            });
          }

          this.gameStates.delete(fixtureId);
        }
      }
    } catch (error) {
      this.logger.error(
        `Basketball live poll failed: ${(error as Error).message}`,
      );
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isMonitoring) return;

    const interval = this.getAdaptiveInterval();

    this.pollingTimer = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll();
    }, interval);
  }

  private getAdaptiveInterval(): number {
    const states = Array.from(this.gameStates.values());

    if (states.length === 0) return this.normalIntervalMs;

    // If any game is in overtime, poll faster
    if (states.some((s) => s.status === 'OT')) {
      return this.overtimeIntervalMs;
    }

    return this.normalIntervalMs;
  }

  private mapToState(raw: any): LiveBasketballGameState {
    return {
      fixtureId: raw.id,
      homeTeamId: raw.teams.home.id,
      homeTeamName: raw.teams.home.name,
      awayTeamId: raw.teams.away.id,
      awayTeamName: raw.teams.away.name,
      leagueId: raw.league.id,
      leagueName: raw.league.name,
      status: raw.status.short,
      timer: raw.status.timer ?? null,
      scoreHome: raw.scores?.home?.total ?? null,
      scoreAway: raw.scores?.away?.total ?? null,
      raw,
    };
  }

  private emitEvent(event: BasketballDetectedEvent): void {
    this.logger.log(`[BB LIVE EVENT] ${event.type}: ${event.detail}`);

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(
          `Listener error for ${event.type}: ${(error as Error).message}`,
        );
      }
    }
  }
}
