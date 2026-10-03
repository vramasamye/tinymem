/**
 * Identity, scope, and provenance repositories: users, projects, sources.
 */

import { NewProjectSchema, NewSourceSchema, NewUserSchema, SOURCE_KINDS, uuidv7 } from '@onememory/core';
import type {
  NewProject,
  NewSource,
  NewUser,
  ProjectRecord,
  SourceRef,
  UserRecord,
} from '@onememory/core';

import type { Database } from '../drivers/client';

import { mapProjectRow, mapUserRow } from './row-mappers';
import { NotFoundError, parseInput } from './util';

export async function createUser(db: Database, rawInput: NewUser): Promise<UserRecord> {
  const input = parseInput(NewUserSchema, rawInput, 'createUser');
  const result = await db.query(
    `INSERT INTO users (id, name, email) VALUES ($1::uuid, $2, $3) RETURNING *`,
    [input.id ?? uuidv7(), input.name, input.email ?? null],
  );
  return mapUserRow(result.rows[0]!);
}

export async function createProject(db: Database, rawInput: NewProject): Promise<ProjectRecord> {
  const input = parseInput(NewProjectSchema, rawInput, 'createProject');
  const result = await db.query(
    `INSERT INTO projects (id, name, root_path, git_remote, description, digest, settings)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING *`,
    [
      input.id ?? uuidv7(),
      input.name,
      input.root_path ?? null,
      input.git_remote ?? null,
      input.description ?? null,
      JSON.stringify(input.digest ?? {}),
      JSON.stringify(input.settings ?? {}),
    ],
  );
  return mapProjectRow(result.rows[0]!);
}

export async function getProject(db: Database, id: string): Promise<ProjectRecord | null> {
  const result = await db.query('SELECT * FROM projects WHERE id = $1::uuid', [id]);
  const row = result.rows[0];
  return row ? mapProjectRow(row) : null;
}

export async function createSource(db: Database, rawInput: NewSource): Promise<SourceRef> {
  const input = parseInput(NewSourceSchema, rawInput, 'createSource');
  const result = await db.query<{ id: string; kind: string; uri: string | null; title: string | null }>(
    `INSERT INTO sources (id, kind, uri, title, content_hash, metadata, project_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::uuid)
       RETURNING id, kind, uri, title`,
    [
      input.id ?? uuidv7(),
      input.kind,
      input.uri ?? null,
      input.title ?? null,
      input.content_hash ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.project_id ?? null,
    ],
  );
  const row = result.rows[0]!;
  const ref: SourceRef = { id: row.id, kind: input.kind };
  if (row.uri !== null) ref.uri = row.uri;
  if (row.title !== null) ref.title = row.title;
  return ref;
}

export async function getSource(db: Database, id: string): Promise<SourceRef | null> {
  const result = await db.query<{ id: string; kind: string; uri: string | null; title: string | null }>(
    'SELECT id, kind, uri, title FROM sources WHERE id = $1::uuid',
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!(SOURCE_KINDS as readonly string[]).includes(row.kind)) {
    throw new TypeError(`storage: invalid source kind ${JSON.stringify(row.kind)}`);
  }
  const ref: SourceRef = { id: row.id, kind: row.kind as SourceRef['kind'] };
  if (row.uri !== null) ref.uri = row.uri;
  if (row.title !== null) ref.title = row.title;
  return ref;
}

/** Ensures the implicit local user exists and returns it (embedded/local mode has exactly one). */
export async function ensureLocalUser(db: Database): Promise<UserRecord> {
  const existing = await db.query('SELECT * FROM users LIMIT 1');
  if (existing.rows[0]) return mapUserRow(existing.rows[0]);
  return createUser(db, { name: 'local' }).catch(async (error: unknown) => {
    // lost a race creating the implicit user — read it back
    if ((error as { code?: string }).code === '23505') {
      const row = await db.query('SELECT * FROM users LIMIT 1');
      if (row.rows[0]) return mapUserRow(row.rows[0]);
    }
    throw error;
  });
}

export { NotFoundError };
