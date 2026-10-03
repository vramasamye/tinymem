# ADR-0005: Memory graph in relational tables; staged entity resolution

Status: Accepted · Date: 2026-10-03

## Context

Spec §10 requires a lightweight relationship graph (`related_to`, `depends_on`, `caused_by`,
`solved_by`, `decided_by`, `supersedes`, `contradicts`, `derived_from`, `belongs_to`, `used_by`,
`modifies`) without Neo4j (§17). Entity resolution is lifecycle stage 7; wrong merges corrupt
retrieval for years.

## Decision

1. **Edges are relational rows** (`edges` table, unique per (from, to, relation)) with **edge-level
   bi-temporal validity** (`valid_from`/`valid_until`): contradiction marks the old edge invalid —
   the Zep pattern, in SQL instead of Cypher. Traversal is index-backed 1–2 hops for ranking;
   `WITH RECURSIVE` for deeper questions and timeline reconstruction.
2. **Entity resolution is staged, conservative, and reversible**:
   - Deterministic blocking first: normalized name (NFC, casefold, alias table) within
     project scope; global entities (PostgreSQL, Docker) resolved across projects with lower
     confidence.
   - Embedding similarity over entity names/descriptions proposes candidates.
   - LLM merge decision is OPTIONAL (local mode: threshold rules only). Merges below the auto
     threshold create `unresolved` candidates, surfaced in the UI's quality dashboard for human
     review. Merges are never destructive: `merged_into` pointer, aliases preserved.
   - **Dedupe/fact comparison is constrained to the same entity pair** (Zep §2.2.2) — prevents
     cross-entity false merges.
3. **No community clustering initially** (Louvain/Leiden): dependency research found the
   graphology community modules low-cadence, and label-propagation clusters are partitions, not
   identity evidence. Revisit after graph structure and evaluation show a need.

## Consequences

- No graph-DB dependency to install (local-first win); queries stay in Postgres.
- Entity registry becomes retrieval-critical infrastructure → covered by conformance tests and
  the quality dashboard.
- Entity names in `content` keep working even if resolution fails (lexical channel unaffected).

## References

`docs/research/memory-systems-landscape.md` adopt-item 6, avoid-items 4, 8;
`docs/research/dependency-verification.md` §13; Zep paper §2.2 https://arxiv.org/abs/2501.13956 ;
`docs/architecture/database-schema.md` (entities/edges DDL).
