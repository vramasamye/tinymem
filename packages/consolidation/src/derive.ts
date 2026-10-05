/**
 * Episodic → semantic derivation (memory-model.md §9; the M14 mission scope): a cluster of
 * ≥ 3 active episodic memories, same project + primary entity, no contradictions among them,
 * becomes ONE semantic memory carrying `derived_from` edges to every source. The sources stay
 * (they are the evidence).
 *
 * The merged statement comes from the model router's `consolidate` operation when one is
 * configured; otherwise the templated offline merge runs — the representative source's content
 * verbatim, typed `semantic`, subtype `semantic.derived`. Zero network by default
 * (AGENTS.md rule 4); a failing or invalid LLM merge falls back to the same template, recorded
 * in the report, never silent.
 *
 * Provenance (AGENTS.md rule 8): the derived memory carries a real source (the representative's
 * provenance source), the union of every source's evidence spans, and consolidation extraction
 * metadata. Semantic memories are NEVER created from single observations (ADR-0003 rule 7) —
 * this pass and explicit user statements are the only two creation paths.
 */

import { extractTechMentions } from '@onememory/extraction';
import type { ModelRouter } from '@onememory/llm';
import { z } from 'zod';

import type { EmbeddingIndex, EvidenceSpan, MemoryRecord, NewMemory, Store } from '@onememory/core';

import { mergeKeeperOrder, authorityViewOf } from './authority';
import { cosineComponents, scopeKeyOf } from './cluster';
import type { ContradictionDetector } from './contradiction';
import { contradictsHeuristically, contradictionTemplate } from './contradiction';
import type { DerivationRecord, DerivationSkip } from './types';

export const DERIVATION_TEMPLATE_VERSION = 'consolidation/template-merge-1';
export const DERIVATION_LLM_PROMPT_VERSION = 'consolidation/llm-merge-1';

/** The evidence span budget of one derivation (bounds the union stored on one row). */
export const MAX_DERIVATION_EVIDENCE = 24;

/** The projection of a cluster member the pure derivation builders work on. */
export interface MergeSourceView {
  id: string;
  content: string;
  observed_at: string;
  valid_from: string;
  confidence: number;
  importance: number;
  /**
   * `provenance.source.kind === 'explicit'` — carried from the record so the representative
   * tie-break orders by the real authority facts (an explicit-kind source wins over a newer
   * inferred one), never by a hardcoded default.
   */
  explicit: boolean;
  /** `type === 'decision'` — carried (always false in the episodic derivation pool, but honest). */
  isDecision: boolean;
  /** The provenance source anchoring the derived memory (the representative's, M3d semantics). */
  source_id: string;
  evidence: EvidenceSpan[];
}

export function mergeSourceOf(memory: MemoryRecord): MergeSourceView {
  return {
    id: memory.id,
    content: memory.content,
    observed_at: memory.observed_at,
    valid_from: memory.valid_from,
    confidence: memory.confidence,
    importance: memory.importance,
    explicit: memory.provenance.source.kind === 'explicit',
    isDecision: memory.type === 'decision',
    source_id: memory.provenance.source.id,
    evidence: memory.provenance.evidence,
  };
}

/**
 * The representative source — the most central statement (highest total cosine to the cluster),
 * ties broken by the authority order then id. Its content becomes the templated statement and
 * its source anchors the derived memory's provenance.
 */
export function representativeSource(
  sources: readonly MergeSourceView[],
  cosineSum: ReadonlyMap<string, number>,
): MergeSourceView {
  return [...sources].sort((a, b) => {
    const cosineDiff = (cosineSum.get(b.id) ?? 0) - (cosineSum.get(a.id) ?? 0);
    if (cosineDiff !== 0) return cosineDiff;
    return mergeKeeperOrder(
      { ...authorityViewOfProjection(a), observedAt: a.observed_at },
      { ...authorityViewOfProjection(b), observedAt: b.observed_at },
    );
  })[0]!;
}

/** Authority view of a source projection — the authority facts the view carries from the record. */
function authorityViewOfProjection(source: MergeSourceView): {
  explicit: boolean;
  isDecision: boolean;
  observedAt: string;
  confidence: number;
  id: string;
} {
  return {
    explicit: source.explicit,
    isDecision: source.isDecision,
    observedAt: source.observed_at,
    confidence: source.confidence,
    id: source.id,
  };
}

