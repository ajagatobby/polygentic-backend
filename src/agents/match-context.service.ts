import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { CollectedMatchData } from './data-collector.agent';
import { MatchInsights } from './match-insights.service';

// ─── Types ───────────────────────────────────────────────────────────────

export interface RefereeProfile {
  name: string | null;
  gamesAnalyzed: number;
  yellowPerGame: number | null;
  redPer10Games: number | null;
  penaltiesPerGame: number | null;
  homeWinPct: number | null;
  note: string;
}

export interface WeatherProfile {
  available: boolean;
  temperatureC: number | null;
  precipitationMm: number | null;
  windKph: number | null;
  condition: string | null;
  note: string;
}

export interface DisciplineWatchPlayer {
  name: string | null;
  yellowCards: number;
  teamSide: 'home' | 'away';
}

export interface StakesProfile {
  derby: string | null;
  lateSeasonStakes: string | null;
  notes: string[];
}

export interface MatchContext {
  referee: RefereeProfile | null;
  weather: WeatherProfile | null;
  discipline: {
    home: DisciplineWatchPlayer[];
    away: DisciplineWatchPlayer[];
  };
  stakes: StakesProfile | null;
  narrative: string;
}

const COMPLETED = ['FT', 'AET', 'PEN'];
// Season yellow-card count above which we flag a player as a suspension/booking risk.
const YELLOW_WATCH_THRESHOLD = 7;

/**
 * Builds the contextual layer: referee tendencies (from our own fixture +
 * event history), matchday weather (keyless Open-Meteo), discipline watch, and
 * what's at stake. Display + confidence-modulation only — not a probability
 * input.
 */
