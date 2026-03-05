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

  // Global validation pipe — strict mode
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true, // Reject requests with unexpected properties
      transformOptions: {
        enableImplicitConversion: false, // Require explicit @Type() decorators
      },
    }),
  );

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // CORS — explicit allowlist only, never reflect arbitrary origins
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '');
  const allowedOrigins = corsOrigins
    ? corsOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Retry-After',
    ],
  });

  if (allowedOrigins.length === 0) {
    logger.warn(
      'CORS_ORIGINS is empty — cross-origin requests are blocked. Set CORS_ORIGINS=http://localhost:3000 for development.',
    );
  }

  // Swagger — only in non-production environments
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Polygentic API')
      .setDescription(
        'AI-powered soccer prediction backend using multi-agent analysis.',
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
    logger.log('Swagger docs enabled at /api/docs (non-production)');
  } else {
    logger.log('Swagger docs DISABLED in production');
  }

  const port = configService.get<number>('PORT', 3000);
  const host = configService.get<string>(
    'HOST',
    nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1',
  );

  await app.listen(port, host);

  logger.log(`Polygentic backend running on http://${host}:${port}`);
  logger.log(`Health check at http://${host}:${port}/api/health`);
}

bootstrap();
