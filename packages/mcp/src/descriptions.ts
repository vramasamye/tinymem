/**
 * Tool descriptions — a MAINTAINED artifact (ADR-0010 consequence: the model's UX depends on
 * them as much as on results; `descriptions.test.ts` pins the budgets).
 *
 * Budgets (verified per-runtime constraints, docs/research/mcp-memory-implementations.md):
 * - every description ≤ `MAX_TOOL_DESCRIPTION_CHARS` (2,048 — Claude Code's truncation point;
 *   we target far below it: descriptions are tokens in the model's context);
 * - server `instructions` ≤ `MAX_INSTRUCTIONS_CHARS` (512) and self-contained in the first
 *   sentence (Codex reads the first 512 chars standalone);
 * - the FIRST SENTENCE of `memory_forget` / `memory_delete` states the forget ≠ delete
 *   difference (ADR-0010 §5: "to a model they look identical" — differentiate hard).
 */

import type { ToolName } from './schemas';

/** Claude Code truncates tool descriptions at 2,048 chars — never exceed this. */
export const MAX_TOOL_DESCRIPTION_CHARS = 2048;

/** Codex reads the first 512 chars of `instructions` standalone — keep the whole thing short. */
export const MAX_INSTRUCTIONS_CHARS = 512;

export const SERVER_INSTRUCTIONS = [
  'onememory is persistent memory for AI coding agents.',
  'At session start call memory_project_context once, then work normally.',
  'Before re-deciding or debugging, search memory (kind=decision|failure|skill filters the curated lists).',
  'memory_search returns an ID-index; memory_get fetches full records for chosen IDs.',
  'Store durable facts with evidence via memory_store (outcome new|merged|superseded — never silent).',
  'memory_forget is a recoverable tombstone; memory_delete hard-purges. Secrets are auto-redacted.',
].join(' ');

