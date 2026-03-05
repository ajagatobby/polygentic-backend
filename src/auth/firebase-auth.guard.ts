import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as admin from 'firebase-admin';
import { IS_PUBLIC_KEY } from './public.decorator';
import { FIREBASE_ADMIN } from './firebase-admin.provider';
import { UsersService } from './users.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    @Inject(FIREBASE_ADMIN) private readonly firebaseApp: admin.app.App,
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if the route is marked as @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header',
      );
    }

    const idToken = authHeader.replace('Bearer ', '');

    let decodedToken: admin.auth.DecodedIdToken;
    try {
      decodedToken = await this.firebaseApp.auth().verifyIdToken(idToken);
    } catch (error: any) {
      this.logger.warn(`Firebase token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired Firebase token');
    }

    // Upsert user in DB (creates on first request, updates lastActiveAt + requestCount)
    const dbUser = await this.usersService.upsertFromToken(decodedToken);

    // Block disabled users
    if (dbUser.disabled) {
      throw new ForbiddenException('Account is disabled');
    }

    // Attach both Firebase token data and DB user to request
    request.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified,
      displayName: decodedToken.name,
      picture: decodedToken.picture,
      firebaseToken: decodedToken,
      dbUser,
    };

    return true;
  }
}
