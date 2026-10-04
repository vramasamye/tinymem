# Mission 13 report: init wiring (Claude Code + Codex, daemon-backed MCP)

**Branch:** `mission/13-init-wiring` (worktree `onemem-m13-init`, base `2aecc93`)
**Scope delivered:** `onemem init` detects Claude Code and Codex, asks for consent, and wires the
chosen runtimes to the daemon's Streamable HTTP MCP surface (`/mcp`, per the
[ADR-0010 amendment of 2026-10-04](../../adr/0010-mcp-protocol-adapters.md)). `onemem doctor`
gains a runtimes check group that reads the scaffolds back and compares their MCP URL with the
configured daemon. This closes two Phase-1 definition-of-done bullets in
[phased-plan.md](../phased-plan.md): "`npx onememory init` ... detects/configures Claude Code +
Codex" and the doctor's "detected runtimes" validation. No ADR, root-config, `AGENTS.md`, or
`docs/architecture/` changes.

**Commits**

| Commit | Summary |
|---|---|
| `95addb2` | `feat(adapter-claude)`: daemon HTTP `.mcp.json` entry, idempotent merges, doctor inspection |
| `a22213b` | `feat(adapter-codex)`: daemon HTTP `config.toml` block and doctor inspection |
| `4825241` | `feat(cli,api)`: wire `onemem init` and doctor to the Claude Code and Codex adapters |
| `092a0cb` | `chore(adapters)`: mark the hook bins executable (mode change made by `bun install`) |
| (this) | `docs`: this report |

---

## 1. What changed

### The URL rule (one source of truth)

`daemonMcpUrl(daemon)` in `apps/api/src/runtime/runtime-scaffolds.ts` (exported from
`@onememory/api/runtime`) returns `http://${daemon.host}:${daemon.port}/mcp` from the loaded
config's `daemon` section. `onemem init` uses it to build both adapters' entries; the doctor uses
it as the expected value. Both adapters additionally refuse any URL that is not loopback `http:`
(Phase 1 has no authentication, so no headers or tokens are emitted).

### `packages/adapters/claude`

