# Mission 13c report: install robustness (published invocation contract + stdio owner guard)

**Branch:** `mission/13c-install-robustness` (worktree `onememory-m13c`, branched from main at `5c20159`)
**Scope delivered:** the two install-robustness P1s every clean first impression depends on —
[backlog cross-follow-up #9](../../backlog/issues.md) (the published hook-invocation contract: a clean
EXTERNAL project that installed the published packages must be able to run every generated hook/MCP
command with no repository-local path, no bare-`PATH` assumption, and a load-bearing shebang) and
[cross-follow-up #5](../../backlog/issues.md) (the standalone `onemem-mcp` stdio bin must refuse a
second embedded-storage owner while the daemon is alive, per the ADR-0002 single-owner rule). Both
were called out by the supermemory parity memo (Tier A item 3,
[supermemory-parity-status-2026-10-05.md](../../research/supermemory-parity-status-2026-10-05.md))
and by [mission-13-init-wiring.md](mission-13-init-wiring.md) follow-up 2. No ADR, root-config,
`AGENTS.md`, `README.md`, `docs/architecture/`, or backlog files were touched (coordinator-owned).

**Provenance note:** `96a932e` and `e0b879a` are the original worker's commits, preserved verbatim
after that worker was stopped mid-mission. `2b44c53` and `835e1d4` complete the same worker's
in-flight, uncommitted adapter edits (never discarded) and add the Codex production constants and
the test-wiring fixes those edits needed.

**Commits**

| Commit | Summary |
|---|---|
| `96a932e` | `feat(config)`: share the daemon lock schema and probe across packages |
| `e0b879a` | `feat(mcp)`: guard the stdio bin against a second embedded-storage owner |
| `2b44c53` | `feat(adapter-claude)`: invoke the published bin links in every scaffolded command |
| `835e1d4` | `feat(adapter-codex)`: resolve the published bin links at run time in the generated commands |
| (this) | `docs`: this report |

---

## 1. What changed

### `packages/config` + `apps/api` (`96a932e`) — the shared lock seam

The daemon.json wire contract (`DaemonLockSchema`, read/write/clear, `isProcessAlive`, `probeDaemon`,
`isLoopbackHost`) moved from `apps/api/src/runtime/lock.ts` into `@onememory-ai/config`
(`src/daemon-lock.ts`), because packages must never import apps and the MCP bin's owner guard
needs the same probe. `daemonLockCandidateDirs` maps both real embedded data-dir layouts (the data
dir IS the `.onememory` config dir, or is its `data/` child) to the lock's candidate config dirs.
`apps/api/src/runtime/lock.ts` stays a signature-preserving re-export shim — every export keeps its
exact name and shape, `DaemonProbe` stays typed against the runtime `HealthReport` — so `daemon.ts`,
`composition.ts`, the CLI, and all existing tests run untouched.

### `packages/mcp` (`e0b879a`) — the stdio embedded-owner guard (backlog #5)

`src/owner-guard.ts` exports `assertNoEmbeddedOwner(dataDir, {fetch?, env?})`, invoked from the
stdio bin's `main()` BEFORE embedded storage opens. No lock → proceed; stale lock (dead pid) →
clean it and proceed; live-pid lock → `EmbeddedStorageOwnerError` pointing the operator at the
running daemon's MCP endpoint — including when the daemon answers health calls but the fetch fails
(wedged-but-alive still owns the data dir). Server-profile storage (`ONEMEMORY_PG_URL`) is
multi-process-safe and deliberately not guarded. Lock discovery covers both embedded layouts via
`daemonLockCandidateDirs`. `@onememory-ai/config` became a workspace dependency of `packages/mcp`.
Tests: fake-lock unit tests with an injectable `fetch`, plus a bin-level test running `main()`
against a real loopback HTTP fake daemon asserting PGlite is never opened.

### `packages/adapters/claude` (`2b44c53`) — the published invocation contract (backlog #9)

