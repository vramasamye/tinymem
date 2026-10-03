/**
 * `onemem search "<query>"` — token-budgeted retrieval (ADR-0010): provenance and relevance come
 * back with every result, tokens used vs. budget are always shown, and warnings (degraded
 * channels, truncation) are printed rather than swallowed.
 */

import { MEMORY_TYPES, type MemoryType, type MemorySearchResponse } from '@onememory/core';
import { BackendError } from '@onememory/api/runtime';

import { shortDate, type Io } from '../io';
import { describeResolution, resolveBackend, type ResolveOptions } from '../resolve';

/** Searchable types (working memory is session-scoped, not part of the durable channel). */
export type SearchMemoryType = Exclude<MemoryType, 'working'>;

export interface SearchOptions extends ResolveOptions {
  query: string;
  /** `--budget N` → `max_tokens`. */
  budget?: number;
  /** `--limit N` → `max_memories`. */
  limit?: number;
  /** `--type <type>` (repeatable). */
  types?: string[];
  /** `--explain` (default on: the CLI is the verbose surface). */
  explain?: boolean;
}

export async function runSearch(options: SearchOptions, io: Io): Promise<number> {
  const types = parseTypes(options.types);
  const resolved = await resolveBackend(options);
  try {
    const response = await resolved.backend.search({
      query: options.query,
      project_id: resolved.projectId,
      ...(options.budget === undefined ? {} : { max_tokens: options.budget }),
      ...(options.limit === undefined ? {} : { max_memories: options.limit }),
      ...(types === undefined ? {} : { types }),
      explain: options.explain ?? true,
    });
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit({ query: options.query, response });
    printSearch(io, response);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export function parseTypes(values: string[] | undefined): SearchMemoryType[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const types: SearchMemoryType[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      if (part === '') continue;
      if (part === 'working') {
        throw new BackendError(
          "type 'working' is not searchable here — working memory is per-session and surfaced via the context endpoint",
          'invalid_request',
        );
      }
      if (!MEMORY_TYPES.includes(part as (typeof MEMORY_TYPES)[number])) {
        throw new BackendError(
          `unknown memory type '${part}' (expected one of ${MEMORY_TYPES.filter((type) => type !== 'working').join(', ')})`,
          'invalid_request',
        );
      }
      types.push(part as SearchMemoryType);
    }
  }
  return types.length === 0 ? undefined : types;
}

export function printSearch(io: Io, response: MemorySearchResponse): void {
  const memories = response.memories;
  if (memories.length === 0) {
    io.out('no memories matched (the project may be new — store some with onemem remember)');
    return;
  }
  io.out(
    `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} — ${response.tokens.used}/${response.tokens.budget} tokens (${response.tokens.packing} packing)`,
  );
  io.out(`intent: ${response.query_understanding.intent}${response.query_understanding.keywords.length > 0 ? `, keywords: ${response.query_understanding.keywords.join(', ')}` : ''}`);
  io.blank();
  memories.forEach((memory, index) => {
    io.out(`${index + 1}. [${memory.type}] ${memory.title ?? '(untitled)'} — relevance ${memory.relevance.toFixed(2)}, ${memory.temporal.status}, ${shortDate(memory.temporal.valid_from)}`);
    const body = memory.content ?? memory.summary;
    for (const line of body.split('\n')) io.out(`   ${line}`);
    io.out(`   id: ${memory.id}`);
    io.out(`   source: ${memory.provenance.source_kind}${memory.provenance.source_uri === undefined ? '' : ` (${memory.provenance.source_uri})`}`);
    for (const factor of memory.explain) {
      if (factor.weight !== 0) io.out(`   + ${factor.factor}: ${factor.detail}`);
    }
    if (index < memories.length - 1) io.blank();
  });
  for (const warning of response.warnings) io.err(`warning: ${warning}`);
}
