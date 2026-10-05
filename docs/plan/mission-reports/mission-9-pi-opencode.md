# Mission 9 report — Pi + OpenCode adapters

**Branch:** `mission/9-pi-opencode` (worktree `onememory-m9`, base `main` @ `91d2b89`)
**Scope delivered:** `@onememory/adapter-pi` (bin-less extension adapter) and
`@onememory/adapter-opencode` (in-process plugin adapter) — the Pi and OpenCode arms of ADR-0010
§6: runtime-native capture into validated `OnememoryEvent` envelopes (`source.runtime: 'pi'` /
`'opencode'`), session context injection, the daemon-backed MCP entries, the generated pointer
files — all idempotent — plus the `--with-pi` / `--with-opencode` init wiring, the `runtime-pi` /
`runtime-opencode` doctor checks, the conformance suite extended to five runtimes, and this
report. The Pi adapter package itself was built and landed earlier on this branch; this mission
resumed at the secret-scanner blocker (a fake Anthropic-key literal in its capture test), then
built OpenCode, fixed a real Pi line-count divergence found by the conformance run, and wired
both runtimes end to end. No ADR, root-config, or architecture-doc changes; no Claude/Codex
adapter source touched (their packages are other missions' lanes — the conformance suite reads
them through their public exports only).

**Commits**

