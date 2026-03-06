import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PolymarketGammaService } from './services/polymarket-gamma.service';
import { PolymarketClobService } from './services/polymarket-clob.service';
import { PolymarketMatcherService } from './services/polymarket-matcher.service';
import { PolymarketTradingAgent } from './services/polymarket-trading.agent';
import { PolymarketService } from './polymarket.service';
import { PolymarketController } from './polymarket.controller';

@Module({
  imports: [ConfigModule],
  controllers: [PolymarketController],
  providers: [
    PolymarketGammaService,
    PolymarketClobService,
    PolymarketMatcherService,
    PolymarketTradingAgent,
    PolymarketService,
  ],
  exports: [PolymarketService],
})
export class PolymarketModule {}
