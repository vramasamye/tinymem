# Mission 6 report — Claude Code adapter

**Branch:** `mission/6-claude-adapter` (worktree `onemem-m6`, base `8a6a2f3`)
**Scope delivered:** `@onememory/adapter-claude` (`packages/adapters/claude`) — hook-payload →
OnememoryEvent translation, the fail-soft `onemem-claude-hook` binary with SessionStart context
injection, daemon REST delivery, and the pure scaffold builders for `onemem init` (`.mcp.json`,
`.claude/settings.json` hooks, AGENTS.md/MEMORY.md pointer) — plus unit + integration tests,
the package README, and this report. No ADR, root-config, or architecture-doc changes.

**Commits**

| Commit | Summary |
|---|---|
| (first) | `feat(adapter-claude)`: hook translation, fail-soft hook binary, daemon delivery, scaffolds |
| (second) | `test(adapter-claude)`: translation, transcript, git, remember, scaffold, delivery + hook-bin integration |
| (third) | `docs(adapter-claude)`: package README + mission-6 report |

---

## 1. What changed

### `packages/adapters/claude` (new package, `@onememory/adapter-claude`)

Depends on **`@onememory/core` + `zod` only** (rationale in §4.4) — plus dev `@types/bun`. Bin:
`onemem-claude-hook` (`src/bin.ts`). Exports: `.` (full public surface, `src/index.ts`).

