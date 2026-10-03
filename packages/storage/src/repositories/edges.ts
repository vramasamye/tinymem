/**
 * Memory-graph edges (`edges` table): memory ↔ memory relations, unique on
 * (from, to, relation) so addEdge is idempotent.
 */

import { NewEdgeSchema, uuidv7 } from '@onememory/core';
import type { EdgeRecord, NewEdge } from '@onememory/core';

import type { Database } from '../drivers/client';

import { mapEdgeRow } from './row-mappers';
import { parseInput } from './util';

export async function addEdge(db: Database, rawInput: NewEdge): Promise<EdgeRecord> {
  const input = parseInput(NewEdgeSchema, rawInput, 'addEdge');
  await db.query(
    `INSERT INTO edges (
        id, from_memory_id, to_memory_id, relation, project_id, confidence, valid_from, valid_until, evidence
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7::timestamptz, $8::timestamptz, $9::jsonb
      )
      ON CONFLICT (from_memory_id, to_memory_id, relation) DO NOTHING`,
    [
      input.id ?? uuidv7(),
      input.from_memory_id,
      input.to_memory_id,
      input.relation,
      input.project_id ?? null,
      input.confidence ?? 0.8,
      input.valid_from ?? null,
      input.valid_until ?? null,
      JSON.stringify(input.evidence ?? []),
    ],
  );
  const result = await db.query(
    `SELECT * FROM edges
      WHERE from_memory_id = $1::uuid AND to_memory_id = $2::uuid AND relation = $3`,
    [input.from_memory_id, input.to_memory_id, input.relation],
  );
  return mapEdgeRow(result.rows[0]!);
}

export async function listEdges(db: Database, memoryId: string): Promise<EdgeRecord[]> {
  const result = await db.query(
    `SELECT * FROM edges
      WHERE from_memory_id = $1::uuid OR to_memory_id = $1::uuid
      ORDER BY created_at ASC`,
    [memoryId],
  );
  return result.rows.map(mapEdgeRow);
}