/** The union of every source's evidence spans — first occurrence wins, duplicates collapse. */
export function unionEvidence(sources: readonly MergeSourceView[], cap = MAX_DERIVATION_EVIDENCE): EvidenceSpan[] {
  const seen = new Set<string>();
  const union: EvidenceSpan[] = [];
  for (const source of sources) {
    for (const span of source.evidence) {
      const key = `${span.source_id}|${span.kind}|${span.locator}|${span.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(span);
      if (union.length >= cap) return union;
    }
  }
  return union;
}

/**
 * Corroboration scores: N independent observations of the same pattern raise both confidence
 * and importance over the strongest single member, capped at 0.95 (corroboration never
 * manufactures certainty).
 */
export function derivedScores(sources: readonly MergeSourceView[]): { importance: number; confidence: number } {
  const maxImportance = Math.max(...sources.map((source) => source.importance));
  const maxConfidence = Math.max(...sources.map((source) => source.confidence));
  return {
    importance: round4(Math.min(0.95, maxImportance + 0.05)),
    confidence: round4(Math.min(0.95, maxConfidence + 0.1)),
  };
}

/** Round to 4 decimals — corroboration bumps must not smuggle float noise into stored scores. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The derived fact was observed at the newest member and valid since the oldest member. */
export function derivedTemporals(sources: readonly MergeSourceView[]): { observed_at: string; valid_from: string } {
  const observed = sources.map((source) => source.observed_at).sort()[sources.length - 1]!;
  const from = sources.map((source) => source.valid_from).sort()[0]!;
  return { observed_at: observed, valid_from: from };
}

export interface MergeContentResult {
  content: string;
  content_summary?: string;
  title?: string;
  method: 'llm' | 'heuristic';
  model?: string;
  prompt_version: string;
  /** Set when the LLM tier was attempted but the template ran instead — never silent. */
  fallback_reason?: string;
}

/** The templated offline merge: the representative's statement, verbatim. */
export function templatedMerge(
  sources: readonly MergeSourceView[],
  representative: MergeSourceView,
): MergeContentResult {
  return {
    content: representative.content,
    method: 'heuristic',
    prompt_version: DERIVATION_TEMPLATE_VERSION,
  };
}

/** Structured output contract for the router's `consolidate` operation. */
export const LlmMergeSchema = z.looseObject({
  content: z.string().min(1).max(500),
  content_summary: z.string().max(160).optional(),
  title: z.string().max(80).optional(),
});
export type LlmMerge = z.infer<typeof LlmMergeSchema>;

export const DERIVATION_SYSTEM_PROMPT = [
  'You consolidate repeated observations from an AI coding agent into ONE stable semantic fact.',
  'The statement must be canonical and self-contained: interpretable without the conversation',
  'it came from, true to every observation, and free of meta commentary about merging.',
  'Answer with the JSON object only.',
].join(' ');

export function buildDerivationPrompt(input: { entityName: string; sources: readonly MergeSourceView[] }): string {
  const statements = input.sources
    .map((source, index) => `${index + 1}. ${source.content} (observed ${source.observed_at})`)
    .join('\n');
  return [
    `Subject entity: ${input.entityName}`,
    `The following ${input.sources.length} episodic observations of the same project were made:`,
    statements,
    'Write the single stable fact they jointly establish.',
  ].join('\n');
}

/**
 * The merged statement: the LLM tier when the router has a `consolidate` route and it answers
 * within the schema; the templated offline merge otherwise (no router, unconfigured route,
 * provider failure, or invalid output — each recorded in `fallback_reason`).
 */
export async function mergeClusterContent(input: {
  sources: readonly MergeSourceView[];
  representative: MergeSourceView;
  entityName: string;
  router?: ModelRouter;
}): Promise<MergeContentResult> {
  const template = templatedMerge(input.sources, input.representative);
  const router = input.router;
  if (router === undefined) return template;
  if (!router.isConfigured('consolidate')) return template;

  const generation = await router.generateStructured({
    operation: 'consolidate',
    schema: LlmMergeSchema,
    system: DERIVATION_SYSTEM_PROMPT,
    prompt: buildDerivationPrompt({ entityName: input.entityName, sources: input.sources }),
    schemaName: 'ConsolidatedFact',
    schemaDescription: 'One canonical semantic statement derived from repeated observations',
  });
  if (!generation.ok) {
    return {
      ...template,
      fallback_reason: `llm merge failed (${generation.error.kind}: ${generation.error.message})`,
    };
  }
  return {
    content: generation.value.content,
    ...(generation.value.content_summary === undefined ? {} : { content_summary: generation.value.content_summary }),
    ...(generation.value.title === undefined ? {} : { title: generation.value.title }),
    method: 'llm',
    model: generation.route.model,
    prompt_version: DERIVATION_LLM_PROMPT_VERSION,
  };
}

/** Assemble the semantic `NewMemory` (provenance: representative's source + union evidence). */
export function buildDerivedMemory(input: {
  scope: { project_id?: string | null; user_id?: string | null };
  sources: readonly MergeSourceView[];
  representative: MergeSourceView;
  merged: MergeContentResult;
}): NewMemory {
  const scores = derivedScores(input.sources);
  const temporals = derivedTemporals(input.sources);
  const evidence = unionEvidence(input.sources);
  if (evidence.length === 0) {
    // Unreachable for stored memories (the provenance invariant guarantees ≥ 1 span) — kept as a
    // hard invariant: a derived durable memory without evidence never reaches the Store.
    throw new Error('derivation: cluster carries no evidence spans');
  }
  return {
    type: 'semantic',
    subtype: 'semantic.derived',
    ...(input.merged.title === undefined ? {} : { title: input.merged.title }),
    content: input.merged.content,
    ...(input.merged.content_summary === undefined ? {} : { content_summary: input.merged.content_summary }),
    importance: scores.importance,
    confidence: scores.confidence,
    observed_at: temporals.observed_at,
    valid_from: temporals.valid_from,
    ...(input.scope.project_id === undefined || input.scope.project_id === null
      ? {}
      : { project_id: input.scope.project_id }),
    ...(input.scope.user_id === undefined || input.scope.user_id === null ? {} : { user_id: input.scope.user_id }),
    source_id: input.representative.source_id,
    evidence,
    extraction: {
      method: input.merged.method,
      ...(input.merged.model === undefined ? {} : { model: input.merged.model }),
      prompt_version: input.merged.prompt_version,
      adapter: 'consolidation',
    },
    tags: ['consolidated'],
    token_estimate: Math.ceil(input.merged.content.length / 4),
  };
}

// ---------------------------------------------------------------------------
// The derivation pass
// ---------------------------------------------------------------------------

export interface DerivationPassResult {
  records: DerivationRecord[];
  skipped: DerivationSkip[];
  warnings: string[];
}

/**
 * The derivation pass over ACTIVE episodic memories. Grouping: same scope + primary entity —
 * a bound entity (earliest binding first; roles are not exposed on the Store read paths) or,
 * for unbound rows, the first tech mention of the content resolved through the entity registry
 * (`findEntity`), falling back to the normalized mention name. Similarity: the existing vector
 * search channel (`EmbeddingIndex.search`) driven with the pool's embeddings.
 */
export async function runDerivationPass(
  store: Store,
  pool: readonly MemoryRecord[],
  vectors: EmbeddingIndex,
  embeddings: ReadonlyMap<string, readonly number[]>,
  options: {
    actor: string;
    router?: ModelRouter;
    minClusterSize: number;
    minClusterCosine: number;
    maxClusterSize: number;
    detector?: ContradictionDetector;
  },
): Promise<DerivationPassResult> {
  const detector = options.detector ?? contradictsHeuristically;
  const records: DerivationRecord[] = [];
  const skipped: DerivationSkip[] = [];
  const warnings: string[] = [];

  // 1. Sources already consumed by a derivation are out (idempotency: `derived_from` edges).
  const consumable: MemoryRecord[] = [];
  for (const memory of pool) {
    const edges = await store.listEdges(memory.id);
    const alreadyDerived = edges.some(
      (edge) => edge.relation === 'derived_from' && edge.to_memory_id === memory.id,
    );
    if (alreadyDerived) continue;
    consumable.push(memory);
  }

  // 2. Group by scope + primary entity key.
  const groups = new Map<string, MemoryRecord[]>();
  const groupEntityName = new Map<string, string>();
  for (const memory of consumable) {
    const key = await entityKeyFor(store, memory);
    if (key === null) {
      skipped.push({ source_ids: [memory.id], reason: 'no primary entity (no bindings, no tech mention)' });
      continue;
    }
    const groupKey = `${scopeKeyOf(memory)}|${key.entityKey}`;
    const group = groups.get(groupKey);
    if (group) group.push(memory);
    else groups.set(groupKey, [memory]);
    if (!groupEntityName.has(groupKey)) groupEntityName.set(groupKey, key.entityName);
  }

  for (const [groupKey, group] of groups) {
    if (group.length < options.minClusterSize) continue;

    // 3. Cluster by cosine within the group (union-find over the vector channel's matches —
    //    the shared shape; `cosineSum` is the centrality signal for the representative).
    const { components, cosineSum } = await cosineComponents(group, vectors, embeddings, {
      minCosine: options.minClusterCosine,
      neighbors: options.maxClusterSize + 1,
    });

    for (const component of components) {
      const ids = component.map((memory) => memory.id);
      if (component.length < options.minClusterSize) continue;
      if (component.length > options.maxClusterSize) {
        skipped.push({ source_ids: ids, reason: `cluster of ${component.length} exceeds the cap (${options.maxClusterSize})` });
        continue;
      }

      // 4. No contradictions among the members — any flagged pair disqualifies the cluster
      //    (never resolved by dropping members: that would resolve the conflict implicitly).
      let contradiction: { aId: string; bId: string } | null = null;
      outer: for (let i = 0; i < component.length; i += 1) {
        for (let j = i + 1; j < component.length; j += 1) {
          if (detector(component[i]!, component[j]!)) {
            contradiction = { aId: component[i]!.id, bId: component[j]!.id };
            break outer;
          }
        }
      }
      if (contradiction !== null) {
        const contradicted = component.find((memory) => memory.id === contradiction!.aId)!;
        skipped.push({
          source_ids: ids,
          reason: `contradiction between ${contradiction.aId} and ${contradiction.bId} (template "${contradictionTemplate(
            contradicted.content,
          )}") — resolve it first, then re-run`,
        });
        continue;
      }

      // 5. Derive: merge the statement, insert the semantic memory, link every source.
      const sources = component.map(mergeSourceOf);
      const representative = representativeSource(sources, cosineSum);
      const entityName = groupEntityName.get(groupKey)!;
      const merged = await mergeClusterContent({ sources, representative, entityName, router: options.router });
      if (merged.fallback_reason !== undefined) {
        warnings.push(`llm merge fell back to the template: ${merged.fallback_reason}`);
      }
      const scope = {
        project_id: component[0]!.project_id ?? null,
        user_id: component[0]!.user_id ?? null,
      };
      const derived = buildDerivedMemory({ scope, sources, representative, merged });

      const write = await store.insertMemory(derived);
      const target = write.outcome === 'inserted' ? write.memory : (write.existing ?? write.memory);
      const reused = write.outcome !== 'inserted';

      for (const source of component) {
        await store.addEdge({
          from_memory_id: target.id,
          to_memory_id: source.id,
          relation: 'derived_from',
          project_id: scope.project_id ?? undefined,
        });
      }

      // 6. Bind the cluster's primary entity to the derived memory (subject role).
      const resolved = await resolveClusterEntity(store, scope, entityName);
      let entity: DerivationRecord['entity'] = null;
      if (resolved !== null) {
        await store.bindMemoryEntities(target.id, [{ entity_id: resolved.id, role: 'subject', weight: 2 }]);
        entity = { id: resolved.id, name: resolved.name };
      }

      records.push({ memory_id: target.id, source_ids: ids, entity, method: merged.method, reused_existing: reused });
    }
  }

  return { records, skipped, warnings };
}

