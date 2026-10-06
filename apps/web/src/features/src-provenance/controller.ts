/**
 * The sources/provenance surfaces.
 *
 * 1. `loadMemoryDetail` — one memory's full drill-down: source, evidence quotes,
 *    extraction method, redactions, entities, edges, supersession, and the typed
 *    payload (decision / failure / skill) — everything the inspect endpoint returns.
 * 2. `loadSources` — the cross-memory source index: search results grouped by the
 *    provenance the API reports per row (source kind + uri), enriched with the
 *    source title from a bounded per-group inspect (the only endpoint that
 *    returns `provenance.source.title`).
 */

import type { ApiClient } from '../../api/client';
import {
  DecisionPayloadSchema,
  FailurePayloadSchema,
  SkillPayloadSchema,
  type DecisionPayload,
  type FailurePayload,
  type InspectResponse,
  type MemorySearchResponse,
  type SkillPayload,
} from '../../api/schemas';

// ---------------------------------------------------------------------------
// Memory detail (provenance drill-down)
// ---------------------------------------------------------------------------

export type MemoryPayloadDisplay =
  | { kind: 'decision'; payload: DecisionPayload }
  | { kind: 'failure'; payload: FailurePayload }
  | { kind: 'skill'; payload: SkillPayload };

/**
 * Discriminate the typed payload by shape. The wire union is already validated at
 * the boundary; this re-checks with the same schemas to pick the display variant —
 * an ambiguous payload renders as none of them (the record's own fields still show).
 */
export function describePayload(payload: unknown): MemoryPayloadDisplay | null {
  if (payload === undefined || payload === null || typeof payload !== 'object') return null;
  const decision = DecisionPayloadSchema.safeParse(payload);
  if (decision.success && 'decision' in payload) return { kind: 'decision', payload: decision.data };
  const failure = FailurePayloadSchema.safeParse(payload);
  if (failure.success && 'problem' in payload) return { kind: 'failure', payload: failure.data };
  const skill = SkillPayloadSchema.safeParse(payload);
  if (skill.success && 'path' in payload) return { kind: 'skill', payload: skill.data };
  return null;
}

export interface MemoryDetailViewModel {
  readonly memory: InspectResponse['memory'];
  readonly provenance: InspectResponse['memory']['provenance'];
  readonly payloadDisplay: MemoryPayloadDisplay | null;
  readonly audit: InspectResponse['audit'];
  readonly history: InspectResponse['history'];
  readonly entities: InspectResponse['entities'];
  readonly edges: InspectResponse['edges'];
  readonly redactions: InspectResponse['redactions'];
  readonly warnings: InspectResponse['warnings'];
}

export async function loadMemoryDetail(
  api: ApiClient,
  projectId: string,
  memoryId: string,
): Promise<MemoryDetailViewModel> {
  const inspect = await api.inspect(projectId, memoryId);
  return {
    memory: inspect.memory,
    provenance: inspect.memory.provenance,
    payloadDisplay: describePayload(inspect.memory.payload),
    audit: inspect.audit,
    history: inspect.history,
    entities: inspect.entities,
    edges: inspect.edges,
    redactions: inspect.redactions,
    warnings: inspect.warnings,
  };
}

// ---------------------------------------------------------------------------
// Sources index
// ---------------------------------------------------------------------------

/** How many groups get inspect-enriched titles (bounded N+1 — a local-first viewer). */
export const SOURCE_INSPECT_CAP = 12;

export interface SourceGroup {
  /** `source_kind` + `source_uri` exactly as the API reported them. */
  readonly kind: string;
  readonly uri: string | null;
  /** `provenance.source.title` from the group's inspect (null when unavailable). */
  readonly title: string | null;
  readonly memories: MemorySearchResponse['memories'];
}

export interface SourcesViewModel {
  readonly querySent: string;
  readonly groups: SourceGroup[];
  /** Memories whose inspect failed (e.g. purged mid-view) — ids only, no invented data. */
  readonly inspectFailures: readonly string[];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

export async function loadSources(
  api: ApiClient,
  projectId: string,
  query: string,
  fallbackQuery: string,
  cap: number = SOURCE_INSPECT_CAP,
): Promise<SourcesViewModel> {
  const querySent = query.trim() || fallbackQuery;
  const response = await api.search(projectId, { query: querySent, explain: false });

  const groupsByKey = new Map<string, { kind: string; uri: string | null; memories: MemorySearchResponse['memories'] }>();
  for (const memory of response.memories) {
    const key = `${memory.provenance.source_kind}\u0000${memory.provenance.source_uri ?? ''}`;
    const group = groupsByKey.get(key);
    if (group === undefined) {
      groupsByKey.set(key, {
        kind: memory.provenance.source_kind,
        uri: memory.provenance.source_uri ?? null,
        memories: [memory],
      });
    } else {
      group.memories.push(memory);
    }
  }

  const inspectFailures: string[] = [];
  const groups: SourceGroup[] = [];
  let inspected = 0;
  for (const group of groupsByKey.values()) {
    let title: string | null = null;
    const representative = group.memories[0];
    if (representative !== undefined && inspected < cap) {
      inspected += 1;
      try {
        const inspect = await api.inspect(projectId, representative.id);
        title = inspect.memory.provenance.source.title ?? null;
      } catch {
        inspectFailures.push(representative.id);
      }
    }
    groups.push({ kind: group.kind, uri: group.uri, title, memories: group.memories });
  }

  return {
    querySent,
    groups,
    inspectFailures,
    tokens: response.tokens,
    warnings: response.warnings,
  };
}
