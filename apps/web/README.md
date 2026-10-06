# @onememory/web — the memory explorer UI

The Phase 6 / M10 surface: memories search/filter, per-memory timeline (status
history), the entity/memory graph, projects, decisions, failures, skills,
sources/provenance, and the quality dashboard — **every value on these pages comes
from the REST API** (`apps/api`, `/v1/*`). There is no client-side memory truth: the
Zod mirrors in `src/api/schemas.ts` are `satisfies`-linked to `@onememory/core`'s
canonical types, and every response is validated at the HTTP boundary before a page
renders it.

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
`http://127.0.0.1:7331` (`DEFAULT_DAEMON_PORT` in `@onememory/config`). For a
deployed build behind a different origin, set `VITE_ONEMORY_API` (absolute base —
requires CORS on the API; see the mission report follow-up) and/or
`ONEMEMORY_API_PROXY_TARGET` (dev proxy target).

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
