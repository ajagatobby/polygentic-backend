import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, desc, sql } from 'drizzle-orm';
import * as admin from 'firebase-admin';
import { users, User } from '../database/schema/users.schema';
import { FIREBASE_ADMIN } from './firebase-admin.provider';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject('DRIZZLE') private readonly db: any,
    @Inject(FIREBASE_ADMIN) private readonly firebaseApp: admin.app.App,
  ) {}

  // ─── Upsert on every authenticated request ───────────────────────────

  /**
   * Insert or update a user row from a decoded Firebase token.
   * Called by FirebaseAuthGuard on every authenticated request.
   *
   * Uses ON CONFLICT DO UPDATE so the first request creates the row
   * and subsequent requests keep email/displayName/photo/lastActiveAt fresh.
   * Increments request_count atomically.
   */
  async upsertFromToken(decoded: admin.auth.DecodedIdToken): Promise<User> {
    const provider = decoded.firebase?.sign_in_provider || 'unknown';

    const [user] = await this.db
      .insert(users)
      .values({
        uid: decoded.uid,
        email: decoded.email || null,
        emailVerified: decoded.email_verified || false,
        displayName: decoded.name || null,
        photoUrl: decoded.picture || null,
        provider,
        role: 'user',
        disabled: false,
        requestCount: 1,
        lastActiveAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email: decoded.email || sql`${users.email}`,
          emailVerified: decoded.email_verified ?? sql`${users.emailVerified}`,
          displayName: decoded.name || sql`${users.displayName}`,
          photoUrl: decoded.picture || sql`${users.photoUrl}`,
          provider,
          requestCount: sql`${users.requestCount} + 1`,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        },
      })
      .returning();

    return user;
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  async findByUid(uid: string): Promise<User | undefined> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.uid, uid))
      .limit(1);
    return user;
  }

  async findAll(opts: { limit?: number; offset?: number } = {}): Promise<{
    data: User[];
    total: number;
  }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [data, [{ count }]] = await Promise.all([
      this.db
        .select()
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(users),
    ]);

    return { data, total: count };
  }

  // ─── Role management ─────────────────────────────────────────────────

  /**
   * Set a user's role in the DB and sync it to Firebase custom claims.
   * Firebase custom claims propagate on the user's next token refresh.
   */
  async setRole(uid: string, role: 'user' | 'admin'): Promise<User> {
    // Update DB
    const [updated] = await this.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.uid, uid))
      .returning();

    if (!updated) {
      throw new Error(`User ${uid} not found`);
    }

    // Sync to Firebase custom claims so the client token includes the role
    try {
      await this.firebaseApp.auth().setCustomUserClaims(uid, { role });
      this.logger.log(
        `Set role '${role}' for user ${uid} (DB + Firebase claims)`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to set Firebase custom claims for ${uid}: ${error.message}`,
      );
      // DB is already updated — the guard reads from DB anyway,
      // so this is non-fatal. Claims will be stale until next setRole call.
    }

    return updated;
  }

  /**
   * Disable or re-enable a user account.
   */
  async setDisabled(uid: string, disabled: boolean): Promise<User> {
    const [updated] = await this.db
      .update(users)
      .set({ disabled, updatedAt: new Date() })
      .where(eq(users.uid, uid))
      .returning();

    if (!updated) {
      throw new Error(`User ${uid} not found`);
    }

    // Also disable in Firebase so they can't get new tokens
    try {
      await this.firebaseApp.auth().updateUser(uid, { disabled });
      this.logger.log(`User ${uid} disabled=${disabled} (DB + Firebase)`);
    } catch (error: any) {
      this.logger.error(
        `Failed to update Firebase disabled status for ${uid}: ${error.message}`,
      );
    }

    return updated;
  }
}
