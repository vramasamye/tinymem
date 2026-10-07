/**
 * Entity registry + memory bindings (ENTITY RESOLUTION persistence primitives). The resolution
 * logic itself is the `EntityResolver` port (packages/graph, later mission); these are the
 * storage primitives it drives.
 */

import { NewEntitySchema, MergeEntitiesInputSchema, EntityBindingSchema, normalizeEntityName, uuidv7 } from '@onememory-ai/core';
import type {
  EntityBinding,
  EntityRecord,
  MergeEntitiesInput,
  NewEntity,
} from '@onememory-ai/core';

import type { Database } from '../drivers/client';
import { pgTextArray } from '../drivers/client';

import { mapEntityRow } from './row-mappers';
import { NotFoundError, parseInput } from './util';

const NIL = '00000000-0000-0000-0000-000000000000';

export async function findEntity(
  db: Database,
  scope: { project_id?: string | null },
  normalizedName: string,
): Promise<EntityRecord | null> {
  const result = await db.query(
    `SELECT * FROM entities
      WHERE coalesce(project_id, '${NIL}'::uuid) = coalesce($1::uuid, '${NIL}'::uuid)
        AND normalized_name = $2
      LIMIT 1`,
    [scope.project_id ?? null, normalizedName],
  );
  const row = result.rows[0];
  return row ? mapEntityRow(row) : null;
}

export async function createEntity(db: Database, rawInput: NewEntity): Promise<EntityRecord> {
  const input = parseInput(NewEntitySchema, rawInput, 'createEntity');
  const result = await db.query(
    `INSERT INTO entities (id, project_id, kind, name, normalized_name, aliases, description, confidence)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, $8)
       RETURNING *`,
    [
      input.id ?? uuidv7(),
      input.project_id ?? null,
      input.kind,
      input.name,
      input.normalized_name ?? normalizeEntityName(input.name),
      pgTextArray(input.aliases ?? []),
      input.description ?? null,
      input.confidence ?? 0.5,
    ],
  );
  return mapEntityRow(result.rows[0]!);
}

export async function mergeEntities(
  db: Database,
  rawInput: MergeEntitiesInput,
): Promise<void> {
  const input = parseInput(MergeEntitiesInputSchema, rawInput, 'mergeEntities');
  if (input.source_id === input.target_id) {
    throw new Error('mergeEntities: source and target must differ');
  }
  const result = await db.query(
    `UPDATE entities
        SET merged_into = $2::uuid,
            updated_at = now()
      WHERE id = $1::uuid AND merged_into IS NULL`,
    [input.source_id, input.target_id],
  );
  if ((result.rowCount ?? 0) === 0) {
    // Already merged, or missing — verify which for an honest error.
    const check = await db.query<{ id: string; merged_into: string | null }>(
      'SELECT id, merged_into FROM entities WHERE id = $1::uuid',
      [input.source_id],
    );
    if (!check.rows[0]) throw new NotFoundError('entity', input.source_id);
    if (check.rows[0].merged_into !== null) return; // idempotent: already merged
    throw new Error(`mergeEntities: could not merge ${input.source_id}`);
  }
}

export async function bindMemoryEntities(
  db: Database,
  memoryId: string,
  rawBindings: readonly EntityBinding[],
): Promise<void> {
  const bindings = rawBindings.map((binding) =>
    parseInput(EntityBindingSchema, binding, 'bindMemoryEntities'),
  );
  if (bindings.length === 0) return;
  const values = bindings
    .map((_, index) => {
      const base = index * 4;
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4})`;
    })
    .join(', ');
  const params = bindings.flatMap((binding) => [
    memoryId,
    binding.entity_id,
    binding.role ?? 'context',
    binding.weight ?? 1.0,
  ]);
  await db.query(
    `INSERT INTO memory_entities (memory_id, entity_id, role, weight)
       VALUES ${values}
       ON CONFLICT (memory_id, entity_id) DO NOTHING`,
    params,
  );
}

export async function listMemoryEntities(
  db: Database,
  memoryId: string,
): Promise<EntityRecord[]> {
  const result = await db.query(
    `SELECT e.* FROM memory_entities me
       JOIN entities e ON e.id = me.entity_id
      WHERE me.memory_id = $1::uuid
      ORDER BY me.created_at ASC`,
    [memoryId],
  );
  return result.rows.map(mapEntityRow);
}
