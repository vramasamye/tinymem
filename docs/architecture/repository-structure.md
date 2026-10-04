# Repository structure

Status: draft for architecture review · Feeds ADR-0001 · Implements spec §16 (universal adapter), §28

Bun + TypeScript monorepo. Package manager: Bun workspaces. The layout below is the Phase 1–6
target; empty directories from later phases are created with `.gitkeep` only when a phase starts
(no placeholder code, per AGENTS.md rule 3).

```text
onememory/
├── apps/
│   ├── api/                  # REST API server (Hono). Serves /v1/*, OpenAPI spec, jobs trigger.
│   ├── cli/                  # The `onemem` binary (commander/citty). Thin wrapper over @onememory/sdk.
│   └── web/                  # Memory explorer UI (Phase 6): memories, timeline, graph, decisions,
│                             #   failures, skills, sources, quality dashboard.
├── packages/
│   ├── core/                 # THE ENGINE. Memory model, lifecycle pipeline orchestration,
│   │                         #   scoring, status transitions, Zod schemas (canonical),
│   │                         #   ports (interfaces): Store, Searcher, Embedder, Extractor,
│   │                         #   Reranker, EntityResolver, DriftWatcher, SecretRedactor.
│   ├── storage/              # Port implementation: Postgres dialect (Drizzle ORM) — runs on
│   │                         #   PGlite (embedded) and Postgres+pgvector (server/cloud/SaaS).
│   │                         #   Owns migrations, jobs table, repositories. Only place with SQL.
│   ├── retrieval/            # Port implementation: hybrid retrieval — lexical (tsvector BM25),
│   │                         #   vector (pgvector KNN), graph expansion, temporal filter,
│   │                         #   RRF fusion, weighted scoring, rerankers, token packing.
│   ├── extraction/           # Port implementation: LLM extractor (via llm router) + heuristic
│   │                         #   no-LLM extractor; classifiers; future-value gate.
│   ├── consolidation/        # Slow-loop jobs: episodic→semantic derivation, near-dup merges,
│   │                         #   contradiction resolution, failure→skill candidates, decay,
│   │                         #   project digest rollups, archiving.
│   ├── embeddings/           # Port implementation: providers — local (transformers.js ONNX),
│   │                         #   ollama, openai-compatible (LM Studio/llama.cpp/vLLM), hosted.
│   ├── llm/                  # Model router: per-operation provider routing (extraction → cheap,
│   │                         #   consolidation → strong, conflict → reasoning, etc.). One
│   │                         #   abstraction; never a hard dependency of correctness.
│   ├── graph/                # Entity resolution (match/merge/alias), edge semantics, traversal.
│   ├── security/             # Secret detection & redaction, path exclusions, ACL enforcement,
│   │                         #   privacy/100%-local mode guarantees.
│   ├── codememory/           # (Phase 2) Git fingerprints, blob-hash drift detection, symbol
│   │                         #   extraction (tree-sitter), stale-memory mapping, minimal
│   │                         #   re-index; architecture digest.
│   ├── mcp/                  # MCP server: stdio + Streamable HTTP, all memory tools.
│   ├── sdk/                  # Composition root + public facade (`MemoryEngine`), stable
│   │                         #   programmatic API. Published as `@onememory/sdk`.
│   ├── config/               # Config discovery & validation (onememory.config.yaml + zod),
│   │                         #   doctor checks shared with CLI.
│   └── adapters/             # Runtime adapters. Translate runtime events → OnememoryEvent.
│       ├── claude/           # .claude/: hooks (Session*, Pre/PostToolUse → events), MCP config,
│       │                     #   skills wiring, CLAUDE.md bootstrap.
│       ├── codex/            # config.toml MCP wiring, AGENTS.md bootstrap, session capture.
│       ├── cursor/           # .cursor/mcp.json, rules bootstrap.
│       ├── pi/               # Pi extension/config + MCP wiring.
│       └── opencode/         # opencode.json MCP + skills wiring.
├── plugins/
│   ├── vscode/               # (post-1.0) IDE plugin: search/inspect memories.
│   └── jetbrains/            # (post-1.0)
├── benchmarks/               # Memory-quality evaluation (spec §25): retrieval precision/recall,
│   │                         #   token efficiency, pollution, temporal accuracy, contradiction
│   │                         #   accuracy, consolidation quality. Golden datasets + harness.
├── docker/
│   ├── compose.yaml          # memory-api + postgres(+pgvector); optional: ollama, web, reranker.
│   └── postgres-init/        # extension bootstrap (vector, pg_trgm if needed).
├── docs/                     # architecture/, adr/, research/ (cited), plan/, backlog/, risks.md
├── examples/
│   ├── claude-code-project/  # Working example: init onememory in a repo, run with Claude Code.
│   ├── codex-project/
│   └── mcp-generic/          # Any MCP client: node script using the SDK + MCP server.
├── tests/                    # Cross-package integration & e2e (unit tests live in packages).
└── scripts/                  # release, benchmark, fixture generation.
```

