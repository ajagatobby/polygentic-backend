import { Controller, Post, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SyncService } from './sync.service';

@ApiTags('Sync')
@Controller('api/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('full')
  @ApiOperation({
    summary: 'Run a full sync cycle (fixtures, standings, injuries, odds)',
  })
  async fullSync() {
    return this.syncService.runFullSync();
  }

  @Post('fixtures')
  @ApiOperation({ summary: 'Sync upcoming fixtures for all tracked leagues' })
  async syncFixtures() {
    await this.syncService.syncFixtures();
    return { message: 'Fixtures sync completed' };
  }

  @Post('completed-fixtures')
  @ApiOperation({
    summary: 'Sync completed fixtures (final scores) for all tracked leagues',
  })
  async syncCompletedFixtures() {
    await this.syncService.syncCompletedFixtures();
    return { message: 'Completed fixtures sync completed' };
  }

  @Post('injuries')
  @ApiOperation({ summary: 'Sync injuries for all tracked leagues' })
  async syncInjuries() {
    await this.syncService.syncInjuries();
    return { message: 'Injuries sync completed' };
  }

  @Post('standings')
  @ApiOperation({ summary: 'Sync standings for all tracked leagues' })
  async syncStandings() {
    await this.syncService.syncStandings();
    return { message: 'Standings sync completed' };
  }

  @Post('odds')
  @ApiOperation({ summary: 'Sync odds for all tracked leagues' })
  async syncOdds() {
    await this.syncService.syncOdds();
    return { message: 'Odds sync completed' };
  }

  @Get('history')
  @ApiOperation({ summary: 'Get sync history log' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max records to return (default 50)',
  })
  async getSyncHistory(@Query('limit') limit?: string) {
    return this.syncService.getSyncHistory(limit ? parseInt(limit, 10) : 50);
  }
}
