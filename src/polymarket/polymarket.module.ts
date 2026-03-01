import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PolymarketService } from './polymarket.service';
import { PolymarketWebSocketService } from './polymarket-websocket.service';
import { PolymarketController } from './polymarket.controller';

@Module({
  imports: [ConfigModule],
  controllers: [PolymarketController],
  providers: [PolymarketService, PolymarketWebSocketService],
  exports: [PolymarketService, PolymarketWebSocketService],
})
export class PolymarketModule {}
