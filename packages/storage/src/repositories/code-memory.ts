/**
 * Code-memory persistence (ADR-0008): `repositories` + `file_fingerprints` — this module is the
 * only writer of those tables. `last_ingested_commit` is intentionally untouched: the ingestion
 * checkpoint advances only when changed knowledge is fully processed, which is the drift
 * pipeline's job, never persistence's.
 *
 * Conventions: handwritten parameterized SQL over the shared `Database` client (the one SQL
 * surface in the engine), every input Zod-parsed at the boundary, one transaction per snapshot.
 */

import { z } from 'zod';

import {
  EnsureCodeRepositorySchema,
  SnapshotInputSchema,
  SnapshotMetadataSchema,
  uuidv7,
} from '@onememory/core';
import type {
  CodeRepositoryRecord,
  EnsureCodeRepository,
  FingerprintTier,
  SnapshotInput,
  SnapshotMetadata,
  SnapshotSaveResult,
  StoredFingerprint,
} from '@onememory/core';

import type { Database } from '../drivers/client';
import { pgTextArray, toIso, toIsoOrNull } from '../drivers/client';

import { NotFoundError, parseInput } from './util';

const TIERS = ['committed', 'worktree'] as const;
const UPSERT_CHUNK = 500;

const tierKey = (tier: string, path: string): string => `${tier}\u0000${path}`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type RepositoryRow = {
  id: string;
  project_id: string;
  root_path: string;
  remote_url: string | null;
  head_commit: string | null;
  last_ingested_commit: string | null;
  fingerprint: Record<string, unknown>;
  last_indexed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapRepository(row: RepositoryRow): CodeRepositoryRecord {
  return {
    id: row.id,
    project_id: row.project_id,
    root_path: row.root_path,
    remote_url: row.remote_url,
    head_commit: row.head_commit,
    last_ingested_commit: row.last_ingested_commit,
    last_indexed_at: toIsoOrNull(row.last_indexed_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

type FingerprintRow = {
  repository_id: string;
  path: string;
  tier: string;
  blob_sha: string;
  file_mode: string | null;
  last_seen_commit: string | null;
  updated_at: Date | string;
};

function mapFingerprint(row: FingerprintRow): StoredFingerprint {
  if (row.tier !== 'committed' && row.tier !== 'worktree') {
    throw new TypeError(`storage: invalid fingerprint tier ${JSON.stringify(row.tier)}`);
  }
  return {
    repository_id: row.repository_id,
    path: row.path,
    tier: row.tier,
    blob_sha: row.blob_sha,
    file_mode: row.file_mode,
    last_seen_commit: row.last_seen_commit,
    updated_at: toIso(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export async function ensureRepository(
  db: Database,
  rawInput: EnsureCodeRepository,
): Promise<CodeRepositoryRecord> {
  const input = parseInput(EnsureCodeRepositorySchema, rawInput, 'ensureRepository');
  const result = await db.query<RepositoryRow>(
    `INSERT INTO repositories (id, project_id, root_path)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (project_id, root_path)
       DO UPDATE SET root_path = EXCLUDED.root_path
       RETURNING *`,
    [uuidv7(), input.project_id, input.root_path],
  );
  return mapRepository(result.rows[0]!);
}

export async function getRepository(db: Database, id: string): Promise<CodeRepositoryRecord | null> {
  const result = await db.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1::uuid', [id]);
  const row = result.rows[0];
  return row ? mapRepository(row) : null;
}

export async function listRepositories(db: Database, projectId: string): Promise<CodeRepositoryRecord[]> {
  const result = await db.query<RepositoryRow>(
    'SELECT * FROM repositories WHERE project_id = $1::uuid ORDER BY created_at, id',
    [projectId],
  );
  return result.rows.map(mapRepository);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function saveSnapshot(
  db: Database,
  repositoryId: string,
  rawSnapshot: SnapshotInput,
): Promise<SnapshotSaveResult> {
  const snapshot = parseInput(SnapshotInputSchema, rawSnapshot, 'saveSnapshot');
  return db.transaction(async (tx) => {
    const locked = await tx.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE id = $1::uuid FOR UPDATE',
      [repositoryId],
    );
    const repository = locked.rows[0];
    if (!repository) throw new NotFoundError('repository', repositoryId);
    // A snapshot captured under a different root must never overwrite this repository's rows.
    parseInput(
      z.literal(repository.root_path),
      snapshot.root_path,
      'saveSnapshot root_path mismatch',
    );

    const current = await tx.query<{ tier: string; path: string }>(
      'SELECT tier, path FROM file_fingerprints WHERE repository_id = $1::uuid',
      [repositoryId],
    );
    const present = new Set(snapshot.files.map((file) => tierKey(file.tier, file.path)));
    const unavailable = new Set(snapshot.skipped.map((entry) => tierKey(entry.tier, entry.path)));

    let deleted = 0;
    for (const tier of TIERS) {
      const gone = current.rows
        .filter(
          (row) => row.tier === tier &&
            !present.has(tierKey(row.tier, row.path)) &&
            !unavailable.has(tierKey(row.tier, row.path)),
        )
        .map((row) => row.path);
      if (gone.length === 0) continue;
      const result = await tx.query(
        `DELETE FROM file_fingerprints
          WHERE repository_id = $1::uuid AND tier = $2 AND path = ANY($3::text[])`,
        [repositoryId, tier, pgTextArray(gone)],
      );
      deleted += result.rowCount ?? gone.length;
    }
    const retained = current.rows.filter((row) => unavailable.has(tierKey(row.tier, row.path))).length;

    let rewritten = 0;
    for (let offset = 0; offset < snapshot.files.length; offset += UPSERT_CHUNK) {
      const chunk = snapshot.files.slice(offset, offset + UPSERT_CHUNK);
      const values: string[] = [];
      const params: unknown[] = [repositoryId];
      chunk.forEach((file, index) => {
        const base = 2 + index * 5;
        values.push(
          `($1::uuid, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, now())`,
        );
        params.push(file.path, file.tier, file.blob_sha, file.mode, snapshot.head_commit);
      });
      // The IS DISTINCT FROM guard keeps unchanged fingerprints untouched: updated_at marks the
      // last value change, and rowCount reports only rows that actually changed.
      const result = await tx.query(
        `INSERT INTO file_fingerprints
           (repository_id, path, tier, blob_sha, file_mode, last_seen_commit, updated_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (repository_id, tier, path) DO UPDATE
           SET blob_sha = EXCLUDED.blob_sha,
               file_mode = EXCLUDED.file_mode,
               last_seen_commit = EXCLUDED.last_seen_commit,
               updated_at = now()
         WHERE file_fingerprints.blob_sha IS DISTINCT FROM EXCLUDED.blob_sha
            OR file_fingerprints.file_mode IS DISTINCT FROM EXCLUDED.file_mode
            OR file_fingerprints.last_seen_commit IS DISTINCT FROM EXCLUDED.last_seen_commit`,
        params,
      );
      rewritten += result.rowCount ?? 0;
    }

    const fingerprint = JSON.stringify({
      hash_algorithm: snapshot.hash_algorithm,
      mode: snapshot.mode,
      exclusion_globs: snapshot.exclusion_globs,
      captured_at: snapshot.captured_at,
      file_count: snapshot.files.length,
      skipped_count: snapshot.skipped.length,
    });
    const updated = await tx.query<RepositoryRow>(
      `UPDATE repositories
         SET head_commit = $2, last_indexed_at = now(), fingerprint = $3::jsonb, updated_at = now()
       WHERE id = $1::uuid
       RETURNING *`,
      [repositoryId, snapshot.head_commit, fingerprint],
    );

    return {
      repository: mapRepository(updated.rows[0]!),
      rewritten,
      deleted,
      retained_unavailable: retained,
    };
  });
}

export async function loadFingerprints(
  db: Database,
  repositoryId: string,
  filter: { tier?: FingerprintTier; paths?: readonly string[] } = {},
): Promise<StoredFingerprint[]> {
  const params: unknown[] = [repositoryId];
  let query = 'SELECT * FROM file_fingerprints WHERE repository_id = $1::uuid';
  if (filter.tier !== undefined) {
    params.push(filter.tier);
    query += ` AND tier = $${params.length}`;
  }
  if (filter.paths !== undefined) {
    params.push(pgTextArray(filter.paths));
    query += ` AND path = ANY($${params.length}::text[])`;
  }
  query += ' ORDER BY tier, path';
  const result = await db.query<FingerprintRow>(query, params);
  return result.rows.map(mapFingerprint);
}

export async function loadSnapshotMetadata(
  db: Database,
  repositoryId: string,
): Promise<SnapshotMetadata | null> {
  const result = await db.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1::uuid', [
    repositoryId,
  ]);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('repository', repositoryId);
  const raw = row.fingerprint ?? {};
  if (!('captured_at' in raw)) return null; // no snapshot persisted yet
  // root_path/head_commit come from the live row, not the jsonb, so they can never go stale.
  return parseInput(SnapshotMetadataSchema, {
    ...raw,
    root_path: row.root_path,
    head_commit: row.head_commit,
  }, 'loadSnapshotMetadata');
}
