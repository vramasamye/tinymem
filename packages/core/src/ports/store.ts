/**
 * The `Store` port — the engine's persistence boundary (repository-structure.md: "core declares
 * ports, does not import implementations"; storage is the only package with SQL).
 *
 * The lifecycle pipeline (memory-model.md §8) codes against this interface:
 *   INGEST (2)        → `createSource`, `ingestEvent`
 *   DEDUPLICATE (6)   → `findDuplicate`
 *   STORE (9)         → `insertMemory`, `supersede`, `addEdge`, `bindMemoryEntities`
 *   RETRIEVE (10)     → `queryCurrent`, `queryAsOf`, `historyOf`, `getMemory`
 *   REINFORCE (11)    → `reinforce`
 *   audit             → `appendMemoryEvent`, `listMemoryEvents` (every status change records here)
 *
 * Implementations MUST: enforce the status transition machine (every transition audited), keep
 * the dedupe invariant ((scope, type, content_hash) unique), and run supersession as one
 * transaction (loser status/valid_until/superseded_by + winner insert + audit rows).
 */

import type { OnememoryEvent } from '../schema/event';
import type { MemoryRecord } from '../schema/memory';
import type {
  DeleteMemoryOptions,
  EnqueueJobInput,
  EntityBinding,
  MergeEntitiesInput,
  MemoryQuery,
  NewEdge,
  NewEntity,
  NewMemory,
  NewMemoryEvent,
  NewProject,
  NewSession,
  NewSource,
  NewUser,
  NewWorkingMemory,
  StatusChangeOptions,
  SupersedeInput,
} from '../schema/persistence';
import type { MemoryStatus, DurableMemoryType } from '../model/types';

import type {
  EdgeRecord,
  EntityRecord,
  EventIngestResult,
  MemoryDeleteResult,
  MemoryEventRecord,
  MemoryWriteResult,
  ProjectRecord,
  SessionRecord,
  SourceRef,
  StoredEvent,
  SupersedeResult,
  UserRecord,
  WorkingMemoryRecord,
  WorkingSweepResult,
} from './records';

export interface Store {
  // --- identity & scope -----------------------------------------------------

  createUser(input: NewUser): Promise<UserRecord>;
  createProject(input: NewProject): Promise<ProjectRecord>;
  getProject(id: string): Promise<ProjectRecord | null>;
  /**
   * The cwd→project lookup (M17): the deepest registered `root_path` containing the path wins, so
   * a nested directory resolves to its own project in a multi-project data dir. No registered
   * root contains it → null (an honest miss, never a guess).
   */
  findProjectByPath(path: string): Promise<ProjectRecord | null>;

  // --- provenance & raw events (INGEST) --------------------------------------

  createSource(input: NewSource): Promise<SourceRef>;
  getSource(id: string): Promise<SourceRef | null>;
  /** Dedupe by (project_id, kind, content_hash); redactions passthrough; never throws on duplicates. */
  ingestEvent(event: OnememoryEvent): Promise<EventIngestResult>;
  /** Events awaiting the async pipeline (processed_at IS NULL). */
  listPendingEvents(limit: number): Promise<StoredEvent[]>;
  markEventProcessed(
    id: string,
    options?: { process_error?: string; needs_review?: boolean },
  ): Promise<void>;

  // --- memories (DEDUPLICATE → STORE → RETRIEVE) ------------------------------

  /** The stage-6 exact-dedupe probe (database-schema.md §4). */
  findDuplicate(
    scope: { project_id?: string | null; user_id?: string | null },
    type: DurableMemoryType,
    contentHash: string,
  ): Promise<MemoryRecord | null>;
  insertMemory(candidate: NewMemory): Promise<MemoryWriteResult>;
  getMemory(id: string): Promise<MemoryRecord | null>;
  /**
   * Audited status transition — validated by the model's transition machine; throws
   * InvalidTransitionError on an illegal edge. `valid_until`/`superseded_by_id` ride along for
   * supersession/forget flows.
   */
  updateMemoryStatus(id: string, to: MemoryStatus, options: StatusChangeOptions): Promise<MemoryRecord>;
  /** The supersession transaction: winner insert + loser (superseded, valid_until, superseded_by) + audit rows. */
  supersede(input: SupersedeInput): Promise<SupersedeResult>;
  /**
   * Hard purge (destructive — the opposite of a forget tombstone): deletes the memories row in
   * one transaction. Vectors, entity bindings, edges, decisions/failures/code-ref rows cascade
   * (schema `ON DELETE CASCADE`); dangling `superseded_by`/`promoted_memory_id` pointers are
   * cleared so FKs never block the purge. The `'purged'` audit row survives — `memory_events`
   * is FK-less by design. Returns null when the id is unknown.
   */
  deleteMemory(id: string, options: DeleteMemoryOptions): Promise<MemoryDeleteResult | null>;
  /** Current-validity lookup: status IN (active, stale) AND valid_until IS NULL. */
  queryCurrent(query: MemoryQuery): Promise<MemoryRecord[]>;
  /** Point-in-time lookup at `at`: valid_from ≤ at < valid_until; superseded included, disputed excluded. */
  queryAsOf(at: string, query: MemoryQuery): Promise<MemoryRecord[]>;
  /** The full supersession chain containing `memoryId`, oldest first ("full history"). */
  historyOf(memoryId: string): Promise<MemoryRecord[]>;
  /** Stage 11 REINFORCE: bump access_count + last_accessed_at (fire-and-forget). */
  reinforce(memoryIds: string[], at?: string): Promise<void>;

  // --- audit trail ------------------------------------------------------------

  appendMemoryEvent(entry: NewMemoryEvent): Promise<MemoryEventRecord>;
  listMemoryEvents(memoryId: string): Promise<MemoryEventRecord[]>;

  // --- memory graph ------------------------------------------------------------

  addEdge(edge: NewEdge): Promise<EdgeRecord>;
  listEdges(memoryId: string): Promise<EdgeRecord[]>;

  // --- entity registry (ENTITY RESOLUTION persistence primitives) ----------------

  findEntity(scope: { project_id?: string | null }, normalizedName: string): Promise<EntityRecord | null>;
  createEntity(input: NewEntity): Promise<EntityRecord>;
  /** Loser gets `merged_into`; the resolver implementation owns re-binding memories. */
  mergeEntities(input: MergeEntitiesInput): Promise<void>;
  bindMemoryEntities(memoryId: string, bindings: EntityBinding[]): Promise<void>;
  listMemoryEntities(memoryId: string): Promise<EntityRecord[]>;

  // --- working memory (separate table, TTL scratchpad, deletions allowed) --------

  createSession(input: NewSession): Promise<SessionRecord>;
  insertWorking(entry: NewWorkingMemory): Promise<WorkingMemoryRecord>;
  markWorkingPromoted(id: string, memoryId: string): Promise<void>;
  /** Purge expired unpromoted rows; promoted rows are preserved (database-schema.md §2). */
  sweepWorking(now?: string): Promise<WorkingSweepResult>;
  listWorking(sessionId: string): Promise<WorkingMemoryRecord[]>;
}
