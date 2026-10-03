# onememory

**One memory across every agent.**

`onememory` is an open-source, self-hostable, local-first persistent memory engine for AI coding
agents and AI assistants. It gives every agent — Claude Code, OpenAI Codex, Cursor, Pi, OpenCode,
or any MCP-compatible runtime — a shared, low-token, continuously improving memory layer, so agents
arrive knowing your project, its decisions, conventions, failures, and solutions.

> **Status: architecture phase.** No production code yet, by design. The architecture review
> (research, ADRs, schemas, retrieval design, phased plan) is being produced first in `docs/`.
> See [docs/plan/](docs/plan/) for the roadmap.

## Why

Agent memory today is either a giant manually-maintained `AGENTS.md` or a naive vector store that
dumps thousands of tokens of stale, duplicated context into every session. `onememory` is built on
a different premise:

**Memory is not a vector database.** It is a typed knowledge system with a lifecycle.

- **Ten memory layers** — episodic, semantic, procedural, working, project, entity, decision,
  failure, preference, source — instead of one undifferentiated pile of text.
- **An explicit lifecycle** — observe → ingest → normalize → extract → classify → deduplicate →
  entity-resolve → score → store → retrieve → reinforce → consolidate → decay → archive.
- **Temporal truth** — memories carry `valid_from` / `valid_until`; questions like "what Node
  version does this project use?" return the current fact, not every fact ever seen.
- **Token efficiency as a first-class metric** — retrieval packs a token budget with the most
  information-dense memories, not the most numerous.
- **Code memory without re-embedding your repo** — git fingerprints mean unchanged files cost
  zero tokens on re-index; drift marks only affected memories stale.
- **Skills from repeated successes** — verified failure/solution patterns become reusable skills.
- **Local-first** — works 100% offline with no account, no telemetry, and local models
  (Ollama / on-device embeddings). Hosted LLM providers are optional, not required.
- **Postgres-compatible** — same Postgres dialect and schema embedded (no Docker), via Docker
  Compose, or on any cloud / hosted Postgres. Multi-tenant SaaS is a deployment mode, not a fork.

## Package

| | |
|---|---|
| CLI | `onemem` (`npx onememory init`) |
| License | Apache-2.0 |
| Runtime | TypeScript on Bun / Node LTS |
| Storage | Postgres + pgvector (server) · PGlite embedded (local) |
| Protocol | REST + MCP (stdio & Streamable HTTP) |

## Documentation

| Path | Contents |
|---|---|
| `docs/research/` | Landscape research (Supermemory, Mem0, Zep, Letta, MCP memory servers) with primary-source citations |
| `docs/adr/` | Architecture decision records |
| `docs/architecture/` | Memory model, lifecycle, event/memory schemas, database schema, retrieval design, code memory |
| `docs/plan/` | Phased implementation plan |
| `docs/backlog/` | Issue backlog per mission (mirrored to GitHub once the repo is published) |
| `docs/risks.md` | Risks and unresolved architectural decisions |

## Contributing

Read `AGENTS.md` first — it is the operating manual for both human and agent contributors.
