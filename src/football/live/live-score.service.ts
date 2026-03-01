import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FootballService, TRACKED_LEAGUES } from '../football.service';

/**
 * Represents a snapshot of a live fixture state used for change detection.
 */
export interface LiveFixtureState {
  fixtureId: number;
  homeTeamId: number;
  homeTeamName: string;
  awayTeamId: number;
  awayTeamName: string;
  leagueId: number;
  leagueName: string;
  status: string;
  elapsed: number | null;
  goalsHome: number | null;
  goalsAway: number | null;
  events: any[];
  raw: any;
}

/**
 * Describes a detected event during live match monitoring.
 */
export interface DetectedEvent {
  type: 'goal' | 'red-card' | 'match-start' | 'match-end' | 'status-change';
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
export type LiveEventListener = (event: DetectedEvent) => void;

@Injectable()
export class LiveScoreService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveScoreService.name);

  /** Currently tracked live fixture states, keyed by fixture ID. */
  private readonly matchStates = new Map<number, LiveFixtureState>();

  /** Polling timer reference. */
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether monitoring is actively running. */
  private isMonitoring = false;

  /** Registered event listeners. */
  private readonly listeners: LiveEventListener[] = [];

  /** Configurable polling intervals in ms. */
  private readonly normalIntervalMs: number;
  private readonly halftimeIntervalMs: number;
  private readonly penaltyIntervalMs: number;

  constructor(
    private readonly footballService: FootballService,
    private readonly config: ConfigService,
  ) {
    this.normalIntervalMs = this.config.get<number>(
      'LIVE_POLLING_INTERVAL_MS',
      30_000,
    );
    this.halftimeIntervalMs = this.config.get<number>(
      'LIVE_HALFTIME_POLLING_MS',
      60_000,
    );
    this.penaltyIntervalMs = this.config.get<number>(
      'LIVE_PENALTY_POLLING_MS',
      15_000,
    );
  }

  onModuleDestroy(): void {
    this.stopMonitoring();
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────

  /**
   * Register a listener that will be called when significant live events
   * are detected (goals, red cards, match start/end).
   */
  onEvent(listener: LiveEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Start polling API-Football for live fixtures at the configured
   * interval. Adjusts polling rate based on match state.
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      this.logger.warn('Live monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.logger.log(
      `Starting live match monitoring (normal=${this.normalIntervalMs}ms, ht=${this.halftimeIntervalMs}ms, pen=${this.penaltyIntervalMs}ms)`,
    );

    this.poll();
    this.scheduleNextPoll();
  }

  /**
   * Stop the live monitoring polling loop.
   */
  stopMonitoring(): void {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.logger.log(
      `Live monitoring stopped. Was tracking ${this.matchStates.size} matches.`,
    );
    this.matchStates.clear();
  }

  /**
   * Return a snapshot of all currently monitored live matches.
   */
  getActiveMatches(): LiveFixtureState[] {
    return Array.from(this.matchStates.values());
  }

  /**
   * Compare a previous fixture state with a new state and return
   * any significant events that occurred between them.
   */
  detectEvents(
    previousState: LiveFixtureState | undefined,
    currentState: LiveFixtureState,
  ): DetectedEvent[] {
    const detected: DetectedEvent[] = [];
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

    // Match just started (no previous state, or previously NS)
    if (!previousState || previousState.status === 'NS') {
      if (['1H', '2H', 'ET', 'P'].includes(currentState.status)) {
        detected.push({
          ...base,
          type: 'match-start',
          detail: `${currentState.homeTeamName} vs ${currentState.awayTeamName} has started`,
          data: { status: currentState.status },
        });
      }
    }

    // Match ended
    if (previousState && !['FT', 'AET', 'PEN'].includes(previousState.status)) {
      if (['FT', 'AET', 'PEN'].includes(currentState.status)) {
        detected.push({
          ...base,
          type: 'match-end',
          detail: `${currentState.homeTeamName} ${currentState.goalsHome} - ${currentState.goalsAway} ${currentState.awayTeamName} (${currentState.status})`,
          data: {
            status: currentState.status,
            goalsHome: currentState.goalsHome,
            goalsAway: currentState.goalsAway,
          },
        });
      }
    }

    // Goal detection
    if (previousState) {
      const prevHome = previousState.goalsHome ?? 0;
      const prevAway = previousState.goalsAway ?? 0;
      const currHome = currentState.goalsHome ?? 0;
      const currAway = currentState.goalsAway ?? 0;

      if (currHome > prevHome) {
        const diff = currHome - prevHome;
        for (let i = 0; i < diff; i++) {
          detected.push({
            ...base,
            type: 'goal',
            detail: `GOAL! ${currentState.homeTeamName} scores! (${currHome}-${currAway})`,
            data: {
              scoringTeamId: currentState.homeTeamId,
              scoringTeamName: currentState.homeTeamName,
              goalsHome: currHome,
              goalsAway: currAway,
              elapsed: currentState.elapsed,
            },
          });
        }
      }

      if (currAway > prevAway) {
        const diff = currAway - prevAway;
        for (let i = 0; i < diff; i++) {
          detected.push({
            ...base,
            type: 'goal',
            detail: `GOAL! ${currentState.awayTeamName} scores! (${currHome}-${currAway})`,
            data: {
              scoringTeamId: currentState.awayTeamId,
              scoringTeamName: currentState.awayTeamName,
              goalsHome: currHome,
              goalsAway: currAway,
              elapsed: currentState.elapsed,
            },
          });
        }
      }
    }

    // Red card detection — check events array for new red cards
    if (previousState && currentState.events?.length) {
      const prevEventCount = previousState.events?.length ?? 0;
      const newEvents = currentState.events.slice(prevEventCount);

      for (const evt of newEvents) {
        if (
          evt.type === 'Card' &&
          (evt.detail === 'Red Card' || evt.detail === 'Second Yellow card')
        ) {
          detected.push({
            ...base,
            type: 'red-card',
            detail: `RED CARD: ${evt.player?.name} (${evt.team?.name}) — ${evt.detail}`,
            data: {
              playerId: evt.player?.id,
              playerName: evt.player?.name,
              teamId: evt.team?.id,
              teamName: evt.team?.name,
              elapsed: evt.time?.elapsed,
              cardDetail: evt.detail,
            },
          });
        }
      }
    }

    // Status change (e.g. 1H -> HT)
    if (
      previousState &&
      previousState.status !== currentState.status &&
      !detected.some((d) => d.type === 'match-start' || d.type === 'match-end')
    ) {
      detected.push({
        ...base,
        type: 'status-change',
        detail: `Status changed: ${previousState.status} -> ${currentState.status}`,
        data: {
          previousStatus: previousState.status,
          currentStatus: currentState.status,
        },
      });
    }

    return detected;
  }

  // ─── PRIVATE ─────────────────────────────────────────────────────────

  /**
   * Execute a single poll cycle: fetch live fixtures, diff against
   * stored state, and emit any detected events.
   */
  private async poll(): Promise<void> {
    if (!this.isMonitoring) return;

    try {
      const liveFixtures = await this.footballService.fetchLiveFixtures();

      // Filter to tracked leagues only
      const tracked = liveFixtures.filter((f: any) =>
        TRACKED_LEAGUES.includes(f.league?.id),
      );

      this.logger.debug(
        `Live poll: ${liveFixtures.length} total, ${tracked.length} tracked`,
      );

      const currentFixtureIds = new Set<number>();

      for (const raw of tracked) {
        const state = this.mapToState(raw);
        currentFixtureIds.add(state.fixtureId);

        const previous = this.matchStates.get(state.fixtureId);
        const events = this.detectEvents(previous, state);

        // Update stored state
        this.matchStates.set(state.fixtureId, state);

        // Emit detected events
        for (const event of events) {
          this.emitEvent(event);
        }
      }

      // Detect matches that ended (were tracked but no longer live)
      for (const [fixtureId, prevState] of this.matchStates) {
        if (!currentFixtureIds.has(fixtureId)) {
          // Match is no longer live — likely finished
          if (!['FT', 'AET', 'PEN'].includes(prevState.status)) {
            this.emitEvent({
              type: 'match-end',
              fixtureId: prevState.fixtureId,
              homeTeamId: prevState.homeTeamId,
              homeTeamName: prevState.homeTeamName,
              awayTeamId: prevState.awayTeamId,
              awayTeamName: prevState.awayTeamName,
              leagueId: prevState.leagueId,
              leagueName: prevState.leagueName,
              detail: `${prevState.homeTeamName} ${prevState.goalsHome} - ${prevState.goalsAway} ${prevState.awayTeamName} (ended)`,
              timestamp: new Date(),
              data: {
                goalsHome: prevState.goalsHome,
                goalsAway: prevState.goalsAway,
              },
            });
          }

          this.matchStates.delete(fixtureId);
        }
      }
    } catch (error) {
      this.logger.error(`Live poll failed: ${(error as Error).message}`);
    }
  }

  /**
   * Schedule the next poll with an interval that adapts to match states.
   * - Penalty shootout: fastest polling (15s)
   * - All halftime: slow polling (60s)
   * - Default: normal polling (30s)
   */
  private scheduleNextPoll(): void {
    if (!this.isMonitoring) return;

    const interval = this.getAdaptiveInterval();

    this.pollingTimer = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll();
    }, interval);
  }

  /**
   * Determine the optimal polling interval based on current match states.
   */
  private getAdaptiveInterval(): number {
    const states = Array.from(this.matchStates.values());

    if (states.length === 0) return this.normalIntervalMs;

    // If any match is in penalty shootout, poll fastest
    if (states.some((s) => s.status === 'P')) {
      return this.penaltyIntervalMs;
    }

    // If ALL matches are in halftime, poll slower
    if (states.length > 0 && states.every((s) => s.status === 'HT')) {
      return this.halftimeIntervalMs;
    }

    return this.normalIntervalMs;
  }

  /**
   * Map raw API-Football fixture response to our LiveFixtureState shape.
   */
  private mapToState(raw: any): LiveFixtureState {
    return {
      fixtureId: raw.fixture.id,
      homeTeamId: raw.teams.home.id,
      homeTeamName: raw.teams.home.name,
      awayTeamId: raw.teams.away.id,
      awayTeamName: raw.teams.away.name,
      leagueId: raw.league.id,
      leagueName: raw.league.name,
      status: raw.fixture.status.short,
      elapsed: raw.fixture.status.elapsed,
      goalsHome: raw.goals.home,
      goalsAway: raw.goals.away,
      events: raw.events ?? [],
      raw,
    };
  }

  /**
   * Emit a detected event to all registered listeners.
   */
  private emitEvent(event: DetectedEvent): void {
    this.logger.log(
      `[LIVE EVENT] ${event.type}: ${event.detail}`,
    );

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
