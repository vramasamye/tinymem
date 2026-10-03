# Mission 13 report — Config, CLI (`onemem`), REST API + runtime composition root & daemon

**Branch:** `mission/13-cli-api`
**Scope delivered:** `packages/config` (`@onememory/config`), `apps/api` (`@onememory/api` + `@onememory/api/runtime`), `apps/cli` (npm `onememory`, bin `onemem`), this report. No existing file was touched outside `bun.lock` (workspace entries + one new dependency).
**ADRs exercised:** 0002 (single-owner embedded storage → the daemon lock), 0003 (provenance mandatory, status tombstones), 0004 (token-budgeted retrieval), 0006 (local model router), 0007 (redaction/path exclusion/network guard), 0010 §5 (forget ≠ delete).

---

## 1. What shipped

Three new workspaces; 36 source/test files. `bun test` from the worktree root:
**449 pass / 0 fail / 15 skip** (464 tests, 38 files; baseline at `main` 74df5c6 was 373/0/15 —
M13 adds **76 tests**: config 30, api 34, cli 12). `bunx tsc --noEmit` clean in all three packages
(strict; both other consumers re-verified).

### `packages/config` — one file, one truth, fail closed

| File | Role |
|---|---|
| `src/schema.ts` | Zod schemas for `onememory.yaml`: version, project identity, storage (`profile: embedded\|server`, `pg_url`), retrieval (budgets), redaction groups + extra patterns, exclusions, model router (providers, routes over `MODEL_OPERATIONS`), daemon (host/port), embedder presets |
| `src/defaults.ts` | `renderDefaultConfigYaml()` / `renderConfigForProject(name)` — the local preset; `renderOllamaConfig` lives in the CLI (prompt-shaped), this stays data-shaped |
| `src/load.ts` | Discovery (`--config` > `ONEMEMORY_CONFIG` env > nearest `.onememory/onememory.yaml` walking up, like git), exactly-one-file read, **credential-free URL enforcement** (inline credentials rejected; `pg_url: ENV_NAME` resolved at load, source recorded as `env:<NAME>`), profile↔pg_url consistency (embedded forbids pg_url; server requires it), `.onememory/project.json` pointer |
| `src/derive.ts` | `networkGuardPlan`, `vectorConfigFor`, `llmProfileSummary`, `embedderConfigFor` — the derived decisions other packages consume (no `pg_url` value ever leaves storage, no key value ever leaves the router) |
| `src/project-state.ts` | `project.json` (the project pointer `onemem init` writes, every command resolves) |
| `src/errors.ts` | `ConfigError` (file-scoped, path+message issues, value-free) + `ConfigNotFoundError` |

The config bug this uncovered and fixed: **zod 4 `z.record(z.enum(...))` is exhaustive**, so
`redaction.groups: {jwt: false}` failed validation. Partial group maps are now
`z.record(z.string(), z.boolean()).refine(known-ids)` — unknown ids still rejected, partial maps
allowed (tested).

### `apps/api` — the composition root, the backend port, the REST surface, the daemon

| File | Role |
|---|---|
| `src/runtime/composition.ts` | `openRuntime()` = config → **network guard first** → storage (PGlite or Postgres, migrations) → redactor/exclusions → embedder (lazy, degraded when absent) → retrieval engine → job worker (optional) → doctor glue. `close()` drains tracked writes **before** storage closes (see §4.6). Multi-runtime processes: the guard patch is process-global, so the second open warns and reuses the first (tested) |
| `src/runtime/local-backend.ts` | The in-process `OnememoryBackend`: health/doctor/remember/forget/restore/search/ingest/stats/createProject/getProject/listProjects/session context — provenance + audit + cache invalidation enforced by the service layer |
| `src/runtime/http-backend.ts` | The same port over REST (daemon mode); timeouts, typed errors (`unavailable` on connection loss), same shapes |
| `src/runtime/memory-service.ts` | The write/read rules: redact-before-hash, provenance row + evidence span always, duplicate = reported never silent, forget = audited `archived` + `restore_hint`, `listProjectMemories`, `requireProject` |
| `src/runtime/daemon.ts` | `startDaemon()`: config → **lock check** → runtime+worker → `Bun.serve` (loopback only unless `--listen-public`) → self-check → lock write; SIGTERM/SIGINT graceful reverse shutdown; single-owner refusal (ADR-0002) |
| `src/runtime/lock.ts` | `daemon.json`: pid+host+port+url; `probeDaemon()` — stale lock (dead pid) is removed; live-but-unresponsive → `problem` and **local open refuses** (the wedge case must not corrupt) |
| `src/runtime/doctor.ts`, `stats.ts`, `embedder.ts`, `version.ts` | Honest doctor (exit 0 = ok/degraded, 1 = failed), honest stats (missing APIs → `null` + warning, never fake zeros), lazy embedder |
| `src/server/app.ts`, `schemas.ts` | Hono + zod-openapi; every response validated against its schema at runtime (a backend bug is a 500, never a bad payload — tested both directions); `GET /openapi.json` |
| `src/bin.ts` | `onemem-api serve` entry (arg parsing; refuses non-loopback without the flag) |

