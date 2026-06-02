import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema';
import { BaseballTeamMapService } from './baseball-team-map.service';

export interface PitcherTrueTalent {
  mlbamId: number;
  name: string;
  xera: number | null;
  xwobaAgainst: number | null;
  era: number | null;
  fip: number | null;
  siera: number | null;
  kPct: number | null;
  bbPct: number | null;
  barrelPct: number | null;
  hrPer9: number | null;
  ip: number | null;
  stale: boolean;
}

export interface TeamBattingQuality {
  teamMlbamId: number;
  split: string;
  xwoba: number | null;
  woba: number | null;
  runsPerGame: number | null;
  wrcPlus: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Baseball Savant (Statcast) + FanGraphs adapter — the predictive edge over
 * raw ERA. Pulls *expected* metrics keyed by MLBAM player id, caches them in
 * baseball_pitchers / baseball_team_batting, and degrades gracefully (returns
 * `stale`/null so the model can lower confidence) when the unofficial
 * endpoints change or are unreachable.
 */
@Injectable()
export class StatcastService {
  private readonly logger = new Logger(StatcastService.name);
  private readonly savant: AxiosInstance;

  constructor(
    private readonly config: ConfigService,
    @Inject('DRIZZLE') private db: any,
    private readonly teamMap: BaseballTeamMapService,
  ) {
    this.savant = axios.create({
      baseURL:
        this.config.get<string>('BASEBALL_SAVANT_BASE_URL') ||
        'https://baseballsavant.mlb.com',
      timeout: 30_000,
      headers: { 'User-Agent': 'polygentic/1.0' },
    });
  }

  // ─── Pitchers ────────────────────────────────────────────────────────

