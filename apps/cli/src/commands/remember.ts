/**
 * `onemem remember "<content>"` — an explicit durable write. This is the one path where a user
 * statement becomes a durable memory directly (memory-model.md §4 rule 4); the content is
 * redacted before it is hashed or stored (ADR-0007), and provenance (`explicit/remember`) is
 * recorded by the service layer — here we only choose the fields and print the outcome honestly,
 * including what the redactor removed (kinds and counts, never values).
 */

import { DURABLE_MEMORY_TYPES } from '@onememory/core';
import { BackendError, type RememberOutcome } from '@onememory/api/runtime';

import type { Io } from '../io';
import { describeResolution, resolveBackend, type ResolveOptions } from '../resolve';

export interface RememberOptions extends ResolveOptions {
  content: string;
  /** `--type` (default semantic: a stable user statement). */
  type?: string;
  /** `--title` */
  title?: string;
  /** `--tags a,b` */
  tags?: string[];
  /** `--importance 0..1` */
  importance?: number;
  /** `--confidence 0..1` */
  confidence?: number;
}

export async function runRemember(options: RememberOptions, io: Io): Promise<number> {
  const requested = options.type ?? 'semantic';
  if (!DURABLE_MEMORY_TYPES.includes(requested as (typeof DURABLE_MEMORY_TYPES)[number])) {
    throw new BackendError(
      `unknown memory type '${requested}' (expected one of ${DURABLE_MEMORY_TYPES.join(', ')})`,
      'invalid_request',
    );
  }
  const type = requested as (typeof DURABLE_MEMORY_TYPES)[number];
  for (const field of ['importance', 'confidence'] as const) {
    const value = options[field];
    if (value !== undefined && (value < 0 || value > 1)) {
      throw new BackendError(`--${field} must be between 0 and 1`, 'invalid_request');
    }
  }
  const tags = options.tags === undefined ? undefined : options.tags.flatMap((value) => value.split(',')).filter((tag) => tag !== '');

  const resolved = await resolveBackend(options);
  try {
    const outcome = await resolved.backend.remember({
      project_id: resolved.projectId,
      content: options.content,
      type,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(tags === undefined ? {} : { tags }),
      ...(options.importance === undefined ? {} : { importance: options.importance }),
      ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
    });
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit(outcome);
    printRemember(io, type, outcome);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export function printRemember(io: Io, type: string, outcome: RememberOutcome): void {
  if (outcome.outcome === 'duplicate') {
    io.out(`already remembered — merged with the existing ${type} memory`);
    if (outcome.duplicate_of !== undefined) io.out(`  existing: ${outcome.duplicate_of}`);
  } else {
    io.out(`remembered as a ${type} memory (${outcome.memory_id})`);
  }
  if (outcome.redactions.length > 0) {
    const kinds = [...new Set(outcome.redactions.map((redaction) => redaction.kind))];
    io.out(`  redaction: ${outcome.redactions.length} ${outcome.redactions.length === 1 ? 'secret' : 'secrets'} removed (${kinds.join(', ')}); the memory stores placeholders, not values`);
  } else {
    io.out('  redaction: none');
  }
  io.out(`  inspect: onemem inspect ${outcome.memory_id}`);
  for (const warning of outcome.warnings) io.err(`warning: ${warning}`);
}
