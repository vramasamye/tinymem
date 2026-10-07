/**
 * Migration runner (database-schema.md §6): one committed, drizzle-kit-generated SQL migration
 * set applied to BOTH embedded PGlite and server Postgres — re-running is a no-op (drizzle
 * records applied files in `drizzle.__drizzle_migrations`). Server mode takes a Postgres advisory
 * lock on a dedicated connection so concurrent boots cannot race a migration.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';

/** Nearest ancestor holding a package.json — the package root, in the src AND the dist layout. */
function packageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`storage: no package root above ${from}`);
    dir = parent;
  }
}

let cachedMigrationsFolder: string | null = null;

/**
 * Absolute path of the committed `migrations/` set, anchored at the PACKAGE ROOT (M16).
 *
 * Anchoring on the package root rather than on this module's own depth is what makes it correct
 * both in the repo (`src/drivers/migrate.ts` → `packages/storage/migrations`) and in the published
 * bundle, where every module is inlined into `dist/index.js` — a fixed `../../migrations` resolved
 * one level outside the installed package and the published CLI could not migrate its own database.
 * The published tarball ships the folder (`files: ["dist", "migrations"]`).
 */
export function migrationsFolder(): string {
  if (cachedMigrationsFolder === null) {
    cachedMigrationsFolder = join(packageRoot(dirname(fileURLToPath(import.meta.url))), 'migrations');
  }
  return cachedMigrationsFolder;
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
