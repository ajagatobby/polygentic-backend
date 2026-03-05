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

  // ─── Registration ────────────────────────────────────────────────────

  /**
   * Create a new user in Firebase Auth and insert a DB row with role=user.
   * Called by the public POST /api/auth/register endpoint.
   *
   * Throws Firebase error codes (auth/email-already-exists, etc.) on failure.
   */
  async createUser(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<User> {
    // 1. Create in Firebase Auth
    const firebaseUser = await this.firebaseApp.auth().createUser({
      email: input.email,
      password: input.password,
      displayName: input.displayName || undefined,
      emailVerified: false,
    });

    // 2. Insert into DB with default role=user
    const [dbUser] = await this.db
      .insert(users)
      .values({
        uid: firebaseUser.uid,
        email: input.email,
        emailVerified: false,
        displayName: input.displayName || null,
        photoUrl: null,
        provider: 'password',
        role: 'user',
        disabled: false,
        requestCount: 0,
        lastActiveAt: new Date(),
      })
      .returning();

    this.logger.log(
      `Created user ${input.email} (${firebaseUser.uid}) with role=user`,
    );

    return dbUser;
  }

  // ─── Upsert on every authenticated request ───────────────────────────

  /**
   * Insert or update a user row from a decoded Firebase token.
   * Called by FirebaseAuthGuard on every authenticated request.
   *
   * Uses ON CONFLICT DO UPDATE so the first request creates the row
   * and subsequent requests keep email/displayName/photo/lastActiveAt fresh.
   * Increments request_count atomically.
   *
   * NOTE: role is NOT touched on update — it can only be changed via direct DB access.
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
          // role is intentionally NOT updated here — immutable via API
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

  // ─── Account management (admin-only, called from controller) ─────────

  /**
   * Disable or re-enable a user account.
   * Blocks in DB + Firebase so they can't get new tokens either.
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
