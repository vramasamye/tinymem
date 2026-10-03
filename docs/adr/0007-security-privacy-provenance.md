# ADR-0007: Security & privacy — redact at ingest, no secret storage, opt-in everything external

Status: Accepted · Date: 2026-10-03

## Context

Spec §26/§27: memory can contain secrets; never store API keys, passwords, private keys, OAuth
tokens, session cookies unless explicitly configured; 100% local mode must exist. The landscape
shows the failure mode to avoid: MIRIX's knowledge vault stores `api_key` values with sensitivity
tiers — a liability for a coding-agent memory engine; and Graphiti ships opt-out telemetry,
which contradicts a privacy-positioned product.

## Decision

1. **Detect-and-redact at ingest, before anything else touches the payload** — the earliest
   lifecycle point (between OBSERVE and INGEST), enforced in `packages/security`:
   - Patterns: API keys (provider formats), bearer tokens, passwords in URLs/commands/env vars,
     private key blocks, connection strings with credentials, `.env`-style assignments.
   - Redaction record stores kind + JSON-path location + length ONLY. **Taint tests** assert secrets
     never reach DB payloads, logs, LLM prompts, or embeddings — the invariant is testable CI.
   - `.env*`, key/credential files, and configurable path globs are excluded from ingestion entirely.
2. **No secret vault, off-by-default, ever**: unlike MIRIX, onememory does not persist secret
   values under any flag in v1. If a user explicitly wants a pointer, they store a *reference*
   ("DB URL is in 1Password: item X") — redact-and-point, not store.
3. **Project/user isolation at the storage layer**: every retrieval path is scope-filtered
   (already enforced by schema + repository layer); tests enumerate cross-scope leak scenarios.
   Memory-level ACLs arrive in Phase 3 (backlog M12.5) without schema breakage (policy table).
4. **100% local mode is a profile, not a setting**: `local` profile asserts zero outbound network —
   enforced by a CI integration test that runs the full pipeline with networking disabled.
5. **Telemetry opt-in, minimal**: none in `local` profile; self-host/SaaS modes ask. Hosted
   rerankers/LLMs require explicit opt-in and are labeled with data-flow warnings.
6. **Provenance is the audit backbone** (spec §32): every durable memory carries source + evidence
   spans; `memory_events` is an append-only audit of every state change. This is also the
   security story: any claim the engine makes is inspectable.

## Consequences

- Redaction false-positives are possible (a redacted-looking token in prose) — acceptable direction
  of error; UI exposes what was redacted (kind + location, never content).
- Adapters never trust runtime transcripts to be clean — redaction runs on the engine side of
  every event boundary regardless of source.
- SaaS mode inherits all of this; org isolation adds RLS (ADR-0011).

## References

`docs/research/memory-systems-landscape.md` avoid-items 8–9 (secrets, telemetry);
`docs/architecture/event-memory-schemas.md` §1 (Redaction), §7 (redaction invariant);
`docs/architecture/memory-model.md` §6; backlog M12.