interface EntityKey {
  entityKey: string;
  entityName: string;
}

/**
 * The primary entity of a memory: its earliest entity binding when one exists (the read paths
 * expose no binding roles), else its first tech mention resolved through the registry, else the
 * normalized mention name (created lazily at derivation time).
 */
async function entityKeyFor(store: Store, memory: MemoryRecord): Promise<EntityKey | null> {
  const bound = memory.entities[0];
  if (bound !== undefined) {
    return { entityKey: `id:${bound.id}`, entityName: bound.name };
  }
  const mention = extractTechMentions(memory.content)[0];
  if (mention === undefined) return null;
  const normalized = mention.trim().toLowerCase();
  const resolved = await store.findEntity({ project_id: memory.project_id ?? null }, normalized);
  if (resolved !== null) {
    return { entityKey: `id:${resolved.id}`, entityName: resolved.name };
  }
  return { entityKey: `name:${normalized}`, entityName: mention };
}

/** Resolve (or honestly create) the cluster's subject entity at derivation time. */
async function resolveClusterEntity(
  store: Store,
  scope: { project_id: string | null; user_id: string | null },
  name: string,
): Promise<{ id: string; name: string } | null> {
  const normalized = name.trim().toLowerCase();
  const existing = await store.findEntity({ project_id: scope.project_id ?? null }, normalized);
  if (existing !== null) return { id: existing.id, name: existing.name };
  const created = await store.createEntity({
    project_id: scope.project_id ?? undefined,
    kind: 'other',
    name,
  });
  return { id: created.id, name: created.name };
}
