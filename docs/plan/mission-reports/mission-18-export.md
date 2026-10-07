# Mission 18: Markdown export surface (ADR-0013)

Branch: `mission/18-export` · Base: `3acaebf` (main) · Closes the M18 row of Phase 7 Wave B
(docs/plan/phased-plan.md) · Decision record: docs/adr/0013-markdown-export-surface.md (accepted
on main before the branch opened).

## Scope delivered

The 1.0 trust surface from the external-memory comparison (§5 items 1–2): a readable,
git-diffable projection of everything the engine claims about a project, produced by
`onemem export` and never read back.

1. **Pure renderer** — `renderProjectExport` (`packages/core/src/types/export.ts`): the
   complete ADR-0013 layout — `MEMORY.md` (digest header, settled decisions / known failures /
   procedures sections, per-type index), one status-grouped `<type>.md` index per present type,
   and one `memories/<type>/<id>.md` file per memory with frontmatter provenance (ownership
   marker, id/type/status/title/importance/confidence/observed/valid window/superseded_by/
   agent/tags/source), hydrated payload sections (decision: alternatives with rejection reasons,
   rationale, participants, status; failure: problem/context/root cause/solution/verification/
   occurrences; skill: the skill card), and evidence bullets (`"excerpt" (kind, locator)`).
   Deterministic by construction: stable sort (type → status → observed → id), no wall clock,
   byte-identical across renders and independent of input order (test-pinned).
2. **Caps, fail closed** — `MEMORY.md` stays under 200 lines / 25,600 bytes by whole-line
   trimming in a fixed order (procedures → failures → decisions), each trim visible as
   `(+N more, see [<type>.md](<type>.md))`; when the skeleton alone cannot fit, the renderer
   throws `ExportCapExceededError` (never a silent truncated export).
3. **Config section** — `export.dir` (`packages/config/src/schema.ts`): the default root for
   `onemem export`. Absent → `<project root>/memory`. `~/…` resolves against HOME,
   project-relative against the project root. Wired into `RootShape` with an empty default and
   documented in the init template.
4. **Export service** — `exportProject` (`apps/api/src/runtime/export-service.ts`): pages the
   project's durable memories through `searchRepo.listMemoryPage` (the same keyset read the typed
   lists use) and hydrates each row via `memoriesRepo.getMemory` — the canonical read path that
   batch-fills entities AND the typed payload rows (the search projection carries neither).
   Root resolution: the CLI flag wins, then the config section, then `<project root>/memory`;
   every durable status is in scope (working memory never exports — it lives in a separate
   store). Writes are pure renders of the store; the prune pass deletes only files carrying the
   ownership marker (`onememory-export: true`) that are no longer wanted, and removes only the
   directories that pruning emptied — operator files in the export tree are untouchable. A cap
   overflow surfaces as a `BackendError` with an actionable message, not a raw renderer error.
5. **CLI** — `onemem export [--dir <path>] [--project <id>] [--json]`
   (`apps/cli/src/commands/export.ts`, registered in `bin.ts` after `digest`). Direct mode only:
   while a live daemon owns the data dir the command refuses (`conflict`), the digest precedent —
   the REST API exposes no export endpoint yet. `--json` emits the report document; human mode
   prints the summary plus the one-way-projection reminder.

## Acceptance criteria vs delivered

| AC (Wave B DoD) | Delivered |
| --- | --- |
| Every durable memory renders with provenance | Yes: 4 service tests + 5 renderer tests assert frontmatter fields, payload sections, evidence bullets, and source URIs from real embedded storage |
| A re-run is byte-identical | Yes: deterministic sort + no wall clock; the service test snapshots every file and compares after a re-run; the CLI test does the same through the binary |
| Nothing reads the export back | Yes: enforced by shape — the service only writes; no read path exists for export files anywhere in the codebase |
| The index stays under its cap or the writer errors | Yes: renderer cap tests (trim order, visible overflow, fail-closed `ExportCapExceededError`); the service maps it to an actionable `BackendError` |