/**
 * The default 8-tool surface (ADR-0010 §2). Order is the registration order — deterministic
 * (the tools spec recommends deterministic ordering; clients list in registration order).
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  memory_search:
    'Search this project memory and return a compact ID-index: one line per result with id, type, ' +
    'title, one-line summary, relevance and token_estimate — honoring the max_tokens budget. ' +
    'This is the cheap first step: pick interesting ids, then call memory_get for full records ' +
    '(provenance, evidence, temporal window). kind narrows results: "decision", "failure", ' +
    '"skill" (= promoted procedural know-how) or a memory type ("episodic", "semantic", ' +
    '"procedural", "preference"). as_of + temporal_mode="historical" query past states; ' +
    'include=["stale","superseded","archived","disputed"] widens the status filter. ' +
    'entities filters by entity name. Results carry query understanding and warnings.',

  memory_get:
    'Fetch full memory records by id (content, title, summary, type, status, temporal window, ' +
    'importance/confidence, provenance with source + evidence spans + extraction method, ' +
    'entities, tags, access stats). Use for the ids memory_search returned — the search result ' +
    'is only an index. include_history adds the full supersession chain (every revision the fact ' +
    'went through, oldest first); include_audit adds the append-only audit trail ' +
    '(created/status_changed/… rows). Not-found ids return isError with code "not_found".',

  memory_store:
    'Store a durable memory and return {id, outcome: "new"|"merged"|"superseded"} — dedupe is ' +
    'never silent: "merged" means an identical (scope, type, content) memory already existed and ' +
    'NOTHING new was written (its id is returned as existing_id); "superseded" means the memory ' +
    'in the supersedes field was replaced (append-only history; the old record stays queryable). ' +
    'Durable writes require evidence: pass at least one evidence span (what supports this — an ' +
    'excerpt plus optional locator); without provenance the write is rejected (unattributable ' +
    'content is not durable memory). type is the content taxonomy: episodic, semantic, ' +
    'procedural, decision, failure, preference. Content is redacted automatically (secrets are ' +
    'replaced by [REDACTED:*] markers) — never store credentials on purpose.',

  memory_update:
    'Edit a memory, revision-checked: pass expected_revision exactly as read (the record\'s ' +
    'updated_at). Edits are append-mostly — the corrected fact is stored as a NEW revision and ' +
    'the old record is superseded (kept as history, superseded_by points forward), so the result ' +
    'is {id: new id, previous_id, outcome: "superseded", revision: new revision token}. ' +
    'Re-check with a stale revision → isError "revision_conflict" with the current revision. ' +
    'This tool owns valid_from/valid_until transitions of the new revision; content must ' +
    'actually change (edits that leave content identical are rejected: the storage layer has no ' +
    'field-update path yet). Evidence passes fresh provenance for the corrected statement, ' +
    'defaulting to the old record\'s evidence.',

  memory_forget:
    'Soft forget: tombstones the memory (status → archived) — the row stays, the audit trail ' +
    'records who/when/why, and it stays recoverable with recover: true (archived → active, also ' +
    'audited). Unlike memory_delete nothing is ever destroyed: archived rows are excluded from ' +
    'default retrieval but still queryable via memory_search include=["archived"] or ' +
    'temporal_mode="historical". Optionally reason documents why (redacted automatically). ' +
    'Forgetting an already-archived memory → isError "invalid_transition"; a wrong ' +
    'expected_revision (when supplied) → isError "revision_conflict".',

  memory_delete:
    'Hard delete: PERMANENTLY purges the memory row and its vectors — unrecoverable, no ' +
    'history, the opposite of memory_forget (a soft, recoverable tombstone). ' +
    'Requires expected_revision from your last read so a purge can never happen by accident. ' +
    "A 'purged' audit entry survives, so the deletion itself stays on the record; superseded " +
    'memories that pointed here keep their history with the forward link cleared.',

  memory_related:
    'List the memory\'s graph neighbors: full records of memories connected by typed edges ' +
    '(related_to, caused_by, solved_by, supersedes, contradicts, …), each with the relation and ' +
    'direction ("outgoing"/"incoming"). Filter with relations=[…], direction="both" (default)/' +
    '"outgoing"/"incoming", max results (default 10). Edges whose validity window has expired are ' +
    'skipped unless include_expired: true. Use it to walk a decision to what caused it, or a ' +
    'failure to what solved it — after memory_get gave you an anchor id.',

  memory_project_context:
    'Build the compact session-start context for a project: project digest, active decisions, ' +
    'known failures, procedures and preferences — packed line by line under a token budget ' +
    '(default 750, override with budget), sections joined into one ready-to-inject text block. ' +
    'Call ONCE at session start (or when switching projects); per-task lookups should use ' +
    'memory_search. project_id defaults to the server\'s configured project. The result reports ' +
    'used tokens per section plus honest warnings (e.g. digest not built yet).',

  // ---- full11 profile additions (curated lists as dedicated tools) -------------------------

  memory_decisions:
    'List this project\'s accepted decisions, newest first: title, decision, rationale, ' +
    'decided_at and a one-line index entry per decision. Use at session start or before ' +
    're-litigating an architecture choice — the whole point is not to re-decide settled ' +
    'matters. Same data as memory_search kind="decision", as a flat curated list. ' +
    'limit caps entries (default 10).',

  memory_failures:
    'List this project\'s known failures, ranked by recurrence: problem, status ' +
    '(open/mitigated/solved/verified), solution when known, occurrence_count, last_seen_at. ' +
    'Check it when hitting an error — a stored failure usually carries its verified fix. ' +
    'Same data as memory_search kind="failure", as a flat curated list. limit caps entries ' +
    '(default 10).',

  memory_skills:
    'List this project\'s skills: promoted procedural know-how (how to deploy, test, migrate, ' +
    'recurring fixes) — name/description, step content summary, status and usage stats. ' +
    'Same data as memory_search kind="skill". Skills originate from verified procedures and ' +
    'solved failures; generated SKILL.md artifacts are the skillify stage\'s job. ' +
    'limit caps entries (default 10).',
};

/** Tool annotations (MCP advisory metadata; ADR-0010 §5 mandates the destructive hints). */
export interface ToolAnnotationSpec {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export const TOOL_ANNOTATIONS: Readonly<Record<ToolName, ToolAnnotationSpec>> = {
  memory_search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_get: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_store: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_update: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  memory_forget: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  memory_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  memory_related: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_project_context: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_decisions: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_failures: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  memory_skills: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** Human-readable tool titles (client UIs surface these). */
export const TOOL_TITLES: Readonly<Record<ToolName, string>> = {
  memory_search: 'Search memory (ID-index)',
  memory_get: 'Get full memory records',
  memory_store: 'Store a durable memory',
  memory_update: 'Update a memory (revision-checked)',
  memory_delete: 'Hard-delete a memory',
  memory_forget: 'Soft-forget a memory (recoverable)',
  memory_related: 'List related memories (graph)',
  memory_project_context: 'Project session context',
  memory_decisions: 'List accepted decisions',
  memory_failures: 'List known failures',
  memory_skills: 'List skills (promoted procedures)',
};
