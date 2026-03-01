import { Module } from '@nestjs/common';
import { MatcherService } from './matcher.service';
import { FuzzyMatchUtil } from './fuzzy-match.util';

@Module({
  providers: [MatcherService, FuzzyMatchUtil],
  exports: [MatcherService, FuzzyMatchUtil],
})
export class MatcherModule {}
