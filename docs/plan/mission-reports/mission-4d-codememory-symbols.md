# Mission 4d: code-memory symbols (fourth M4 slice)

Branch: `mission/4d-codememory-symbols` · Base: `d279e06` · ADR: `0008-code-memory-git-fingerprints.md`

## Delivered scope

ADR-0008's symbol tier now exists end to end — extraction, persistence, and the only-changed
re-extraction primitive:

- **Extraction** (`packages/codememory/src/grammar.ts`, `declarations.ts`, `symbols.ts`):
  `extractSymbolTable(root)` parses the worktree's source files with tree-sitter and returns one
  `SymbolFile` per parsed path — `symbols` (name, kind, normalized signature, line span,
  `span_hash`), `parse_errors` (ERROR-node count), `language`, `symbols_hash` — plus a
  `skipped` list with a structured reason per path. `extractSymbolTable(root, { files })` is the
  scoped mode: re-extract exactly the drift-flagged paths, skip everything else.
- **Persistence** (port extension, no new port): `CodeMemoryStore` gained
  `saveSymbolTable(repositoryId, { files })` and `loadSymbols(repositoryId, { paths? })`, with Zod
  inputs in `core/src/schema/persistence.ts` and SQL in
  `storage/src/repositories/code-memory.ts`. Writes go to the existing `code_symbols` table
  (migration 0000 — no migration needed in this slice) and stamp the per-file `symbols_hash`
  onto the path's worktree-tier `file_fingerprints` row. `saveSnapshot` now prunes `code_symbols`
  rows whose worktree-tier fingerprint anchor died in the capture: symbols never outlive their
  evidence.
- **Rewrite guard**: `saveSymbolTable` compares each incoming table's `symbols_hash` against the
  persisted one inside one transaction and rewrites only genuinely changed files
  (delete + insert per path, chunked). Identical tables are reported `unchanged` and never
  touched — rows keep their `updated_at`. The result is `{ repository, rewritten, unchanged }`.

## Tree-sitter approach (offline, no native build)

Per the dependency-verification §9 verdict: **`web-tree-sitter` 0.27.0** (WASM runtime, no OS
addon) plus the prebuilt grammar packages `tree-sitter-typescript` 0.23.2 (TS + TSX),
`tree-sitter-javascript` 0.25.0, `tree-sitter-python` 0.25.0, `tree-sitter-go` 0.25.0, and
`tree-sitter-rust` 0.24.0, all pinned exact. Verified concretely:

- Every grammar package ships its prebuilt `.wasm` in the published tarball; `bun install`
  performs **no compilation at all** — Bun blocks the grammar packages' `install: node-gyp-build`
  scripts (`bun pm untrusted` reports none trusted/run), and `find` confirms zero `.node`
  artifacts under any tree-sitter package.
- The core runtime WASM resolves through `web-tree-sitter`'s exported `web-tree-sitter.wasm`
  subpath (`Parser.init({ locateFile })` with a literal `require.resolve`); grammar bytes are read
  from the installed packages via six literal `require.resolve('tree-sitter-*/...wasm')` calls —
  nothing is fetched at install or runtime. The grammar packages have no `exports` map, so the
  wasm files are resolvable subpaths, and the literals give bundlers a static asset reference.
- The offline invariant is pinned by a test running the full extraction under the
  `@onememory/security` network guard: zero network calls, extraction succeeds.
- Runtime support: Bun-from-source is the repo's supported runtime (the whole suite proves it).
  Node LTS compatibility is proven by a bundled smoke — `bun build --target=node`, executed by
  Node 26.1.0 from the installed package tree, extracts symbols correctly; an artifact moved
  away from its `node_modules` fails honestly with `runtime_unavailable`/`grammar_unavailable`
  skip reasons rather than fake results. All runtime imports are plain `node:*` APIs.

## Symbol vocabularies

| Language | Kinds extracted |
| --- | --- |
| TypeScript / TSX / JavaScript | `function`, `method`, `class`, `interface`, `type`, `enum`, `module` |
| Python | `function`, `class` |
| Go | `function`, `struct`, `interface`, `type` |
| Rust | `function`, `struct`, `enum`, `trait`, `impl`, `module` |

Declarations only — no statement-local bindings. Signatures are canonical single-space token
renderings capped at 240 chars; ambient TypeScript declarations
(`declare function`/`declare module`) are skipped; tree-sitter ERROR nodes are counted per file
and clean declarations under a partially broken tree still extract.

## Hash semantics (the drift contract for symbols)

- **`span_hash`** — SHA-256 over the declaration's normalized token stream (comments excluded,
  whitespace collapsed, domain-prefixed `onememory.symbol-span.v1`). Pinned by tests: adding or
  editing comments, reindenting, or switching CRLF/LF never moves a hash; editing real tokens
  moves that symbol's hash and leaves siblings untouched.
- **`symbols_hash`** — SHA-256 over the ordered symbol table **including line positions**, so a
  line shift is a real change (it invalidates persisted positions), while a cosmetic-only edit
  keeps the file's hash and its rows. This is exactly what the storage rewrite guard consumes.

## Only-changed re-extraction (the primitive, no job/queue)