| Module | Contents |
|---|---|
| `hook-input.ts` | Tolerant Zod mirror of the **officially documented** hook payload shapes (hooks reference + tools reference, verified 2026-10-03; per-field citations in the module header): the 5 subscribed events, per-tool `tool_input`/`tool_response` schemas (Bash/PowerShell, Edit, Write, NotebookEdit), `parseHookInput` → stable reason codes. All `looseObject` — undocumented extras are ignored, never assumed. |
| `translate.ts` | The pure translation core: `translateHookInput(rawInput, context)` → `{ events, drops }`. Every envelope is minted **complete** (uuidv7 `id`, timestamps, `content_hash`, `redactions: []`) and must pass `validateOnememoryEvent`; unmappable payloads become counted drops with stable reason codes (mapping table §2). Clamps to the core schema maxes (output_digest 2000, error message 2000, context 500, message 20 000, remember 2000). Paths relativized under the project root. |
| `hook-bin.ts` | `runHook(rawInput, options)` — the orchestration, every seam injectable (fetch, git runner, transcript reader, sinks, env, clock). parse → resolve target → (SessionStart: fetch context, emit stdout JSON) → (git enrichment) → (Stop: bounded transcript read, parse, uuid-cursor delta) → translate → deliver → advance cursor **only on success** → stderr diag. Never throws; always exit 0. |
| `bin.ts` | The `onemem-claude-hook` process: stdin → `runHook` → exit 0 always (last-resort catch included). |
| `transcript.ts` | Tolerant JSONL parser (string or text-block content; machine-generated wrappers and tool_result carriers counted as skips, never utterances) + `selectTranscriptDelta` with the uuid cursor, 500-event cap (oldest-first — nothing orphaned), rescans on cursor loss (daemon dedupes). |
| `remember.ts` | `extractRememberUtterance`: start-anchored imperative patterns ("remember that/to…", "don't forget…", "keep in mind…", "make sure you remember…", "always remember…", "for future reference…", "note that…") — conversational "do you remember…?" is rejected. Clause clamped to 2000. |
| `git.ts` | Commit enrichment: `looksLikeGitCommit`, `commitShaFromStdout` (git's `[branch sha]` summary line), `commitStatsFromStdout`, `readGitCommitFacts` — one read-only `git log -1` (execFile, no shell, 2s timeout), trusted only when the enrichment sha agrees with the committed short sha (kills `echo "git commit"` false positives). |
| `discovery.ts` | `.onememory/project.json` + `daemon.json` readers (re-declared strict wire schemas), git-style upward discovery from the hook `cwd`/`CLAUDE_PROJECT_DIR`/process cwd, `ONEMEMORY_PROJECT_ID` / `ONEMEMORY_DAEMON_URL` env overrides, daemon **pid liveness check** (never spend the timeout budget on a dead process), and the adapter state file `adapters/claude.json` (per-session transcript uuid cursors — the only thing the adapter persists). |
| `deliver.ts` | `deliverEvents`: `POST /v1/projects/{id}/events` with `{ events }` (mission-13's REST contract), AbortController-bounded (default 1000ms), fail-soft result with a bounded error (origin + status only — never payload contents). |
| `context.ts` | SessionStart context injection: `fetchSessionContext` (`GET /v1/projects/{id}/context?budget=`, default 750, env `ONEMEMORY_CONTEXT_BUDGET`, server cap honored at 4000, 1500ms), `additionalContextOutput` (the documented `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}` stdout JSON), `capAdditionalContext` (Claude Code's 10 000-char cap, reported honestly). |
| `scaffolds.ts` | Pure builders for `onemem init` (signatures §5): `.mcp.json`, settings.json hooks, AGENTS.md/MEMORY.md pointer block — all schema-validated before return. |
| `diag.ts` | `emitDiag`: one machine-readable stderr JSON line (`{v, ts, component, event?, outcome, reason?, …counts}`) — reasons and counts only, never payload contents. |

### Hook → event mapping (the mission's table)

| Claude Code hook | OnememoryEvent(s) | Payload facts / drop gates |
|---|---|---|
| `SessionStart` (startup/resume/clear/fork) | `session.start` | `started_at`, relativized `cwd`, summary with source. Missing `cwd` → `session_start_missing_cwd`. **`source: compact` → `session_start_compact`** (compaction is not a lifecycle boundary; context injection still runs). |
| `SessionEnd` | `session.end` | `ended_at`, `cwd`, summary with reason. Missing `cwd` → `session_end_missing_cwd`. |
| `PostToolUse` Bash/PowerShell | `terminal.output` | `command`, `exit_code: 0`, `output_digest` (stdout, or stderr only when stdout is empty; clamped 2000), `shell`. `run_in_background: true` → `background_command`; `interrupted: true` → `interrupted_command`; unusable `tool_input` → `missing_command:<tool>`. |
| `PostToolUse` Bash `git commit` | + `git.commit` | Enrichment-gated: summary line present (`commitShaFromStdout`), else `git_commit_without_summary_output`; facts present and sha-agreeing, else `git_commit_facts_unavailable`. Payload: full `sha`, `message` (subject + body), `author_name`, `files` (≤500), optional `stats` from the summary. `terminal.output` for the commit command always flows regardless. |
| `PostToolUse` Edit | `file.changed` | `change: 'modified'`, exact `lines_added`/`lines_removed` from `old_string`/`new_string` (unknown → omitted, not guessed). |
| `PostToolUse` Write | `file.changed` | Documented `{type: "create"}` response → `change: 'created'` + `lines_added` from content; otherwise `modified` with no guessed deltas. |
| `PostToolUse` NotebookEdit | `file.changed` | `change: 'modified'`; path from `notebook_path` **or** `file_path` (the hooks reference names neither — both accepted, neither assumed); neither present → `notebook_edit_missing_path`. |
| `PostToolUse` (other tools) | — | `unmapped_tool:<name>` (counted). The scaffold's matcher keeps these from spawning at all. |
| `PostToolUseFailure` Bash/PowerShell | `terminal.output` + `error.raised` (origin `terminal`) | `exit_code` parsed from the documented `Exit code N` first line (absent → null, honest unknown); `context` = command. |
| `PostToolUseFailure` (other tools) | `error.raised` (origin `tool`) | First meaningful error line; `context` = tool name. `is_interrupt: true` → `interrupted_failure` (an abort is not a project error). |
| `Stop` | `conversation.message` ×n, `explicit.remember` ×n | Transcript delta (uuid cursor): user/assistant utterances with the transcript's own timestamps; imperative remember utterances become `explicit.remember` (one utterance, one authoritative capture). The final assistant text comes from the documented `last_assistant_message` (the sessions reference warns the file is written asynchronously and may lag); a transcript copy equal to it is deduped (`stop_deduped_last_message`) — delivered exactly once. |

Envelope contract: the adapter mints **complete** envelopes — `id` (uuidv7), `occurred_at`,
`ingested_at`, `source { runtime: 'claude-code', adapter_version }`, `scope { project_id?,
session_id?, agent_id: 'claude-code' }`, `payload`, `content_hash`, `redactions: []` — and every
one passes `validateOnememoryEvent` before leaving the package (deviation §4.2).

## 2. The fail-soft contract (what the agent experiences)

- **Exit 0 always** — exit 2 is Claude Code's blocking signal; onememory never emits it.
- Diagnostics: one JSON stderr line per fact (exit-0 stderr goes to the debug log only, never to
  Claude): `no_daemon: start one with onemem serve (or set ONEMEMORY_DAEMON_URL)`,
  `no_project: run onemem init (or set ONEMEMORY_PROJECT_ID)`, `invalid_input:not_an_object`,
  `transcript_unreadable`, `transcript_cursor_lost: rescanning (duplicates are deduped by the
  daemon)`, … Payload contents, transcripts, and secrets never appear in stdout/stderr (asserted by
  tests §6).
- Budgets: 1000ms delivery, 1500ms context, 2s git, 32MB transcript cap, 500 events/delivery
  (the daemon's ingest limit). Single attempt, no retry loop — fail-soft wins over blocking.
- No daemon → nothing delivered, **cursor not advanced** (the delta retries next `Stop`; the
  daemon dedupes exact payload duplicates, so over-delivery is safe where under-delivery loses
  memories).
- State: `.onememory/adapters/claude.json` — per-session transcript uuid cursors **only**.

## 3. Scaffolds: exact API for `onemem init` wiring

```ts
import {
  // .mcp.json (stdio entry for mission-5's onemem-mcp bin)
  buildMcpJson,   // (options?: {
  renderMcpJson,  //   command?: string;              // default 'bun'
                   //   args?: string[];               // default ['${CLAUDE_PROJECT_DIR:-.}/node_modules/@onememory/mcp/src/bin.ts']
                   //   env?: Record<string, string>;  // extra env, wins on key collision
                   //   profile?: 'default8' | 'full11';
                   //   storage?: { mode: 'embedded'; dataDir?: string } | { mode: 'server' };
                   //   projectId?: string;             // → env ONEMEMORY_PROJECT_ID
                   //   agentId?: string;               // default 'claude-code'
                   // }) => { mcpServers: { onememory: { command; args?; env? } } }   (schema-validated)
  // .claude/settings.json hooks
  buildClaudeHooksConfig,    // (options?: { hook?: { command: string; args?: string[] } }) => HooksConfig
  renderClaudeSettingsHooks, // (options?) => string   // default invocation: bun ${CLAUDE_PROJECT_DIR}/node_modules/@onememory/adapter-claude/src/bin.ts
  // AGENTS.md / MEMORY.md pointer (ADR-0010 §7)
  buildMemoryPointerBlock,   // (options?: { projectName?: string }) => string
  mergeMemoryPointerBlock,   // (existing: string, block: string) => string  // idempotent; replaces between MEMORY_POINTER_BEGIN/END
} from '@onememory/adapter-claude';
```

Scaffold decisions (all cite the Claude Code references; details in the module header):
- `.mcp.json`: stdio server under `mcpServers.onememory` (no `type` field for stdio);
  `${CLAUDE_PROJECT_DIR:-.}`-relative paths; storage env passes the URL **by name**
  (`"ONEMEMORY_PG_URL": "${ONEMEMORY_PG_URL}"`) so no URL is ever committed; `CLAUDE_PROJECT_DIR`
  is set explicitly for other hosts that read `.mcp.json`.
- hooks: the five events only; `PostToolUse` matcher `Bash|PowerShell|Edit|Write|NotebookEdit`
  (unmapped tools cost no spawn), `PostToolUseFailure` matcher `*`; **exec form**
  (`command` + `args` — no shell quoting hazards); `SessionEnd` timeout raised to **5 seconds**
  (the field is in seconds; SessionEnd hooks share a 1.5s budget by default).
- pointer block: marker-delimited (`<!-- onemem:begin … -->` … `<!-- onemem:end -->`), states that
  durable project memory lives in onememory, points at `mcp__onememory__*` tools and the
  SessionStart injection, and explicitly says Claude Code's MEMORY.md stays a readable ingest
  source — never a duplicate knowledge base.

Runtime env the hook honors: `ONEMEMORY_PROJECT_ID` (override), `ONEMEMORY_DAEMON_URL`
(override), `ONEMEMORY_CONTEXT_BUDGET` (SessionStart budget, default 750, cap 4000),
`CLAUDE_PROJECT_DIR` (discovery start + fallback).

## 4. Deviations and determinations (with reasons)

1. **The context endpoint is `GET /v1/projects/{id}/context?budget=`** — not POST as the mission
   brief phrased it. Verified against mission-13's `http-backend.ts` and its OpenAPI document;
   `fetchSessionContext` matches the actual surface.
2. **The adapter mints complete envelopes.** The OpenAPI description says drafts omitting
   `id`/`ingested_at`/`content_hash`/`redactions` are "completed from the payload before
   validation", but the runtime path calls `validateOnememoryEvent(raw)` directly, and
   mission-13's runtime tests state id/timestamps/content-hash/redactions are the adapter's job.
   The adapter therefore mints complete envelopes — the doc-vs-code gap is **flagged for the
   coordinator** (either fix the doc text or add server-side completion in `apps/api`; the wire
   stays compatible either way).
3. **`SessionStart source: compact` is dropped** (reason `session_start_compact`). Compaction
   replaces in-window history mid-session — it is not a lifecycle boundary, and a `session.start`
   per compaction would fabricate session churn. Context injection still proceeds (the compacted
   context is exactly when memory is most valuable).
4. **Wire schemas re-declared in `discovery.ts`** (project.json, daemon.json) instead of importing
   `@onememory/config` / `@onemory/api`. The hook spawns on **every matched tool call**; the
   config/api import graphs (yaml, router, composition root) would multiply spawn latency for two
   tiny stable cross-process wire records. Field names there are the contract to update if either
   format evolves (both formats are owned by those packages — flagged as a follow-up).
5. **Transcript format treated as unstable** (it is: the sessions reference explicitly documents
   the JSONL "entry format is internal to Claude Code and changes between versions"). The parser
   recognizes only the long-stable shapes (`type: user|assistant`, string or text-block content),
   counts every skip (`transcript_entry_type:<t>`, `transcript_machine_generated`,
   `transcript_tool_result_entry`, `transcript_no_text_blocks`, `transcript_unparseable_line`, …),
   and cursor selection over-delivers rather than loses on cursor loss (daemon dedupe is the
   safety net).
6. **Over-cap delivery is oldest-first** (the module's own under-delivery-loses-memories rule):
   when a delta exceeds 500 entries the head is delivered and the cursor advances only past what
   was delivered; the remainder arrives on the next `Stop`. (The first implementation kept the
   newest 500 and orphaned the oldest — caught and fixed by the cap test.)
7. **`NotebookEdit`'s path field is not named in the hooks reference** (it is not in the file-tools
   list). Both well-known spellings (`notebook_path`, `file_path`) are accepted; neither is
   assumed; neither → counted drop.
8. **The final assistant message is deduped, not double-counted:** a transcript entry equal to
   `last_assistant_message` is tallied `stop_deduped_last_message` and the event is minted from the
   documented field (hook clock) — the transcript is written asynchronously and may lag, so the
   documented field is the authoritative carrier.
9. **No ADR / root-config changes.** All Claude Code shape facts cite the official docs
   (hooks reference, sessions, MCP, tools reference — verified 2026-10-03 via the live pages).

## 5. Follow-ups (coordinator)

1. **Wire `onemem init`** to the scaffold builders (§3 signatures) and to `runHook`'s contract for
   any doctor diagnostics (state file present, cursor count). The CLI owns file writes; the
   builders are pure.
2. **Fix or implement the draft-completion claim** in mission-13's OpenAPI document (§4.2) — either
   reword the description or complete drafts server-side; the adapter is unaffected either way.
3. **Shared wire-schema package** (project.json / daemon.json): both `@onememory/config` and
   `apps/api` own formats the adapter re-declares. If either gains a field, update
   `discovery.ts` (strict schemas fail loud → visible, not silent).
4. **`onemem doctor`** may want to surface adapter state (`.onememory/adapters/claude.json` —
   per-session cursors) and offer a reset; a stale cursor only costs a deduped rescan.
5. **Delivery retries:** a single bounded attempt per hook (fail-soft wins). If real-world Stop
   drops show up, consider a local spool in `.onememory/adapters/` — deliberately NOT built here
   (no placeholder implementations; the daemon dedupe already makes the next-Stop retry safe).

## 6. Test evidence

`bun test` from the worktree root: **676 pass / 0 fail / 16 skip** (692 tests, 50 files) — the
baseline was 544 pass / 0 fail / 16 skip, so this mission adds **132 tests / 0 regressions**
(the 16 skips are the env-gated Postgres-server leg). `bunx tsc --noEmit -p
packages/adapters/claude` is clean (strict base config + `noUncheckedIndexedAccess`).

| Suite | Tests | Against |
|---|---|---|
| `translate.test.ts` | 46 | the pure translation: every mapping row above with fixtures copied from the official docs' own examples; envelope validation on every event; exact payload shapes; every drop gate (background/interrupted commands, compact, unmapped tools, the three commit gates, notebook path absence); path relativization; exact line deltas; remember-utterance split; timestamp fallback; tolerance (unknown events, non-object input, unknown fields, unscoped events) |
| `hook-bin.test.ts` | 19 | the REAL bin spawned as Claude Code spawns it, against a fake daemon (Bun.serve) + real temp projects: delivery e2e, discovery from a nested cwd, dead-pid lock → `no_daemon`, env overrides, no project → `no_project`, unreachable daemon → failed + exit 0, **no-secret-leak** (payload secret delivered to the daemon but absent from stdout/stderr), SessionStart `additionalContext` JSON + `?budget=` (default 750, env 900), context failure still delivers `session.start`, compact, Stop deltas + cursor advance, appended-delta second Stop, failed delivery leaves the cursor untouched, unparseable/empty stdin, unhandled event |
| `delivery.test.ts` | 8 | fake HTTP server: documented body/outcome contract, non-2xx fail-soft, bounded timeout, dead port, context budget query, context failure-as-result, `contextBudgetFromEnv` |
| `transcript.test.ts` | 13 | tolerant parse (string/block content, machine wrappers, tool_result carriers, unknown types, garbage lines), delta selection (cursor, rescan, cap oldest-first, skipped-only advance) |
| `remember.test.ts` | 19 | 10 imperative positives, multi-line, 6 conversational negatives, envelope validation, 2000 clamp |
| `git.test.ts` | 12 | detection, summary-line sha extraction (and rejections), stats parsing (singular/absent halves), enrichment via injected runner (subject-only, subject+body, sha cross-check, runner failure, malformed output, 500-file cap) |
| `scaffolds.test.ts` | 15 | `.mcp.json` (defaults, server-mode URL-by-name, profile/agent/data-dir overrides, render parses), hooks config (exactly 5 events, matchers, exec form, SessionEnd timeout 5s, custom invocation, render parses), pointer block (content, empty/existing/idempotent/stale-replacement merges), `additionalContext` contract (exact shape, 10 000 cap) |

Secrets: the no-secret-leak tests assert that a payload-borne secret and a transcript-borne
credential reach the daemon (the redaction boundary) but appear in **no** stdout/stderr output,
and that the state file holds uuids only.
