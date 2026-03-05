import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as admin from 'firebase-admin';
import { IS_PUBLIC_KEY } from './public.decorator';
import { FIREBASE_ADMIN } from './firebase-admin.provider';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    @Inject(FIREBASE_ADMIN) private readonly firebaseApp: admin.app.App,
    private readonly reflector: Reflector,
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

    try {
      const decodedToken = await this.firebaseApp.auth().verifyIdToken(idToken);
      // Attach the decoded user info to the request for downstream use
      request.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        emailVerified: decodedToken.email_verified,
        displayName: decodedToken.name,
        picture: decodedToken.picture,
        // Pass through the full token for any custom claims
        firebaseToken: decodedToken,
      };
      return true;
    } catch (error: any) {
      this.logger.warn(`Firebase token verification failed: ${error.message}`);
      throw new UnauthorizedException('Invalid or expired Firebase token');
    }
  }
}