| File | Change |
|---|---|
| `src/bin.ts` | `#!/usr/bin/env bun` shebang added (mode 100755 preserved). Load-bearing: the settings.json scaffold now points hooks at this bin through the published install's `node_modules/.bin/onemem-claude-hook` link, so without the shebang the link is not executable and every scaffolded hook fails. npm preserves the shebang and the 0755 mode in the published tarball. |
| `src/scaffolds.ts` | `defaultHookCommand()` → `${CLAUDE_PROJECT_DIR}/node_modules/.bin/onemem-claude-hook` (exec form, `args: []`); `defaultMcpServerCommand()` → `${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/onemem-mcp`. `defaultMcpServerArgs()`/`defaultHookArgs()` retired from the public surface. Custom `command`/`args`/`hook` options are honored verbatim (source-checkout installs). |
| `src/index.ts` | Exports follow the rename. |
| `src/scaffold-merge.ts`, `src/scaffold-inspect.ts` | Unchanged on purpose: the merge/doctor ownership predicate is token-based (`@onememory-ai/adapter-claude`, `onemem-claude-hook`), a substring of both the previous `bun …/@onememory-ai/adapter-claude/src/bin.ts` form and the new bin-link form — re-running init replaces stale handlers; the doctor keeps reporting pre-existing installs as wired. |
| `src/scaffold-published.test.ts` (new) | The acceptance test — see §3. |
| `README.md` | The scaffold section documents the published-link invocation. |

### `packages/adapters/codex` (`835e1d4`) — the published invocation contract (backlog #9)

| File | Change |
|---|---|
| `src/hooks-scaffold.ts` | New `PROJECT_CAPTURE_COMMAND` = `exec "$(git rev-parse --show-toplevel 2>/dev/null \|\| pwd)"/node_modules/.bin/onemem-codex-capture` — the default for every generated handler. Codex runs command hooks through a shell with the session cwd and may be started from a subdirectory, so the command resolves the project root at run time (git toplevel inside a repo; `pwd` as the documented fallback for non-git projects launched at their root), then `exec`s the published bin link (no lingering shell process — a timeout kill hits the bin itself). New `CAPTURE_BIN_TOKEN` (the bare bin name) is the stable replacement token. |
| `src/config-scaffold.ts` | New `PROJECT_MCP_COMMAND` = `./node_modules/.bin/onemem-mcp` — the stdio `command` default, relative to the launch dir (the same working-directory assumption the stdio block already documents for the default embedded data dir). |
| `src/scaffold.ts` | `scaffoldCodex` passes the new default through to the hooks renderers. |
| `src/scaffold-inspect.ts` | `inspectCodexHooksContent`'s default needle is now `CAPTURE_BIN_TOKEN` — same value, one source of truth; it matches both the previous bare-name form and the new command, so the doctor keeps reporting pre-existing installs as wired. |
| `src/index.ts` | `PROJECT_CAPTURE_COMMAND`, `CAPTURE_BIN_TOKEN`, `PROJECT_MCP_COMMAND` exported. |
| `src/scaffold-published.test.ts` (new) | The acceptance test — see §3. |
| `README.md` | The artifact table documents both generated commands. |

---

## 2. The generated artifacts, before → after

| Artifact | Before (main) | After |
|---|---|---|
| Claude `.claude/settings.json` handler | `bun` + args [`${CLAUDE_PROJECT_DIR}/node_modules/@onememory-ai/adapter-claude/src/bin.ts`] — a source path from THIS repository, and a bin with no shebang | `${CLAUDE_PROJECT_DIR}/node_modules/.bin/onemem-claude-hook`, `args: []` (exec form) |
| Claude `.mcp.json` stdio `command` | `bun` + args [`${CLAUDE_PROJECT_DIR:-.}/node_modules/@onememory-ai/mcp/src/bin.ts`] | `${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/onemem-mcp`, no args |
| Codex `.codex/hooks.json` handler `command` | `onemem-codex-capture` (bare name, PATH-only) | `exec "$(git rev-parse --show-toplevel 2>/dev/null \|\| pwd)"/node_modules/.bin/onemem-codex-capture` |
| Codex `.codex/config.toml` stdio `command` | `onemem-mcp` (bare name, PATH-only) | `./node_modules/.bin/onemem-mcp` |
| Claude hook bin | executable but no shebang | `#!/usr/bin/env bun`, mode 0755 (both bins already carried shebangs in `packages/mcp` and `packages/adapters/codex`) |

Migration is idempotent in both adapters: `mergeClaudeSettingsHooks` / `patchCodexHooksJson` replace
their own stale handlers by token (a substring of every form ever scaffolded — the old
`@onememory-ai/adapter-claude` source path and the old bare Codex bin name included), never duplicate,
preserve user handlers and unrelated settings, and pass a third time unchanged. New tests pin the
old-default → new-command migration explicitly (`scaffold-merge.test.ts`, `hooks-scaffold.test.ts`).
User overrides (`command`/`args` on Claude, `captureCommand`/`mcpCommand` on Codex) are honored
verbatim, as before.

---

