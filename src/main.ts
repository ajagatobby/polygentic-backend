import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // CORS
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Polygentic API')
    .setDescription(
      'AI-powered soccer prediction backend using multi-agent analysis. Combines API-Football data, bookmaker odds, and real-time research to produce match predictions.',
    )
    .setVersion('2.0')
    .addTag('Health', 'System health and status')
    .addTag('Football', 'Fixtures, teams, and match data')
    .addTag('Odds', 'Bookmaker odds and consensus probabilities')
    .addTag('Predictions', 'AI-powered match predictions')
    .addTag('Alerts', 'Alert management')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  await app.listen(port, '0.0.0.0');

  logger.log(`Polygentic backend running on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
  logger.log(`Health check at http://localhost:${port}/api/health`);
}

bootstrap();
