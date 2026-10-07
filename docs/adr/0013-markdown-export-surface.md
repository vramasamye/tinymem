# ADR-0013: Markdown export surface (`onemem export`)

Status: Accepted · Date: 2026-10-07

## Context

Phase 7 Wave B (M18, `docs/plan/phased-plan.md`): the October 2026 comparison
(`docs/research/onememory-vs-external-memory-2026-10.md` §4, gaps 1–2) verified that the
file-camp systems (Cognition AMR, Claude Code auto memory, the Anthropic memory tool) and even
engine-camp peers (Hindsight knowledge pages) expose memory as human-readable, git-diffable
Markdown, while onememory's only windows are the store, the REST/web surfaces, and the CLI. The
borrow list (§5, items 1–2) asks for `onemem export` — a Markdown projection — and a
`MEMORY.md` session-index artifact with Claude Code's load-cap discipline (first 200 lines /
25KB).

## Decision

1. **Canonical-store rule.** The database (PGlite / Postgres) stays the single source of truth.
   Export is a one-way, read-only projection: no import, no sync-back, and no engine path ever
   reads it back. `onemem export` renders and writes; that is the whole contract.
2. **Output layout** — default root `<project root>/memory/`, configurable via `export.dir` in
   the config, overridable with `--dir`:
   - `MEMORY.md` — the session-index artifact: the project digest sections the 750-token session
     context assembles (summary + stack, settled decisions, known failures, procedures), one
     line per entry, ending in an `## Index` of links to the per-type files.
   - `<type>.md` per content type (`episodic.md`, `semantic.md`, `procedural.md`,
     `decisions.md`, `failures.md`, `preferences.md`) — one line per memory: a Markdown link,
     a metadata tail `[status: active; observed: 2026-10-06]`.
   - `memories/<type>/<id>.md` — one file per memory: frontmatter generated only from stored
     data (id, type, subtype, status, title, importance, confidence, observed_at, valid window,
     superseded_by, source URI, agent_id, tags), body (canonical content; decision/failure
     payloads hydrated through the same read path that serves `memory_get`; evidence excerpts
     at their stored ≤200-char bound).
   - Working memory never exports (it is not durable). Every durable status exports (active,
     stale, superseded, disputed, archived) with the status marked, so history stays diffable.
3. **Idempotency and ownership.** Rendering is deterministic: stable sort (type, status order,
   observed_at, id) and no wall-clock anywhere in file content — every timestamp comes from
   data. A re-run over unchanged data is byte-identical. The export owns exactly the files it
   writes, marked `onememory-export: true` in frontmatter; a re-run rewrites owned files and
   prunes owned files whose memory no longer exists. It never touches any other file in the
   directory (the operator may keep their own notes there).
4. **Index-cap discipline.** `MEMORY.md` must stay ≤ 200 lines / 25KB (the Claude Code load
   limit). It is machine-generated, so the renderer keeps it under the cap by construction:
     sections trim in a fixed order (procedures, then failures, then decisions) with a visible
   `(+N more, see the per-type file)` overflow line; if the digest header alone cannot fit, the
   command errors rather than emit an oversized index — fail closed, never silently truncate to
   uselessness.
5. **Where it lives.** The renderer is a pure function in `@onememory/core` (records + digest
   rollup → bytes; no IO, unit-testable, byte-identical by property test). The service (page
   memories via `listMemoryPage`, read the stored `projects.digest` rollup, write + prune) lives
   in `apps/api/src/runtime` beside the skills service. The CLI command follows the digest
   precedent: it refuses while a daemon owns the data dir (no REST export endpoint yet) and
   runs direct-mode otherwise.
6. **Security and privacy.** Export writes exactly what the store holds — content already
   passed ingest-time redaction, and evidence excerpts keep their stored bound. The export root
   is inside the project tree by default, so committing it is the operator's explicit choice;
   the writer never writes outside the resolved root.

## Consequences

- onememory gains the trust surface every peer already has: the operator can `git diff` their
  memory, read it without the web UI, and keep it under version control.
- Store/export drift is impossible by construction (one-way, deterministic, pruning); running
  export on a schedule or in CI is safe.
- The capped `MEMORY.md` is usable as an always-loaded session artifact for runtimes that want
  file-shaped memory (the AMR / Claude Code pattern); adapters keep injecting the
  engine-assembled session context, which this file mirrors rather than replaces.
- Non-goals until the direct-mode surface is proven: an export REST endpoint, daemon-side
  scheduling, `--watch` mode, and any agent-editable read-back path.
- Cost: a directory inside the operator's project; the default root is `memory/` and the
  command writes only inside it.

## References

`docs/plan/phased-plan.md` Phase 7 Wave B (M18); `docs/research/onememory-vs-external-memory-2026-10.md`
§4 gaps 1–2, §5 items 1–2, §7 decisions; `docs/research/external-memory-systems-2026-10.md` §1
(AMR one-line bullets, `[source; added]` metadata, `[[path]]` links), §4b (the 200-line / 25KB
cap with error-forcing rewrite), §3 (Hindsight knowledge pages "as ordinary markdown");
ADR-0003 (statuses, provenance), ADR-0002 (backend resolution), ADR-0009 §5 (the file-write
precedent: configurable root, canonical path identity).
