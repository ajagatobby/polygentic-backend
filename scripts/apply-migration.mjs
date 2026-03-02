/**
 * Apply a single SQL migration file directly to the database.
 * Usage: node scripts/apply-migration.mjs <path-to-sql-file>
 *
 * Splits on Drizzle's `--> statement-breakpoint` delimiter and runs
 * each statement sequentially.
 */
import postgres from 'postgres';
import { readFileSync } from 'fs';

const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-sql-file>');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { ssl: 'require', max: 1 });

const raw = readFileSync(migrationFile, 'utf-8');
const statements = raw
  .split('--> statement-breakpoint')
  .map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  )
  .filter((s) => s.length > 0);

console.log(
  `Applying ${statements.length} statements from ${migrationFile}...`,
);

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const preview = stmt.substring(0, 80).replace(/\n/g, ' ');
  try {
    await sql.unsafe(stmt);
    console.log(`  [${i + 1}/${statements.length}] OK: ${preview}...`);
  } catch (err) {
    console.error(`  [${i + 1}/${statements.length}] FAILED: ${preview}...`);
    console.error(`    Error: ${err.message}`);
    // Continue on IF EXISTS statements, fail on others
    if (!stmt.includes('IF EXISTS') && !stmt.includes('IF NOT EXISTS')) {
      await sql.end();
      process.exit(1);
    }
  }
}

console.log('Migration applied successfully.');
await sql.end();