## 3. The clean-install acceptance tests (the AC, executed)

Both new `scaffold-published.test.ts` files build a temp directory exactly like a clean external
install — `node_modules/.bin/<name>` symlinked to the real bin entrypoint, the way npm/bun link every
`bin` declared in package.json — and then RUN the generated commands, not just assert strings:

- **Claude hooks**: every scaffolded handler (SessionStart, SessionEnd, Stop, PostToolUse,
  PostToolUseFailure) is spawned in exec form with the `${CLAUDE_PROJECT_DIR}` placeholders expanded
  the way Claude Code expands them (plain-string substitution). Each invocation resolves inside the
  clean install's `node_modules/.bin`, contains no `src/` path and no `@onememory-ai/` package path,
  exits 0, and emits the fail-soft stderr diagnostics. The SessionStart handler's stdout JSON
  contract is asserted (empty-or-valid JSON with no daemon).
- **Claude stdio MCP**: the generated `.mcp.json` entry's command and env (placeholders expanded over
  a real user environment — the shebang needs `PATH`; Claude Code spawns servers with parent env +
  the entry's env map) is spawned with cwd = the clean project. The server boots embedded storage for
  real (PGlite creates `.onememory` with content), the daemon-less owner guard passes, and the bin
  exits 0 on stdin EOF — the documented shutdown signal.
