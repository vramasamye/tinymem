# AGENTS.md — operating manual for agents and humans working on onememory

`onememory` (CLI: `onemem`) is an open-source, self-hostable, local-first persistent memory engine
for AI coding agents. This file is the contract every contributor — human or AI — follows.

## Ground rules (apply to all work)

1. **Architecture-first.** Production code lands only after the architecture review in `docs/` is
   approved. ADRs in `docs/adr/` are the source of truth for decisions; code must not contradict
   them. To change a decision, write or amend an ADR first, then code.
2. **Reuse before building.** Before implementing any feature, search this repo and the open-source
   ecosystem for a mature existing implementation (see `docs/research/dependency-verification.md`).
   We own the memory model and orchestration logic. We do not reinvent vector search, embeddings,
   parsers, git tooling, AST parsing, reranking, OAuth, or database migrations.
3. **No placeholder implementations.** Nothing that "will later require an architectural rewrite".
   If a component cannot be built properly within its scope, cut the scope — do not fake the
   component.
4. **Local-first invariant.** The default install must work fully offline: no account, no
   telemetry, no external AI API calls. Hosted providers (OpenAI/Anthropic/Gemini/…) are optional
   paths behind the model router. Any change that breaks this invariant is wrong.
5. **Postgres dialect only.** All SQL is Postgres-flavored and must run on PGlite (embedded mode),
   Docker Postgres + pgvector (server mode), and hosted Postgres (cloud/SaaS). No raw SQL outside
   `packages/storage`. Schema changes ship with migrations, never destructive without a path.
6. **Secrets never enter memory.** Ingestion redacts credentials by default; `.env` and key files
   are excluded. Never commit secrets, API keys, session transcripts with credentials, or logs.
7. **Token efficiency is a feature, not a nice-to-have.** Retrieval APIs default to token budgets.
   Regressions in tokens-per-answer are treated as benchmark failures, not style issues.
8. **Provenance is mandatory.** No durable memory may be created without a source and evidence.
   If the pipeline cannot attribute a memory, it stays in working memory, not durable memory.

## Mission discipline (parallel agents)

- One mission = one branch = one bounded scope. Branch naming: `mission/<n>-<slug>`
  (e.g. `mission/2-retrieval-engine`).
- Missions must not modify the same files. Files under `docs/adr/`, root configs (`package.json`,
  `AGENTS.md`, `README.md`, `LICENSE`), and `docs/architecture/` are owned by the coordinating
  session; missions link to them, they do not edit them.
- Every mission ends with: tests green (`bun test`), docs updated, no TODOs in shipped code, and a
  report covering what changed and what it depends on.
- Every core component ships with unit tests + integration tests; benchmarks where performance is
  a goal; a migration for any schema change.

## Engineering conventions

- **Runtime:** Bun for install/test/dev. Published packages stay Node LTS-compatible.
- **Language:** TypeScript strict mode. Zod schemas validate every external boundary (HTTP, MCP,
  adapter events). No `any` at package boundaries.
- **Layout:** see `docs/architecture/repository-structure.md`. The engine core
  (`packages/core`, `packages/memory`) must never import agent-runtime-specific code — adapters
  depend on core, never the reverse.
- **IDs:** UUIDv7 everywhere; time-ordered and index-friendly.
- **Commits:** conventional, imperative (`feat:`, `fix:`, `docs:`, `test:`, `perf:`).
- **Docs:** architecture in `docs/architecture/`, cited research in `docs/research/`, plans in
  `docs/plan/`, issues backlog in `docs/backlog/`, risks in `docs/risks.md`.

## What "done" means

A new developer runs `npx onememory init`, then `onemem doctor`, opens Claude Code / Codex /
Cursor / Pi / OpenCode in their project — and the agent already knows the project's architecture
decisions, conventions, past failures, and solutions, with minimal injected tokens, zero
hand-maintained `AGENTS.md` bookkeeping, and zero cloud dependency.