| Commit | Summary |
|---|---|
| `a80d345` | `feat(adapter-pi)`: the Pi extension adapter (translate, capture firewall, injection, scaffolds) — landed with the runtime-assembled fake-key fix that unblocked Droid-Shield |
| `9287b41` | `fix(adapter-pi)`: strip one trailing newline in edit line counts (based on a wrong premise — superseded by `5eec52e`; net effect is a corrected comment) |
| `df58963` | `feat(adapter-opencode)`: the OpenCode plugin adapter (wire mirrors, translate, capture firewall, injection, plugin, scaffolds) |
| `ee637d8` | `test(conformance)`: the conformance suite extended to five runtimes (cursor package + harness vendored byte-identical from main; pi + opencode renderers and tests) |
| `d8937ca` | `feat(cli)`: `--with-pi` / `--with-opencode` init wiring + the doctor's runtimes group for all five runtimes |
| `5eec52e` | `fix(adapters)`: align edit line counts with the Claude conformance baseline (revert of the wrong-premise strip; OpenCode given the same math) |
| (this) | `docs`: mission-9 report |

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | The secret-pattern blocker in `packages/adapters/pi/src/capture.test.ts` fixed without weakening the redaction assertion; pi tests stay 96/0 | **delivered** | The complete fake Anthropic key no longer appears in source: `const FAKE_KEY = \`sk-ant-\${'b'.repeat(40)}\`` is assembled at runtime (the same convention as the security package's own fixtures and the codex adapter). The assertion got STRONGER: the sent payload must contain neither `FAKE_KEY` nor any `sk-ant-` substring, and `redactions.length > 0`. Droid-Shield accepted commit `a80d345`; pi suite 96 pass / 0 fail |
| 2 | New `packages/adapters/opencode` package, TypeScript strict, Zod-validated config | **delivered** | `packages/adapters/opencode` (24 files, `tsc --noEmit` clean); every external shape — plugin hook payloads, tool args/metadata, `opencode.json` entries, daemon REST responses — has a Zod schema with its source cited; no `any` at any boundary |
| 3 | Adapter capture/injection per the verified runtime surfaces, gaps documented honestly | **delivered, gaps documented** | `src/translate.ts` (the full mapping table in the header), `src/capture.ts` (the security pipeline), `src/plugin.ts` (the four hooks OpenCode loads); §3/§4 below |
| 4 | `scaffoldOpenCode` writes `opencode.json` + `.opencode/plugins/onememory.ts` + the instructions pointer; idempotent, never clobbers | **delivered** | `src/scaffold.ts` returns `ScaffoldedFile[]` (`created\|patched\|unchanged\|skipped`); `src/scaffolds.ts` holds the pure renderers + idempotent merges. A JSONC (comment) `opencode.json` is reported and left untouched (never rewritten); a foreign plugin file is skipped; an orphaned pointer marker is skipped. `dryRun: true` returns the exact bytes with zero filesystem access (`renderOpenCodeScaffold` is the pure zero-I/O variant) |
| 5 | Both runtimes wired into `onemem init` + `onemem doctor` | **delivered** | `--with-pi` / `--with-opencode` flags (`apps/cli/src/bin.ts`, `commands/init.ts`, `commands/wire-runtimes.ts`); detection `~/.pi`/`.pi` and `~/.config/opencode`/`.opencode`/`opencode.json`; `runtime-pi` / `runtime-opencode` doctor checks (`apps/api/src/runtime/runtime-scaffolds.ts`) — end-to-end through the real CLI in `apps/cli/src/init-wiring.test.ts` (fresh project → wire → doctor `pass` → idempotent re-run → `unchanged` × 3) |
| 6 | Conformance tests for both adapters reusing the M8 harness | **delivered** | `benchmarks/eval/src/adapter-conformance/{pi,opencode}.test.ts` (14 tests each): one canonical session, per-runtime NATIVE payloads, each adapter's own translation entry points, then the REAL engine. **Pi == OpenCode == Claude, byte for byte** on events, memories, evidence, working memory, ranking, and `memory_get`; the two pre-existing divergences (Codex's kept period, Cursor's null exit code) are pinned by named tests; Pi/OpenCode side with the Claude baseline on both (real exit codes, stripped period) |
| 7 | Mission report with AC status, exact test counts, config citations, honest limitations | **delivered** | this document (counts §6, citations §2, limitations §4) |

## 2. Config/contract citations (research, all fetched 2026-10-06)

**Pi** (`@onememory/adapter-pi`, landed earlier on this branch — citations for the record):
- Extensions: <https://pi.dev/docs/latest/extensions> — `pi.on(name, handler)` lifecycle events
  (`session_start`, `session_shutdown`, `before_agent_start`, `message_end`, `tool_result`);
  `pi.sendUserMessage(text, {deliverAs: 'steer'})` for the injection channel.
- MCP: <https://pi.dev/docs/latest/mcp> — `.pi/mcp.json` `{"mcpServers": {…}}`, streamable-HTTP
  `url` entries; project trust required before project-scope config is read.
- Pointer: `APPEND_SYSTEM.md` under `.pi/`; `bash.ts` `structuredContent.exit_code`,
  `edit.ts` `{path, edits[]}`, `write.ts` `{path, content}` (no create/overwrite signal).

**OpenCode** (`@onememory/adapter-opencode`):
- Plugins: <https://opencode.ai/docs/plugins/> — a module "that exports one or more plugin
  functions", each receiving a context (`directory`, `worktree`, `client`, `$`, `project`) and
  returning hooks; **files in `.opencode/plugins/` are automatically loaded at startup** (so the
  generated shim needs no config entry). Hook signatures verified against
  `@opencode-ai/plugin@1.18.34` `dist/index.d.ts`: `event`, `tool.execute.after`, `chat.message`
  ("Called when a new message is received"), `experimental.chat.system.transform`
  (`output: {system: string[]}` — the injection channel).
- Events/parts: `@opencode-ai/sdk@1.18.34` `dist/gen/types.gen.d.ts` — the `Event` union
  (`session.created {info: Session}`, `session.idle {sessionID}`, `message.part.updated
  {part, delta?}`), `TextPart` (`synthetic?`, `ignored?`, `time: {start, end?}` — `end` set when
  streaming completes), `ToolPart` (`state.status: "error"` carries `error`), `UserMessage`.
- Tools (opencode sources): `tool/shell/id.ts` keeps the exposed tool id `"bash"` for
  compatibility; `tool/shell.ts` args `{command, workdir?, timeout?}` and result
  `metadata: {output, exit: number | null, truncated, outputPath?}` — **`exit` is `null` exactly
  for abort/timeout**; `tool/edit.ts` args `{filePath, oldString, newString, replaceAll?}` with
  `metadata.filediff`; `tool/write.ts` args `{filePath, content}` with `metadata.exists` —
  whether the file existed before the write (the create signal Pi cannot report).
- Config: `@opencode-ai/sdk` `Config` + <https://opencode.ai/docs/config/> — `opencode.json`
  `mcp` entries `{type: "remote", url, enabled?, headers?, oauth?, timeout?}` /
  `{type: "local", command: string[], cwd?, environment?, enabled?, timeout?}` (`type` REQUIRED
  on both, unlike Cursor's); `instructions: string[]` (<https://opencode.ai/docs/rules/> — the
  always-applied instruction surface the pointer registers into).
- MCP spawn semantics (load-bearing for the scaffold): opencode `mcp/index.ts` `connectLocal`
  spawns local servers with `env: { ...process.env, ...entry.environment }` — the parent
  environment IS inherited and there is **no `${env:…}` interpolation** for MCP environment
  values (the `${env:}` expander in `tool/shell.ts` applies to bash command strings only). The
  stdio entry therefore emits NO `ONEMEMORY_PG_URL` placeholder — a literal placeholder would
  override the user's real inherited URL — and points embedded storage at the relative
  `.onememory` (the spawn cwd is the OpenCode project directory).

## 3. Capture → event mapping (the honest table)

| Pi signal | Onememory kind(s) | Notes |
|---|---|---|
| `session_start` (any reason) | `session.start` | cwd from the extension context |
| `session_shutdown` (any reason) | `session.end` | the sweep trigger |
| `message_end` role `user` | `conversation.message` / `explicit.remember` | the message timestamp becomes `occurred_at` |
| `message_end` role `assistant` | `conversation.message` (assistant) | |
| `tool_result` bash/powershell ok | `terminal.output` (exit 0) | exit from `structuredContent.exit_code` |
| `tool_result` bash/powershell `isError` | `terminal.output` + `error.raised` (origin terminal) | first meaningful output line |
| `tool_result` bash `git commit` | `git.commit` | enrichment-gated (`git.ts`) |
| `tool_result` edit | `file.changed` (modified) | exact deltas from `edits[]` |
| `tool_result` write | `file.changed` (modified) | no create signal exists → no line deltas |
| `before_agent_start` | — (counted drop) | the injection-only channel; the prompt arrives via `message_end` |
| `tool_result` other tools, ok | — (counted drop) | read/grep/find/ls must not cost events |

| OpenCode signal | Onememory kind(s) | Notes |
|---|---|---|
| `event` `session.created` | `session.start` | cwd from `info.directory`, title in the summary |
| `event` `session.idle` | `session.end` | the quiescence boundary — see gap 1 |
| `chat.message` hook | `conversation.message` (user) / `explicit.remember` | the hook CLAIMS the user message id so the part channel never double-captures the turn |
| `event` text part, `time.end` set, not synthetic | `conversation.message` (assistant) | |
| `event` tool part, `state.status: "error"` | `error.raised` (origin tool) | the failure channel for tools that throw |
| `tool.execute.after` bash, `exit === 0` | `terminal.output` (exit_code 0) | |
| `tool.execute.after` bash, `exit > 0` | `terminal.output` + `error.raised` (origin terminal) | first meaningful output line |
| `tool.execute.after` bash, `exit == null` | `terminal.output` (exit_code `null`) + `error.raised` | "command failed (aborted or timed out)" — never a guessed code |
| `tool.execute.after` edit | `file.changed` (modified) | Claude-baseline line math from `oldString`/`newString` |
| `tool.execute.after` write, `exists === false` | `file.changed` (created, `lines_added`) | the create signal write.ts reports |
| `tool.execute.after` write, `exists === true` | `file.changed` (modified, no deltas) | an overwrite's delta is not derivable — never guessed |
| `tool.execute.after` `*onememory*` | — (counted drop `own_memory_tool`) | our memory-tool traffic is never ingested |
| `tool.execute.after` other tools | — (counted drop) | read/grep/glob; their failures ride the tool-part error state |
| `experimental.chat.system.transform` | (injection, not capture) | sentinel-prefixed context, once per session, fail-soft |

## 4. Honest limitations (the runtimes' contracts, not our bugs)

1. **OpenCode has no session-END signal.** Sessions are long-lived and resumable; the SDK Event
   union has no quit/close. `session.idle` — which OpenCode's own docs use for "session
   completed" notifications — is mapped to `session.end` honestly: it fires per turn-end, the
   daemon treats it like the other runtimes' boundaries, and a resumed session gets a fresh one.
   `session.error` is deliberately NOT subscribed: it carries LLM-provider failures (auth,
   abort, output length), which are not tool/command failures and would pollute the
   failure-memory family.
2. **The injection channel is experimental upstream.** `experimental.chat.system.transform` is
   named so by OpenCode itself; a rename or removal surfaces as a counted no-op, never a broken
   session. The static `.opencode/onememory.md` instructions pointer is the durable channel.
3. **OpenCode's write tool has no overwrite-delta signal.** `metadata.exists === true` means the
   file existed; the previous content is not exposed, so `file.changed` is `modified` without
   line deltas (Pi has no create signal at all — write is `modified` there). Both gaps are
   stated, not papered over.
4. **Pi's wire payloads carry no session id.** Pi's real extension reads one from its
   `sessionManager.getSessionId()` and passes it in the translate context (the conformance
   scenario renders that same production shape); when the structural surface is absent the
   scope simply omits `session_id` — never invented.
5. **`opencode.json` is strict-JSON-only for the merge.** OpenCode accepts JSONC comments, but a
   comment-preserving JSONC rewrite is not something this merge fakes: a file that does not
   parse is reported (with the manual-add instructions) and left untouched.
6. **Two review steps OpenCode requires, by design:** restart after scaffolding (plugins and
   config load at startup) and the MCP-tool permission prompt. The adapter surfaces both as
   required-review output; it never bypasses them.
7. **Pi requires project trust** before reading project-scope `.pi/` files, and `/reload` after
   out-of-session scaffolding — both surfaced as required review (Pi's design, not bypassed).

## 5. Conformance — what "same results" means here

The suite (vendored byte-identical from main, then extended) renders ONE canonical session (10
facts: session start, user question, assistant answer, a successful command run, a file edit, a
failed command later resolved by the re-run, an explicit "remember that …", a final assistant
answer, the re-run, session end) into each runtime's **native hook vocabulary** and drives each
adapter's own translation entry points; the events run through the REAL engine (PGlite +
migrations, the real extract job over the heuristic extractor, the real retrieval engine).

1. **Pi == Claude, byte for byte:** event kinds and payload projections for every canonical
   fact; the three memories (resolved failure 0.85, recurring command 0.7, explicit remember
   0.9) with identical content/evidence/working-memory/ranking/`memory_get`; 11 events processed
   → 3 memories + 1 working row, 0 drops. The failed command's exit code is `1` (parsed from
   `structuredContent.exit_code`) and the remember clause's trailing period is stripped — Pi
   sides with the Claude baseline on both pinned divergences.
