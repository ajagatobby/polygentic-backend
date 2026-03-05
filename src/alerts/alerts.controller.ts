import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { AlertsService } from './alerts.service';

@ApiTags('Alerts')
@ApiBearerAuth('firebase-auth')
@Roles('admin')
@Controller('api/alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Get alerts with optional filters' })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['high_confidence', 'value_bet', 'live_event', 'lineup_change'],
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
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 100);

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