- **Codex hooks**: the SessionEnd and Stop handlers run through `sh -c` with the session cwd (exactly
  Codex's execution model), on a faithful wire payload (`transcript_path` present) — exit 0, stdout
  empty, stderr diagnostics non-empty; and a separate test proves the `git rev-parse` → `pwd`
  fallback works in a NON-git project launched at its root.
- **Codex stdio MCP**: the generated config.toml block is parsed back with a real TOML reader
  (smol-toml), its `command` (`./node_modules/.bin/onemem-mcp`) resolves inside the clean install and
  is spawned the way Codex launches it — as a path against the working directory, with the block's
  env table applied — boots embedded PGlite into `.onememory` and exits 0 on stdin EOF.

No generated command depends on `src/*.ts`, a monorepo path, or bare-PATH resolution. Temp dirs are
bounded (`mkdtempSync` + `afterEach` cleanup; 60s per-test ceilings for the cold PGlite boots, which
take ~8–12s each).

---

## 4. Test evidence (exact runs, worktree `onememory-m13c` at `835e1d4`)

- `bun test packages/config/src/daemon-lock.test.ts packages/mcp/src/owner-guard.test.ts`:
  **22 pass / 0 fail** (71 expect calls).
- `bun test packages/adapters/claude`: **159 pass / 0 fail** (9 files, 685 expect calls) — includes
  the 3 new published-install tests.
- `bun test packages/adapters/codex`: **161 pass / 0 fail** (12 files, 653 expect calls) — includes
  the 3 new published-install tests.
- `bun test packages/mcp`: **104 pass / 0 fail** (7 files).
- `bun test apps/cli`: **32 pass / 0 fail** (3 files) — the end-to-end init wiring consumes the new
  defaults with no assertion drift.
- `bun test apps/api`: **67 pass / 0 fail** (8 files) — the doctor runtimes group reads the new
  scaffolds back through the token-based inspections and stays green.
- Full workspace `bun test`: **1086 pass / 0 fail / 22 skip, 1108 tests across 85 files,
  212.78s**. The 22 skips are the env-gated Postgres-server storage scenarios (they require a
  Docker Postgres instance; every skip carries its env-gate note).
- `bunx tsc --noEmit` clean in all 14 workspace packages: `apps/cli`, `apps/api`,
  `packages/{llm,embeddings,core,config,security,mcp,storage,retrieval,codememory,extraction}`,
  `packages/adapters/{claude,codex}`.
- No timeout flakes were observed in any run; no test timeout defaults were changed to make a
  failure disappear (the 60s ceilings in the two new test files were the original worker's, kept).
- No TODOs in shipped code; no credentials introduced (tests use loopback URLs and synthetic UUIDs
  only; temp dirs under the system tmpdir).

---

## 5. Decisions and deviations (with reasoning)

1. **Codex hooks resolve the git root at run time; the MCP stdio command does not.** Codex command
   hooks run through a shell with the session cwd and may fire from a subdirectory, so the capture
   command must find the project root itself (`git rev-parse --show-toplevel`, `pwd` fallback). The
   stdio MCP `command` is `./node_modules/.bin/onemem-mcp`, relative to the launch dir: that is the
   SAME working-directory assumption the stdio block already made for its default embedded data dir
   (`.onememory` under the launch dir), and `onemem init` scaffolds the daemon HTTP form by default,
   so stdio is the manual/server-profile path. `mcpCommand` and `cwd` remain the documented overrides
   for launches from elsewhere.
2. **`exec` in the Codex capture command.** The shell is replaced by the bin, so no extra process
   lingers and a Codex timeout kill hits the bin itself (the bin is fail-soft and self-bounds
   delivery to 2.5s regardless). A missing bin link still exits 127 — an honest install failure, not
   a silent capture skip.
3. **Token-based migration and doctor recognition, mirroring the Claude adapter.** The replacement
   token is the bin NAME (`CAPTURE_BIN_TOKEN`), a substring of every invocation form ever scaffolded,
   so stale configs migrate to the current command without duplicating handlers, and the doctor keeps
   reporting pre-existing installs as wired instead of suddenly warning. Trade-off: the doctor cannot
   distinguish a stale PATH-only invocation from the current one — only a re-run of `onemem init`
   migrates (see follow-ups).
4. **The Claude MCP acceptance test spawns over the parent environment.** The first run of the
   preserved test failed with exit 127: it replaced the environment wholesale, and the bin's
   `#!/usr/bin/env bun` shebang could not find `bun` without `PATH`. The fix models what Claude Code
   actually does (parent env + the entry's env map), after deleting onememory's control variables to
   keep the "clean install" deterministic.
5. **The preserved Codex test payloads were completed to the real wire shape.** The original worker's
   SessionEnd payload omitted `transcript_path`, which every Codex command hook carries (nullable) —
   the schema correctly dropped it (`unmappable-session-end`), which made stderr empty. The test now
   sends the faithful shape, so delivery is genuinely attempted and the fail-soft diagnostic lands.
6. **The codex stdio acceptance test spawns the generated command rather than only stat-ing it.**
   The preserved test checked executability (`accessSync` X_OK); the mission's AC ("can run every
   generated command") warranted actually running it — the TOML block is parsed with smol-toml and
   booted, mirroring the Claude side.

---

## 6. Follow-ups for the coordinator

1. **pnpm isolated layouts do not link transitive bins into `node_modules/.bin`.** npm/bun/yarn
   hoist, so the published `onemem` CLI's adapter/MCP dependencies get root `.bin` links and the
   generated commands resolve. With pnpm's default strict layout, only DIRECT dependencies receive
   `.bin` links; a user installing `onemem` (not the adapter packages) under pnpm would not get
   `onemem-claude-hook`/`onemem-mcp` links. Options: document direct installation of the adapter
   packages, or a `pnpm.public-hoist-pattern[]=@onememory-ai/*` note. This belongs in the
   coordinator-owned user docs (root `README.md`).
2. **Doctor cannot flag stale-but-wired invocation forms** (decision 3's trade-off): a
   `hooks.json`/`settings.json` written by an older `onemem init` still reports `complete`. If
   wanted, add an inspection detail that reports the invocation form so the doctor can suggest a
   re-run.
3. **User-scope wiring** (backlog #11) is untouched: init/doctor remain project-scope; the Codex
   stdio `cwd`/`mcpCommand` overrides are the existing escape hatch for `~/.codex` installs.
4. **Windows**: the bun shebangs and the Codex shell command are POSIX-only, consistent with the
   Phase-1 posture (`docs/research/dependency-verification.md` §10 pins argv-array spawning; no
   Windows CI exists to gate). No claim of Windows support is made anywhere.
5. `bun.lock` gained only the `packages/mcp` → `@onememory-ai/config` workspace edge (in `e0b879a`).
   Resolve with the coordinator's usual `--ours` + reinstall flow if it collides with a sibling
   merge.
6. The two cold-boot acceptance tests add ~25s to the adapter suites (~8–12s each for a real PGlite
   boot + clean EOF shutdown). They are bounded (60s ceilings) and parallel across files, but if
   the coordinator wants a faster suite they can be marked with a slower tier once one exists.

## 7. Intentionally left out

- Any change to the daemon's own lock acquisition or the doctor's daemon check (the guard only
  PROBES the lock; the daemon remains the writer).
- Any ADR amendment: ADR-0002's single-owner rule and the ADR-0010 amendment are already the source
  of truth; the guard implements them.
- Coordinator-owned docs (`README.md`, `docs/architecture/**`, `docs/adr/**`, backlog, phased plan)
  — linked from here, not edited.