2. **OpenCode == Claude, byte for byte:** the same equality across all five suites' surfaces.
   The user turns ride `chat.message` exactly once each (the claim set drops the part
   channel's copies — asserted); the exit code is `1` (`metadata.exit`); the period is
   stripped.
3. **The pinned landscape (pre-existing, asserted by name so it cannot grow silently):**
   - the failed command's `exit_code`: Claude/Codex/Pi/OpenCode `1`; **Cursor `null`** (Cursor's
     hook contract exposes no exit code on failure — M8's documented gap);
   - the remember clause's trailing period: Claude/Cursor/Pi/OpenCode strip it; **Codex keeps
     it** (a pre-existing Codex normalization difference, recorded as a follow-up — another
     mission's lane);
   - the file-edit line counts (deliberately outside the strict projection per pipeline.ts):
     **Claude/Pi/OpenCode count a trailing newline as a split boundary (2/3); Cursor strips it
     (1/2); Codex's apply_patch channel carries no line counts.** Pi and OpenCode match the
     Claude baseline — the conformance reference — byte for byte.

**Does Pi pass conformance today? Yes** — against Claude exactly, against Codex modulo Codex's
pinned trailing-period divergence, against Cursor modulo Cursor's pinned exit-code-null.
**Does OpenCode pass conformance today? Yes** — the same, against all four.

## 6. Validation (exact commands and counts)

| Command | Result |
|---|---|
| `bun test packages/adapters/pi` | **96 pass, 0 fail** (267 `expect()` calls, 8 files, 356 ms) |
| `bun test packages/adapters/opencode` | **147 pass, 0 fail** (409 `expect()` calls, 8 files, 284 ms) |
| `bun test benchmarks/eval` (includes the 5-runtime conformance suite) | **91 pass, 0 fail** (277 `expect()` calls, 7 files, 28.05 s) |
| `bun test apps/cli` | **49 pass, 0 fail** (243 `expect()` calls, 4 files, 18.75 s) |
| `bun test apps/api` | **90 pass, 0 fail** (550 `expect()` calls, 11 files, 13.64 s) |
| `tsc --noEmit` in `packages/adapters/{pi,opencode}`, `apps/cli`, `apps/api`, `benchmarks/eval` | **all clean** |
| `bun test --timeout=15000` (full repo) | **1600 pass, 22 skip, 0 fail** (1622 tests, 125 files, 12,139 `expect()` calls, 224.37 s) |

Failures surfaced and fixed along the way (all now green): the plugin passed the event hook's
payload where the wrapper `{event}` was expected (a real adapter bug caught by the conformance
run); the `--with-opencode` commander camelCase (`withOpencode`); two stale three-runtime test
pins (the doctor info count and the runtimes list — both now runtime-agnostic, M8's pattern);
and the wrong-premise line-count strip (§5.3) caught by running the canonical session through the
real pipeline.

## 7. Files

**New** — `packages/adapters/opencode/` (`package.json`, `tsconfig.json`, `README.md`,
`src/{version,wire,remember,event-builder,translate,delivery,capture,plugin,scaffolds,scaffold,scaffold-inspect,index,testing}.ts`
+ 8 test files), `benchmarks/eval/src/adapter-conformance/{pi,opencode}.test.ts`.

**Vendored byte-identical from main** (merge-safe: base `91d2b89` predates the cursor mission;
the union merge sees identical content on both sides) — `packages/adapters/cursor/**` (24 files),
`benchmarks/eval/src/adapter-conformance/{scenario,pipeline,cursor.test}.ts`,
`benchmarks/eval/package.json`.

**Modified** — `benchmarks/eval/src/adapter-conformance/scenario.ts` (pi + opencode renderers,
5-runtime dispatch), `apps/cli/src/{bin.ts,commands/init.ts,commands/wire-runtimes.ts,init-wiring.test.ts}`,
`apps/api/src/runtime/{runtime-scaffolds.ts,runtime-scaffolds.test.ts,runtime.test.ts,doctor-codememory.test.ts}`,
`apps/cli/package.json`, `apps/api/package.json` (workspace deps), `bun.lock` (`bun install` —
registers `@onememory/adapter-opencode` and the cli/api/eval edges),
`packages/adapters/{pi,opencode}/src/translate*.ts` (the Claude-baseline line-count alignment).

## 8. Deviations from the task sheet

1. **The Pi package landed before this resume point** (`a80d345`): the resume task began at its
   commit blocker, so its landing is part of this mission's branch but was already complete —
   the secret-pattern fix (§1, criterion 1) is what this session added before the commit.
2. **Cursor vendored, not rebuilt.** The conformance harness and the cursor adapter are M8's
   lane on main; the merge-safe move was vendoring them byte-identical (both sides of the union
   merge then agree), then extending the shared files with pi/opencode on top of main's cursor
   state — so the only diff the coordinator merges is this mission's own additions.
3. **`bun.lock` is shared by two commits.** It lands with the wiring commit (`d8937ca`), which
   also carries the conformance commit's adapter edges; the two intermediate trees are
   lock-stale but the branch tip is consistent (CI runs at the tip).

## 9. Follow-ups (for the coordinator)

1. **Codex: strip the `explicit.remember` clause's trailing sentence punctuation** to match the
   Claude/Cursor/Pi/OpenCode normalization — a one-line change in the Codex adapter, owned by
   that mission's lane; the conformance tests already pin the divergence and go green
   automatically when it is fixed. (Same follow-up as M8's; now pinned by four suites.)
2. **Unify the edit line-count formula across runtimes.** The Claude baseline counts a trailing
   newline as a split boundary (2/3 for the canonical edit), Cursor strips it (1/2), Codex
   carries none. Either normalize Claude/Cursor/Codex onto the git-true count or accept the
   pinned landscape — a cross-adapter decision the coordinator owns; the pin (in
   `pi.test.ts`) makes the current state explicit either way.
3. **Hoist the remember-clause extractor into a shared adapter kit.** `remember.ts` now exists as
   four byte-identical deliberate duplicates (claude/cursor/pi/opencode); the conformance suite
   asserts the identity, but the duplication is coordinator-level debt (adapters may not import
   sibling adapters).
4. **OpenCode session boundaries:** if OpenCode documents a real session-end signal (or a
   durable replacement for `experimental.chat.system.transform`), remap; until then the
   session.idle mapping and the static instructions pointer carry the load, and the gap is
   documented (§4.1/§4.2), not hidden.
5. **Pi/OpenCode user-scope (global) scaffolds** (`~/.pi`, `~/.config/opencode`) are not yet
   emitted — both seams are project-scope only, matching the Claude/Codex/Cursor phase.
6. **Vector-channel conformance:** the suite runs with no embedding provider configured, so the
   ranking comparison covers the lexical channel; add a vector-channel variant when an offline
   embedder lands behind the model router (same follow-up as M8's).