@Injectable()
export class MatchContextService {
  private readonly logger = new Logger(MatchContextService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  async build(
    data: CollectedMatchData,
    insights: MatchInsights,
  ): Promise<MatchContext> {
    const [referee, weather] = await Promise.all([
      this.buildRefereeProfile(data),
      this.buildWeather(data),
    ]);
    const discipline = this.buildDiscipline(insights);
    const stakes = this.buildStakes(data);

    const ctx: MatchContext = {
      referee,
      weather,
      discipline,
      stakes,
      narrative: '',
    };
    ctx.narrative = this.buildNarrative(ctx);
    return ctx;
  }

  // ─── Referee ────────────────────────────────────────────────────────────

  private async buildRefereeProfile(
    data: CollectedMatchData,
  ): Promise<RefereeProfile | null> {
    const refRaw: string | null = data.fixture?.referee ?? null;
    if (!refRaw) return null;
    // API-Football referee strings sometimes carry ", Country" — strip it.
    const refName = refRaw.split(',')[0].trim();
    if (!refName) return null;

    try {
      const fixtures = await this.db
        .select({
          id: schema.fixtures.id,
          goalsHome: schema.fixtures.goalsHome,
          goalsAway: schema.fixtures.goalsAway,
        })
        .from(schema.fixtures)
        .where(
          and(
            inArray(schema.fixtures.status, COMPLETED),
            ne(schema.fixtures.id, data.fixture.id),
            sql`${schema.fixtures.referee} ILIKE ${'%' + refName + '%'}`,
          ),
        )
        .orderBy(desc(schema.fixtures.date))
        .limit(60);

      const games = fixtures.length;
      if (games === 0) {
        return {
          name: refName,
          gamesAnalyzed: 0,
          yellowPerGame: null,
          redPer10Games: null,
          penaltiesPerGame: null,
          homeWinPct: null,
          note: `${refName}: no prior matches on record in our database.`,
        };
      }

      const ids = fixtures.map((f: any) => f.id);
      const events = await this.db
        .select({
          type: schema.fixtureEvents.type,
          detail: schema.fixtureEvents.detail,
        })
        .from(schema.fixtureEvents)
        .where(inArray(schema.fixtureEvents.fixtureId, ids));

      let yellow = 0;
      let red = 0;
      let pens = 0;
      for (const e of events) {
        const t = String(e.type ?? '').toLowerCase();
        const d = String(e.detail ?? '').toLowerCase();
        if (t === 'card' && d.includes('yellow')) yellow++;
        else if (t === 'card' && d.includes('red')) red++;
        if (d.includes('penalty')) pens++;
      }

      let homeWins = 0;
      let decided = 0;
      for (const f of fixtures) {
        const gh = Number(f.goalsHome);
        const ga = Number(f.goalsAway);
        if (Number.isNaN(gh) || Number.isNaN(ga)) continue;
        decided++;
        if (gh > ga) homeWins++;
      }

      const yellowPerGame = round2(yellow / games);
      const redPer10 = round2((red / games) * 10);
      const pensPerGame = round2(pens / games);
      const homeWinPct = decided > 0 ? round2((homeWins / decided) * 100) : null;

      const tags: string[] = [];
      if (yellowPerGame >= 4.5) tags.push('card-happy');
      else if (yellowPerGame <= 2.5) tags.push('lenient');
      if (pensPerGame >= 0.25) tags.push('points to the spot often');

      return {
        name: refName,
        gamesAnalyzed: games,
        yellowPerGame,
        redPer10Games: redPer10,
        penaltiesPerGame: pensPerGame,
        homeWinPct,
        note:
          `${refName} (${games} games): ${yellowPerGame} yellows/game, ${pensPerGame} pens/game, ` +
          `${homeWinPct ?? '?'}% home wins${tags.length ? ` — ${tags.join(', ')}` : ''}.`,
      };
    } catch (error: any) {
      this.logger.warn(`Referee profile failed: ${error.message}`);
      return null;
    }
  }

  // ─── Weather (keyless Open-Meteo) ───────────────────────────────────────

  private async buildWeather(
    data: CollectedMatchData,
  ): Promise<WeatherProfile | null> {
    const city: string | null =
      data.fixture?.venueCity ?? data.fixture?.venueName ?? null;
    const kickoff: string | Date | null = data.fixture?.date ?? null;
    if (!city || !kickoff) return null;

    try {
      const geo = await fetchJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
          String(city).split(',')[0],
        )}&count=1`,
      );
      const place = geo?.results?.[0];
      if (!place) return this.weatherUnavailable('venue not geocodable');

      const date = new Date(kickoff);
      const day = date.toISOString().split('T')[0];
      const forecast = await fetchJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          `&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code&start_date=${day}&end_date=${day}`,
      );
      const hours: string[] = forecast?.hourly?.time ?? [];
      if (!hours.length) return this.weatherUnavailable('no forecast (out of range)');

      // Nearest hour to kickoff.
      const targetHour = date.getUTCHours();
      let idx = 0;
      let best = Infinity;
      hours.forEach((h, i) => {
        const hr = new Date(h).getUTCHours();
        const diff = Math.abs(hr - targetHour);
        if (diff < best) {
          best = diff;
          idx = i;
        }
      });

      const temp = forecast.hourly.temperature_2m?.[idx] ?? null;
      const precip = forecast.hourly.precipitation?.[idx] ?? null;
      const windMs = forecast.hourly.wind_speed_10m?.[idx] ?? null;
      const windKph = windMs != null ? round2(Number(windMs) * 3.6) : null;

      const tags: string[] = [];
      if (precip != null && precip >= 2) tags.push('wet pitch — favours physical/direct play, can suppress passing');
      if (windKph != null && windKph >= 30) tags.push('strong wind — affects long balls and set pieces');
      if (temp != null && temp >= 30) tags.push('hot — tempo likely to drop');
      if (temp != null && temp <= 2) tags.push('cold');

      return {
        available: true,
        temperatureC: temp != null ? round2(Number(temp)) : null,
        precipitationMm: precip != null ? round2(Number(precip)) : null,
        windKph,
        condition: tags.length ? tags.join('; ') : 'mild conditions, no weather edge',
        note: `Kickoff weather at ${city}: ${temp ?? '?'}°C, ${precip ?? 0}mm rain, ${windKph ?? '?'} kph wind${tags.length ? ` — ${tags.join('; ')}` : ''}.`,
      };
    } catch (error: any) {
      this.logger.debug(`Weather fetch failed: ${error.message}`);
      return this.weatherUnavailable(error.message);
    }
  }

  private weatherUnavailable(reason: string): WeatherProfile {
    return {
      available: false,
      temperatureC: null,
      precipitationMm: null,
      windKph: null,
      condition: null,
      note: `Weather unavailable (${reason}).`,
    };
  }

  // ─── Discipline watch ───────────────────────────────────────────────────

  private buildDiscipline(insights: MatchInsights): MatchContext['discipline'] {
    const collect = (
      pb: { goalkeepers: any[]; defenders: any[]; midfielders: any[]; forwards: any[] } | null,
      side: 'home' | 'away',
    ): DisciplineWatchPlayer[] => {
      if (!pb) return [];
      const all = [
        ...pb.goalkeepers,
        ...pb.defenders,
        ...pb.midfielders,
        ...pb.forwards,
      ];
      return all
        .map((p) => ({
          name: p.name,
          yellowCards: p.seasonStats?.yellowCards ?? 0,
          teamSide: side,
        }))
        .filter((p) => p.yellowCards >= YELLOW_WATCH_THRESHOLD)
        .sort((a, b) => b.yellowCards - a.yellowCards)
        .slice(0, 5);
    };
    return {
      home: collect(insights.players.home, 'home'),
      away: collect(insights.players.away, 'away'),
    };
  }

  // ─── Stakes ─────────────────────────────────────────────────────────────

  private buildStakes(data: CollectedMatchData): StakesProfile | null {
    const vc = (data as any).venueContext;
    if (!vc) return null;
    const stakesLabel: Record<string, string> = {
      title_race: 'Title race — maximum stakes',
      top_4_chase: 'European-places chase',
      relegation_fight: 'Relegation battle — desperation factor',
      mid_table_dead_rubber: 'Mid-table, little at stake — motivation risk',
    };
    return {
      derby: vc.derbyLabel ?? null,
      lateSeasonStakes: vc.lateSeasonStakes
        ? stakesLabel[vc.lateSeasonStakes] ?? vc.lateSeasonStakes
        : null,
      notes: Array.isArray(vc.notes) ? vc.notes : [],
    };
  }

  // ─── Narrative ──────────────────────────────────────────────────────────

  private buildNarrative(ctx: MatchContext): string {
    const lines: string[] = [];
    if (ctx.referee) lines.push(`REFEREE: ${ctx.referee.note}`);
    if (ctx.weather) lines.push(`WEATHER: ${ctx.weather.note}`);
    if (ctx.stakes) {
      const bits = [ctx.stakes.derby, ctx.stakes.lateSeasonStakes, ...ctx.stakes.notes].filter(
        Boolean,
      );
      if (bits.length) lines.push(`STAKES: ${bits.join('; ')}.`);
    }
    const dh = ctx.discipline.home,
      da = ctx.discipline.away;
    if (dh.length || da.length) {
      const fmt = (arr: DisciplineWatchPlayer[]) =>
        arr.map((p) => `${p.name} (${p.yellowCards}Y)`).join(', ');
      lines.push(
        `BOOKING WATCH: ${[fmt(dh), fmt(da)].filter(Boolean).join(' | ') || 'none'}.`,
      );
    }
    return lines.join('\n');
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
