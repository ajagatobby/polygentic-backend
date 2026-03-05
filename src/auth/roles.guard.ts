import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard that checks whether the authenticated user has one of the
 * required roles set via @Roles('admin', ...).
 *
 * If no @Roles() decorator is present on the handler or class,
 * the guard passes (any authenticated user is allowed).
 *
 * Must run AFTER FirebaseAuthGuard so that `req.user` is populated.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // If no @Roles() decorator, allow any authenticated user
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user?.dbUser) {
      throw new ForbiddenException('User profile not loaded');
    }

    if (user.dbUser.disabled) {
      throw new ForbiddenException('Account is disabled');
    }

    const hasRole = requiredRoles.includes(user.dbUser.role);
    if (!hasRole) {
      throw new ForbiddenException(
        `This endpoint requires one of: [${requiredRoles.join(', ')}]. Your role: ${user.dbUser.role}`,
      );
    }

    return true;
  }
}
