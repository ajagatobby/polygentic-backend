import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { PredictionService } from './prediction.service';
import {
  PredictionQueryDto,
  MispricingQueryDto,
  PredictionResponseDto,
  PredictionDetailResponseDto,
  GeneratePredictionsResultDto,
} from './dto/prediction-query.dto';

@ApiTags('Predictions')
@Controller('api/predictions')
export class PredictionController {
  private readonly logger = new Logger(PredictionController.name);

  constructor(private readonly predictionService: PredictionService) {}

  @Get()
  @ApiOperation({
    summary: 'Get all predictions sorted by confidence',
  })
  @ApiResponse({ status: 200, type: [PredictionResponseDto] })
  async getPredictions(@Query() query: PredictionQueryDto) {
    try {
      const results = await this.predictionService.getPredictions(query);
      return {
        data: results,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      };
    } catch (err) {
      this.logger.error(`Failed to get predictions: ${err.message}`);
      throw new HttpException(
        'Failed to retrieve predictions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('mispricings')
  @ApiOperation({
    summary: 'Get only significant mispricings',
  })
  @ApiResponse({ status: 200, type: [PredictionResponseDto] })
  async getMispricings(@Query() query: MispricingQueryDto) {
    try {
      const minGap = query.minGap ?? 0.05;
      const results = await this.predictionService.getMispricings(minGap);
      return {
        data: results,
        minGap,
        count: results.length,
      };
    } catch (err) {
      this.logger.error(`Failed to get mispricings: ${err.message}`);
      throw new HttpException(
        'Failed to retrieve mispricings',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get detailed prediction by ID' })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({ status: 200, type: PredictionDetailResponseDto })
  async getPredictionById(@Param('id', ParseIntPipe) id: number) {
    try {
      const prediction = await this.predictionService.getPredictionById(id);

      if (!prediction) {
        throw new HttpException(
          `Prediction ${id} not found`,
          HttpStatus.NOT_FOUND,
        );
      }

      return prediction;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Failed to get prediction ${id}: ${err.message}`);
      throw new HttpException(
        'Failed to retrieve prediction',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('generate')
  @ApiOperation({
    summary: 'Trigger manual prediction generation for all matched markets',
  })
  @ApiResponse({ status: 201, type: GeneratePredictionsResultDto })
  async generatePredictions() {
    try {
      this.logger.log('Manual prediction generation triggered');
      const result = await this.predictionService.generatePredictions();
      return result;
    } catch (err) {
      this.logger.error(`Prediction generation failed: ${err.message}`);
      throw new HttpException(
        `Prediction generation failed: ${err.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