## Design decisions

- **Two-step read, canonical hydration.** `listMemoryPage` gives keyset-ordered ids but its
  search projection has no payload join, and the export renders payloads — so the service re-reads
  each id through `getMemory`, which batch-fills entities and payload rows. One extra read per
  memory on a one-shot, offline command; correctness over micro-perf, and no second SQL surface
  (reuse, not a divergent query).
- **No special cases in scope.** Every durable memory of the project exports — including the
  digest pass's own `project_context` semantic row (visible with full provenance in `semantic.md`).
  Excluding it would need a filter rule the ADR never sanctioned; duplication with the
  `MEMORY.md` header is honest and self-explaining.
- **The ownership marker is the only prune license.** A stale file is removed iff it carries
  `onememory-export: true` and is not in the wanted set. An operator's `NOTES.md` placed inside
  the export tree survives every re-run (test-pinned at both the service and CLI layers).
- **Root resolution is total and honest.** flag → config → `<project root>/memory`; `~` against
  HOME; relative against the project root; a project with no filesystem root and no configured
  dir fails closed (`invalid_request`), never a guess.
- **Alternatives render as option objects.** The wire/store decision payload carries
  `alternatives: [{ option, why_rejected? }]`; the renderer's first cut treated them as strings
  and silently dropped real payloads. Fixed to render `- Qdrant (rejected: a second system to
  run)` — the rejection reason is the interesting half.

## Validation

- `packages/config`: all pass, including the 2 new `export.dir` tests (project-relative, `~/`,
  and the empty-section rejection).
- `packages/core`: all pass, including 5 renderer tests + the alternatives-object assertions.
- `apps/api`: `export-service.test.ts` 4 pass / 0 fail over real embedded PGlite (tree shape,
  idempotence + prune, default root + `not_found`, config root + `~` expansion + flag wins).
- `apps/cli`: `export-command.test.ts` 3 pass / 0 fail end-to-end through the real binary
  (init → remember ×3 → digest → export, prune + idempotence, `--dir` override + human mode,
  refusal without a project).
- `tsc --noEmit` clean for core, config, api, cli.
- Full repo `bun test`: **2073 pass / 51 skip / 0 fail** (2124 tests across 185 files), up from
  2059 — the 14 new tests of this mission, zero regressions.

## Files changed

New:
- `packages/core/src/types/export.ts`, `export.test.ts` (renderer, caps, ownership contract)
- `apps/api/src/runtime/export-service.ts`, `export-service.test.ts`
- `apps/cli/src/commands/export.ts`, `apps/cli/src/export-command.test.ts`
- `docs/plan/mission-reports/mission-18-export.md` (this report)

Modified:
- `packages/core/src/index.ts` (exports the export module)
- `packages/config/src/schema.ts`, `defaults.ts`, `config.test.ts` (the `export` section)
- `apps/api/src/runtime/index.ts` (exports the export service)
- `apps/cli/src/bin.ts` (registers `export` with `--dir`)
- `docs/plan/phased-plan.md` (Wave B status)

## Commits

- `bfa51b8` feat(core): add the pure Markdown export renderer (ADR-0013)
- `c97971f` feat(config): add the export section naming the Markdown export root
- `79cd140` fix(core): render option-object decision alternatives in the export files
- `6d578c1` feat(api): add the export service over the canonical read path
- CLI + docs commits follow this report.

## Coordinator follow-ups

1. A REST `POST /v1/projects/:id/export` endpoint + daemon-side export scheduling (the CLI
   refusal message already names this as the planned follow-up).
2. Wave B remainder: M17 (scope & identity wiring) and M16 (npm publish prep; ask before the
   real publish).
3. Consider a security note in the docs: frontmatter values are YAML-escaped by the renderer
   (`yamlScalar`), but the export tree is a generated artifact — never hand-edited into trust.
