import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Security headers via helmet
  app.use(helmet());

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

  const configService = app.get(ConfigService);

  // CORS — reads allowed origins from env (comma-separated), defaults to * in dev
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  const origin =
    corsOrigins === '*'
      ? true // allow all in dev
      : corsOrigins.split(',').map((o) => o.trim());

  app.enableCors({
    origin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Retry-After',
    ],
  });

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Polygentic API')
    .setDescription(
      'AI-powered soccer prediction backend using multi-agent analysis. Combines football data, bookmaker odds, and real-time research to produce match predictions.',
    )
    .setVersion('2.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Firebase ID Token',
        description: 'Enter your Firebase ID token',
      },
      'firebase-auth',
    )
    .addTag('Health', 'System health and status')
    .addTag('Auth', 'Authentication and user info')
    .addTag('Football', 'Fixtures, teams, and match data')
    .addTag('Odds', 'Bookmaker odds and consensus probabilities')
    .addTag('Predictions', 'AI-powered match predictions')
    .addTag('Alerts', 'Alert management')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('PORT', 3000);

  await app.listen(port, '0.0.0.0');

  logger.log(`Polygentic backend running on http://localhost:${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api/docs`);
  logger.log(`Health check at http://localhost:${port}/api/health`);
}

bootstrap();