  /**
   * Refresh expected pitching stats for the whole league from Savant's
   * expected_statistics leaderboard (CSV, keyed by player_id = MLBAM).
   * Idempotent upsert into baseball_pitchers. Returns rows updated.
   */
  async refreshPitcherExpectedStats(
    season = new Date().getFullYear(),
  ): Promise<number> {
    let rows: Record<string, string>[];
    try {
      const { data } = await this.savant.get(
        '/leaderboard/expected_statistics',
        {
          params: {
            type: 'pitcher',
            year: season,
            position: '',
            team: '',
            min: '1',
            csv: 'true',
          },
          responseType: 'text',
        },
      );
      rows = parseCsv(data as string);
    } catch (err) {
      this.logger.warn(
        `refreshPitcherExpectedStats failed: ${(err as Error).message}`,
      );
      return 0;
    }

    let n = 0;
    for (const r of rows) {
      const mlbamId = toInt(r.player_id);
      if (!mlbamId) continue;
      const name = `${r.first_name ?? ''} ${r.last_name ?? r['last_name, first_name'] ?? ''}`.trim();
      const xera = toNum(r.xera ?? r.est_era);
      const xwoba = toNum(r.est_woba ?? r.xwoba);
      const era = toNum(r.era);
      const ip = toNum(r.ip ?? r.formatted_ip);

      await this.db
        .insert(schema.baseballPitchers)
        .values({
          mlbamId,
          name: name || `Pitcher ${mlbamId}`,
          xera: numStr(xera),
          xwobaAgainst: numStr(xwoba),
          era: numStr(era),
          ip: numStr(ip),
          rawStatcast: r,
          statcastFetchedAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.baseballPitchers.mlbamId,
          set: {
            name: name || undefined,
            xera: numStr(xera),
            xwobaAgainst: numStr(xwoba),
            era: numStr(era),
            ip: numStr(ip),
            rawStatcast: r,
            statcastFetchedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      n++;
    }
    this.logger.log(`Refreshed expected stats for ${n} pitchers (season ${season})`);
    return n;
  }

  /**
   * Get a pitcher's true-talent snapshot. Reads cache; if missing/stale and
   * `mlbStatsFallback` is supplied, fills basic stats so the model still runs.
   */
  async getPitcherTrueTalent(
    mlbamId: number,
    name?: string,
  ): Promise<PitcherTrueTalent | null> {
    const rows = await this.db
      .select()
      .from(schema.baseballPitchers)
      .where(eq(schema.baseballPitchers.mlbamId, mlbamId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return name
        ? {
            mlbamId,
            name,
            xera: null,
            xwobaAgainst: null,
            era: null,
            fip: null,
            siera: null,
            kPct: null,
            bbPct: null,
            barrelPct: null,
            hrPer9: null,
            ip: null,
            stale: true,
          }
        : null;
    }
    const fetchedAt = row.statcastFetchedAt
      ? new Date(row.statcastFetchedAt).getTime()
      : 0;
    return {
      mlbamId,
      name: row.name,
      xera: toNum(row.xera),
      xwobaAgainst: toNum(row.xwobaAgainst),
      era: toNum(row.era),
      fip: toNum(row.fip),
      siera: toNum(row.siera),
      kPct: toNum(row.kPct),
      bbPct: toNum(row.bbPct),
      barrelPct: toNum(row.barrelPct),
      hrPer9: toNum(row.hrPer9),
      ip: toNum(row.ip),
      stale: Date.now() - fetchedAt > DAY_MS,
    };
  }

  // ─── Team batting ────────────────────────────────────────────────────

  /**
   * Refresh team offensive quality from Savant batter expected stats,
   * aggregated to team level (overall split). Handedness splits can be added
   * later; overall is the v1 driver.
   */
  async refreshTeamBatting(
    season = new Date().getFullYear(),
  ): Promise<number> {
    let rows: Record<string, string>[];
    try {
      const { data } = await this.savant.get(
        '/leaderboard/expected_statistics',
        {
          params: {
            type: 'batter-team',
            year: season,
            position: '',
            team: '',
            min: '1',
            csv: 'true',
          },
          responseType: 'text',
        },
      );
      rows = parseCsv(data as string);
    } catch (err) {
      this.logger.warn(`refreshTeamBatting failed: ${(err as Error).message}`);
      return 0;
    }

    let n = 0;
    for (const r of rows) {
      // Savant team rows carry an abbreviation we resolve to MLBAM.
      const abbr = r.team ?? r.entity_name ?? r['team_name'] ?? '';
      const seed = this.teamMap.resolve(abbr);
      if (!seed) continue;
      const xwoba = toNum(r.est_woba ?? r.xwoba);
      const woba = toNum(r.woba);
      await this.db
        .insert(schema.baseballTeamBatting)
        .values({
          teamMlbamId: seed.mlbamTeamId,
          season,
          split: 'all',
          xwoba: numStr(xwoba),
          woba: numStr(woba),
          raw: r,
          fetchedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            schema.baseballTeamBatting.teamMlbamId,
            schema.baseballTeamBatting.season,
            schema.baseballTeamBatting.split,
          ],
          set: {
            xwoba: numStr(xwoba),
            woba: numStr(woba),
            raw: r,
            fetchedAt: new Date(),
          },
        });
      n++;
    }
    this.logger.log(`Refreshed team batting for ${n} teams (season ${season})`);
    return n;
  }

  async getTeamBatting(
    teamMlbamId: number,
    split = 'all',
    season = new Date().getFullYear(),
  ): Promise<TeamBattingQuality | null> {
    const rows = await this.db
      .select()
      .from(schema.baseballTeamBatting)
      .where(eq(schema.baseballTeamBatting.teamMlbamId, teamMlbamId))
      .limit(20);
    const row =
      rows.find((r: any) => r.split === split && r.season === season) ??
      rows.find((r: any) => r.split === 'all');
    if (!row) return null;
    return {
      teamMlbamId,
      split: row.split,
      xwoba: toNum(row.xwoba),
      woba: toNum(row.woba),
      runsPerGame: toNum(row.runsPerGame),
      wrcPlus: row.wrcPlus ?? null,
    };
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/** Minimal RFC-ish CSV parser (handles quoted fields with commas). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = (text || '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => (row[h] = (cells[idx] ?? '').trim()));
    out.push(row);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function toNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toInt(v: any): number | null {
  const n = toNum(v);
  return n == null ? null : Math.trunc(n);
}
function numStr(v: number | null): string | null {
  return v == null ? null : String(v);
}
