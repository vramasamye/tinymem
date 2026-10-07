# Mission 10 report — Web UI (memory explorer)

**Branch:** `mission/10-web-ui` (worktree `onememory-m10`, base `main` @ `7251c5a`)
**Scope delivered:** `apps/web` (`@onememory-ai/web`, private) — the Phase 6 / M10 memory explorer:
11 routes over 9 feature modules, one HTTP boundary (`src/api/client.ts`) whose Zod mirrors are
`satisfies`-linked to `@onememory-ai/core`'s canonical types, and 73 tests (boundary, route map,
per-page controllers, render smoke). No `apps/api`, `packages/**`, architecture-doc, ADR, or
root-config file touched — the only root-adjacent change is the additive `bun.lock` entry for the
new workspace package (the root `package.json` `workspaces: ["apps/*", …]` glob already covers
`apps/web`, so no root edit was needed).

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `apps/web` is a real workspace package; root `package.json` untouched unless needed | **delivered (no root edit)** | `apps/web/package.json` (`@onememory-ai/web`, scripts `dev/build/preview/test/typecheck`); auto-discovered by the existing `"apps/*"` workspace glob; `bun install` links it (additive `bun.lock` diff only) |
| 2 | Routes for every M10 surface: memories list/filter + full-text + structured search, timeline (status history), graph, projects, decisions, failures, skills, sources/provenance drill-down, quality dashboard | **delivered — 11 routes** | `src/router.tsx` `APP_ROUTES` (pinned by `src/router.test.ts`): `/` → redirect, `/memories`, `/memories/:memoryId`, `/memories/:memoryId/timeline`, `/projects`, `/decisions`, `/failures`, `/skills`, `/graph`, `/sources`, `/quality` |
| 3 | Every claim on screen is API data; per-page controller test asserting no fallback hard-coded values | **delivered** | 9 controller tests (one per feature): exact pass-through equality against fixture responses (`vm.memories` `toEqual` the API payload), empty-response cases asserting zero rows + the API's own warnings (no invented content), 404 cases asserting the API's error envelope surfaces verbatim. Render smoke (`src/smoke.test.tsx`): each surface's View rendered via `react-dom/server` with controller output — fixture-derived strings present, and with empty API responses the data markers are absent |
| 4 | `bun run dev` starts on a known port; one route renders without errors | **delivered** | Vite dev server on **5173** (bumps only if taken), verified live: `GET /` 200 with the shell, `/src/main.tsx` 200 (transformed). "One route renders" is proven stronger: all 10 surface Views render to string without errors in the smoke suite, and a live end-to-end run (§4) rendered real engine data |
| 5 | Mission report: AC, route count, stack, API→UI flow, follow-ups for missing endpoints | **delivered** | this document (§2 stack, §3 flow, §4 validation, §5 follow-ups, §6 the two yes/no answers) |

## 2. The chosen frontend stack (reuse, not invention)

| Piece | Choice | Why |
|---|---|---|
| Build/dev | **Vite 8** + `@vitejs/plugin-react` | the repo's existing toolchain family (root devDeps already carry vitest/vite); zero new toolchain invented |
| UI | **React 19** + `react-dom` | the documented repo convention for `apps/web` ("bun + TypeScript strict + Vite + React") |
| Routing | **react-router 7** (`createBrowserRouter`) | mature, covers the whole need (paths, params, query params, links); route table exported as data so the route-map test pins it |
| Validation | **zod 4** (same version as the repo) | every API response validated at the boundary; schemas re-declared browser-side and `satisfies`-linked to canonical `@onememory-ai/core` types so drift fails `tsc` (core is imported **type-only** — its barrel re-exports `model/hashing.ts` (`node:crypto`), which must never enter the browser bundle; the production build logs no node-builtin warning) |
| Tests | **bun test** (repo runner) + `react-dom/server` render-to-string | no DOM emulation dependency at all: controllers are plain async functions (API client injected), Views are pure functions of view-models — both testable headlessly, the same way every other package in this repo tests |

## 3. API → UI data flow

```text
daemon (apps/api)                                apps/web
─────────────────────────────────────────       ─────────────────────────────────────────────────
GET  /v1/health                       ◄──────── AppShell · HealthPill
GET  /v1/projects                     ◄──────── ProjectProvider (active project; UI state only —
                                               the project record itself is the API's)
POST /v1/projects/:id/search          ◄──────── memories (filters → request 1:1)
                                     ◄──────── graph (seeds memory nodes), sources (groups),
                                               skills (query 'skill' + types ['procedural'],
                                               mirroring the API's typed-list synthesis and the
                                               MCP kind mapping), quality (include-filtered
                                               samples, labeled query-scoped)
GET  /v1/projects/:id/decisions       ◄──────── decisions page
GET  /v1/projects/:id/failures        ◄──────── failures page
GET  /v1/projects/:id/memories/:mid   ◄──────── memory detail (provenance drill-down: source,
                                               evidence quotes, redactions, typed payload,
                                               entities, edges, supersession) · timeline
                                               (the audit trail IS memory_events) · bounded
                                               inspect enrichment for graph / sources / skills /
                                               quality (N+1 capped at 10–12, per-item failures
                                               reported, never silently dropped)
GET  /v1/projects/:id/stats           ◄──────── projects page + quality (authoritative counts)
GET  /v1/projects/:id/context        ◄──────── projects page (session context + token accounting)
```

The pipeline inside the app is fixed: **route → Page (hooks) → controller (async fn) → ApiClient
(fetch + error envelope + zod wire mirror) → view-model → View**. The client is read-only (the
explorer is a viewer; forget/restore/purge are CLI/SDK operations, not UI scope).

