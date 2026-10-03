# Build vs. reuse — what onememory owns, what it borrows

Status: draft for architecture review · Implements spec §37 (never reinvent mature infrastructure)

Full version-by-version evidence: `docs/research/dependency-verification.md` (all verdicts with
sources). This is the architectural summary.

## What onememory OWNS (the differentiators — nobody else ships this combination)

| Capability | Why it's ours |
|---|---|
| Memory model & lifecycle | 7 content types + 3 structural layers, 14-stage pipeline, status machine, provenance invariants (ADR-0003) |
| Temporal model & supersession | bi-temporal columns, `superseded_by` chains, point-in-time queries (ADR-0003) |
| Dedupe / contradiction / authority resolution | exact-hash → embedding → entity-pair-constrained comparison → authority order (ADR-0003/0005) |
| Hybrid retrieval orchestration | 3 channels + RRF + weighted scoring + token-budget packing + explain (ADR-0004) |
| Entity resolution policy | staged, conservative, reversible merges (ADR-0005) |
| Code-drift mapping | git fingerprints → affected memories → minimal re-index (ADR-0008) |
| Skill generation & verification gate | failure recurrence → candidate → review → SKILL.md (ADR-0009) |
| Event schema & adapters | the universal `OnememoryEvent` contract + 5 runtime translators |
| MCP tool semantics | the 11 memory tools over the SDK (ADR-0010) |
| Benchmarks & golden dataset | spec §25 metrics with pinned judge/harness/budget |
| Redaction policy | patterns, taint tests, redact-and-point (ADR-0007) |

## What onememory REUSES (mature dependencies, no NIH)

| Concern | Chosen dependency | Verdict |
|---|---|---|
| Server DB + vectors | PostgreSQL + pgvector (HNSW) | adopt |
| ORM + migrations | Drizzle (pgvector + PGlite adapters), committed SQL | adopt |
| Embedded DB | PGlite + pglite-pgvector | **evaluate behind gate** (ADR-0002); sqlite-vec only as escape hatch |
| LLM abstraction | Vercel AI SDK v6 behind our `ModelProvider` interface | adopt |
| Local embeddings | Ollama `/api/embed` (preferred) · transformers.js v4 + bge-small (gated) | adopt / gated |
| MCP protocol | official TS SDK v2 split packages | adopt (Bun transport smoke first) |
| REST + OpenAPI | Hono + `@hono/zod-openapi` | adopt |
| CLI | Commander + `@clack/prompts` | adopt |
| Code parsing | `web-tree-sitter` + pinned grammars | adopt |
| Git | system git via argument-safe subprocess | adopt (no isomorphic-git) |
| PDF / HTML / MD / CSV | unpdf / cheerio (+readability) / unified+remark / papaparse | adopt |
| Jobs | own Postgres jobs table + worker loop | adopt (pg-boss at scale) |
| Tests / benchmarks | Vitest (Node) + bun:test smoke / tinybench | adopt |
| Reranking | none by default; opt-in adapter (local cross-encoder or hosted) | defer |
| Graph clustering | none initially | defer |

## Explicitly NOT built (rejected, with reasons)

- A vector database service (Qdrant/LanceDB/Chroma) — pgvector covers all three profiles; no
  second system to install (spec §17; Mem0/cognee/memU converge on Postgres+pgvector).
- A graph database — edges + recursive CTEs at our scale (ADR-0005).
- A custom MCP implementation — official SDK.
- A custom LLM client abstraction — AI SDK behind a thin internal interface.
- An embedding model — pinned open models via providers.
- A job queue service — a table + worker loop until proven insufficient.
- Community clustering (Louvain/Leiden) — partitions are not identity evidence; low-cadence JS modules.
- OAuth in v1 for local stdio MCP — needed only in hosted mode (M5.5, Phase 4).

## Rules going forward (enforced in review)

1. Any new dependency needs a slot in `dependency-verification.md` (maturity, license, Bun compat,
   verdict) — added by the mission that proposes it, before the dependency enters `package.json`.
2. Model weights and native/wasm artifacts are dependencies too: license + revision pinned in the
   model catalog.
3. "Evaluate" verdicts carry an acceptance test in the owning mission (PGlite's is in backlog M1.5).
