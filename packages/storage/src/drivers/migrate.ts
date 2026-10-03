/**
 * Migration runner (database-schema.md §6): one committed, drizzle-kit-generated SQL migration
 * set applied to BOTH embedded PGlite and server Postgres — re-running is a no-op (drizzle
 * records applied files in `drizzle.__drizzle_migrations`). Server mode takes a Postgres advisory
 * lock on a dedicated connection so concurrent boots cannot race a migration.
 */

import { fileURLToPath } from 'node:url';

import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';

/** Absolute path of packages/storage/migrations — resolved from this module, not cwd. */
export function migrationsFolder(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/** Advisory lock key guarding server-mode migrations (arbitrary, stable constant). */
export const MIGRATION_ADVISORY_LOCK = 727045;

/** Apply committed migrations to an embedded PGlite database (idempotent). */
export async function migrateEmbedded(pglite: PGlite): Promise<void> {
  const db = drizzlePglite(pglite);
  await migratePglite(db, { migrationsFolder: migrationsFolder() });
}

/**
 * Apply committed migrations to a server Postgres database (idempotent, advisory-locked on one
 * dedicated connection, migrating through that same connection).
 */
export async function migrateServer(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    try {
      const db = drizzleNodePg(client);
      await migrateNodePg(db, { migrationsFolder: migrationsFolder() });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]);
    }
  } finally {
    client.release();
  }
}
