# ADR-0001: TypeScript/Bun monorepo, Node-compatible published packages

Status: Accepted (user decision 2026-10-03) · Date: 2026-10-03 · Supersedes: none

## Context

onememory must ship: a one-command CLI (`npx onememory init`), an MCP server, adapters for
TS-native agent runtimes (Claude Code hooks, Cursor, OpenCode, Pi), a REST API, a web UI, and a
hosted SaaS mode. The ecosystem tools (MCP SDK, agent hooks/skills conventions, npx distribution)
are TypeScript-first.

## Decision

TypeScript monorepo (Bun workspaces). Bun is the dev/test runtime; every published package stays
Node LTS-compatible — no Bun-only APIs in shared library packages; CI runs package tests under
Vitest (Node) plus `bun:test` smoke tests. Strict TS; Zod schemas at every boundary (HTTP, MCP,
adapter events, CLI args).

## Options considered

- **Python** — strongest local-AI ecosystem, but fights `npx` distribution and every agent-runtime
  adapter seam is TS-native; rejected.
- **Rust core + TS edge** — best single-binary story, but MCP SDK immaturity and iteration speed
  cost too much at this stage; rejected (may revisit for a future indexer binary).
- **Polyglot (TS + Python SDK)** — double maintenance before product-market fit; deferred.

## Consequences

- One language across CLI/API/MCP/adapters/UI; adapters reuse SDK types directly.
- Local in-process embedding risk (Bun × ONNX) is isolated to `packages/embeddings` behind the
  `Embedder` port with a worker-process fallback (ADR-0006).
- Heavy ML work stays out-of-process by design: Ollama / LM Studio / llama.cpp over local HTTP.
- Vitest + bun:test dualism adds a little CI config; bought safety for npm consumers.

## References

`docs/research/dependency-verification.md` §5 (Bun/ONNX risk), §17 (test runners);
`docs/architecture/repository-structure.md` (layout + dependency rules).
