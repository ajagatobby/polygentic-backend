import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { firebaseAdminProvider } from './firebase-admin.provider';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { AuthController } from './auth.controller';

/**
 * Global auth module.
 *
 * - Initialises Firebase Admin SDK (singleton).
 * - Registers FirebaseAuthGuard as a global guard via APP_GUARD.
 * - Routes marked with @Public() bypass the guard.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    firebaseAdminProvider,
    FirebaseAuthGuard,
    {
      provide: APP_GUARD,
      useClass: FirebaseAuthGuard,
    },
  ],
  exports: [firebaseAdminProvider],
})
export class AuthModule {}
