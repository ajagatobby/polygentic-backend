import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PolymarketGammaService } from './services/polymarket-gamma.service';
import { PolymarketClobService } from './services/polymarket-clob.service';
import { PolymarketMatcherService } from './services/polymarket-matcher.service';
import { PolymarketTradingAgent } from './services/polymarket-trading.agent';
import { PolymarketDataService } from './services/polymarket-data.service';
import { SmartMoneySignalService } from './services/smart-money-signal.service';
import { CopyTraderService } from './services/copy-trader.service';
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
    PolymarketDataService,
    SmartMoneySignalService,
    CopyTraderService,
    PolymarketService,
  ],
  exports: [
    PolymarketService,
    PolymarketDataService,
    SmartMoneySignalService,
    CopyTraderService,
  ],
})
export class PolymarketModule {}
