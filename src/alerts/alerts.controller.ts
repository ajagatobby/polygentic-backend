import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';

@ApiTags('Alerts')
@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Get alerts with optional filters' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['mispricing', 'live_event', 'price_movement', 'lineup_change'],
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: ['low', 'medium', 'high', 'critical'],
  })
  @ApiQuery({ name: 'acknowledged', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAlerts(
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('acknowledged') acknowledged?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;

    return this.alertsService.getAlerts({
      type: type as any,
      severity: severity as any,
      acknowledged:
        acknowledged !== undefined ? acknowledged === 'true' : undefined,
      limit: limitNum,
      offset: (pageNum - 1) * limitNum,
    });
  }

  @Get('unread')
  @ApiOperation({ summary: 'Get unacknowledged alerts' })
  async getUnreadAlerts() {
    return this.alertsService.getUnreadAlerts();
  }

  @Post(':id/acknowledge')
  @ApiOperation({ summary: 'Acknowledge an alert' })
  @ApiParam({ name: 'id', type: Number })
  async acknowledgeAlert(@Param('id', ParseIntPipe) id: number) {
    const alert = await this.alertsService.acknowledgeAlert(id);
    if (!alert) {
      throw new NotFoundException(`Alert ${id} not found`);
    }
    return alert;
  }

  @Post('acknowledge-all')
  @ApiOperation({ summary: 'Acknowledge all unread alerts' })
  async acknowledgeAll() {
    const count = await this.alertsService.acknowledgeAll();
    return { acknowledged: count };
  }
}
