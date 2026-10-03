# ADR-0011: SaaS path without open-core rot

Status: Accepted (user direction: host-it-ourselves like Supermemory/Mem0) · Date: 2026-10-03

## Context

Spec §34: permissive license, no artificial limitations in the open-source version, proprietary
cloud functionality kept separate; the user explicitly wants a hosted SaaS as one deployment mode.
The competitive landscape shows two SaaS shapes: Supermemory (open storage/search, closed
extraction model + control plane) and Mem0 (Apache-2.0 core, closed "platform optimizations" —
their best benchmark numbers are platform-only).

## Decision

1. **One engine, one schema, all profiles** (`local` / `server` / `cloud`): the hosted offering is
   the same Apache-2.0 code running multi-tenant. Tenancy is **additive**: an `orgs` table +
   `org_id` columns (one migration, default org for legacy rows) + Postgres RLS policies in the
   SaaS profile. Every query path already scopes by `project_id`/`user_id` — no redesign.
2. **What may be closed is operations, not intelligence**: billing, multi-tenant control plane,
   managed connectors, team sync, support — infrastructure services may be closed. **The memory
   engine itself — extraction, retrieval, consolidation, skills — stays fully open.** No
   "production-ready version is licensed" split (cognee's pattern) and no platform-only quality
   (Mem0's pattern): OSS benchmarks must be reproducible from the Apache-2.0 tree.
3. **Diff billing** (Supermemory's cost mechanic, where applicable): re-ingesting the same document
   content with the same `customId`-equivalent hash costs only the delta — our `content_hash`
   dedupe already gives this for free.
4. **Local-first guarantees are CI-enforced forever** (R11): the no-network test and the embedded
   profile stay in the matrix; a PR that breaks local mode for SaaS convenience is wrong.

## Consequences

- Schema reviews must keep scope columns on every new table (checklist item).
- SaaS profile tests (RLS isolation between orgs) added when tenancy migration lands (post-1.0).
- Marketing benchmark claims must state judge model, harness, and retrieval budget (landscape
  open-question 12 — every competitor's numbers are otherwise noise).

## References

`docs/research/supermemory.md` (two-plane model, pricing/diff billing, open/closed boundary);
`docs/research/memory-systems-landscape.md` avoid-item 10, open-questions 2/12;
`docs/architecture/database-schema.md` §3 (tenancy path); `docs/risks.md` R11.
