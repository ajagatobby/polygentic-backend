import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a route as public — bypasses FirebaseAuthGuard.
 *
 * Usage:
 *   @Public()
 *   @Get('health')
 *   getHealth() { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