REST surface (all under `/v1`, JSON only): `health`, `doctor`, `projects` (POST/GET),
`projects/{id}` (GET), `projects/{id}/events` (POST ingest), `projects/{id}/search` (POST),
`projects/{id}/decisions|failures` (GET, ADR-0010's first-class kind filters),
`projects/{id}/context` (POST session context), `projects/{id}/memories` (POST remember),
`projects/{id}/memories/{id}` (GET inspect), `.../forget` + `.../restore` (POST),
`projects/{id}/stats` (GET).

### `apps/cli` — `onemem`

`onemem init [--preset local|ollama|server] [--name]` · `serve [--host] [--port] [--listen-public]`
· `doctor` · `search <query> [--budget --limit --type --no-explain]` ·
`remember <content> [--type --title --tags --importance --confidence]` · `forget <id> [--reason]`
· `restore <id>` · `inspect <id>` · `stats` — every command takes `--json` (one document on
stdout, prompts/warnings on stderr) and `--cwd`/`--config`/`--project`.

Design seams: `Io` (human text vs machine document, no `if (json)` in commands), `Prompt`
(clack interactively, fail-closed non-interactive: missing answers name the flag to pass),
`resolveBackend` (the one ADR-0002 decision every command makes first: a live daemon lock → HTTP
backend; otherwise open the composition root without the worker). Exit codes: 0 ok (doctor
degraded is still 0), 1 any reported error; `--json` error documents carry `error.code`.

Verified against a real process: `init` → `remember` → `search` → `stats` → `serve` → daemon lock
→ CLI routes over REST → second `serve` refused → SIGTERM drains the worker, closes storage,
removes the lock.

---

## 2. Deviations (all deliberate, all tested)

1. **No `onemem forget --purge`.** ADR-0003 defines the hard delete, but the storage port exposes
   no purge API in Phase 1. Instead of faking it, `forget` prints an honest `purge_hint` pointing
   at this report. Storage follow-up.
2. **`GET /v1/projects` returns only the configured project** with an explicit `warnings` entry —
   the store port has no `listProjects`. Same honesty rule in `stats`: job-queue count is `null`
   **with a warning naming the missing API**, not `0`.
3. **zod-openapi `.openapi()` is not retroactive** across differently-resolved zod instances (the
   CLI graph loads `@onememory/core` before the API surface; annotating imported schemas throws
   `MemorySearchRequestSchema.openapi is not a function`). Imported schemas are used AS-IS
   (structural description in `openapi.json`; only cosmetic $ref names are lost). The import-order
   contract is documented at the annotation site.
4. **`onemem serve` requires Bun** (`Bun.serve`); the check happens before any resource is held
   and the error names the follow-up (@hono/node-server). Every other command runs on any runtime
   the packages support (no Bun-only APIs outside `daemon.ts`).
5. **The network guard has no loopback allowance** — it blocks the daemon's own health endpoint in
   a guarded process. Production flows are unaffected by ordering: the CLI probes the lock
   *before* opening a runtime (guard installs inside `openRuntime`). The daemon additionally takes
   an explicit `fetch` for embedders that already hold a guard. Allowlist = follow-up.
6. **The REINFORCE-vs-close race is fixed at the composition seam**, not in M2's `engine.ts`: the
   engine fires `void store.reinforce(...)` (a floating write); PGlite's close waits on in-flight
   queries indefinitely, so short-lived CLI processes hung 3/3 until `close()` learned to drain
   tracked in-flight writes first. Scoped to `composition.ts` (M13's file), with a comment at the
   seam.
7. **Direct mode runs no job worker** (a CLI process is not a job host): `normalize`/`extract`
   jobs queue until `onemem serve` runs; `doctor` prints `worker: not running` and the drain path.
8. **Config discovery walks up the tree** (nearest `.onememory/`), like git — an empty
   subdirectory of an initialized project resolves the parent project (tested as such).
9. **Server preset fails closed at init**: `--pg-url-env` must name a set, credential-free
   `postgres://` URL, or init refuses with the exact remediation.

---

## 3. Follow-ups (coordinator / later missions)

- **Storage port gaps:** `listProjects`, a job-queue count API, and a hard-purge API
  (`memory_delete`, ADR-0010) — each currently reported honestly as missing.
- **Network guard loopback allowlist** (its own `origin` list), so a guarded process can reach the
  local daemon without passing a raw `fetch`.
- **Node adapter for `onemem serve`** (`@hono/node-server`) to drop the Bun-only constraint.
- **Retention/compaction job** (decay → archive) is not in Phase 1; the worker already has the
  shape for more handlers.
- **MCP server (ADR-0010)** can be built directly on `OnememoryBackend` + the wire schemas here;
  the REST surface and the port agree by construction (app tests run the HTTP backend against the
  same app).
- **M16 config extras** (more presets, `onemem config lint`) reuse `@onememory/config` schemas.

**Test totals:** worktree `bun test` **449 pass / 0 fail / 15 skip** (464 tests; config 30, api 34,
cli 12 new). `tsc --noEmit` clean for `packages/config`, `apps/api`, `apps/cli`.
