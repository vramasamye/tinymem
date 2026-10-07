/**
 * Minimal re-index (ADR-0008 point 4, backlog M4.5; parity memo §5 Tier A item 2). Drift marks
 * memories `stale` (M4e); this is the pass that refreshes them so they do not stay stale forever.
 *
 * Per project it:
 *
 * 1. runs the SAME zero-token drift oracle (`createDriftWatcher`) over persisted state and keeps
 *    the drifted memories that are currently `stale` (active drift is `drift_scan`'s job);
 * 2. re-extracts ONLY the drifted paths: tree-sitter symbols through `extractSymbolTable(root,
 *    { files })` → `saveSymbolTable` (unchanged files are never read — the only-changed
 *    primitive), and current file text through the existing extraction pipeline (the injected
 *    `Extractor` + classifier the `extract` job uses) via synthetic `document.added` events;
 * 3. refreshes each stale memory through audited store paths: `stale → active` (the model's
 *    re-verified edge, audited as `restored`) when the re-read content reproduces the memory's own
 *    knowledge, or an audited `supersede` when the drifted file now states something different.
 *    Knowledge that cannot be reproduced stays `stale` and is reported `deferred` — never a
 *    silent un-stale;
 * 4. re-embeds refreshed and superseded memories (`re_embed`, reason `backfill`) when an embedder
 *    is registered — the handler upserts, so a memory that was never embedded (the embedder may
 *    be newly enabled) gains its vector and an already-correct one is written identically;
 * 5. rebuilds and persists the architecture digest ({@link buildArchitectureDigest}) as a durable
 *    project memory with provenance.
 *
 * Degraded modes are honest warnings, not errors: a tree-sitter runtime that cannot load, an
 * extractor that fails, and an unreadable path all degrade this pass without throwing. Nothing is
 * deleted; a `deferred` memory keeps drifting on later passes.
 */

import {
  estimateTokens,
  memoryContentHash,
  type CodeMemoryStore,
  type DurableMemoryType,
  type ExtractedMemory,
  type ExtractionInput,
  type Extractor,
  type JobQueue,
  type MemoryRecord,
  type NewMemory,
  type Store,
} from '@onememory-ai/core';

import { buildCodeDocumentEvent, fileEvidence } from './code-events';
import {
  buildArchitectureDigest,
  DIGEST_PROMPT_VERSION,
  DEFAULT_DIGEST_BUDGET_TOKENS,
  isCurrentArchitectureDigest,
  loadDigestInputs,
  type ArchitectureDigest,
} from './digest';
import { createDriftWatcher } from './drift';
import { compareText, describeError } from './internal';
import type { SkippedSymbolFile, SymbolTable } from './schema';
import { extractSymbolTable, readSourceFile } from './symbols';

/** The subset of `Store` re-index composes (narrow on purpose). */
export type ReindexStore = Pick<
  Store,
  | 'getMemory'
  | 'updateMemoryStatus'
  | 'supersede'
  | 'insertMemory'
  | 'createSource'
  | 'queryCurrent'
  | 'findDuplicate'
>;

/** Structural shape of the classifier's output the re-index consumes (no extraction import). */
export interface ReindexClassification {
  durable_type: DurableMemoryType;
  subtype?: string;
  awaiting_consolidation: boolean;
}

/** Classify one extracted candidate (composition passes the extract pipeline's classifier). */
export type ReindexClassifier = (candidate: ExtractedMemory) => ReindexClassification;

export interface ReindexDeps {
  store: ReindexStore;
  codeMemory: CodeMemoryStore;
  jobs: JobQueue;
  extractor: Extractor;
  classify: ReindexClassifier;
  /** Redact re-read text before it reaches the extractor (secrets never enter memory). */
  redactText?: (text: string) => string;
  /** Enqueue `re_embed` for refreshed/superseded content (false when no embedder is registered). */
  enqueueReEmbed?: boolean;
  /** Per-file read cap (default 1 MiB — the capture default's neighborhood, not the 10 MB max). */
  maxFileBytes?: number;
  /** Digest token budget (default 300 — the Phase 2 DoD). */
  digestBudgetTokens?: number;
  now?: () => Date;
  /** Test seams; production uses the shared bounded worktree read and the real symbol extractor. */
  readText?: (root: string, path: string, maxBytes: number) => Promise<{ source: string } | SkippedSymbolFile>;
  extractSymbols?: (root: string, options: { files: string[]; max_file_bytes?: number }) => Promise<SymbolTable>;
}

