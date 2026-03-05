import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to specific roles.
 *
 * Usage:
 *   @Roles('admin')
 *   @Post('sync/full')
 *   fullSync() { ... }
 *
 * Requires the RolesGuard to be active (registered via APP_GUARD in AuthModule).
 * The guard reads the user's role from `req.user.dbUser.role`, which is set by
 * FirebaseAuthGuard after upserting the user.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
