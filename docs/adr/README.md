# Architecture decision records

The ADR set for onememory. Statuses: `Accepted`, `Proposed`, `Superseded by ADR-XXXX`. To change
a decision, write a new ADR that supersedes the old one — never edit history silently
(AGENTS.md rule 1).

| # | Decision | Status |
|---|---|---|
| 0001 | [TypeScript/Bun monorepo, Node-compatible packages](0001-stack-runtime.md) | Accepted |
| 0002 | [One Postgres dialect: Docker server default, PGlite embedded (gated), cloud/SaaS](0002-storage-postgres-dialect.md) | Accepted |
| 0003 | [Typed memory model, bi-temporal validity, mandatory provenance](0003-memory-model.md) | Accepted |
| 0004 | [Hybrid token-budgeted retrieval, RRF fusion, explainability](0004-retrieval.md) | Accepted |
| 0005 | [Memory graph in relational tables; staged entity resolution](0005-graph-entity-resolution.md) | Accepted |
| 0006 | [Local-first AI: model router, per-operation routing, zero network by default](0006-local-ai-model-router.md) | Accepted |
| 0007 | [Security & privacy: redact at ingest, no secret storage, opt-in external](0007-security-privacy-provenance.md) | Accepted |
| 0008 | [Code memory via git fingerprints, zero-token drift](0008-code-memory-git-fingerprints.md) | Accepted |
| 0009 | [Skill generation from verified failure/solution patterns](0009-skill-generation.md) | Accepted |
| 0010 | [MCP-first protocol surface + universal adapters](0010-mcp-protocol-adapters.md) | Accepted |
| 0011 | [SaaS path without open-core rot](0011-saas-path.md) | Accepted |

ADR-0010 is grounded in `docs/research/mcp-memory-implementations.md` (MCP 2026-07-28 facts,
per-runtime integration matrix, memory-server survey).

Companion documents: `docs/architecture/` (normative designs), `docs/risks.md` (open decisions),
`docs/plan/phased-plan.md` + `docs/backlog/issues.md` (execution).