export interface ReindexInput {
  project_id: string;
}

/**
 * - `refreshed`: the re-read content reproduced the memory's own knowledge; `stale → active` was
 *   audited and its refs re-recorded against the current blobs;
 * - `superseded`: the drifted file now yields different knowledge of the same type; the memory was
 *   superseded by the freshly extracted candidate;
 * - `deferred`: nothing reproducible was extracted (or the path was unreadable/missing) — the
 *   memory stays `stale` and keeps drifting;
 * - `not_stale`: drift was reported for a memory that is no longer stale (handled by drift_scan);
 * - `gone`: the memory disappeared mid-pass;
 * - `failed`: an unexpected error; the memory's status is left as found.
 */
export type ReindexMemoryOutcome =
  | 'refreshed'
  | 'superseded'
  | 'deferred'
  | 'not_stale'
  | 'gone'
  | 'failed';

export interface ReindexedMemory {
  memory_id: string;
  outcome: ReindexMemoryOutcome;
  status_before: string | null;
  drifted_paths: string[];
  /** The winning memory id when the outcome is `superseded`. */
  winner_id?: string;
  error?: string;
}

export interface DigestOutcome {
  outcome: 'created' | 'refreshed' | 'unchanged' | 'failed';
  memory_id: string | null;
  tokens: number;
  truncated: boolean;
  text: string;
  error?: string;
}

export interface ReindexResult {
  project_id: string;
  repositories: number;
  /** Drifted paths re-extracted this pass (sorted, deduplicated). */
  drifted_paths: string[];
  symbols_rewritten: number;
  symbols_unchanged: number;
  /** Synthetic document events handed to the extraction pipeline (one per readable drifted path). */
  extraction_inputs: number;
  candidates_extracted: number;
  memories: ReindexedMemory[];
  refreshed: number;
  superseded: number;
  deferred: number;
  re_embed_jobs: number;
  digest: DigestOutcome | null;
  warnings: string[];
}

export interface Reindexer {
  reindex(input: ReindexInput): Promise<ReindexResult>;
}

interface Candidate {
  candidate: ExtractedMemory;
  classification: ReindexClassification;
  path: string;
  repository_id: string;
}

const REINDEX_ACTOR = 'job:reindex';

/** A winner's `observed_at` must be strictly after the loser's `valid_from` (supersede's rule). */
function supersedingObservedAt(now: string, loser: MemoryRecord): string {
  const candidate = Date.parse(now);
  const floor = Date.parse(loser.valid_from) + 1;
  return new Date(Math.max(candidate, floor)).toISOString();
}

