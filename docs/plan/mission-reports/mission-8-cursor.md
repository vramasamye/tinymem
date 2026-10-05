# Mission 8 report — Cursor adapter

**Branch:** `mission/8-cursor` (worktree `onememory-m8`, base `main` @ `91d2b89`)
**Scope delivered:** `@onememory/adapter-cursor` (bin `onemem-cursor-hook`) — the Cursor adapter of
ADR-0010 §6: Cursor-native hook capture into validated `OnememoryEvent` envelopes
(`source.runtime: 'cursor'`), SessionStart context injection, the `.cursor/mcp.json`
`mcpServers.onememory` block, the `.cursor/hooks.json` capture handlers, the
`.cursor/rules/onememory.mdc` pointer rule — all idempotent — plus the `--with-cursor` init wiring,
the `runtime-cursor` doctor check, the cross-adapter conformance suite (M8 acceptance 5 / backlog
M5.4) and this report. No ADR, root-config, or architecture-doc changes; no Claude or Codex
adapter source touched (their packages are other missions' lanes — the conformance suite reads
them through their public exports only).

**Commits**

| Commit | Summary |
|---|---|
| `c7a7ce8` | `feat(adapter-cursor)`: adapter package — capture, injection, scaffolds, `--with-cursor` wiring, doctor check, cross-adapter conformance |
| (this) | `docs`: mission-8 report |

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | New `packages/adapters/cursor` package, TypeScript strict, Zod-validated config | **delivered** | `packages/adapters/cursor` (23 files, 3,151 lines, `tsc --noEmit` clean); every external shape — hook input, scaffold document, hook output, REST response — has a Zod schema; no `any` at any boundary |
| 2 | `scaffoldCursor(options)` writes `.cursor/mcp.json` (onememory server block, default 8-tool surface) + canonical Cursor rules path; idempotent, marker-fenced, `ScaffoldedFile[]` with `created\|patched\|unchanged\|skipped` | **delivered** | `src/scaffold.ts` returns `ScaffoldedFile[]` with exactly those actions; `src/mcp-scaffold.ts` / `src/rules.ts` / `src/hooks-scaffold.ts` are the pure renderers + idempotent patchers. The daemon-http entry carries the URL (the daemon owns the 8-tool default surface, ADR-0010 §2); the stdio entry sets `ONEMEMORY_MCP_PROFILE: default8` |
| 3 | `dryRun: true` returns the exact bytes without touching disk | **delivered** | `scaffoldCursor({ …, dryRun: true })` performs zero filesystem writes and returns the byte-identical content that the real run writes (`renderCursorScaffold` is the pure zero-I/O variant); asserted in `src/scaffolds.test.ts` |
| 4 | Event hook integration (SessionStart→context; Pre/PostToolUse→tool events; Stop/SessionEnd→working-memory sweep; transcript→conversation events), with Cursor's real event sources researched and gaps documented honestly | **delivered, gaps documented** | `src/translate.ts` + `src/hook-bin.ts` + `src/runtime.ts`; §3 below is the honest mapping table and §4 the documented gaps (Cursor's own contract has no exit code on failure, no documented transcript format, fire-and-forget SessionStart) |
| 5 | Conformance test: the same canonical fake events produce the same memory results across Cursor/Claude/Codex | **delivered** | `benchmarks/eval/src/adapter-conformance/cursor.test.ts` (14 tests): one canonical session, per-runtime NATIVE payloads, each adapter's own translation entry point, then the real engine. **Cursor == Claude byte for byte** (events, memories, evidence, working memory, search ranking, `memory_get`); Cursor == Codex except one pre-existing Codex normalization gap (§5.2), pinned by a dedicated test |
| 6 | `onemem doctor` detects Cursor config in a fresh project | **delivered** | `runtime-cursor` check (`apps/api/src/runtime/runtime-scaffolds.ts`); end-to-end in `apps/cli/src/init-wiring.test.ts`: fresh temp project → `init --with-cursor` → `doctor` reports `pass` with the daemon URL, and a changed port flips it to `warn` with the fix |
| 7 | Mission report with AC status, exact test counts, the config-format citation, honest limitations | **delivered** | this document (counts §6, citations §2, limitations §4) |

## 2. Config format citation (research, all fetched 2026-10-05)

