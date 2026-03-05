import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { firebaseAdminProvider } from './firebase-admin.provider';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { RolesGuard } from './roles.guard';
import { UsersService } from './users.service';
import { AuthController } from './auth.controller';

/**
 * Global auth module.
 *
 * - Initialises Firebase Admin SDK (singleton).
 * - Provides UsersService for user upsert / role management.
 * - Registers FirebaseAuthGuard globally (verifies token + upserts user).
 * - Registers RolesGuard globally (checks @Roles() decorator).
 * - Routes marked with @Public() bypass both guards.
 *
 * Guard execution order (guaranteed by APP_GUARD registration order):
 *   1. FirebaseAuthGuard — verifies token, upserts user, populates req.user
 *   2. RolesGuard — checks req.user.dbUser.role against @Roles()
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    firebaseAdminProvider,
    UsersService,
    FirebaseAuthGuard,
    RolesGuard,
    // Global guard #1: Firebase token verification + user upsert
    {
      provide: APP_GUARD,
      useClass: FirebaseAuthGuard,
    },
    // Global guard #2: Role-based access control
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  exports: [firebaseAdminProvider, UsersService],
})
export class AuthModule {}