Base URL: same-origin relative by default (`/v1/...`) because the daemon serves `/v1` without
CORS — the Vite dev server proxies `/v1` → `http://127.0.0.1:7331` (`DEFAULT_DAEMON_PORT`,
`@onememory-ai/config`), and a deployed build sits behind the same origin. `VITE_ONEMEMORY_API`
overrides with an absolute base; `ONEMEMORY_API_PROXY_TARGET` overrides the dev proxy target.

## 4. Validation matrix (all run in the worktree)

| Check | Result |
|---|---|
| `bun test apps/web` | **73 pass, 0 fail** (12 files — per-file counts below) |
| `tsc --noEmit` (apps/web, extends `../../tsconfig.base.json`, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) | **clean** |
| `bun run build` (production) | **clean** — 143 modules, no node-builtin warnings (type-only core import proven) |
| `bun run dev` | **starts on 5173 without errors**; `GET /` 200 (shell + title), `/src/main.tsx` 200 |
| Full repo `bun test --timeout=15000` | **1803 pass, 42 skip, 0 fail** (155 files) — the web suite is discovered by the root runner; no other package affected |
| Live end-to-end (real daemon + real PGlite) | fresh project → `onemem init` → `onemem serve` (7331) → `onemem remember` → the explorer's own `createApiClient` + `loadMemories` + `MemoriesView` against the live daemon: projects validated, 1 row, 20/800 tokens, rendered HTML contains the real memory title + real explain factors; the memory detail returns source kind `explicit`, 1 evidence span, `heuristic` extraction |

Per-file test counts: `client.test.ts` 15 · `router.test.ts` 7 · `memories` 8 · `timeline` 3 ·
`src-provenance` 6 · `graph` 4 · `projects` 4 · `decisions` 3 · `failures` 3 · `skills` 3 ·
`quality` 4 · `smoke.test.tsx` 13 — **73 total**.

## 5. Coordinator follow-ups — endpoints the UI needs but the API does not expose

These are **API gaps, not UI gaps** (the UI documents each honestly on the page instead of
inventing data). All would land in `apps/api` (not this mission's lane):

1. **Project-wide memory_events stream.** The audit trail (`memory_events`) is exposed only per
   memory (`inspect.audit`), so the timeline route is memory-scoped
   (`/memories/:memoryId/timeline`). A `GET /v1/projects/:id/events` would power a
   project-level timeline page.
2. **A quality endpoint.** Duplicate groups live inside consolidation (M14/M15) and no
   `/v1/*` route exposes them, so the quality dashboard's Duplicates card states the gap
   instead of a number. A `GET /v1/projects/:id/quality` (duplicates, stale, conflicts, unused,
   low-confidence, computed where the engine already computes them) would replace the
   stats + three include-filtered searches + capped inspects the controller composes today.
3. **Query-less status lists.** Every list is query-driven (`search` requires `query` ≥ 1), so
   the quality category lists are *labeled query-scoped samples* while the counts come from
   `/v1/stats`. A `GET /v1/projects/:id/memories?status=&type=` list route would make them true
   category lists.
4. **A skills route.** Skill payloads ride procedural memories; the skills page synthesizes
   `query: 'skill', types: ['procedural']` (the API's own typed-list synthesis +
   the MCP skill→procedural mapping) and discriminates via inspect. A
   `GET /v1/projects/:id/skills` would be direct (and become the natural M15 surface).
5. **A graph route.** The graph view composes one search + ≤12 per-memory inspects. A
   `GET /v1/projects/:id/graph?query=` returning nodes + edges in one call would remove the
   bounded N+1 (entities/edges are per-memory today).
6. **Project listing.** The API itself warns: storage has no list-projects query, so only the
   registered project is returned — the explorer surfaces that warning verbatim on every page
   (pre-existing mission-13 follow-up, unchanged).
7. **CORS for split deployments.** If a deployed build must talk to the daemon cross-origin
   (`VITE_ONEMEMORY_API` absolute), the API needs CORS middleware; today same-origin + the dev
   proxy is the supported path.
8. **Source titles on search rows.** `provenance.source.title` only rides `inspect`, so the
   sources index enriches ≤12 groups with a bounded inspect; carrying `source_title` on search
   rows would remove that.

## 6. The two direct answers

- **Does every UI claim on the rendered routes come from API responses today?**
  **Yes.** Every data value rendered (titles, summaries, statuses, relevance, score components,
  token meters, sources, evidence quotes, code refs, payloads, audit events, entities, edges,
  redactions, stats counts, context sections, warnings, error messages) is read from a validated
  API response; the only client-authored strings are UI chrome (labels, headings, empty-state
  sentences, and the two stated view policies: the low-confidence threshold 0.5 and
  unused = `access_count` 0). The controller tests pin pass-through equality and the empty-path
  (zero rows stays zero rows; the API's warnings render verbatim; 404s surface the API's own
  envelope), and the render smoke asserts the fixture-derived strings appear while invented ones
  cannot.
- **Does `bun run dev` start the server without errors today?**
  **Yes.** Verified on port 5173 (twice), with the `/v1` proxy exercised live against a real
  daemon: `GET /v1/health` and `POST …/search` through `http://localhost:5173/v1` returned real
  engine data, and the production build is clean.

## 7. Files

Everything under `apps/web/**` is new: `package.json`, `tsconfig.json`, `vite.config.ts`,
`index.html`, `README.md`, and `src/` (api, components, features × 9, lib, state, router, App,
main, styles, tests). Plus `bun.lock` (additive) and this report. The docker compose `web`
service (repository-structure.md mentions an optional web container) is deliberately not
touched — `docker/` was outside this mission's lane; the same-origin/proxy notes in §3 are what
such a service would need.
