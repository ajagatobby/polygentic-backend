import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq, desc, and, sql } from 'drizzle-orm';
import * as schema from '../database/schema';

export type AlertType = 'mispricing' | 'live_event' | 'price_movement' | 'lineup_change';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

interface CreateAlertDto {
  predictionId: number;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  data?: Record<string, any>;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(@Inject('DRIZZLE') private db: any) {}

  async createAlert(dto: CreateAlertDto): Promise<any> {
    try {
      const [alert] = await this.db
        .insert(schema.alerts)
        .values({
          predictionId: dto.predictionId,
          type: dto.type,
          severity: dto.severity,
          title: dto.title,
          message: dto.message,
          data: dto.data || null,
          acknowledged: false,
        })
        .returning();

      this.logger.log(`Alert created: [${dto.severity.toUpperCase()}] ${dto.title}`);
      return alert;
    } catch (error) {
      this.logger.error(`Failed to create alert: ${error.message}`);
      throw error;
    }
  }

  async createMispricingAlert(
    predictionId: number,
    marketTitle: string,
    polymarketPrice: number,
    consensusPrice: number,
    gap: number,
  ): Promise<any> {
    const severity = this.getMispricingSeverity(Math.abs(gap));
    return this.createAlert({
      predictionId,
      type: 'mispricing',
      severity,
      title: `Mispricing detected: ${marketTitle}`,
      message: `Polymarket price ${(polymarketPrice * 100).toFixed(1)}% vs consensus ${(consensusPrice * 100).toFixed(1)}%. Gap: ${(gap * 100).toFixed(1)}%`,
      data: { polymarketPrice, consensusPrice, gap },
    });
  }

  async createLiveEventAlert(
    predictionId: number,
    eventType: string,
    matchTitle: string,
    details: Record<string, any>,
  ): Promise<any> {
    return this.createAlert({
      predictionId,
      type: 'live_event',
      severity: eventType === 'goal' || eventType === 'red_card' ? 'high' : 'medium',
      title: `Live: ${eventType.toUpperCase()} in ${matchTitle}`,
      message: `${eventType} detected. Checking for Polymarket price lag.`,
      data: { eventType, ...details },
    });
  }

  async getAlerts(filters?: {
    type?: AlertType;
    severity?: AlertSeverity;
    acknowledged?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ data: any[]; total: number }> {
    const conditions: any[] = [];

    if (filters?.type) {
      conditions.push(eq(schema.alerts.type, filters.type));
    }
    if (filters?.severity) {
      conditions.push(eq(schema.alerts.severity, filters.severity));
    }
    if (filters?.acknowledged !== undefined) {
      conditions.push(eq(schema.alerts.acknowledged, filters.acknowledged));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;

    const [data, countResult] = await Promise.all([
      this.db
        .select()
        .from(schema.alerts)
        .where(where)
        .orderBy(desc(schema.alerts.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.alerts)
        .where(where),
    ]);

    return { data, total: countResult[0]?.count || 0 };
  }

  async getUnreadAlerts(): Promise<any[]> {
    return this.db
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.acknowledged, false))
      .orderBy(desc(schema.alerts.createdAt))
      .limit(100);
  }

  async acknowledgeAlert(id: number): Promise<any> {
    const [updated] = await this.db
      .update(schema.alerts)
      .set({ acknowledged: true })
      .where(eq(schema.alerts.id, id))
      .returning();

    return updated;
  }

  async acknowledgeAll(): Promise<number> {
    const result = await this.db
      .update(schema.alerts)
      .set({ acknowledged: true })
      .where(eq(schema.alerts.acknowledged, false));

    return result.rowCount || 0;
  }

  private getMispricingSeverity(absGap: number): AlertSeverity {
    if (absGap >= 0.15) return 'critical';
    if (absGap >= 0.10) return 'high';
    if (absGap >= 0.07) return 'medium';
    return 'low';
  }
}
