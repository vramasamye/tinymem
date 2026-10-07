/**
 * The shared contract between the CLI and the REST API.
 *
 * `onemem` needs the same behaviour whether it talks to storage directly (no daemon running) or to
 * a running daemon over HTTP (ADR-0002: one owner process per embedded data dir). Both paths
 * therefore implement exactly this interface:
 *
 * - `createLocalBackend(runtime)` — in-process calls into the composition root;
 * - `createHttpBackend(baseUrl)` — the same calls over `/v1/*`.
 *
 * CLI commands depend on the interface, never on a concrete backend, which is what makes the
 * per-command tests able to inject a fake.
 */

import type { MemorySearchRequest, MemorySearchResponse } from '@onememory-ai/core';
import type { LlmProfileSummary } from '@onememory-ai/config';
import type { SkillStatus, SkillsTargetSource } from '@onememory-ai/core';
import type {
  DurableMemoryType,
  EntityRecord,
  EdgeRecord,
  MemoryEventRecord,
  MemoryRecord,
  ProjectRecord,
  Redaction,
} from '@onememory-ai/core';
import type { SessionContext } from '@onememory-ai/retrieval';

import type { DoctorOptions, DoctorReport } from './doctor';

/** Machine-readable health summary (ADR-0010: the daemon is probed, not guessed). */
export interface HealthReport {
  status: 'ok' | 'degraded' | 'failed';
  version: string;
  uptime_ms: number;
  pid: number;
  config_path: string | null;
  storage: { profile: 'embedded' | 'server'; vector_backend: string; vector_model: string; vector_dim: number };
  llm: LlmProfileSummary;
  embedder: { provider: string | null; model: string | null; dim: number | null };
  network_guard: { enforced: boolean; attempts: number; reason: string };
  warnings: string[];
}

export interface CreateProjectInput {
  name: string;
  root_path?: string;
  git_remote?: string;
  description?: string;
}

export interface ProjectListResult {
  projects: ProjectRecord[];
  warnings: string[];
}

export interface RememberInput {
  project_id: string;
  content: string;
  /** Durable content type; explicit user statements may declare one (memory-model.md §4 rule 4). */
  type?: 'episodic' | 'semantic' | 'procedural' | 'decision' | 'failure' | 'preference';
  title?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
  subtype?: string;
  /** Audit actor; defaults to `user:<local-user>` (CLI/REST are the user's own action). */
  actor?: string;
}

export interface RememberOutcome {
  outcome: 'inserted' | 'duplicate';
  memory_id: string;
  /** Redaction records from the write path — kind + location + length only, never values. */
  redactions: Redaction[];
  /** Set when the same (scope, type, content) already existed. */
  duplicate_of?: string;
  warnings: string[];
}

export interface ForgetInput {
  project_id: string;
  memory_id: string;
  reason?: string;
  actor?: string;
}

export interface ForgetOutcome {
  memory_id: string;
  from_status: string;
  to_status: string;
  /** The audited transition row id. */
  audit_event_id: string;
  /** How to undo it (restore) and how to hard-purge later. */
  restore_hint: string;
  purge_hint: string;
  note: string;
}

export interface PurgeInput {
  project_id: string;
  memory_id: string;
  /** Purges are never accidental: the revision token (`updated_at`) from your last read. */
  expected_revision: string;
  reason?: string;
  actor?: string;
}

export interface PurgeOutcome {
  memory_id: string;
  purged: true;
  from_status: string;
  /** The surviving 'purged' audit row id (memory_events is FK-less by design). */
  audit_event_id: string;
  note: string;
}

export interface InspectResult {
  memory: MemoryRecord;
  /** Supersession chain, oldest first (includes `memory`). */
  history: MemoryRecord[];
  /** Append-only audit trail, oldest first. */
  audit: MemoryEventRecord[];
  entities: EntityRecord[];
  edges: EdgeRecord[];
  /** Redaction summaries recovered from the write-path audit rows: kinds + locations + lengths. */
  redactions: Redaction[];
  warnings: string[];
}

