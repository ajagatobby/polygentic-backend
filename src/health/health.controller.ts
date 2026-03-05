import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { desc, sql } from 'drizzle-orm';
import * as schema from '../database/schema';
import { Public } from '../auth/public.decorator';

@ApiTags('Health')
@Controller('api')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startTime = Date.now();

  constructor(@Inject('DRIZZLE') private db: any) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  async health() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    let dbStatus = 'unknown';

    try {
      await this.db.execute(sql`SELECT 1`);
      dbStatus = 'connected';
    } catch {
      dbStatus = 'disconnected';
    }

    let lastSyncs: Record<string, any> = {};
    try {
      const syncs = await this.db
        .select()
        .from(schema.syncLog)
        .orderBy(desc(schema.syncLog.startedAt))
        .limit(10);

      const seen = new Set<string>();
      for (const sync of syncs) {
        const key = `${sync.source}_${sync.task}`;
        if (!seen.has(key)) {
          seen.add(key);
          lastSyncs[key] = {
            status: sync.status,
            startedAt: sync.startedAt,
            completedAt: sync.completedAt,
            durationMs: sync.durationMs,
          };
        }
      }
    } catch {
      lastSyncs = { error: 'Failed to query sync log' };
    }

    let counts: Record<string, number> = {};
    try {
      const [fixturesCount, teamsCount, alertsCount, predictionsCount] =
        await Promise.all([
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.fixtures),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.teams),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.alerts),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.predictions),
        ]);
      counts = {
        fixtures: fixturesCount[0]?.count || 0,
        teams: teamsCount[0]?.count || 0,
        predictions: predictionsCount[0]?.count || 0,
        alerts: alertsCount[0]?.count || 0,
      };
    } catch {
      counts = { error: -1 };
    }

    return {
      status: dbStatus === 'connected' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime_seconds: uptime,
      database: dbStatus,
      counts,
      last_syncs: lastSyncs,
    };
  }
}
