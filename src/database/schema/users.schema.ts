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

// ─── Subscription enums ────────────────────────────────────────────────

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'free',
  'pro',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'none',
  'active',
  'canceled',
  'past_due',
  'trialing',
]);

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

    /** Subscription / billing */
    subscriptionTier: subscriptionTierEnum('subscription_tier')
      .default('free')
      .notNull(),
    stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
    stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
    subscriptionStatus: subscriptionStatusEnum('subscription_status')
      .default('none')
      .notNull(),
    subscriptionPeriodEnd: timestamp('subscription_period_end'),

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
