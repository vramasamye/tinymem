/**
 * Code-memory persistence (ADR-0008): `repositories`, `file_fingerprints`, and `code_symbols` —
 * this module is the only writer of those tables. `last_ingested_commit` is intentionally
 * untouched: the ingestion checkpoint advances only when changed knowledge is fully processed,
 * which is the drift pipeline's job, never persistence's.
 *
 * Conventions: handwritten parameterized SQL over the shared `Database` client (the one SQL
 * surface in the engine), every input Zod-parsed at the boundary, one transaction per save.
 */

import { z } from 'zod';

import {
  EnsureCodeRepositorySchema,
  RecordCodeRefsSchema,
  SnapshotInputSchema,
  SnapshotMetadataSchema,
  SymbolTableSaveSchema,
  uuidv7,
} from '@onememory/core';
import type {
  CodeRepositoryRecord,
  EnsureCodeRepository,
  FingerprintTier,
  MemoryCodeRef,
  RecordCodeRefs,
  SnapshotInput,
  SnapshotMetadata,
  SnapshotSaveResult,
  StoredFingerprint,
  StoredSymbol,
  SymbolTableSave,
  SymbolTableSaveResult,
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
  symbols_hash: string | null;
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
    symbols_hash: row.symbols_hash,
    updated_at: toIso(row.updated_at),
  };
}

type SymbolRow = {
  repository_id: string;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  line_start: number | null;
  line_end: number | null;
  span_hash: string | null;
  updated_at: Date | string;
};

function mapSymbol(row: SymbolRow): StoredSymbol {
  return {
    repository_id: row.repository_id,
    path: row.path,
    name: row.name,
    kind: row.kind,
    signature: row.signature,
    line_start: row.line_start,
    line_end: row.line_end,
    span_hash: row.span_hash,
    updated_at: toIso(row.updated_at),
  };
}

type CodeRefRow = {
  memory_id: string;
  repository_id: string;
  path: string;
  blob_sha: string;
  created_at: Date | string;
};