export type IngestOutcomeStatus = 'stored' | 'duplicate' | 'excluded' | 'dead-letter';

export interface IngestOutcome {
  index: number;
  status: IngestOutcomeStatus;
  event_id?: string;
  duplicate_of?: string;
  /** Why the event was excluded or dead-lettered (path exclusion / validation issues). */
  reason?: string;
  redactions?: Redaction[];
}

export interface IngestResult {
  outcomes: IngestOutcome[];
  stored: number;
  duplicates: number;
  excluded: number;
  dead_lettered: number;
  /** Id of the queued `normalize` job when at least one event was stored. */
  normalize_job_id: string | null;
  warnings: string[];
}

export interface StatsResult {
  project_id: string;
  storage: {
    profile: 'embedded' | 'server';
    vector_backend: string;
    vector_model: string;
    vector_dim: number;
    data_dir: string | null;
  };
  memories: {
    total: number;
    by_status: Record<string, number>;
    by_type: Record<string, number>;
    /** True when a status hit the read cap — counts are a lower bound. */
    truncated: boolean;
  };
  working_memory: { session_id: string; depth: number } | null;
  /** `null` while `@onememory-ai/storage` has no job-count API (see the M13 report follow-ups). */
  jobs: { pending: number; running: number; dead: number } | null;
  cache: { embeddings: number; results: number; entityScopes: number };
  llm: LlmProfileSummary;
  warnings: string[];
}

export interface ContextOptions {
  budget?: number;
  session_id?: string;
}

export interface ListOptions {
  max_tokens?: number;
  max_memories?: number;
  /** Free-text override; the decisions/failures endpoints synthesize one for intent routing. */
  query?: string;
}

/** Non-active statuses a memory listing may opt into (active rows are always listed). */
export const MEMORY_PAGE_INCLUDE = ['stale', 'superseded', 'disputed', 'archived'] as const;
export type MemoryPageInclude = (typeof MEMORY_PAGE_INCLUDE)[number];

export const DEFAULT_MEMORY_PAGE_SIZE = 50;
export const MAX_MEMORY_PAGE_SIZE = 200;

export interface MemoryPageOptions {
  /** Opaque cursor from the previous page's `next_cursor`. */
  cursor?: string;
  page_size?: number;
  /** Empty or absent = every durable type. */
  types?: readonly DurableMemoryType[];
  include?: readonly MemoryPageInclude[];
}

