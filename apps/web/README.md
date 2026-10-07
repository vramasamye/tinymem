# @onememory-ai/web — the memory explorer UI

The Phase 6 / M10 surface: memories search/filter, per-memory timeline (status
history), the entity/memory graph, projects, decisions, failures, skills,
sources/provenance, and the quality dashboard — **every value on these pages comes
from the REST API** (`apps/api`, `/v1/*`). There is no client-side memory truth: the
Zod mirrors in `src/api/schemas.ts` are `satisfies`-linked to `@onememory-ai/core`'s
canonical types, and every response is validated at the HTTP boundary before a page
renders it.

`/browse` is the one surface that is not a ranked search: it walks *every* memory of the
project, newest observation first, one keyset page at a time
(`GET /v1/projects/{id}/memories`, `page_size` + the API's opaque `next_cursor`). The
cursor lives in the URL, so a page is deep-linkable and "next page" pushes history —
the browser's back button returns to the previous page without the client inventing a
reverse cursor. Changing a filter restarts at the first page, because a cursor is bound
to the filters that produced it.

## Run it

```sh
# terminal 1 — the daemon (owns storage; serves /v1 on 7331)
cd your-project && onemem serve

# terminal 2 — the explorer (Vite dev server on 5173, proxies /v1 to the daemon)
cd onememory/apps/web && bun run dev
# open http://localhost:5173
```

The daemon has no CORS middleware, so the client defaults to same-origin relative
URLs (`/v1/...`) and the Vite dev server proxies them to
`http://127.0.0.1:7331` (`DEFAULT_DAEMON_PORT` in `@onememory-ai/config`). For a
deployed build behind a different origin, set `VITE_ONEMORY_API` (absolute base —
requires CORS on the API; see the mission report follow-up) and/or
`ONEMEMORY_API_PROXY_TARGET` (dev proxy target).

## Run the whole stack with Docker Compose

`docker/compose.yaml` has a `web` profile that brings up Postgres + the daemon + this
UI as three containers, so one command gives a working stack with no host toolchain:

```sh
docker compose -f docker/compose.yaml --profile web up   # then open http://localhost:4173
```

| Service | What it is | Host address |
|---|---|---|
| `postgres` | pgvector/pgvector:pg17 — the daemon's storage | `127.0.0.1:5433` (`ONEMEMORY_PG_HOST_PORT` overrides) |
| `memory-api` | the daemon in server mode, built from `docker/api.Dockerfile` | `127.0.0.1:7331` |
| `web` | `vite build` output served by `vite preview` (`docker/web.Dockerfile`) | `127.0.0.1:4173` |

`docker/api-config.yaml` is the container's config: Postgres-backed storage with a
credential-free `pg_url` (credentials travel in `PGUSER`/`PGPASSWORD`, because
`@onememory-ai/config` rejects inline userinfo). Both published ports bind loopback only —
the REST API has no authentication of its own (ADR-0012), and the daemon's non-loopback
bind is acknowledged inside the container by `--listen-public`.

The `preview` server proxies `/v1` to `memory-api` exactly as the dev server does, so the
built bundle stays same-origin. Plain `docker compose up` still starts Postgres alone —
the profile is additive, and the env-gated Postgres test suite is unaffected.

The stack starts **empty**: no project is registered, so the explorer shows its honest
empty state. Point the CLI at the same database to fill it, from the host:

```sh
export ONEMEMORY_PG_URL=postgresql://postgres:5432/onememory   # the compose Postgres
onemem init && onemem doctor                                    # register this repo
```

(`/v1/projects` lists only the project registered in `.onememory/project.json` — a
storage list-projects query is still an open coordinator follow-up, so a server-mode
daemon with no local project file reports an empty list plus that warning.)

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` | Vite dev server on 5173 (with the `/v1` proxy) |
| `bun run build` | Production build to `dist/` |
| `bun run preview` | Serve the production build |
| `bun test` | The full web test suite (client, route map, per-page controllers, render smoke) |
| `bun run typecheck` | `tsc --noEmit` (strict, no `any` at boundaries) |

## Layout

```text
src/
├── api/        # the one HTTP boundary: client.ts (fetch wrapper) + schemas.ts (wire mirrors)
├── components/ # the shared presentational kit (rows, badges, meters, warnings)
├── features/   # one module per M10 surface: controller (data) + View (render) + Page (route)
├── lib/        # useAsync + AsyncGate (the loading/ready/error machine)
├── state/      # the project provider (API client + active project)
├── router.tsx  # the route table (the route-map test pins it)
└── App.tsx     # the shell: nav, health pill, outlet
```

Design rule (M10 acceptance): a page never invents data. Controllers call the API and
pass the response through; Views render view-models; empty or failed API responses
render honest empty/error states — the per-page controller tests pin exactly that.