function mapCodeRef(row: CodeRefRow): MemoryCodeRef {
  return {
    memory_id: row.memory_id,
    repository_id: row.repository_id,
    path: row.path,
    blob_sha: row.blob_sha,
    created_at: toIso(row.created_at),
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
      // Symbol rows never outlive their worktree-tier fingerprint anchor (its symbols_hash is
      // the per-file rewrite guard): when a capture drops the path's fingerprint, its symbol
      // table dies with it. Unavailable paths keep both as retained last-known, like above.
      if (tier === 'worktree') {
        await tx.query(
          'DELETE FROM code_symbols WHERE repository_id = $1::uuid AND path = ANY($2::text[])',
          [repositoryId, pgTextArray(gone)],
        );
      }
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
      // The unreadable (path, tier) set of the LATEST capture: drift reads this to treat
      // retained-unavailable fingerprints as suspect instead of silently fresh.
      skipped: snapshot.skipped,
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

// ---------------------------------------------------------------------------
// Code refs (which memories rest on which code — the drift oracle's read side)
// ---------------------------------------------------------------------------

export async function recordCodeRefs(
  db: Database,
  rawInput: RecordCodeRefs,
): Promise<MemoryCodeRef[]> {
  const input = parseInput(RecordCodeRefsSchema, rawInput, 'recordCodeRefs');
  return db.transaction(async (tx) => {
    // Better-than-FK errors at the boundary; the FKs still guard the check-to-insert race.
    const memory = await tx.query('SELECT 1 FROM memories WHERE id = $1::uuid', [input.memory_id]);
    if (memory.rows.length === 0) throw new NotFoundError('memory', input.memory_id);
    const repository = await tx.query('SELECT 1 FROM repositories WHERE id = $1::uuid', [
      input.repository_id,
    ]);
    if (repository.rows.length === 0) throw new NotFoundError('repository', input.repository_id);

    for (let offset = 0; offset < input.refs.length; offset += UPSERT_CHUNK) {
      const chunk = input.refs.slice(offset, offset + UPSERT_CHUNK);
      const values: string[] = [];
      const params: unknown[] = [input.memory_id, input.repository_id];
      chunk.forEach((ref, index) => {
        const base = 3 + index * 2;
        values.push(`($1::uuid, $2::uuid, $${base}, $${base + 1})`);
        params.push(ref.path, ref.blob_sha);
      });
      await tx.query(
        `INSERT INTO memory_code_refs (memory_id, repository_id, path, blob_sha)
         VALUES ${values.join(', ')}
         ON CONFLICT (memory_id, repository_id, path) DO UPDATE SET blob_sha = EXCLUDED.blob_sha`,
        params,
      );
    }

    const readBack = await tx.query<CodeRefRow>(
      `SELECT * FROM memory_code_refs
        WHERE memory_id = $1::uuid AND repository_id = $2::uuid AND path = ANY($3::text[])
        ORDER BY path`,
      [input.memory_id, input.repository_id, pgTextArray(input.refs.map((ref) => ref.path))],
    );
    return readBack.rows.map(mapCodeRef);
  });
}

export async function listCodeRefs(
  db: Database,
  repositoryId: string,
  filter: { paths?: readonly string[] } = {},
): Promise<MemoryCodeRef[]> {
  const params: unknown[] = [repositoryId];
  let query = 'SELECT * FROM memory_code_refs WHERE repository_id = $1::uuid';
  if (filter.paths !== undefined) {
    params.push(pgTextArray(filter.paths));
    query += ` AND path = ANY($${params.length}::text[])`;
  }
  query += ' ORDER BY memory_id, path';
  const result = await db.query<CodeRefRow>(query, params);
  return result.rows.map(mapCodeRef);
}

// ---------------------------------------------------------------------------
// Symbol tables (tree-sitter extraction persistence — ADR-0008)
// ---------------------------------------------------------------------------

export async function saveSymbolTable(
  db: Database,
  repositoryId: string,
  rawInput: SymbolTableSave,
): Promise<SymbolTableSaveResult> {
  const input = parseInput(SymbolTableSaveSchema, rawInput, 'saveSymbolTable');
  return db.transaction(async (tx) => {
    const locked = await tx.query<RepositoryRow>(
      'SELECT * FROM repositories WHERE id = $1::uuid FOR UPDATE',
      [repositoryId],
    );
    const repository = locked.rows[0];
    if (!repository) throw new NotFoundError('repository', repositoryId);

    const paths = input.files.map((file) => file.path);
    const anchors = await tx.query<FingerprintRow>(
      `SELECT * FROM file_fingerprints
        WHERE repository_id = $1::uuid AND tier = 'worktree' AND path = ANY($2::text[])`,
      [repositoryId, pgTextArray(paths)],
    );
    const anchorByPath = new Map(anchors.rows.map((row) => [row.path, row]));
    // The symbols_hash anchor lives on the worktree-tier fingerprint row by schema design, so
    // the pipeline shape is saveSnapshot FIRST, then saveSymbolTable: a covered path without a
    // live worktree anchor is a pipeline error, reported at the boundary rather than guessed.
    for (const path of paths) {
      if (!anchorByPath.has(path)) throw new NotFoundError('worktree fingerprint', path);
    }

    // The conflict guard: only covered files whose symbols_hash differs are rewritten; files
    // whose hash already matches keep their rows and updated_at exactly as stored.
    const changed = input.files.filter(
      (file) => anchorByPath.get(file.path)?.symbols_hash !== file.symbols_hash,
    );

    for (let offset = 0; offset < changed.length; offset += UPSERT_CHUNK) {
      const chunk = changed.slice(offset, offset + UPSERT_CHUNK);
      const chunkPaths = chunk.map((file) => file.path);
      // Replacement per covered file: rows for the file die and are re-created (symbol rows have
      // no natural key — overloads legitimately repeat a name within one file).
      await tx.query(
        'DELETE FROM code_symbols WHERE repository_id = $1::uuid AND path = ANY($2::text[])',
        [repositoryId, pgTextArray(chunkPaths)],
      );
      const values: string[] = [];
      const params: unknown[] = [repositoryId];
      let rows = 0;
      const flush = async (): Promise<void> => {
        if (rows === 0) return;
        await tx.query(
          `INSERT INTO code_symbols
             (id, repository_id, path, name, kind, signature, line_start, line_end, span_hash, updated_at)
           VALUES ${values.join(', ')}`,
          params,
        );
        values.length = 0;
        params.length = 1;
        rows = 0;
      };
      for (const file of chunk) {
        for (const symbol of file.symbols) {
          if (rows === UPSERT_CHUNK) await flush();
          const base = params.length;
          values.push(
            `($${base + 1}::uuid, $1::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, now())`,
          );
          params.push(
            uuidv7(), file.path, symbol.name, symbol.kind, symbol.signature,
            symbol.line_start, symbol.line_end, symbol.span_hash,
          );
          rows++;
        }
      }
      await flush();
      // Record the new per-file hash on the worktree anchor (its updated_at keeps marking
      // fingerprint-value changes only — a symbol-table change is not a fingerprint change).
      const hashValues: string[] = [];
      const hashParams: unknown[] = [repositoryId];
      chunk.forEach((file, index) => {
        hashValues.push(`($${2 + index * 2}, $${3 + index * 2})`);
        hashParams.push(file.path, file.symbols_hash);
      });
      await tx.query(
        `UPDATE file_fingerprints AS ff
           SET symbols_hash = v.hash
           FROM (VALUES ${hashValues.join(', ')}) AS v(path, hash)
         WHERE ff.repository_id = $1::uuid AND ff.tier = 'worktree' AND ff.path = v.path`,
        hashParams,
      );
    }

    return {
      repository: mapRepository(repository),
      rewritten: changed.length,
      unchanged: input.files.length - changed.length,
    };
  });
}

export async function loadSymbols(
  db: Database,
  repositoryId: string,
  filter: { paths?: readonly string[] } = {},
): Promise<StoredSymbol[]> {
  const params: unknown[] = [repositoryId];
  let query = 'SELECT * FROM code_symbols WHERE repository_id = $1::uuid';
  if (filter.paths !== undefined) {
    params.push(pgTextArray(filter.paths));
    query += ` AND path = ANY($${params.length}::text[])`;
  }
  // Document order per file, then stable for same-named rows (overloads).
  query += ' ORDER BY path, line_start, line_end, name, id';
  const result = await db.query<SymbolRow>(query, params);
  return result.rows.map(mapSymbol);
}
