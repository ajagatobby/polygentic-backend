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

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Firebase Admin initialisation failed — FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY env vars are all required.',
      );
    }

    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        // Private key comes from .env with literal \n — replace them
        privateKey: privateKey.replace(/\\n/g, '\n'),
      }),
    });
    logger.log(`Firebase Admin initialised (project: ${projectId})`);
    return app;
  },
  inject: [ConfigService],
};
