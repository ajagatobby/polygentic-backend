import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as postgresModule from 'postgres';
import * as schema from './schema';

// Handle both ESM default export and CJS module.exports
const postgres =
  typeof (postgresModule as any).default === 'function'
    ? (postgresModule as any).default
    : postgresModule;

export const DRIZZLE = 'DRIZZLE';

export const DrizzleProvider: Provider = {
  provide: DRIZZLE,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => {
    const databaseUrl = configService.get<string>('DATABASE_URL');
    const databaseSsl = configService.get<string>('DATABASE_SSL', 'false');

    let connectionString = databaseUrl;

    if (!connectionString) {
      const host = configService.get<string>('DATABASE_HOST');
      const port = configService.get<number>('DATABASE_PORT', 5432);
      const name = configService.get<string>('DATABASE_NAME');
      const user = configService.get<string>('DATABASE_USER');
      const password = configService.get<string>('DATABASE_PASSWORD');
      connectionString = `postgresql://${user}:${password}@${host}:${port}/${name}`;
    }

    const client = postgres(connectionString, {
      ssl: databaseSsl === 'true' ? 'require' : false,
      max: 20,
      idle_timeout: 20,
      connect_timeout: 10,
    });

    return drizzle(client, { schema });
  },
};
