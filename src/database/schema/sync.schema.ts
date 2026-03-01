import {
  pgTable,
  varchar,
  text,
  timestamp,
  serial,
  integer,
  index,
} from 'drizzle-orm/pg-core';

// ─── sync_log ──────────────────────────────────────────────────────────

export const syncLog = pgTable(
  'sync_log',
  {
    id: serial('id').primaryKey(),
    source: varchar('source', { length: 50 }).notNull(),
    task: varchar('task', { length: 100 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    recordsProcessed: integer('records_processed'),
    errorMessage: text('error_message'),
    apiRequestsUsed: integer('api_requests_used'),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at').notNull(),
    completedAt: timestamp('completed_at'),
  },
  (table) => [
    index('idx_sync_log_source').on(table.source, table.task),
    index('idx_sync_log_started').on(table.startedAt),
    index('idx_sync_log_status').on(table.status),
  ],
);
