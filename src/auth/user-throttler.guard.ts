import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Custom ThrottlerGuard that uses Firebase UID as the throttle key
 * for authenticated requests, falling back to IP for public routes.
 *
 * This ensures rate limits are per-user rather than per-IP,
 * so users behind shared NATs (offices, universities) each get
 * their own rate limit bucket.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // If the user is authenticated (FirebaseAuthGuard ran first),
    // use their UID as the throttle key
    if (req.user?.uid) {
      return `user:${req.user.uid}`;
    }

    // Fallback to IP for public/unauthenticated routes
    return req.ips?.length ? req.ips[0] : req.ip;
  }
}