export function createReindexer(deps: ReindexDeps): Reindexer {
  const now = deps.now ?? (() => new Date());
  const maxFileBytes = deps.maxFileBytes ?? 1_000_000;
  const budgetTokens = deps.digestBudgetTokens ?? DEFAULT_DIGEST_BUDGET_TOKENS;
  const redact = deps.redactText ?? ((text: string) => text);
  const enqueueReEmbed = deps.enqueueReEmbed ?? false;
  const extractSymbols = deps.extractSymbols ?? extractSymbolTable;
  const readText = deps.readText ?? readSourceFile;
  const watcher = createDriftWatcher(deps.codeMemory);

  async function enqueueEmbed(result: ReindexResult, memoryId: string, text: string): Promise<void> {
    if (!enqueueReEmbed) return;
    try {
      await deps.jobs.enqueue({
        kind: 're_embed',
        key: `re_embed:${memoryId}`,
        payload: { reason: 'backfill', items: [{ memory_id: memoryId, text }] },
      });
      result.re_embed_jobs += 1;
    } catch (error) {
      result.warnings.push(`re_embed enqueue failed for memory ${memoryId}: ${describeError(error)}`);
    }
  }

  async function refreshMemory(
    result: ReindexResult,
    memory: MemoryRecord,
    drifted: { repository_id: string; path: string }[],
    currentBlobs: ReadonlyMap<string, string>,
  ): Promise<void> {
    const refs = drifted
      .map((ref) => ({ path: ref.path, blob_sha: currentBlobs.get(ref.path) }))
      .filter((ref): ref is { path: string; blob_sha: string } => ref.blob_sha !== undefined);
    if (refs.length !== drifted.length) {
      result.memories.push({
        memory_id: memory.id,
        outcome: 'deferred',
        status_before: memory.status,
        drifted_paths: drifted.map((ref) => ref.path),
        error: 'a drifted path has no current readable fingerprint; freshness cannot be re-recorded',
      });
      result.deferred += 1;
      return;
    }
    try {
      // Status change FIRST, refs after — the safe degradation order. If the status write fails,
      // the refs still name the OLD blob, so the drift oracle sees the memory again and the next
      // pass retries (never a permanently stale memory whose refs quietly match current state).
      // If instead the ref re-record fails after a successful status change, the memory is active
      // but its refs still name the old blob — the next drift scan re-marks it stale and the next
      // pass retries the refresh. Either failure degrades into a retry, never into silence.
      await deps.store.updateMemoryStatus(memory.id, 'active', {
        actor: REINDEX_ACTOR,
        reason: 'code_reindexed',
        details: { paths: refs.map((ref) => ref.path) },
      });
      await deps.codeMemory.recordCodeRefs({
        memory_id: memory.id,
        repository_id: drifted[0]!.repository_id,
        refs,
      });
      result.memories.push({
        memory_id: memory.id,
        outcome: 'refreshed',
        status_before: memory.status,
        drifted_paths: drifted.map((ref) => ref.path),
      });
      result.refreshed += 1;
      await enqueueEmbed(result, memory.id, `${memory.title ?? ''} ${memory.content}`.trim());
    } catch (error) {
      result.memories.push({
        memory_id: memory.id,
        outcome: 'failed',
        status_before: memory.status,
        drifted_paths: drifted.map((ref) => ref.path),
        error: describeError(error),
      });
    }
  }

  async function supersedeMemory(
    result: ReindexResult,
    memory: MemoryRecord,
    candidate: Candidate,
  ): Promise<void> {
    const observedAt = supersedingObservedAt(now().toISOString(), memory);
    let sourceId: string;
    try {
      const source = await deps.store.createSource({
        kind: 'file',
        uri: `repo:${candidate.repository_id}/${candidate.path}`,
        title: candidate.path,
        ...(memory.project_id === undefined ? {} : { project_id: memory.project_id }),
      });
      sourceId = source.id;
    } catch (error) {
      result.memories.push({
        memory_id: memory.id,
        outcome: 'failed',
        status_before: memory.status,
        drifted_paths: [candidate.path],
        error: `provenance source creation failed: ${describeError(error)}`,
      });
      return;
    }

    const winner: NewMemory = {
      type: candidate.classification.durable_type,
      ...(candidate.classification.subtype === undefined ? {} : { subtype: candidate.classification.subtype }),
      ...(candidate.candidate.title === undefined ? {} : { title: candidate.candidate.title }),
      content: candidate.candidate.content,
      ...(candidate.candidate.content.length > 160
        ? { content_summary: candidate.candidate.content.slice(0, 159) }
        : {}),
      importance: candidate.candidate.importance,
      confidence: candidate.candidate.confidence,
      observed_at: observedAt,
      valid_from: observedAt,
      ...(memory.project_id === undefined ? {} : { project_id: memory.project_id }),
      ...(memory.user_id === undefined ? {} : { user_id: memory.user_id }),
      source_id: sourceId,
      evidence: candidate.candidate.evidence.map((span) =>
        // The FILE is the durable source of truth; `fileEvidence` bounds the excerpt.
        fileEvidence(span.source_id, candidate.path, span.excerpt),
      ),
      extraction: { method: 'heuristic', prompt_version: 'code-reindex-v1', adapter: 'codememory' },
      tags: [
        'code_reindex',
        ...(candidate.classification.awaiting_consolidation ? ['semantic_candidate'] : []),
      ],
      token_estimate: estimateTokens(candidate.candidate.content),
    };

    try {
      const superseded = await deps.store.supersede({
        winner,
        loser_id: memory.id,
        actor: REINDEX_ACTOR,
        reason: 'code_reindexed',
      });
      if (superseded.outcome === 'winner-duplicate') {
        // The extracted knowledge already exists as a current memory: point the stale row at it.
        const existing = superseded.existing ?? superseded.winner;
        await deps.store.updateMemoryStatus(memory.id, 'superseded', {
          actor: REINDEX_ACTOR,
          reason: 'code_reindexed',
          superseded_by_id: existing.id,
        });
        result.memories.push({
          memory_id: memory.id,
          outcome: 'superseded',
          status_before: memory.status,
          drifted_paths: [candidate.path],
          winner_id: existing.id,
        });
        result.superseded += 1;
        return;
      }
      const winnerId = superseded.winner.id;
      // Track the winner against the current blob so the refreshed knowledge keeps drifting later.
      const blob = await currentBlobFor(candidate.repository_id, candidate.path);
      if (blob !== null) {
        await deps.codeMemory.recordCodeRefs({
          memory_id: winnerId,
          repository_id: candidate.repository_id,
          refs: [{ path: candidate.path, blob_sha: blob }],
        });
      }
      result.memories.push({
        memory_id: memory.id,
        outcome: 'superseded',
        status_before: memory.status,
        drifted_paths: [candidate.path],
        winner_id: winnerId,
      });
      result.superseded += 1;
      await enqueueEmbed(
        result,
        winnerId,
        `${candidate.candidate.title ?? ''} ${candidate.candidate.content}`.trim(),
      );
    } catch (error) {
      result.memories.push({
        memory_id: memory.id,
        outcome: 'failed',
        status_before: memory.status,
        drifted_paths: [candidate.path],
        error: describeError(error),
      });
    }
  }

  async function currentBlobFor(repositoryId: string, path: string): Promise<string | null> {
    const fingerprints = await deps.codeMemory.loadFingerprints(repositoryId, {
      tier: 'worktree',
      paths: [path],
    });
    return fingerprints[0]?.blob_sha ?? null;
  }

  async function persistDigest(
    result: ReindexResult,
    projectId: string,
    repositories: Awaited<ReturnType<CodeMemoryStore['listRepositories']>>,
    digest: ArchitectureDigest,
  ): Promise<void> {
    if (digest.file_count === 0 && digest.symbol_count === 0) {
      result.digest = null;
      result.warnings.push('architecture digest skipped: no repository data to summarize');
      return;
    }
    try {
      // 1. Deterministic unchanged probe — the Store's own exact-dedupe lookup, indexed and
      //    independent of any recency window: a long-unchanged digest in a busy project is found
      //    here no matter how many newer memories exist.
      const digestHash = memoryContentHash(digest.text);
      const identical = await deps.store.findDuplicate({ project_id: projectId }, 'semantic', digestHash);
      if (identical !== null && isCurrentArchitectureDigest(identical)) {
        result.digest = {
          outcome: 'unchanged',
          memory_id: identical.id,
          tokens: digest.tokens,
          truncated: digest.truncated,
          text: digest.text,
        };
        return;
      }

      // 2. The digest text changed (or none exists yet): find the current digest to supersede.
      //    The Store port has no tag/subtype-filtered query, so this predecessor lookup is bounded
      //    by the port's own query limit (1 000, its maximum). In daemon mode this window can
      //    never miss — every re-index pass refreshes the digest, so it is always the newest
      //    semantic memory; only a project whose re-index passes are >1 000 semantic memories
      //    apart could age a digest past this window.
      const previous = (await deps.store.queryCurrent({
        project_id: projectId,
        types: ['semantic'],
        limit: 1000,
      })).find((memory) => isCurrentArchitectureDigest(memory));

      const rootPath = repositories[0]?.root_path ?? '';
      const sourceId =
        previous !== undefined
          ? previous.provenance.source.id
          : (
              await deps.store.createSource({
                kind: 'file',
                uri: `repo:${rootPath}#architecture-digest`,
                title: 'architecture digest',
                project_id: projectId,
              })
            ).id;
      const observedAt =
        previous !== undefined
          ? supersedingObservedAt(now().toISOString(), previous)
          : now().toISOString();
      const winner: NewMemory = {
        type: 'semantic',
        subtype: 'project_digest',
        title: 'architecture digest',
        content: digest.text,
        ...(digest.text.length > 160 ? { content_summary: digest.text.slice(0, 159) } : {}),
        importance: 0.7,
        confidence: 0.6,
        observed_at: observedAt,
        valid_from: observedAt,
        project_id: projectId,
        source_id: sourceId,
        evidence: [
          {
            source_id: sourceId,
            kind: 'range',
            locator: `code_symbols:${repositories.map((repository) => repository.id).join(',')}`,
            excerpt: digest.text.split('\n')[0] ?? 'architecture digest',
          },
        ],
        extraction: { method: 'heuristic', prompt_version: DIGEST_PROMPT_VERSION, adapter: 'codememory' },
        tags: ['architecture_digest', 'project_digest', 'code_memory'],
        token_estimate: digest.tokens,
      };
      if (previous === undefined) {
        const written = await deps.store.insertMemory(winner);
        // `insertMemory` runs the same dedupe probe: an exact-text digest can never be inserted
        // twice — a `duplicate` outcome here means the text already exists (age immaterial), so
        // it is `unchanged`, never a fresh `created`.
        if (written.outcome === 'duplicate') {
          const existing = written.existing ?? written.memory;
          if (!isCurrentArchitectureDigest(existing)) {
            // The exact text matches a SUPERSEDED historical digest: the storage dedupe index
            // spans superseded rows, so it blocks re-inserting the text. Honest warning — the
            // port has no way to express "revalidate a superseded row".
            result.warnings.push(
              'architecture digest text matches a superseded historical digest; the storage dedupe index blocks re-inserting it (no current digest row was written)',
            );
          }
          result.digest = {
            outcome: 'unchanged',
            memory_id: existing.id,
            tokens: digest.tokens,
            truncated: digest.truncated,
            text: digest.text,
          };
          return;
        }
        result.digest = {
          outcome: 'created',
          memory_id: written.memory.id,
          tokens: digest.tokens,
          truncated: digest.truncated,
          text: digest.text,
        };
        await enqueueEmbed(result, written.memory.id, digest.text);
        return;
      }
      const superseded = await deps.store.supersede({
        winner,
        loser_id: previous.id,
        actor: REINDEX_ACTOR,
        reason: 'code_digest_refresh',
      });
      const memoryId = superseded.winner.id;
      result.digest = {
        outcome: superseded.outcome === 'winner-duplicate' ? 'unchanged' : 'refreshed',
        memory_id: memoryId,
        tokens: digest.tokens,
        truncated: digest.truncated,
        text: digest.text,
      };
      if (superseded.outcome !== 'winner-duplicate') {
        await enqueueEmbed(result, memoryId, digest.text);
      }
    } catch (error) {
      result.digest = {
        outcome: 'failed',
        memory_id: null,
        tokens: digest.tokens,
        truncated: digest.truncated,
        text: digest.text,
        error: describeError(error),
      };
      result.warnings.push(`architecture digest persistence failed: ${describeError(error)}`);
    }
  }

  return {
    async reindex(input: ReindexInput): Promise<ReindexResult> {
      const projectId = input.project_id;
      const result: ReindexResult = {
        project_id: projectId,
        repositories: 0,
        drifted_paths: [],
        symbols_rewritten: 0,
        symbols_unchanged: 0,
        extraction_inputs: 0,
        candidates_extracted: 0,
        memories: [],
        refreshed: 0,
        superseded: 0,
        deferred: 0,
        re_embed_jobs: 0,
        digest: null,
        warnings: [],
      };

      const repositories = await deps.codeMemory.listRepositories(projectId);
      result.repositories = repositories.length;
      const byId = new Map(repositories.map((repository) => [repository.id, repository]));

      const report = await watcher.detectDrift({ project_id: projectId });
      const staleByMemory = new Map<
        string,
        { memory: MemoryRecord; refs: { repository_id: string; path: string }[] }
      >();
      for (const drifted of report.drifted) {
        const memory = await deps.store.getMemory(drifted.memory_id);
        if (memory === null) {
          result.memories.push({
            memory_id: drifted.memory_id,
            outcome: 'gone',
            status_before: null,
            drifted_paths: drifted.changed_paths,
          });
          continue;
        }
        if (memory.status !== 'stale') {
          result.memories.push({
            memory_id: memory.id,
            outcome: 'not_stale',
            status_before: memory.status,
            drifted_paths: drifted.changed_paths,
          });
          continue;
        }
        const refs = drifted.refs
          .filter((ref) => ref.successor_path === undefined)
          .map((ref) => ({ repository_id: ref.repository_id, path: ref.path }));
        staleByMemory.set(memory.id, { memory, refs });
      }

      // Group the drifted paths per repository; only these are ever re-read.
      const pathsByRepository = new Map<string, Set<string>>();
      for (const { refs } of staleByMemory.values()) {
        for (const ref of refs) {
          if (!byId.has(ref.repository_id)) continue;
          const set = pathsByRepository.get(ref.repository_id) ?? new Set<string>();
          set.add(ref.path);
          pathsByRepository.set(ref.repository_id, set);
        }
      }

      const currentBlobsByRepository = new Map<string, Map<string, string>>();
      const candidatesByPath = new Map<string, Candidate[]>();
      for (const [repositoryId, pathSet] of pathsByRepository) {
        const repository = byId.get(repositoryId)!;
        const paths = [...pathSet].sort(compareText);
        for (const path of paths) result.drifted_paths.push(path);

        const fingerprints = await deps.codeMemory.loadFingerprints(repositoryId, { tier: 'worktree' });
        const blobs = new Map(fingerprints.map((fingerprint) => [fingerprint.path, fingerprint.blob_sha]));
        currentBlobsByRepository.set(repositoryId, blobs);

        // 1. Symbols: re-extract exactly the drifted paths (unchanged files are never read).
        try {
          const table = await extractSymbols(repository.root_path, {
            files: paths,
            max_file_bytes: maxFileBytes,
          });
          if (table.files.length > 0) {
            const saved = await deps.codeMemory.saveSymbolTable(repositoryId, { files: table.files });
            result.symbols_rewritten += saved.rewritten;
            result.symbols_unchanged += saved.unchanged;
          }
        } catch (error) {
          result.warnings.push(
            `symbol re-extraction degraded for repository ${repositoryId}: ${describeError(error)}`,
          );
        }

        // 2. Text: read only the drifted paths, redact, and hand them to the extraction pipeline.
        const inputs: ExtractionInput[] = [];
        const pathByEventId = new Map<string, string>();
        for (const path of paths) {
          let read: { source: string } | SkippedSymbolFile;
          try {
            read = await readText(repository.root_path, path, maxFileBytes);
          } catch (error) {
            result.warnings.push(`read failed for ${path}: ${describeError(error)}`);
            continue;
          }
          if ('reason' in read) {
            result.warnings.push(`drifted path ${path} is ${read.reason}; extraction skipped`);
            continue;
          }
          let sourceId: string;
          try {
            const source = await deps.store.createSource({
              kind: 'file',
              uri: `repo:${repositoryId}/${path}`,
              title: path,
              project_id: projectId,
            });
            sourceId = source.id;
          } catch (error) {
            result.warnings.push(`provenance source creation failed for ${path}: ${describeError(error)}`);
            continue;
          }
          const text = redact(read.source);
          const event = buildCodeDocumentEvent({
            project_id: projectId,
            path,
            text,
            occurred_at: now().toISOString(),
          });
          // The event id → its path, recorded where `path` is in scope (no payload round-trip).
          pathByEventId.set(event.id, path);
          inputs.push({ event, source: { id: sourceId, kind: 'file', uri: `repo:${repositoryId}/${path}`, title: path } });
        }

        if (inputs.length === 0) continue;
        result.extraction_inputs += inputs.length;
        let extraction;
        try {
          extraction = await deps.extractor.extract(inputs);
        } catch (error) {
          result.warnings.push(`extraction degraded for repository ${repositoryId}: ${describeError(error)}`);
          continue;
        }
        for (const candidate of extraction.memories) {
          result.candidates_extracted += 1;
          const eventId = candidate.evidence[0]?.locator?.startsWith('event:')
            ? candidate.evidence[0].locator.slice('event:'.length)
            : undefined;
          const path = eventId === undefined ? undefined : pathByEventId.get(eventId);
          if (path === undefined || path === '') continue;
          const classification = deps.classify(candidate);
          const list = candidatesByPath.get(`${repositoryId}\0${path}`) ?? [];
          list.push({ candidate, classification, path, repository_id: repositoryId });
          candidatesByPath.set(`${repositoryId}\0${path}`, list);
        }
      }
      result.drifted_paths = [...new Set(result.drifted_paths)].sort(compareText);

      // 3. Refresh or supersede each stale memory through audited store paths.
      for (const { memory, refs } of staleByMemory.values()) {
        const drifted = refs.filter((ref) => byId.has(ref.repository_id));
        if (drifted.length === 0) {
          result.memories.push({
            memory_id: memory.id,
            outcome: 'deferred',
            status_before: memory.status,
            drifted_paths: [],
            error: 'the memory references a repository that no longer exists',
          });
          result.deferred += 1;
          continue;
        }
        const pool: Candidate[] = [];
        for (const ref of drifted) {
          pool.push(...(candidatesByPath.get(`${ref.repository_id}\0${ref.path}`) ?? []));
        }
        const sameType = pool.filter(
          (entry) => entry.classification.durable_type === memory.type,
        );
        if (sameType.length === 0) {
          result.memories.push({
            memory_id: memory.id,
            outcome: 'deferred',
            status_before: memory.status,
            drifted_paths: drifted.map((ref) => ref.path),
            error: 'no reproducible knowledge of this type was extracted from the drifted paths',
          });
          result.deferred += 1;
          continue;
        }
        const contentHash = memoryContentHash(memory.content);
        const reproduced = sameType.find(
          (entry) => memoryContentHash(entry.candidate.content) === contentHash,
        );
        if (reproduced !== undefined) {
          const blobs = currentBlobsByRepository.get(reproduced.repository_id) ?? new Map<string, string>();
          await refreshMemory(result, memory, drifted, blobs);
          continue;
        }
        sameType.sort(
          (a, b) =>
            b.candidate.importance - a.candidate.importance ||
            b.candidate.confidence - a.candidate.confidence ||
            compareText(a.candidate.content, b.candidate.content),
        );
        await supersedeMemory(result, memory, sameType[0]!);
      }

      // 4. Architecture digest — rebuilt from persisted data (no file reads, no model calls),
      //    through the same input assembly the doctor's digest probe uses.
      try {
        const inputs = await loadDigestInputs(deps.codeMemory, projectId, repositories);
        const digest = buildArchitectureDigest({
          repositories: inputs,
          budgetTokens,
        });
        await persistDigest(result, projectId, repositories, digest);
      } catch (error) {
        result.warnings.push(`architecture digest assembly failed: ${describeError(error)}`);
      }

      return result;
    },
  };
}
