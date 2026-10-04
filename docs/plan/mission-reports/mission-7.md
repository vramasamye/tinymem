# Mission 7 report — Codex adapter

**Branch:** `mission/7-codex-adapter` (worktree `onemem-m7`, base `8a6a2f3`)
**Scope delivered:** `@onememory/adapter-codex` (bin `onemem-codex-capture`) — the OpenAI Codex
CLI adapter of ADR-0010 §6: live hook capture into validated `OnememoryEvent` envelopes,
SessionStart context injection, rollout backfill, the `[mcp_servers.onememory]` config.toml
block, the hooks.json capture handlers, the AGENTS.md pointer block, all idempotent, plus unit +
integration tests and this report. No ADR, root-config, or architecture-doc changes; no Claude
adapter or `apps/cli` files touched (the init wiring is a seam, §6).

**Commits**

| Commit | Summary |
|---|---|
| `e414d8b` | `feat(adapter-codex)`: adapter package — capture, injection, scaffolds, testing world |
| `2002aa8` | `test(adapter-codex)`: 124 tests — wire fixtures, translation, idempotent patches, fake-daemon delivery, redaction firewall, bin contract |
| (this) | `docs`: mission-7 report |

---

## 1. What changed

### `packages/adapters/codex` (new package)

Dependencies: `@onememory/core` (schemas + `validateOnememoryEvent`), `@onememory/security`
(`redactEvent`, `isEventPathExcluded` — the documented adapter contract), `@onememory/config`
(project discovery), `smol-toml` (test-only TOML round-trip verification, §5), `zod`. Exports
`.` and `./testing`. Bin: `onemem-codex-capture`. No SQL (rule 5), no engine internals — the
package deliberately does **not** import `@onememory/api/runtime`; it speaks the daemon's
public REST API and reads the documented `daemon.json` v1 lock directly.

