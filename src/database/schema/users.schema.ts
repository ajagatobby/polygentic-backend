import {
  pgTable,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';

// ─── Role enum ─────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

// ─── users ─────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    /** Firebase UID — primary key, not auto-generated */
    uid: varchar('uid', { length: 128 }).primaryKey(),

    email: varchar('email', { length: 320 }),
    emailVerified: boolean('email_verified').default(false),
    displayName: varchar('display_name', { length: 255 }),
    photoUrl: text('photo_url'),

    /** Auth provider: 'password', 'google.com', 'apple.com', 'phone', etc. */
    provider: varchar('provider', { length: 50 }),

    /** Role-based access control */
    role: userRoleEnum('role').default('user').notNull(),

    /** Tracks whether the account has been disabled by an admin */
    disabled: boolean('disabled').default(false).notNull(),

    /** Usage tracking */
    requestCount: integer('request_count').default(0).notNull(),
    lastActiveAt: timestamp('last_active_at'),

    /** Timestamps */
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => [
    index('idx_users_email').on(table.email),
    index('idx_users_role').on(table.role),
    index('idx_users_last_active').on(table.lastActiveAt),
  ],
);

/** TypeScript type inferred from the schema */
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
