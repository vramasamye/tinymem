/**
 * `onemem inspect <id>` — the full record: content (as stored, post-redaction), provenance,
 * the supersession chain, the append-only audit trail, entities, edges, and what the redactor
 * removed on the way in (kinds + counts, never values).
 */

import { describeResolution, resolveBackend, type ResolveOptions } from '../resolve';
import { shortDate, type Io } from '../io';
import type { InspectResult } from '@onememory-ai/api/runtime';

export interface InspectOptions extends ResolveOptions {
  memoryId: string;
}

export async function runInspect(options: InspectOptions, io: Io): Promise<number> {
  const resolved = await resolveBackend(options);
  try {
    const result = await resolved.backend.inspect(resolved.projectId, options.memoryId);
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit(result);
    printInspect(io, result);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export function printInspect(io: Io, result: InspectResult): void {
  const memory = result.memory;
  io.out(`${memory.type} memory ${memory.id} — ${memory.status}`);
  io.out(`  title:     ${memory.title ?? '(untitled)'}`);
  io.out(`  observed:  ${shortDate(memory.observed_at)}  created: ${shortDate(memory.created_at)}  updated: ${shortDate(memory.updated_at)}`);
  io.out(`  importance: ${memory.importance}  confidence: ${memory.confidence}`);
  if (memory.tags.length > 0) io.out(`  tags:      ${memory.tags.join(', ')}`);
  io.blank();
  io.out('content (as stored, after redaction):');
  for (const line of memory.content.split('\n')) io.out(`  ${line}`);
  if (result.redactions.length > 0) {
    const kinds = [...new Set(result.redactions.map((redaction) => redaction.kind))];
    io.out(`  redaction: ${result.redactions.length} on ingest (${kinds.join(', ')}) — placeholders are stored, values never were`);
  } else {
    io.out('  redaction: none on ingest');
  }
  io.blank();
  io.out(`provenance: ${memory.provenance.source.kind}${memory.provenance.source.uri === undefined ? '' : ` (${memory.provenance.source.uri})`}`);
  io.out(`  extracted by: ${memory.provenance.extraction.method}${memory.provenance.extraction.model === undefined ? '' : ` (${memory.provenance.extraction.model})`}`);
  for (const evidence of memory.provenance.evidence) {
    io.out(`  evidence: ${evidence.kind} @ ${evidence.locator}${evidence.excerpt === undefined ? '' : ` "${truncate(evidence.excerpt, 100)}"`}`);
  }
  if (result.entities.length > 0) {
    io.blank();
    io.out('entities:');
    for (const entity of result.entities) io.out(`  ${entity.name} (${entity.kind})`);
  }
  if (result.edges.length > 0) {
    io.blank();
    io.out('graph edges:');
    for (const edge of result.edges) {
      io.out(`  ${edge.from_memory_id} —[${edge.relation}]→ ${edge.to_memory_id}`);
    }
  }
  if (result.history.length > 1) {
    io.blank();
    io.out('history (supersession chain, oldest first):');
    for (const entry of result.history) {
      io.out(`  ${entry.id} [${entry.status}] ${entry.title ?? '(untitled)'} — ${shortDate(entry.created_at)}`);
    }
  }
  io.blank();
  io.out(`audit trail (${result.audit.length} ${result.audit.length === 1 ? 'event' : 'events'}, oldest first):`);
  for (const event of result.audit) {
    io.out(`  ${shortDate(event.at)} ${event.action}${event.to_status === null ? '' : ` → ${event.to_status}`}${event.actor === '' ? '' : ` by ${event.actor}`}`);
  }
  for (const warning of result.warnings) io.err(`warning: ${warning}`);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