The slice ships the primitive the pipeline will drive, not an orchestrator. The end-to-end test
over real `createEmbeddedDb` PGlite runs the intended loop:

1. `captureSnapshot` → `saveSnapshot` (persisted anchors).
2. `extractSymbolTable(root)` → `saveSymbolTable` (persisted tables, hash stamped on
   fingerprints).
3. Edit two files — one real (token) change, one comment-only — `captureSnapshot` →
   `saveSnapshot` → `detectChanges` (equivalently `detectDrift` over persisted state).
4. `extractSymbolTable(root, { files: changedPaths })` → `saveSymbolTable`: the changed file's
   rows are replaced (delete + insert), the cosmetic-only file is reported `unchanged` and keeps
   its rows, files outside the change set are never read or touched.

## Skip reasons (honesty over silence)

`excluded`, `conflict`, `symlink`, `submodule`, `binary`, `too_large`, `missing`, `unreadable`,
`unsupported_language`, `grammar_unavailable`, `outside_root` — one structured reason per path,
mirroring fingerprint capture's conventions. Extraction reuses the capture's scan machinery
(`scanWorktree`, `createPathFilter`, `resolveRepositoryRoot` — factored out of `fingerprints.ts`
into shared helpers rather than duplicated): the same Git probe, the same exclusion policy and
`.onememory`/dependency/generated-directory ommissions, the same conflict-stage detection, and
the same bounded reads with stat/read race detection. Unparseable or unavailable paths never
produce fake empty tables.

## Persistence details

- One `saveSymbolTable` transaction per call: anchor validation (`NotFoundError` when the
  repository or a path's worktree fingerprint is missing — symbols never attach to a dead
  anchor), `FOR UPDATE` on the fingerprint rows, per-file hash comparison, delete + insert of
  changed paths in chunks, and a single `symbols_hash` UPDATE on the surviving worktree-tier
  fingerprint rows.
- `loadSymbols` returns rows in document order, optional path filter, `repository_id` on every
  row.
- Boundary validation: duplicate paths, malformed hashes, non-UTF-8-relative paths, and empty
  input reject with `ValidationError` before any SQL; the port header documents the anchor
  invariant (symbol rows die with their worktree fingerprint — implemented by the `saveSnapshot`
  pruning and pinned by the storage integration scenario).

## Dependency reuse

No reinvention: parsing is tree-sitter's (§9 verdict), hashing and bounded reads reuse the
capture's utilities, persistence follows the M4b/M4c port-and-repository pattern (Zod in core,
SQL in storage, transactions, chunked writes), and drift wiring reuses `detectChanges` /
`detectDrift` untouched. New third-party dependencies are exactly the §9-adopted set, pinned
exact; `bun.lock` changes are confined to those additions.

## Validation

- All three touched packages typecheck clean under strict TS: `core`, `storage`, `codememory`.
- `packages/codememory`: **43 pass / 1 skip / 0 fail** (44 tests — the skip is the expected
  Linux-only non-UTF-8 filename fixture on macOS). The 13 new symbol tests cover: the offline
  invariant under the network guard; the TS declaration surface (exact spans, signatures,
  kinds); span-hash cosmetic stability and real-edit movement; position-sensitive
  `symbols_hash`; the JS/Python/Go/Rust vocabularies; TSX; parse-error counting; exclusion
  conventions; honest unavailability; root/broken-Git validation; conflicted paths; the
  real-storage only-changed end-to-end loop above; and `saveSymbolTable` boundary rejections.
- `packages/storage` embedded leg: **25 pass / 18 server-gated skips / 0 fail** (43 tests),
  including the new `codeMemorySymbolsScenario` (scoped replacement, rewrite guard, hashes on
  fingerprints, anchor pruning — including that the emptied-file case saves an empty table and
  that a dead anchor rejects).
- Server leg (Docker `pgvector/pgvector:pg17` on 127.0.0.1:55433, container removed after the
  run): storage suite **41 pass / 0 fail** (505 assertions) with both legs enabled — the new
  scenario passes on real Postgres too.
- Full worktree suite: **924 pass / 20 skip / 0 fail** (944 tests, 71 files) against the
  910/19/0 baseline; the +14/+1 deltas are the 13 symbol tests plus the new embedded scenario
  (pass) and its server-gated twin (skip without `ONEMEMORY_PG_URL`).
- Node LTS smoke: `bun build --target=node` bundle executed by Node 26.1.0 extracts symbols
  correctly from the installed package tree (see above).

## Explicitly not complete

Still pending in M4 (later slices, not placeholders here): symbol-level drift comparison
(matching extracted symbols against persisted rows beyond the per-file guard — e.g. renames of
symbols within unchanged hashes), audited stale-memory application, `memory_code_refs`
retargeting, minimal re-index jobs (`drift_scan`/`reindex` job kinds exist; nothing enqueues
them — the primitive ships, the orchestration does not), checkpoint advancement
(`last_ingested_commit` still never moves), and architecture digests. The symbol domain does not
yet include call-site references, imports/exports graphs, or non-declaration bindings — those
were never in the ADR's symbol vocabulary. The coordinator-owned `docs/architecture/` already
describes `code_symbols` and `file_fingerprints.symbols_hash` as built (migration 0000); this
mission links to it rather than editing it.