| Module | Contents |
|---|---|
| `codex-wire.ts` | Zod mirrors of the **generated** hook input schemas published in the Codex repo (`codex-rs/hooks/schema/generated/*.command.input.schema.json`): SessionStart (with the schema-required `model`), SessionEnd (`reason: "other"`), UserPromptSubmit/PostToolUse (turn-scoped: `turn_id` required), Stop. Loose objects — unknown fields pass through so Codex can add fields without breaking capture. Also the Bash response header regexes (`Process exited with code N` / `Process running with session ID <pid>`, from `ExecCommandToolOutput::response_header`) and the SessionStart output shape. |
| `apply-patch.ts` | `parseApplyPatch` — the verified directive set (`Add/Delete/Update File`, `Move to` → rename). Only directives are parsed; hunk bodies are ignored (paths and change kinds are the memory-relevant part). `null` for non-patch text. Bounded at 200 changes. |
| `event-builder.ts` | `buildEvent` — canonical envelope construction; **throws `EventValidationError` when core validation fails, callers convert that into a counted drop** (never emit what the engine would dead-letter). `clampDigest` (head+tail with a budgeted elision marker — the marker counts against the cap). `DropCounter`. |
| `translate-hooks.ts` | Hook payload → events (§2 table). `session_id` from every hook input becomes `scope.session_id`. Leading "remember/note/don't forget …" prompts → one `explicit.remember` (not also a message — no near-duplicate candidates). Non-zero Bash exits emit the `terminal.output` + `error.raised` pair. Everything unmappable → counted drop. |
| `translate-rollout.ts` | Rollout JSONL → events (backfill): `session_meta` → `session.start` (line timestamps become `occurred_at`), message/function_call/function_call_output mapping, shell pairing with exit codes, apply_patch → `file.changed`. Mirrors Codex's own memory-pipeline record selection: skips `event_msg`, `turn_context`, reasoning, harness-injected context (`<ENVIRONMENT_CONTEXT>` etc.), and our own memory-tool calls. Bounded: 20k lines / 25 MiB. |
| `delivery.ts` | `discoverCaptureTarget` (env `ONEMEMORY_DAEMON_URL`+`ONEMEMORY_PROJECT_ID` override → else nearest `.onememory/` via config loader: `project.json` id + `daemon.json` URL, with pid liveness check → stale lock). `deliverEvents`: `POST /v1/projects/{id}/events` in batches ≤ 500, 2.5s bounded timeout, Zod-validated `IngestResponse`. `fetchSessionContext`: `GET /v1/projects/{id}/context` (§4 deviation 1). Eight fail-soft codes, none of them throws. |
| `capture.ts` | The pipeline: translate → `isEventPathExcluded` → `redactEvent` → deliver. Redaction failure is a **drop**, never an unredacted send. `buildSessionStartOutput` (context injection, clamped under Codex's ~2,500-token spill threshold). `deliveryDiagnostic`/`deliverySummary` (value-free: never echo event content into diagnostics). |
| `config-scaffold.ts` | `renderCodexMcpServerToml` — the verified stdio fields (`command`, `args`, `env`, `env_vars` forwarding `ONEMEMORY_PG_URL`/`ONEMEMORY_DATA_DIR`, `cwd`, `startup_timeout_sec = 20` for cold PGlite boots) + per-tool `output_token_limit` documented as a commented example (onememory results are already budgeted server-side). `patchCodexConfigToml` — text-splice idempotent (never parse→stringify): marker-fenced block replaced in place; a hand-added unmarked `[mcp_servers.onememory]` section is replaced in place so two onememory tables can never accumulate; comments byte-preserved. |
| `hooks-scaffold.ts` | `buildCodexHooksFile` — one capture command for five events: SessionStart sync (injects context; the bin bounds its own work to 2.5s under the 10s ceiling), UserPromptSubmit/PostToolUse(`^Bash$`, `^(apply_patch\|Edit\|Write)$`)/Stop async (never block the agent; ≤8 concurrent background hooks), SessionEnd sync at Codex's 3s max. `patchCodexHooksJson` — merge that replaces our own entries and preserves everything else; unparseable file → error + left untouched. |
| `agents-md.ts` | `renderOnememoryAgentsBlock` — ~0.7 KiB pointer (tool flow: `memory_search` → `memory_get`, `memory_store`, `memory_project_context` note, "remember that …" is captured automatically, "do not maintain a duplicate knowledge base"). Comment-fenced, project-id-tagged; `patchAgentsMd` is idempotent and refuses to touch a file with an orphaned marker (no blind clobbering). |
| `scaffold.ts` | `scaffoldCodex` — the init seam (§3). Project scope writes `.codex/config.toml`, `.codex/hooks.json`, `AGENTS.md`; user scope writes the same three under `$CODEX_HOME`. Returns per-file actions + operator warnings (trust review, `AGENTS.override.md`, unparseable files). `dryRun` returns exact bytes without touching disk. |
| `bin.ts` | `onemem-codex-capture`: stdin hook mode (SessionStart prints **only** the hook output JSON on stdout — that is the only stdout this bin ever produces), `--rollout <file>` backfill, `--project/--cwd/--context-budget/--timeout` flags. Exit 0 for every capture outcome (fail-soft), exit 2 for operator errors only. |
| `testing.ts` | `@onememory/adapter-codex/testing`: verified-shape fixtures (all six hook inputs, `bashToolResponse` with the real header shape, a 16-record golden rollout incl. harness context/own-tool/noise lines, a noise rollout) + the test world: `writeOnememoryProject` (real `onememory.yaml` template + `project.json` + `daemon.json` v1 lock), `writeProjectWithoutDaemon`, `writeConfigWithoutProject`, `startFakeDaemon` — a loopback `node:http` fake of the daemon REST surface (ingest with content-hash duplicate detection, context, health; runs identically under Bun and Node LTS). |

### Capture → event mapping (the honest table)

| Codex signal | Onememory kind(s) | Notes |
|---|---|---|
| SessionStart | `session.start` + context injection | `source` recorded in the summary; `scope.session_id` from `session_id` |
| SessionEnd | `session.end` | fires on close/archive/delete/30-min idle |
| UserPromptSubmit | `conversation.message` (user) or `explicit.remember` | leading directive → `explicit.remember` only (one event, not two) |
| Stop | `conversation.message` (assistant) | from `last_assistant_message`; no message → counted drop |
| PostToolUse `Bash` | `terminal.output` (+ `error.raised` when exit ≠ 0) | exit code parsed from the verified header; PTY sessions → `exit_code: null`, no error |
| PostToolUse `apply_patch`/`Edit`/`Write` | `file.changed` × directives | `Move to` → `renamed` with `old_path`; content never stored |
| Rollout backfill | any of the above | manual-only (transcript format is documented as unstable) |
| anything else | — (counted drop) | unmapped tool names, non-patch payloads, unsupported events |

---

## 2. The scaffold — `onemem init` seam (M13/M14 wiring)

```ts
import { scaffoldCodex } from '@onememory/adapter-codex';

const result = scaffoldCodex({
  scope: 'project' | 'user',
  root: projectRoot,            // project scope: the repo root; user scope: $CODEX_HOME
  projectId: '<uuidv7>',
  // optional: mcpCommand, args, cwd, dataDir, profile ('default8' | 'full11'),
  //           agentId, startupTimeoutSec, captureCommand,
  //           includeSessionStart, includeCapture, captureTimeoutSec, dryRun,
});
// result: { files: [{ path, action: 'created'|'patched'|'unchanged'|'skipped', content }],
//           warnings: string[] }
```

Never throws; a per-project idempotent no-op on re-run (`unchanged` × 3). The CLI call site is
one `scaffoldCodex(...)` after project registration + daemon start, surfacing `warnings[]` in
the init output. `dryRun` powers a future `onemem init --dry-run` for free.

Other public exports: `captureHook`, `captureRollout`, `buildSessionStartOutput`,
`translateCodexHook`, `translateRolloutSession`, `patchCodexConfigToml`,
`renderCodexMcpServerToml`, `patchCodexHooksJson`, `buildCodexHooksFile`, `patchAgentsMd`,
`renderOnememoryAgentsBlock`, `hasOnememoryAgentsBlock`, `parseApplyPatch`, `buildEvent`,
`clampDigest`, `discoverCaptureTarget`, `deliverEvents`, `fetchSessionContext`,
`deliveryDiagnostic`, `deliverySummary`.

---

## 3. Verified primary sources (no field was invented)

- **Hook wire format**: the generated JSON schemas in the Codex repo + the Hooks doc
  (developers.openai.com/codex/hooks): common input fields (`session_id`, `transcript_path`,
  `cwd`, `hook_event_name`, `model`, `turn_id`, `permission_mode`), per-event fields, matcher
  regex semantics, tool coverage (shell/unified-exec match as `Bash`; `apply_patch` matches
  `apply_patch|Edit|Write`), `additionalContextLimit` default ~2,500 tokens with disk spill,
  `async` handlers (≤8 concurrent), **SessionEnd always synchronous, ≤3s**, trust review via
  `/hooks`.
- **Hooks are enabled by default** — `features.hooks = false` is how you turn them *off*
  (docs, verified 2026-10-03). The scaffold therefore does not need to touch any feature flag.
- **Bash tool response header**: `codex-rs/core/src/tools/context.rs`
  (`ExecCommandToolOutput::response_header`) — `Process exited with code N` /
  `Process running with session ID <pid>`.
- **apply_patch**: directive grammar from `codex-rs/apply-patch`; `PostToolUse` fires for
  apply_patch with `tool_input.command` since **Codex 0.123.0**
  (openai/codex#16732) — that is the adapter's version floor for file capture.
- **Rollout JSONL**: line shape `{timestamp, ordinal?, type, payload}` and the
  `session_meta` / `response_item` payloads from `codex-rs/protocol` + `codex-rs/history`
  (Record: `rollout_payload.rs`; ResponseItem/ContentItem: `models.rs`).
- **MCP config.toml fields**: stdio `command`/`args`/`env`/`env_vars`/`cwd`/`startup_timeout_sec`
  (default 10s; we emit 20 for cold PGlite boots) + per-tool `tools.<t>.output_token_limit`
  (with the documented 20% serialization allowance).
- **AGENTS.md**: global `~/.codex/AGENTS.md` + root→cwd project discovery, `AGENTS.override.md`
  precedence (warned about in scaffold output), 32 KiB cap (the generated block is ~0.7 KiB).
- **Memories**: verified against the current config reference — see deviation 2.

## 4. Deviations from the mission memo (with evidence)

1. **Session context endpoint is `GET /v1/projects/{id}/context`, not `POST`.** The mission
   memo said POST; as-built (mission-13, `apps/api/src/server/app.ts`) it is a GET with query
   params (`session_id`, `budget`). The adapter uses the as-built GET.
2. **`memories.disable_on_external_context` defaults to `false`** — the current config
   reference says: "When `true`, threads that use external context such as MCP tool calls, web
   search, or tool search are kept out of memory generation. Defaults to `false`."
   `docs/research/mcp-memory-implementations.md` claimed true-by-default. The README documents
   the verified default and the opt-in snippet; the adapter never writes that flag (a user's
   native-memories configuration is theirs). Also verified: native memories are off by default
   (`features.memories`), `memories.generate_memories`/`memories.use_memories` default `true`.
   Semantic note: the flag governs **memory generation inputs** (whether a thread is summarized
   by Codex), not injection — recorded precisely in the README's division-of-labor section.
3. **No blessed TOML library existed in `docs/research/dependency-verification.md`** — see §5
   for the selection this mission made (test-scope only).
4. **`bun.lock` changed** (+21 lines: the workspace entry + `smol-toml@1.9.0` with integrity
   hash). `bun.lock` is not on the coordinating-session-owned list, and it is the mechanical
   consequence of adding a dependency; flagged here for the merge.

## 5. Dependency: smol-toml (why, and why test-only)

Rule 2 (reuse before building) requires a real library for TOML *parse verification*; the
research doc had none vetted. Selected **smol-toml 1.9.0**: BSD-3-Clause, zero runtime
dependencies (verified against the published tarball/lockfile), actively maintained, spec-sized
(no `@iarna/toml` staleness, no `toml` package's date/dependency weight). Scope kept narrow on
purpose: **production code renders and patches TOML as text** (comment-preserving, idempotent —
a parse→stringify round-trip would destroy user comments), and smol-toml is used by the test
suite to prove every generated artifact parses and patches stay valid. It is listed under
`dependencies` because the scaffold's parse-validation seam is exportable, but no production
module currently imports it — the coordinator may want to keep or demote it to
`devDependencies` at merge (flagged in §7).

## 6. Follow-ups (coordinator / sibling missions)

- **M14 (init wiring):** call `scaffoldCodex({ scope, root, projectId, profile, dataDir? })`
  after `onemem init` registers the project; surface `warnings[]` (trust prompts, `/hooks`
  review, `AGENTS.override.md`) in the init output — they are Codex-mandated review steps the
  adapter must not bypass.
- **`onemem doctor`:** could report capture health (last delivery outcome per hook bin is on
  stderr; a structured "delivery ledger" would need a small daemon-side counters endpoint).
- **Adapter parity:** the Claude Code adapter (M6) should mirror the AGENTS.md pointer and
  the MCP env contract so both runtimes share one `.onememory` project cleanly.
- ~~**Research doc correction:** update
  `docs/research/mcp-memory-implementations.md` re: `disable_on_external_context` default~~
  ✅ Resolved (coordinator, 2026-10-04): section B.2, the per-runtime matrix, and open question 3
  now state the verified `false` default, and ADR-0010 §7's claim was corrected with the
  daemon-backed MCP amendment.
- **Optional:** a `POST /v1/projects/{id}/events` bulk-mode flag for backfills larger than
  the 500-batch cap is unnecessary today (the adapter batches), noted only if backfill volumes
  grow.

## 7. Test evidence

- `bun test packages/adapters/codex` — **124 pass / 0 fail** (10 files: apply-patch,
  agents-md, bin, capture, config-scaffold, delivery, hooks-scaffold, scaffold,
  translate-hooks, translate-rollout).
- Full worktree `bun test` — **668 pass / 0 fail / 16 skip** (684 tests, 53 files; baseline
  before this mission: 544 pass / 0 fail / 16 skip — no regressions, +124 tests).
- `tsc --noEmit` clean for `packages/adapters/codex` and all 12 workspace projects/apps.
- Highlights: every translated event asserted against `validateOnememoryEvent`; smol-toml
  round-trip parse of every generated artifact; byte-idempotent re-patching (config.toml,
  hooks.json, AGENTS.md) with user comments/foreign hooks preserved; delivery tested against a
  real loopback HTTP daemon (happy path, 500-batch cap, timeout, HTTP 500, unparseable body,
  schema-violating body, stale lock, no-daemon, env override vs filesystem discovery); the
  redaction firewall (a `sk-ant-…` credential never reaches the wire; excluded paths never
  sent; already-redacted text is a fixpoint); bin exit-code contract (0 for every capture
  outcome, 2 for operator errors, stdout reserved for SessionStart output).