## Dependency rules (enforced by lint, not convention)

The engine never knows about agent runtimes (spec §16). Dependency direction is one-way:

```text
apps/cli  apps/api  apps/web  packages/mcp  packages/adapters/*
      └──────────────┬─────────────────────┘
                     ▼
               packages/sdk            (composition root, public facade)
                     ▼
               packages/core           (model + lifecycle + PORTS as pure interfaces)
                     ▲
   ┌────────────┬────┴───────┬──────────────┬─────────────┬──────────┐
   │            │            │              │             │          │
storage      retrieval    extraction    consolidation   graph   codememory
   │            │            │              │             │          │
   └────────────┴─────┬──────┴──────────────┴─────────────┴──────────┘
                      ▼
        packages/llm  packages/embeddings  packages/security

As-built (M2): retrieval → storage (read-only candidate fetchers). It is the one
engine-to-engine import; rule 4 still holds — SQL never leaves storage.
```

1. **`core` declares ports, does not import implementations.** `Storage`, `Searcher`, `Embedder`,
   `Extractor`, `Reranker`, `EntityResolver`, `DriftWatcher`, `Redactor` are interfaces in core;
   `sdk` wires implementations via a composition root. This is what makes every layer testable with
   fakes and keeps `core` runtime-free (works in Bun, Node, browsers via PGlite, edge runtimes).
2. **`adapters/*` import `sdk` only.** Zero engine internals. An adapter is a translator:
   runtime-native event → `OnememoryEvent`.
3. **No adapter imports another adapter.** Shared event logic lives in `core`.
4. **`storage` is the only package with SQL.** Migrations ship with every schema change. The one
   engine-to-engine import is `retrieval → storage` for read-only candidate fetchers (as-built
   M2); every other engine package consumes `core` ports only.
5. **`llm`/`embeddings` are the only packages that may make outbound network calls** (and only to
   user-configured providers; `security` gates even those in 100%-local mode).

## Publishing surface (npm)

| Package | Name | Published |
|---|---|---|
| SDK | `@onememory/sdk` | yes |
| Core (types/ports) | `@onememory/core` | yes (advanced embedding) |
| CLI | `onememory` (binary `onemem`) | yes |
| MCP server | `@onememory/mcp` | yes |
| Adapters | `@onememory/adapter-claude`, `-codex`, `-cursor`, `-pi`, `-opencode` | yes |
| Others | internal until stable | no |

`onemem init` scaffolds the config, embedded storage, and registered project. Claude Code and
Codex wiring is project-scoped and opt-in: pass `--with-claude` and/or `--with-codex` to write
their daemon-backed MCP entries, hooks, and project instruction pointers. The generated MCP URL
comes from `daemon.host` / `daemon.port`; `onemem doctor` reports each runtime's wiring and warns
if an explicit `onemem serve --port <n>` override differs from that configured URL. The Phase 1
scaffolds only accept loopback HTTP URLs because the daemon has no authentication.

## Testing layout

- Unit tests: co-located in each package (`*.test.ts`, `bun:test`).
- Integration: `tests/integration/` — pipeline stages against real PGlite + real Postgres
  (docker), both dialect paths exercised (CI matrix: `embedded` / `postgres`).
- E2E: CLI init/doctor wiring tests and daemon HTTP MCP tests live beside their apps; the
  extraction fixture pipeline and temporal retrieval fixtures are separate integration suites.
  A combined transcript-ingest-to-temporal-answer acceptance test remains a Phase 1 gate.
- Benchmarks: `benchmarks/` — token efficiency, retrieval precision/recall, ingestion latency;
  run in CI nightly and on demand; results checked into `benchmarks/results/` for regression diffing.
