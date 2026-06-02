import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import {
  MLB_TEAMS,
  MlbTeamSeed,
  findTeamSeed,
} from './baseball-teams.data';

/**
 * Owns the static bridge between API-Sports baseball team ids and MLB
 * StatsAPI (MLBAM) ids. Seeds `baseball_team_map` from MLB_TEAMS on boot
 * and resolves arbitrary team strings/ids to a canonical entry.
 *
 * The map is the single most failure-prone integration point (two
 * providers, two id spaces), so it is deterministic, idempotent, and
 * unit-testable via the pure `findTeamSeed` helper.
 */
@Injectable()
export class BaseballTeamMapService implements OnModuleInit {
  private readonly logger = new Logger(BaseballTeamMapService.name);

  /** In-memory caches, keyed for O(1) lookups after seed. */
  private byMlbam = new Map<number, MlbTeamSeed>();
  private byApiSports = new Map<number, MlbTeamSeed>();

  constructor(@Inject('DRIZZLE') private db: any) {
    for (const t of MLB_TEAMS) this.byMlbam.set(t.mlbamTeamId, t);
  }

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  /**
   * Seed + load caches. Safe to call from Trigger.dev tasks (which run
   * outside Nest's lifecycle) as well as onModuleInit. Idempotent.
   */
  async init(): Promise<void> {
    try {
      await this.seed();
      await this.loadApiSportsCache();
    } catch (err) {
      // Don't crash boot if the table isn't migrated yet — log and move on.
      this.logger.warn(
        `Team-map seed skipped: ${(err as Error).message}. ` +
          `Run migration 0021_baseball_tables.sql.`,
      );
    }
  }

  /** Idempotently seed the 30 MLB teams (MLBAM side + park factors). */
  async seed(): Promise<void> {
    for (const t of MLB_TEAMS) {
      await this.db
        .insert(schema.baseballTeamMap)
        .values({
          mlbamTeamId: t.mlbamTeamId,
          abbrev: t.abbrev,
          canonicalName: t.canonicalName,
          fullName: t.fullName,
          venueName: t.venueName,
          parkRunFactor: String(t.parkRunFactor),
          parkHrFactorL: String(t.parkHrFactorL),
          parkHrFactorR: String(t.parkHrFactorR),
          parkOrientationDeg: t.parkOrientationDeg,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.baseballTeamMap.mlbamTeamId,
          set: {
            abbrev: t.abbrev,
            canonicalName: t.canonicalName,
            fullName: t.fullName,
            venueName: t.venueName,
            // Park factors refreshed by StatcastService; only seed if null.
            updatedAt: new Date(),
          },
        });
    }
    this.logger.log(`Seeded ${MLB_TEAMS.length} MLB teams into baseball_team_map`);
  }

  /** Cache any api_sports_team_id values already reconciled in the DB. */
  private async loadApiSportsCache(): Promise<void> {
    const rows = await this.db.select().from(schema.baseballTeamMap);
    for (const r of rows) {
      if (r.apiSportsTeamId != null) {
        const seed = this.byMlbam.get(r.mlbamTeamId);
        if (seed) this.byApiSports.set(r.apiSportsTeamId, seed);
      }
    }
  }

  /**
   * Reconcile an API-Sports team (id + name) to its MLBAM entry, persisting
   * the api_sports_team_id link the first time we see it. Called from
   * BaseballService.upsertGame for each team.
   */
  async reconcileApiSportsTeam(
    apiSportsId: number,
    name: string,
  ): Promise<MlbTeamSeed | null> {
    if (this.byApiSports.has(apiSportsId)) {
      return this.byApiSports.get(apiSportsId)!;
    }
    const seed = findTeamSeed(name) ?? findTeamSeed(String(apiSportsId));
    if (!seed) {
      this.logger.warn(
        `Could not map API-Sports team "${name}" (id ${apiSportsId}) to MLBAM`,
      );
      return null;
    }
    this.byApiSports.set(apiSportsId, seed);
    try {
      await this.db
        .update(schema.baseballTeamMap)
        .set({ apiSportsTeamId: apiSportsId, updatedAt: new Date() })
        .where(eq(schema.baseballTeamMap.mlbamTeamId, seed.mlbamTeamId));
    } catch (err) {
      this.logger.warn(
        `Failed to persist api-sports id ${apiSportsId} for ${seed.abbrev}: ${(err as Error).message}`,
      );
    }
    return seed;
  }

  /** Lookup by MLBAM id (from MLB StatsAPI). */
  getByMlbam(mlbamId: number): MlbTeamSeed | null {
    return this.byMlbam.get(mlbamId) ?? null;
  }

  /** Lookup by API-Sports team id (after reconciliation). */
  getByApiSports(apiSportsId: number): MlbTeamSeed | null {
    return this.byApiSports.get(apiSportsId) ?? null;
  }

  /** Resolve any free-text team string (Polymarket, odds feeds, etc.). */
  resolve(raw: string): MlbTeamSeed | null {
    return findTeamSeed(raw);
  }

  all(): MlbTeamSeed[] {
    return MLB_TEAMS;
  }
}