/** One keyset page of a project's memories, newest observation first. */
export interface MemoryPageResult {
  project_id: string;
  page_size: number;
  memories: MemoryRecord[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  next_cursor: string | null;
}

/** Service-level failure carrying a stable code the HTTP layer maps onto a status. */
export type BackendErrorCode = 'not_found' | 'invalid_request' | 'conflict' | 'unavailable' | 'internal';

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly code: BackendErrorCode,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/** The two daemon consolidation job kinds (memory-model.md §8 stages 12–14). */
export type ConsolidateKind = 'consolidate' | 'decay';

export interface ConsolidateInput {
  project_id: string;
  /** `consolidate` runs all four passes; `decay` runs only the terminal decay/archive pass. */
  kind?: ConsolidateKind;
  /** Audit actor recorded on the resulting job (the calling surface). */
  actor?: string;
}

export interface ConsolidateOutcome {
  project_id: string;
  kind: ConsolidateKind;
  job_id: string;
  /** `enqueued` when this call created the job; `existing` when one was already pending. */
  outcome: 'enqueued' | 'existing';
  status: string;
  note: string;
}

/**
 * Everything the CLI (and later adapters through the REST API) can ask onememory to do.
 */
/**
 * The list/detail projection of a `skills` row (M15 follow-up 4): wire-shaped, no payload
 * internals. `path` is the canonical project-relative identity; the write root is chosen at
 * promotion time and reported as `written_path`.
 */
export interface SkillSummary {
  id: string;
  project_id: string | null;
  name: string;
  description: string;
  version: string;
  status: SkillStatus;
  path: string;
  usage_count: number;
  success_rate: number | null;
  evidence_count: number;
  verified_at: string;
  source_failure_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface SkillListResult {
  project_id: string;
  skills: SkillSummary[];
  warnings: string[];
}

/** The review bundle: the row, the SKILL.md bytes as promotion would write them, the audit. */
export interface SkillReviewResult {
  project_id: string;
  skill: SkillSummary;
  markdown: string;
  audit: MemoryEventRecord[];
  unresolved_failure_ids: string[];
}

export interface PromoteSkillInput {
  project_id: string;
  skill_id: string;
  /** Explicit write directory (highest precedence). */
  dir?: string;
  /** Write into this runtime's canonical skills root. */
  runtime?: string;
  note?: string;
  /** `$HOME` for `~/` expansion. */
  home?: string | null;
}

export interface PromoteSkillResult {
  project_id: string;
  skill: SkillSummary;
  written_path: string;
  skills_root: string;
  skills_root_source: SkillsTargetSource;
  markdown_bytes: number;
}

export interface DeprecateSkillInput {
  project_id: string;
  skill_id: string;
  /** Why — required and audited (`deprecated` is terminal). */
  note: string;
}

export interface DeprecateSkillResult {
  project_id: string;
  skill: SkillSummary;
}

export interface OnememoryBackend {
  readonly kind: 'local' | 'remote';
  /** HTTP base URL in remote mode; `null` when the backend owns storage in-process. */
  readonly endpoint: string | null;
  health(): Promise<HealthReport>;
  doctor(options?: DoctorOptions): Promise<DoctorReport>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(id: string): Promise<ProjectRecord>;
  listProjects(): Promise<ProjectListResult>;
  ingestEvents(projectId: string, events: unknown[]): Promise<IngestResult>;
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  remember(input: RememberInput): Promise<RememberOutcome>;
  forget(input: ForgetInput): Promise<ForgetOutcome>;
  /** Undo a soft forget (archived → active, audited) — what makes "recoverable" true. */
  restore(input: ForgetInput): Promise<ForgetOutcome>;
  /**
   * Hard purge (destructive — forget ≠ delete): the row and its cascaded vectors/bindings/edges
   * are deleted, and one 'purged' audit row survives. Requires the revision token so a purge can
   * never happen by accident (ADR-0010).
   */
  purge(input: PurgeInput): Promise<PurgeOutcome>;
  inspect(projectId: string, memoryId: string): Promise<InspectResult>;
  stats(projectId: string, options?: { session_id?: string }): Promise<StatsResult>;
  context(projectId: string, options?: ContextOptions): Promise<SessionContext>;
  decisions(projectId: string, options?: ListOptions): Promise<MemorySearchResponse>;
  failures(projectId: string, options?: ListOptions): Promise<MemorySearchResponse>;
  /** Keyset-paginated listing (no ranking, no token budget): browse, not search. */
  listMemories(projectId: string, options?: MemoryPageOptions): Promise<MemoryPageResult>;
  /**
   * Queue a consolidation pass (memory-model.md §8 stages 12–14). Asynchronous by design: the
   * route enqueues a `consolidate`/`decay` job and returns its id, and the daemon worker runs it —
   * the API/CLI never awaits a pass.
   */
  consolidate(input: ConsolidateInput): Promise<ConsolidateOutcome>;
  /** The project's skills (review queue), newest-updated first. */
  listSkills(projectId: string): Promise<SkillListResult>;
  /** The review bundle for one skill (row + SKILL.md bytes + audit). */
  reviewSkill(projectId: string, skillId: string): Promise<SkillReviewResult>;
  /** Write the artifact and flip `candidate → verified`, audited. */
  promoteSkill(input: PromoteSkillInput): Promise<PromoteSkillResult>;
  /** Reject or retire a skill (`→ deprecated`, terminal), audited; any artifact is kept. */
  deprecateSkill(input: DeprecateSkillInput): Promise<DeprecateSkillResult>;
  close(): Promise<void>;
}