| File | Change |
|---|---|
| `scaffolds.ts` | `McpServerEntrySchema` is now `z.union([McpHttpServerEntrySchema, McpStdioServerEntrySchema])`. The http entry is `{type: 'http', url}` with `url` validated by `LoopbackHttpUrlSchema` (`http:` + loopback host). `McpJsonOptions` gains `transport?: 'stdio' \| 'http'` and `url?`; absent `transport` keeps the stdio entry byte-for-byte. New `buildMcpServerEntry` (the entry alone); `buildMcpJson` / `buildMcpServerEntry` have overloads so stdio callers keep the narrow stdio type. New `isLoopbackHostname`. |
| `scaffold-merge.ts` (new) | `mergeMcpJson(existing, options)` inserts or replaces only `mcpServers.onememory` (an existing key keeps its position; other servers and top-level keys are preserved). `mergeClaudeSettingsHooks(existing, options)` removes onememory's own handlers from every group of each subscribed event (identified by the bin tokens `@onememory/adapter-claude` / `onemem-claude-hook` or the exact configured invocation), keeps user handlers that shared a group, drops only groups that become empty, then appends the generated groups. Both return `{ok: true, content, action: created\|patched\|unchanged}` or `{ok: false, error}`; malformed JSON or a wrong structure (`mcpServers`/`hooks` not an object, an event value not an array) is an error and the file is never rewritten. Both are byte-idempotent. |
| `scaffold-inspect.ts` (new) | `inspectClaudeScaffold(root)` reports `.mcp.json` (`absent \| invalid \| no_entry \| http(url) \| stdio \| unrecognized`; accepts Claude Code's documented `streamable-http` alias), `.claude/settings.json` hooks (`absent \| invalid \| no_entry \| partial(missing_events) \| complete`) and the `CLAUDE.md` pointer block. Pure content-level functions are exported for tests. |
| `index.ts`, `README.md` | Exports and the scaffold section updated. |

### `packages/adapters/codex`

| File | Change |
|---|---|
| `config-scaffold.ts` | `CodexMcpScaffoldOptions` gains `transport?` and `url?`. `transport: 'http'` renders the HTTP block (shape in section 2) inside the same marker fence, so `patchCodexConfigToml` keeps working unchanged: replace-in-place, hand-added unmarked table replaced, byte-idempotent. Absent `transport` renders today's stdio block. New `isLoopbackHostname` and `assertLoopbackHttpUrl`. |
| `scaffold-inspect.ts` (new) | `inspectCodexScaffold(root, {projectId?})` parses `config.toml` with smol-toml (`absent \| invalid \| no_entry \| http(url, managed) \| stdio(managed) \| unrecognized`), checks `hooks.json` for the capture command on every generated event, and checks the AGENTS.md block (project-aware when an id is given). |
| `scaffold.ts` | Header documents the http option. An invalid http `url` throws before any file is touched; everything else still reports through `warnings` / `skipped`. |
| `package.json` | `smol-toml` moves from `devDependencies` to `dependencies` (the doctor inspection now imports it at runtime). |
| `index.ts`, `README.md` | Exports and setup docs updated. |

### `apps/cli`

| File | Change |
|---|---|
| `commands/wire-runtimes.ts` (new) | The scaffold phase. `detectRuntimes(root, env, pathExists)`: Claude Code if `$HOME/.claude` or `<root>/.claude` exists; Codex if `$CODEX_HOME`, `$HOME/.codex` or `<root>/.codex` exists. HOME comes only from the injected env (no `os.homedir()` fallback), and `pathExists` is injectable. `chooseRuntimes`: flags win; otherwise the interactive multi-select (detected runtimes preselected); otherwise none. `wireClaude` merge-writes `.mcp.json`, `.claude/settings.json`, and `CLAUDE.md` (`buildMemoryPointerBlock({projectName})` + `mergeMemoryPointerBlock`; an orphaned begin marker is reported and skipped). `wireCodex` calls `scaffoldCodex({scope: 'project', root, projectId, transport: 'http', url})`. `runScaffoldPhase` adds plain-language notes (detected but not consented, nothing detected, non-loopback daemon host). `printScaffoldPhase` prints per-file actions, the required-review list, and the notes; skipped files are also reported on stderr. |
| `commands/init.ts` | Consent is asked right after the preset questions, before anything is written. The scaffold phase runs after the project row and `project.json` are saved, inside the success path. `InitResult` gains `runtimes` (the phase result) and `required_review` (every adapter warning, prefixed with its runtime). `next_steps` puts `onemem serve` before launching the wired agents. Already initialized: without flags, the old message plus `to wire an agent runtime, re-run with --with-claude and/or --with-codex.`; with flags, the config (`loadConfig`) and `project.json` are loaded and only the scaffold phase runs (`InitAlreadyResult` carries `runtimes` + `required_review`). The server preset scaffolds HTTP as well; init has no stdio branch. |
| `bin.ts` | `--with-claude` and `--with-codex` on `onemem init`. |
| `prompt.ts` | The `Prompt` port gains `multiselect` (clack `multiselect` with `required: false`; the non-interactive implementation returns the initial values, but init only calls it when `io.interactive` is true). |
| `commands/doctor.ts` | Prints the runtimes group under its own heading, labels `info` checks `[info]` with a `hint:` line, and adds the informational count to the summary line. |
| `package.json` | `@onememory/adapter-claude` and `@onememory/adapter-codex` (`workspace:*`); `smol-toml` as a devDependency for the TOML assertions in tests. |

### `apps/api`

| File | Change |
|---|---|
| `runtime/runtime-scaffolds.ts` (new) | `daemonMcpUrl`, `evaluateRuntimeScaffold`, and `runtimeScaffoldChecks(root, {expectedUrl, storageProfile, projectId?})`. |
| `runtime/doctor.ts` | `DoctorCheckStatus` gains `info`. `DoctorReport` gains `runtimes: DoctorCheck[]` and `summary.info`. `inspectRuntime` computes the runtimes group from `runtime.loaded.paths.root`, the configured daemon URL, and the storage profile, and counts it in `summary`/`status`. `failedDoctorReport` returns `runtimes: []`. |
| `server/schemas.ts` | `DoctorCheckSchema.status` accepts `info`; `DoctorReportSchema` gains `runtimes` and `summary.info`. |
| `server/app.test.ts`, `runtime/runtime.test.ts` | The pinned `DoctorReport` fixture is updated; the runtime doctor test asserts two `info` runtime checks. |
| `package.json` | Depends on both adapter packages (for the inspection functions). |

### Doctor runtimes group: the rules

Check ids are `runtime-claude-code` and `runtime-codex`, titled `Claude Code` and `Codex`.

- **info**: nothing onememory-specific exists (no MCP entry, no onememory hooks, no pointer).
  Wiring is opt-in, so this never warns. The remediation reads `to wire it: onemem init --with-claude`
  (or `--with-codex`).
- **pass**: the MCP entry is http with exactly the configured daemon URL, every subscribed hook
  event carries an onememory handler, and the pointer block is present. With server-profile
  storage, a stdio MCP entry also passes, because multi-process Postgres is safe there.
- **warn**: any of the following: a URL that does not match the config, a stdio entry with
  embedded storage (the second-owner hazard), missing or partial hooks, a missing pointer, an
  unrecognized entry, or an unparseable file. The remediation is to re-run the init flag; for an
  unparseable file, it says to fix that file first.
- **fail** is never produced by this group.

## 2. Exact scaffold artifact shapes emitted by `onemem init`

The examples use the default `daemon.host: 127.0.0.1` and `daemon.port: 7331`.

`.mcp.json` (merged; other servers and keys preserved):

```json
{
  "mcpServers": {
    "onememory": {
      "type": "http",
      "url": "http://127.0.0.1:7331/mcp"
    }
  }
}
```

`.claude/settings.json`: the unchanged M6 `buildClaudeHooksConfig()` hooks (SessionStart,
SessionEnd with `timeout: 5`, Stop, PostToolUse matcher `Bash|PowerShell|Edit|Write|NotebookEdit`,
PostToolUseFailure matcher `*`; exec form `bun ${CLAUDE_PROJECT_DIR}/node_modules/@onememory/adapter-claude/src/bin.ts`),
merged per event into the user's settings.

`CLAUDE.md`: the M6 `buildMemoryPointerBlock({projectName})` block between
`<!-- onemem:begin ... -->` and `<!-- onemem:end -->`, appended or replaced in place.

`.codex/config.toml` (marker-fenced; the rest of the file is byte-preserved):

```toml
# --- onememory:begin (generated by `onemem init`; safe to re-run — edit outside the markers) ---
# onememory — persistent project memory for Codex (Streamable HTTP, served by the onememory
# daemon). Start it before launching Codex: `onemem serve` (it is the single owner of the
# project's storage). The URL follows daemon.host / daemon.port in .onememory/onememory.yaml;
# re-run `onemem init --with-codex` after changing them.
[mcp_servers.onememory]
url = "http://127.0.0.1:7331/mcp"

# Codex enforces a per-tool output budget: ... (the commented output_token_limit example)
# --- onememory:end ---
```

`.codex/hooks.json` and `AGENTS.md` are unchanged from M7.

Required-review lines printed by init (emitted only when they apply):

- `Claude Code: Claude Code asks you to approve project-scoped .mcp.json servers — run `claude` in this project and approve the onememory server (it shows as pending approval until then)`. This appears when `.mcp.json` was created or patched.
- `Codex: project-scoped .codex/config.toml only loads for trusted projects — ...`, emitted by `scaffoldCodex`.
- `Codex: run Codex and review the hooks once via /hooks — ...`, emitted by `scaffoldCodex`.
- `Codex: AGENTS.override.md exists — ...` and `Codex: AGENTS.md has an orphaned onememory marker ...`, emitted by `scaffoldCodex` when they apply.
- Merge-skip outcomes, for example `Claude Code: .claude/settings.json is not valid JSON and was left untouched (...) — fix it and re-run onemem init`.

## 3. Verified primary sources

- Claude Code MCP (`https://code.claude.com/docs/en/mcp`, read 2026-10-04): an HTTP entry in
  `.mcp.json` is `{"type": "http", "url": ...}`. `streamable-http` is accepted as an alias. An
  entry with a `url` but no `type` is read as a broken stdio server. Project-scoped `.mcp.json`
  servers need interactive approval ("Pending approval" until then).
- Codex MCP (`https://developers.openai.com/codex/mcp`, read 2026-10-04): Streamable HTTP servers
  take `url` (required). Optional fields include `bearer_token_env_var`, `http_headers`,
  `env_http_headers`, and `startup_timeout_sec` (default 10). The documented example uses
  `url = "http://localhost:3000/mcp"`. Project `.codex/config.toml` loads only for trusted
  projects.

## 4. Deviations from the brief (with evidence)

1. **Non-interactive run with a detected runtime and no flags: nothing is wired.** The brief says
   detected runtimes are preselected, and that consent comes from the prompt (interactive) or
   the flags (non-interactive). With neither, writing files would bypass consent, so init prints
   `<Runtime> was detected but not wired (no consent) — re-run onemem init --with-... to wire it`.
2. **Doctor vocabulary: a new `info` status, plus a separate `runtimes` array.** The existing
   vocabulary (`pass | warn | fail`) has no non-failing "absent" state, and `warn` would turn
   every unwired project into a degraded one. `info` never changes the status or exit code.
   `summary.info` counts it. The group lives in `report.runtimes` rather than inside `checks`,
   so the CLI can print it as its own section. `DoctorReportSchema` was extended to match, and
   the response validation in `app.ts` enforces it.
3. **`apps/api` depends on both adapter packages.** The doctor needs the adapters' read-back
   logic (TOML parsing, hook ownership tokens). Duplicating it in `apps/api` would split one
   format between two owners. The dependency direction is adapters -> core/config/security, and
   api -> adapters. That creates no cycle, and the engine core still imports no adapter code.
4. **`smol-toml` became a runtime dependency of `@onememory/adapter-codex`.** M7 §5 already
   anticipated keeping it under dependencies. Production code still writes TOML as text; only
   the inspection parses it.
5. **The server preset scaffolds HTTP, as the brief directs.** The ADR-0010 amendment calls stdio
   "the surface for the `server` profile". Init still emits HTTP for every preset, because the
   daemon is the deployment for both. The doctor accepts a hand-written stdio entry as `pass`
   under server-profile storage, and warns about it under embedded storage.
6. **A non-loopback `daemon.host` wires nothing.** Both adapters refuse a non-loopback URL
   (Phase 1 has no authentication). Init checks this before calling them and explains it in a
   note. It does not throw after the project was already registered.
7. **Codex HTTP block: no `startup_timeout_sec` by default.** The stdio default of 20s exists for
   cold PGlite boots in the spawned server. Over HTTP the daemon is already running, so Codex's
   10s default applies. An explicit `startupTimeoutSec` is still emitted.
8. **Detection also honours `$CODEX_HOME`**, which is Codex's documented home override and what
   `scaffoldCodex` user scope already uses. All values come from the injected env.
9. **Added a Claude Code required-review line** for the documented `.mcp.json` approval step.
   This mirrors how the Codex trust and `/hooks` steps are surfaced.
10. **`chore` commit for bin modes.** `bun install` marks `packages/adapters/{claude,codex}/src/bin.ts`
    executable once they are linked as bins of `apps/cli` and `apps/api`. The mode change is
    committed so the tree stays clean after install, as main did for the MCP bin in `434618b`.

## 5. Test evidence

- `bun test packages/adapters/claude`: **155 pass / 0 fail** (8 files). The new
  `scaffold-merge.test.ts` covers the http entry shape and validation, the union schema,
  `mergeMcpJson` (create, preserve, replace in place, idempotent, malformed refusal),
  `mergeClaudeSettingsHooks` (preserve, no duplicates, stale-path replacement, shared groups,
  custom invocation, malformed refusal), and inspection on content and on disk.
- `bun test packages/adapters/codex`: **138 pass / 0 fail** (11 files). New coverage: the HTTP
  block render and parse, ignoring stdio options, URL refusal, patch idempotency into an
  existing TOML, stdio-to-http and port switches in place, the hand-added table, `scaffoldCodex`
  HTTP idempotency and upgrade, and the new `scaffold-inspect.test.ts`.
- `bun test apps/cli`: **28 pass / 0 fail** (2 files). The new `init-wiring.test.ts` runs end to
  end through `main()` with real PGlite. It covers: no consent means no files; detected without
  a flag means no files plus a hint; the interactive multi-select preselects detected runtimes;
  both flags write all six artifacts while preserving user files; review lines and next steps;
  doctor `pass`; byte-idempotent re-run on an initialized project; a daemon-port change makes
  doctor warn and re-wiring follow the config; already-initialized without flags gives the hint;
  malformed `settings.json` is left byte-identical while the rest still wires and doctor warns;
  plus detection and non-loopback units.
- `bun test apps/api`: **53 pass / 0 fail** (4 files). The new `runtime-scaffolds.test.ts` covers
  the URL rule, every evaluation branch, and real scaffolds read back.
- Full workspace `bun test`: **875 pass / 0 fail / 16 skip, 891 tests across 66 files**. The
  baseline on main was 813 / 0 / 16 with 829 tests across 62 files, so this mission adds 62
  tests and no regressions.
- `bun run typecheck` is clean in `apps/cli`, `apps/api`, `packages/adapters/claude`, and
  `packages/adapters/codex`.
- No TODOs in shipped code. No credential-shaped literals were added; the new tests use only
  loopback URLs and synthetic UUIDs.

## 6. Follow-ups for the coordinator

1. **The daemon's MCP context has no default project.** `daemon.ts` builds
   `createOnememoryMcpContext({storage, engine, embedder, redactor})` without a `projectId`.
   HTTP clients cannot pass env, and Phase 1 sends no headers. As a result, `memory_store` with
   project scope and `memory_project_context` require an explicit `project_id` over `/mcp`, and
   every HTTP client writes as agent `onememory-mcp`. The suggested one-line fix in
   `apps/api/src/runtime/daemon.ts` is to pass
   `projectId: runtime.loaded.project_state?.project_id`. That file is outside this mission's
   scope, so it was left unchanged. Per-runtime agent identity over HTTP needs a decision: a
   query parameter on the URL, or headers in a later phase.
2. **Hook invocation paths.** The Claude hooks call
   `bun ${CLAUDE_PROJECT_DIR}/node_modules/@onememory/adapter-claude/src/bin.ts` (the M6
   default), which needs the adapter installed in the project's `node_modules`. Codex calls
   `onemem-codex-capture` from `PATH`. Decide the published-bin invocation for both. Note that
   the Claude bin has no shebang, even though it is now executable.
3. `onemem serve --port <n>` overrides the config port. The scaffolds follow the config, so
   doctor warns about the mismatch. That is correct, but worth a sentence in the user docs.
4. User-scope configurations (`~/.claude.json`, `~/.codex/config.toml`) are neither written nor
   inspected. Init and doctor are project-scope only.
5. A pre-existing quirk, not changed here: the CLI doctor appends its `daemon`/`worker` check
   after `summary` is computed, so those checks are not counted in `summary`.
6. Coordinator-owned docs (root `README.md`, `docs/architecture/`) should mention
   `onemem init --with-claude/--with-codex` and the doctor runtimes group. The two Phase-1 DoD
   bullets in `phased-plan.md` can be marked done.
7. `bun.lock` changed: workspace dependency edges for `apps/api` and `apps/cli`, and `smol-toml`
   moved under adapter-codex `dependencies`. Resolve with `--ours` plus a reinstall, as planned.

## 7. Intentionally left out

- `onemem init --dry-run`. `scaffoldCodex` supports it, but the Claude merges are pure and a
  CLI flag was not in scope.
- Any change to the stdio bin's second-owner guard (already tracked in the backlog by the ADR
  amendment).