- **MCP:** <https://cursor.com/docs/mcp> — project config at `<project>/.cursor/mcp.json`, global at
  `~/.cursor/mcp.json`; shape `{"mcpServers": {"<name>": <entry>}}`; stdio entry
  `{type: "stdio", command, args?, env?, envFile?}` (the field table marks `type` required for
  stdio, though the page's own examples omit it — we emit it, the stricter reading); remote entry
  `{url, headers?}` with no `type`; interpolation `${env:NAME}`, `${workspaceFolder}`,
  `${userHome}`, `${workspaceFolderBasename}`, `${pathSeparator}`.
- **Hooks:** <https://cursor.com/docs/hooks> — `.cursor/hooks.json`, `{"version": 1, "hooks":
  {"<event>": [{"command", "matcher"?, "timeout"?}]}}`; **project hooks run from the project
  root** (so the scaffolded command is the relative `bun
  node_modules/@onememory/adapter-cursor/src/bin.ts`); env vars `CURSOR_PROJECT_DIR`,
  `CURSOR_TRANSCRIPT_PATH`; `sessionStart` may return `{"additional_context": …}` but Cursor runs
  it **fire-and-forget** ("the agent loop does not wait for or enforce a blocking response");
  MCP tools require approval.
- **Rules:** <https://cursor.com/docs/rules> — `.cursor/rules/*.mdc` with frontmatter
  (`description`, `globs`, `alwaysApply`); a plain `.md` in `.cursor/rules` is ignored, and only
  `alwaysApply: true` (or a matching glob) applies a rule without an @-mention — hence the
  scaffolded pointer rule is `alwaysApply: true`.

## 3. Capture → event mapping (the honest table)

| Cursor signal | Onememory kind(s) | Notes |
|---|---|---|
| `sessionStart` | `session.start` + context injection | outputs `{"additional_context": …}`; best-effort by Cursor's design (fire-and-forget) |
| `sessionEnd` | `session.end` | the daemon's working-memory sweep trigger |
| `beforeSubmitPrompt` | `conversation.message` (user) or `explicit.remember` | imperative "remember …" → one `explicit.remember` (one utterance, one capture) |
| `afterAgentResponse` | `conversation.message` (assistant) | the final assistant text |
| `postToolUse` (matcher `Shell`) | `terminal.output` | exit code from the documented JSON-stringified `tool_output` |
| `postToolUseFailure` | `error.raised` (+ `terminal.output` for Shell) | `origin: 'terminal'` for Shell, `'tool'` otherwise |
| `afterFileEdit` | `file.changed` | exact line deltas from `old_string`/`new_string`; content never stored |
| `stop` | — (not subscribed) | per-turn loop end (`{status, loop_count}`): no transcript, no lifecycle semantics; the sweep rides `sessionEnd` |
| `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `afterShellExecution` | — (not subscribed) | permission hooks (onememory has no permission opinion); `postToolUse` already carries the Shell execution (subscribing both would double-report) |
| anything else | — (counted drop) | unmapped tools/events, with the reason kept value-free |

## 4. Honest limitations (Cursor's contract, not our bugs)

1. **No exit code for a failed command.** `postToolUseFailure` carries `error_message` +
   `failure_type`; neither it nor `afterShellExecution` carries an exit code, so the failure's
   `terminal.output` has `exit_code: null` (a successful Shell execution does carry `exitCode`
   inside `tool_output`). Failure **detection** is unaffected: Cursor still emits `error.raised`,
   which is what the extractor reads first — pinned by a conformance test (Claude/Codex `1`,
   Cursor `null`).
2. **No transcript parsing.** Cursor exposes `transcript_path` / `CURSOR_TRANSCRIPT_PATH`, but the
   transcript file format is undocumented. Parsing it would fabricate provenance, so conversation
   capture is limited to `beforeSubmitPrompt` (user) and `afterAgentResponse` (assistant).
   Claude's per-turn transcript deltas have no Cursor equivalent — a counted capability gap, not
   a silent one.
3. **Context injection is fire-and-forget.** Cursor documents `additional_context` but does not
   wait for or enforce it; the hook bounds its own work (1,500 ms fetch + 1,000 ms delivery).
4. **No documented size cap on `additional_context`.** The adapter applies its own
   10,000-character ceiling (matching the Claude adapter's documented cap), with an honest stderr
   note when it triggers.

## 5. Conformance — what "same results" means here

The suite (`benchmarks/eval/src/adapter-conformance/`) renders ONE canonical session (10 facts:
session start, user question, two successful runs of one command, an `afterFileEdit` change, a
failed command later resolved by the re-run, an explicit "remember that …", two assistant
answers, session end) into each runtime's **native hook vocabulary** (`SessionStart`/`PostToolUse`/
`PostToolUseFailure`/`Stop` for Claude; `SessionStart`/`UserPromptSubmit`/`Stop`/`PostToolUse` for
Codex; `sessionStart`/`beforeSubmitPrompt`/`afterAgentResponse`/`postToolUse`/`afterFileEdit`/
`postToolUseFailure`/`sessionEnd` for Cursor). Each adapter's own translation entry point produces
the events; those go through the REAL engine — PGlite storage + migrations, the real
`ingestEvent` + extract job over the heuristic extractor, the real retrieval engine — and the
results are compared.

1. **Cursor == Claude, byte for byte:** event kinds and payload projections for every canonical
   fact; the three memories (the resolved failure at importance 0.85, the recurring command at
   0.7, the explicit remember at 0.9) with identical content/status/importance/confidence/
   valid_from; identical evidence (by canonical fact: the failure cites the failing command and
   the resolving re-run, the command cites both successful runs, the remember cites the
   utterance); identical working-memory row (`current_file` → the edited path); identical
   extraction counts (11 events → 3 memories, 1 working row, 0 duplicates); identical
   `memory.search` ranking and identical `memory_get` payload.
2. **Cursor == Codex, except one pre-existing divergence, pinned:** Codex keeps the
   `explicit.remember` clause's trailing sentence period; Claude and Cursor strip it (Claude's
   `extractRememberUtterance` semantics, which Cursor deliberately shares — see `src/remember.ts`).
   The divergence is asserted by name so it cannot grow silently; fixing it is a Codex-package
   change (another mission's lane) and is recorded as a follow-up.

**Does Cursor pass conformance today? Yes** — against the Claude adapter exactly, and against
Codex modulo the single, documented, pre-existing Codex normalization difference above.

## 6. Validation (exact commands and counts)

| Command | Result |
|---|---|
| `bun test packages/adapters/cursor` | **54 pass, 0 fail** (201 `expect()` calls, 4 files, 82 ms) |
| `bun run typecheck` in `packages/adapters/cursor`, `apps/api`, `apps/cli`, `benchmarks/eval` | **all clean** (`tsc --noEmit`, no output) |
| `bun test apps/cli benchmarks/eval` | **104 pass, 0 fail** (414 `expect()` calls, 9 files, 30.5 s — includes the 14 conformance tests) |
| `bun test --timeout=15000 --reporter=dots` (full repo) | **1319 pass, 22 skip, 0 fail** (1341 tests, 107 files, 287.9 s) |

The one test failure surfaced during the full run was `apps/api/src/runtime/doctor-codememory.test.ts`
asserting `summary.info === 2` — a stale two-runtime pin this mission's third runtime legitimately
changed to 3; the assertion was made runtime-agnostic (no check outside the runtimes group is
informational; the info count equals the runtimes group's info entries) and it passes.

## 7. Files

**New** — `packages/adapters/cursor/` (`package.json`, `tsconfig.json`, `README.md`,
`src/{version,hook-input,remember,translate,mcp-scaffold,hooks-scaffold,rules,scaffold,scaffold-inspect,runtime,hook-bin,bin,index}.ts`
+ 4 test files), `benchmarks/eval/src/adapter-conformance/{scenario,pipeline}.ts` +
`cursor.test.ts`.

**Modified** — `apps/cli/src/{bin.ts,commands/init.ts,commands/wire-runtimes.ts,init-wiring.test.ts}`,
`apps/api/src/runtime/{runtime-scaffolds.ts,runtime-scaffolds.test.ts,runtime.test.ts,doctor-codememory.test.ts}`,
`apps/cli/package.json`, `apps/api/package.json`, `benchmarks/eval/package.json` (workspace dep),
`bun.lock` (after `bun install` — the worktree had no `node_modules`).

## 8. Deviations from the task sheet (both forced by the repo's real layout)

1. **The owned file lane `apps/cli/src/init/integrations/cursor.ts` does not exist in this repo.**
   The real init-wiring seam (found by reading how Claude and Codex were landed) is
   `apps/cli/src/commands/wire-runtimes.ts` (+ `init.ts`, `bin.ts`) and the doctor check group
   `apps/api/src/runtime/runtime-scaffolds.ts`. The Cursor wiring was added exactly there,
   following the established seam instead of inventing a parallel one.
2. **No `apps/cli/src/init/__fixtures__/` sandbox was created.** AC6 is covered more strongly by
   the end-to-end CLI test (`init --with-cursor` in a fresh temp project → `doctor` `pass` with
   the daemon URL → port change → `warn` with the fix → re-run re-wires), which exercises the
   real binary rather than a fixture copied next to the source.

## 9. Follow-ups (for the coordinator)

1. **Hoist the remember-clause extractor into a shared adapter kit.** `packages/adapters/cursor/src/remember.ts`
   is a byte-identical deliberate duplicate of Claude's (adapters may not import sibling
   adapters; a shared package is a coordinator-level lane). Keeping them identical is what the
   conformance suite asserts, but the duplication is debt.
2. **Codex: strip the `explicit.remember` clause's trailing sentence punctuation** to match the
   Claude/Cursor normalization (§5.2) — a one-line change in the Codex adapter, owned by that
   mission's lane; the conformance test already pins the divergence and will go green
   automatically when it is fixed.
3. **Cursor exit codes:** if Cursor's `postToolUseFailure` ever documents an exit code (or
   `afterShellExecution` becomes subscribable without double-reporting), map it into
   `terminal.output.exit_code`; until then the gap is pinned by a test, not silently dropped.
4. **Transcript backfill:** when Cursor documents the `transcript_path` file format, add a
   `--transcript` backfill mode mirroring the Codex rollout backfill; parsing an undocumented
   format would fabricate provenance (rule 8).
5. **Vector-channel conformance:** the suite runs with no embedding provider configured (the
   engine reports "lexical + graph only"), so the ranking comparison covers the lexical channel.
   Add a vector-channel variant when an offline embedder lands behind the model router.
6. **`AGENTS.md`-style global wiring:** Cursor also reads `AGENTS.md`; a user-scope
   (global) scaffold (`~/.cursor`) is not yet emitted — `scaffoldCursor` is project-scope only,
   like the Claude and Codex seams at this phase.
