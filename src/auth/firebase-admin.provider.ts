import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

export const FIREBASE_ADMIN = 'FIREBASE_ADMIN';

export const firebaseAdminProvider: Provider = {
  provide: FIREBASE_ADMIN,
  useFactory: (configService: ConfigService): admin.app.App => {
    const logger = new Logger('FirebaseAdmin');

    // If already initialised (hot-reload / tests), return existing app
    if (admin.apps.length > 0) {
      logger.log('Reusing existing Firebase Admin instance');
      return admin.apps[0]!;
    }

    const projectId = configService.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = configService.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = configService.get<string>('FIREBASE_PRIVATE_KEY');

    if (projectId && clientEmail && privateKey) {
      // Prefer env-var credentials (production / CI)
      const app = admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          // Private key comes from .env with literal \n — replace them
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      logger.log(
        `Firebase Admin initialised via env vars (project: ${projectId})`,
      );
      return app;
    }

    // Fallback: local service account JSON file
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const serviceAccount = require('../../firebase-service-account.json');
      const app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      logger.log(
        `Firebase Admin initialised via service-account file (project: ${serviceAccount.project_id})`,
      );
      return app;
    } catch {
      logger.error(
        'Firebase Admin could not be initialised. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env vars, or place firebase-service-account.json in project root.',
      );
      throw new Error(
        'Firebase Admin initialisation failed — missing credentials',
      );
    }
  },
  inject: [ConfigService],
};
