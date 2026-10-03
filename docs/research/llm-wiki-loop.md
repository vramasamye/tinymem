# Research: llm-wiki-loop and zero-token code-drift patterns

Research date: 2026-10-03. Purpose: ground onememory's codebase-memory subsystem
("zero-token code-drift: never re-embed/re-analyze unchanged source; git fingerprints
map diffs to stale memories") in what llm-wiki-loop actually does, plus the closest
proven patterns. All claims cite their source URL.

## Summary

- **llm-wiki-loop is publicly findable and was analyzed from primary sources** (repo, SPEC, verification engine source, skill protocol, audit log). It is `PALAN-K/llm-wiki-loop` on GitHub (npm: `llm-wiki-loop`, CLI `llm-wiki`), an MIT-licensed, single-author, ~13-star "reference architecture for LLM-maintained knowledge vaults" at v1.3.2 (2026-08-21). Sources: https://github.com/PALAN-K/llm-wiki-loop , https://www.npmjs.com/package/llm-wiki-loop
- Its "0-token code drift detection" is real and simple: wiki pages carry a **`Fingerprint: git:<commit>` header plus a `Monitored: <paths>` list**; a Python checker runs **`git diff --name-only <hash> -- <paths>`** (or per-file SHA-256 comparison in non-git mode) and marks the page drifted — no LLM tokens involved in detecting drift. Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md (§4.5), https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py
- The zero-token claim covers **detection only**. Re-generation is not automatic: drifted pages get `Status: Outdated`, an agent (LLM) re-verifies them, and the fingerprint is manually bumped to a fresh commit — their own log shows bumps like `git:a8d384c -> git:1a8ecc1`. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/log.md
- Its real-world failure modes are instructive for us: shallow git clones (CI `fetch-depth: 1`) break commit-hash fingerprints ("invalid hash"); the checker **silently skips** drift checks outside a git repo; fingerprints are **page-level and hand-curated**, not symbol-level or automatic. Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/log.md , https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py
- Adjacent proven patterns confirm the design space: Sourcegraph's SCIP replaced LSIF's global opaque IDs partly to unblock **incremental indexing (re-index only changed files)**; GitHub's stack-graphs did build-free incremental name resolution (repo archived 2025-09); Bazel/Turbo use content-addressed action/input hashes to skip unchanged work; tree-sitter tags/ast-grep give deterministic symbol extraction; CodeDrift ships session-aware reads (re-reads return "unchanged" or a unified diff). Sources cited per pattern in Findings below.
- Net for onememory: adopt llm-wiki-loop's **per-memory `Fingerprint` + `Monitored` declaration and mechanical `git diff`-based drift detection**, but upgrade it with Turbo-style content hashing (survives non-git/shallow-clone cases), a stored index mapping file→memories (llm-wiki-loop scans pages every run), symbol-level spans via tree-sitter (llm-wiki-loop is page-level), and rename-aware staleness (`git diff -M`) which llm-wiki-loop lacks.

## llm-wiki-loop: what it is (or: why it could not be found)

**Found.** Discovery: GitHub repository search for `llm-wiki-loop` returns the canonical repo first: https://github.com/search?q=llm-wiki-loop&type=repositories . It also exists as npm package `llm-wiki-loop` v1.3.2 (15 versions, 0 dependencies): https://www.npmjs.com/package/llm-wiki-loop . No PyPI package of this name appeared in searches (PyPI hosts similarly-named `llmwiki`, `llm-wiki-plus`, etc., but not `llm-wiki-loop`; search evidence: https://pypi.org/project/llmwiki/ and the earlier WebSearch results).

Identity and pedigree:

- Repo: `PALAN-K/llm-wiki-loop`, public template, default branch `master`, Python 65.4% / JavaScript 34.6%, 24 commits, 11 releases (latest v1.3.2, 2026-08-21), 13 stars, 3 forks, 1 contributor (naegeon/Raden), MIT license. Source: https://github.com/PALAN-K/llm-wiki-loop
- Self-description: "The Production Framework for Self-Improving & Self-Organizing LLM Knowledge Vaults — Grounding Invariants • Event-Driven GC • Auto-Skillification • Multi-Agent 1-Click Injection"; `npx llm-wiki-loop init` scaffolds a zero-DB, 100%-Markdown vault. Source: https://github.com/PALAN-K/llm-wiki-loop (README header)
- It instantiates Andrej Karpathy's "LLM Wiki" gist (2026-04-04, 5000+ stars): immutable `raw/` sources → LLM-compiled `wiki/` → schema, with `ingest`/`query`/`lint` operations and `index.md` + `log.md`. The **original gist has no code-drift mechanism** — llm-wiki-loop adds machine verification and the fingerprint. Sources: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f , https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md
- Its `check_evidence.py` is adapted from `Astro-Han/karpathy-llm-wiki` (MIT). Source: https://github.com/PALAN-K/llm-wiki-loop (README, License & Acknowledgments)

**Loop structure** (6 operations): `init` (scaffold+install skill), `ingest` (raw/ → triage New/Update/Disputed/No-material → compile with verbatim `Raw:` provenance → cascade to affected pages → update index+log), `query` (progressive disclosure: read `index.md` first, then targeted pages), `lint` (3 tiers: safe auto-fixes, mechanical script reports, judgment reports), `loop` (event-driven GC + auto-skillification of 2×-repeated fixes), `audit` (skill coverage). Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/SKILL.md , https://github.com/PALAN-K/llm-wiki-loop (README, "The 6 Core Vault Operations")

**Fingerprinting scheme** (the part our spec cites): wiki pages that summarize code declare, in their metadata header:

```markdown
> Fingerprint: git:5b237fa
> Monitored: src/auth/jwt.ts, src/auth/session.ts, package.json
```

- Git mode: baseline commit hash + monitored path list; drift check is `git diff --name-only <hash> -- <paths>`; any changed file marks the page drifted ("Status: Outdated trigger"), "eliminating the need for LLMs to re-read hundreds of source files across sessions". Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md (§4.5)
- Non-git mode: `Fingerprint: sha256:<hash>` plus per-file entries `Monitored: path:sha256:<hex>`; the checker hashes file bytes (64 KiB chunks) and compares. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py (`check_code_drift`)
- Dogfooding example: their own `wiki/topics/cross-platform-cli-and-cicd.md` carries `Fingerprint: git:1a8ecc1`, `Monitored: bin/cli.js, .github/workflows/ci.yml, .github/workflows/release.yml`. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/wiki/topics/cross-platform-cli-and-cicd.md

**How unchanged content is skipped:** nothing is embedded or vectorized at all; freshness is answered mechanically by the checker in "Code freshness (Drift detection)" — pages whose fingerprinted paths show an empty diff report "all N fingerprinted article(s) are fresh", and `check --strict` (used in their CI) exits 1 on any drift. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py (report/exit logic; `--strict` semantics also in v1.2.1 commit notes at https://github.com/PALAN-K/llm-wiki-loop/commit/8f13091a7cc221e9647f3f81ad321bc495c78b97 )

**What gets re-generated on drift:** nothing automatically. Drift is detection + labeling; the agent then re-verifies, edits the page, and bumps the fingerprint to the new commit. Real examples in the audit log: "Fingerprint: git:a8d384c -> git:1a8ecc1" after a Windows-crash fix; "git:1691497 -> git:1a8ecc1" after a release-workflow fix. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/log.md

**Outputs:** a Markdown vault (`raw/`, `wiki/{concepts,topics,references}`, `archive/`, `index.md`, `log.md`, `AGENTS.md`), a `wiki-manager` agent skill installed into Claude Code/Cursor/Codex/OpenCode/Gemini/Windsurf/CommandCode runtimes, and the CLI commands `init/check/doctor/install/clean/version/help`. Source: https://www.npmjs.com/package/llm-wiki-loop (CLI Commands & Tooling)

**Limitations / honesty notes:**

- Tiny adoption (13 stars, 1 contributor); "0.01s" / "99% token savings" figures are README marketing, not benchmarks. Source: https://github.com/PALAN-K/llm-wiki-loop (stars/contributors on page; claims in README tables)
- Commit-hash fingerprints require the hash to exist locally: their own release CI broke with `fetch-depth: 1` shallow checkouts ("invalid hash 1691497"), fixed via `fetch-depth: 0`. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/log.md (2026-08-21 "Release Workflow Fetch-Depth Hotfix")
- Outside a git work tree, the drift check silently returns no-drift (empty list), and unknown revisions are reported rather than trusted. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py (`check_code_drift` git branch)
- Page-level granularity only: a `Monitored` list is hand-curated per page; no symbol spans, no automatic file→page mapping; uncommitted working-tree changes count as drift (the code diffs commit vs working tree, while SPEC.md §4.5 describes `<hash> HEAD`). Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py , https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md
- No rename semantics: `git diff --name-only` lists renamed paths as changes but the checker doesn't distinguish rename vs modify vs delete. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py

## Findings

### 1. llm-wiki-loop: fingerprint + diff as the "has this knowledge changed?" oracle

The core implementable idea: attach a machine-checkable provenance header to each generated knowledge artifact, where provenance = (baseline git commit, monitored path set). Freshness is then a subprocess call, not an LLM call. Per SPEC.md §4.5 the invariant is "Universal Fingerprint (Code Grounding & Drift Invariant)" with optional `Fingerprint:`/`Monitored:` fields; enforcement is mechanical inside `check_evidence.py`. Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md , https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py

### 2. Karpathy's LLM Wiki pattern (the origin): compile-once knowledge, not per-query retrieval

The gist's thesis: instead of RAG rediscovering knowledge per query, the LLM "incrementally builds and maintains a persistent wiki"; raw sources are immutable, the LLM owns the wiki layer, `index.md` (content catalog, one line per page) + `log.md` (append-only, parseable prefixes) provide navigation/audit; lint looks for contradictions, stale claims, orphans. This is the "memory should be a compiled, maintained artifact" stance onememory shares. Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

### 3. Git-checkpoint incremental wiki for codebases (yysun)

The clearest published formulation of incremental code-wiki maintenance: (1) ingest from `HEAD`, (2) save the ingested commit SHA in the wiki index, (3) next run diffs `last_commit..HEAD`, (4) update only affected pages, (5) advance the checkpoint only when the changed set is fully processed. Notes git gives changed-file detection, rename/deletion tracking, a natural checkpoint, and stale-page marking "almost for free". Source: https://dev.to/yysun/bringing-the-llm-wiki-idea-to-a-codebase-22go

### 4. Sourcegraph SCIP/LSIF: document-scoped indexes to unblock incremental indexing

LSIF's "heavy usage of opaque global IDs" made "incremental indexing … difficult … to update an existing index with new information for only a subset of the documents" — the direct predecessor problem to ours. SCIP is a Protobuf schema centered on human-readable string symbol IDs; it "unblocks … incremental indexing: … our backend only needs to index the files that have changed instead of the entire repository on every commit". At scale Sourcegraph ran 45k repos with ~4k LSIF uploads/day; SCIP indexes are ~4x smaller gzipped and scip-typescript gave a 10x CI speedup over lsif-node. Sources: https://sourcegraph.com/blog/announcing-scip , https://scip-code.org/

### 5. GitHub stack-graphs: incremental, build-free name resolution (caveat: archived)

Stack graphs define "name resolution rules for an arbitrary programming language in a way that is efficient, incremental, and does not need to tap into existing build or program analysis tools" (Rust, based on TU Delft scope graphs). Caveat: GitHub archived the repo on 2025-09-09 ("no longer supported or updated by GitHub"). Useful as prior art for per-file incremental analysis, not as a dependency. Source: https://github.com/github/stack-graphs

### 6. Bazel / Turborepo: content-addressed action hashing

Bazel: builds decompose into actions with explicitly declared inputs/outputs; the remote cache holds an action cache (action hash → result metadata) plus a content-addressable store (CAS) of outputs keyed by SHA-256 (`/ac/`, `/cas/` HTTP paths); reproducibility is the stated precondition for cross-machine reuse. Source: https://bazel.build/docs/remote-caching
Turborepo: task inputs are hashed into a global hash + task hash (task definitions, lockfiles, `package.json`, source files, `globalDependencies`, env vars, flags, passthrough args); matching fingerprints restore cached outputs; tasks are assumed deterministic; `--summarize` emits a run summary listing every input so a maintainer can debug exactly which input moved. Source: https://turborepo.dev/docs/crafting-your-repository/caching

### 7. tree-sitter tags / ast-grep: deterministic symbol extraction

tree-sitter tag queries extract named entities with a standardized capture vocabulary — `@definition.class`, `@definition.function`, `@definition.method`, `@definition.module`, `@reference.call`, `@reference.class`, `@reference.implementation`, plus `@name` and optional `@doc` (docstrings) — shipped per grammar at `queries/tags.scm`; this powers GitHub's search-based code navigation. Source: https://tree-sitter.github.io/tree-sitter/4-code-navigation.html
ast-grep adds fast structural search/lint/rewrite over tree-sitter ASTs in 20+ languages (Rust, parallel, NAPI bindings). Source: https://ast-grep.github.io/

### 8. CodeDrift: agent-side index + "context window as cache" reads

CodeDrift (51 stars, MIT) parses codebases with tree-sitter into a SQLite FTS5 index of functions/classes/imports/call sites, served over MCP (`codedrift_search/resolve/overview/read/memory`). Two mechanisms directly relevant to zero-token drift: (a) `codedrift_read` returns the full file on first access and, on re-reads, a one-line "unchanged" notice or a unified diff — "the design treats the LLM's context window as the cache"; (b) `codedrift update` re-indexes changed files only, and a git post-commit hook keeps the index fresh; the dashboard warns when the index is >24h old. Source: https://github.com/darshil3011/codedrift

### 9. Rename-aware staleness for memories (Link's `lnk stale`)

An agent-memory project in the Karpathy gist thread ships `lnk stale`: it lists memories naming files git no longer has, resolving the successor path where git recorded a rename, and flags a path only when it is missing now AND git tracked it before (to avoid noise); they report 0 false flags across 108 path references with every probed deletion detected, enforced in CI. Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f (comment by @gowtham0992, Link 3.0, Sep 2026)

## Design inputs for onememory code memory

### Fingerprint keys

Store per memory record (schema sketch, derived from the patterns above):

- `repo_commit`: HEAD commit at index time (llm-wiki-loop's `Fingerprint: git:<hash>`); needed for git-range diffs (pattern 3).
- `files`: map `path -> {blob_sha (git blob SHA or SHA-256 of content), mtime_ns?}` for every file the memory was derived from. Content hashes, not mtimes, are the authority (Bazel CAS/Turbo hash content; mtime is only a cheap pre-filter). Sources: https://bazel.build/docs/remote-caching , https://turborepo.dev/docs/crafting-your-repository/caching
- `symbols`: optional per-symbol spans for symbol-granular memories — `symbol_fqid -> {span (start_byte,end_byte), span_hash}` extracted via tree-sitter tag queries (`@definition.*`, `@reference.*`) so a memory about `AuthService.login()` can be invalidated by edits to that span only, not the whole file. Sources: https://tree-sitter.github.io/tree-sitter/4-code-navigation.html , https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py (shows the per-file `path:sha256:<hex>` precedent)
- `index_version` / extraction-config hash: include the indexer's own version and extraction rules in the cache key, mirroring Turbo's inclusion of task definitions and flags in the hash, so changing extraction logic invalidates old memories deterministically. Source: https://turborepo.dev/docs/crafting-your-repository/caching (global hash inputs)
- Store the file→memory mapping in a queryable index (onememory's DB), rather than re-scanning memory documents to recover `Monitored:` lists on every check, which is what llm-wiki-loop does (it regex-parses every wiki page per run). Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py

### Staleness rules (which diff events mark a memory stale)

Compute `git diff --name-status <last_indexed_commit> HEAD` (add `-M` for rename detection) and map:

- **Modify (M)**: memories whose `files[p]` blob differs → stale. (llm-wiki-loop: any path in `Monitored` appearing in `git diff --name-only` output → page drifted. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md §4.5)
- **Delete (D)**: memories grounded in `p` → stale with `reason=source_deleted` (llm-wiki-loop reports "monitored file not found"; Link's `lnk stale` flags only if git tracked the path before, to avoid prose-path noise. Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py , https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f )
- **Rename (R old new)**: retarget memories from `old` to `new` if the blob is unchanged (rename with `-M` similarity); if content changed too, treat as modify. llm-wiki-loop has no rename handling; Link's successor-path mapping is the proven precedent. Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- **Add (A)**: new files cannot stale existing memories directly, but new content can contradict them — offer a "contradiction sweep" only for memories whose symbols/keywords the new file references (llm-wiki-loop's ingest `Disputed` triage and cascade step are the analogue). Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/references/wiki-protocol.md (§1.2 Triage, §1.4 Cascade)
- **Uncommitted working-tree changes**: decide explicitly. llm-wiki-loop's implementation diffs fingerprint-commit vs working tree (so uncommitted edits count as drift); yysun's model advances the checkpoint "only when the changed set has been fully processed". Recommendation: two-level answer — `committed_fresh` (vs HEAD) and `worktree_fresh` (vs working tree). Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py , https://dev.to/yysun/bringing-the-llm-wiki-idea-to-a-codebase-22go
- **No TTL**: never invalidate by age; only by events. llm-wiki-loop's SPEC makes "no time-based TTL" an explicit non-goal ("'Haven't read it in 90 days' says nothing about truth"). Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md (§5.1, §9)

### Minimal re-index procedure

1. **Session start / `onemem check`**: read stored `repo_commit`; if `git rev-parse HEAD` equals it and no tracked file's blob SHA differs (cheap `git status`-style pass), report "all code memories fresh" — zero LLM tokens, zero embeddings recomputed. This is llm-wiki-loop's mechanism elevated from page-scan to index lookup. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md §4.5
2. **If HEAD moved**: `git diff --name-status -M <old> <new>`; for each changed path, look up affected memories via the file→memory index; batch them into one stale set. Only these memories change state (SCIP's "only the files that have changed" principle). Source: https://sourcegraph.com/blog/announcing-scip
3. **If the fingerprint commit is missing** (shallow clone, squashed history, non-git dir — the exact llm-wiki-loop CI failure), fall back to per-file content hashes: compare stored blob SHA-256s against current files (Bazel CAS-style), which needs no git history at all. Sources: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/log.md (fetch-depth incident), https://bazel.build/docs/remote-caching
4. **Re-index only stale memories**: re-extract symbols for changed files via tree-sitter (deterministic, no LLM needed for structure), then re-run LLM summarization/embedding **only for memories whose inputs changed**. Copy CodeDrift's delta-read idea: when serving an agent, return "unchanged" or the diff rather than the full artifact. Source: https://github.com/darshil3011/codedrift
5. **On completion, advance the checkpoint** (`repo_commit = new HEAD`) only after every stale memory in the changed set is re-indexed or explicitly deferred — yysun's rule 5, which prevents silent gaps. Source: https://dev.to/yysun/bringing-the-llm-wiki-idea-to-a-codebase-22go
6. **Audit trail**: append a parseable log entry per re-index run (operation, files, memories touched, fresh/stale counts) — llm-wiki-loop's `log.md` invariant "every write updates index and log together"; their log doubles as the drift-event history. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/SPEC.md (§3)

### Answering "has this knowledge changed?" in zero tokens

A memory is fresh **iff** all of: `repo_commit` is an ancestor of HEAD (or content hashes match), no `Monitored` path appears in `git diff --name-status -M <repo_commit> HEAD`, and (optionally) each monitored path's current blob SHA equals the stored one. All three checks are subprocess/SQL calls; none requires an LLM. This is exactly llm-wiki-loop's `check_evidence.py` "Code freshness" sweep, minus its per-page re-parsing and plus rename handling and a stored index. Source: https://raw.githubusercontent.com/PALAN-K/llm-wiki-loop/master/skills/wiki-manager/scripts/check_evidence.py

## Open questions

- **Granularity economics**: page/file-level fingerprints (llm-wiki-loop, yysun) are trivial but coarse; symbol-span hashes (tree-sitter) are precise but add index complexity and re-extraction cost per edit. How often do real agent sessions edit within a file without changing the semantics a memory captured? Needs a benchmark before choosing.
- **Uncommitted changes policy**: llm-wiki-loop counts them as drift (diff vs working tree); that protects correctness but makes `onemem check` non-idempotent mid-edit. Should freshness have two tiers (committed vs working-tree)?
- **Diff-to-memory mapping for "A" (new files)**: modify/delete/rename are mechanical; "new file contradicts existing memory" requires a semantic sweep. llm-wiki-loop handles this only through agent-driven ingest triage (`Disputed`), i.e., with LLM tokens — what is the zero-token upper bound for this case?
- **Merge/rebase and branch switches**: none of the sources address fingerprints surviving rebases where blob SHAs are preserved but commit SHAs change, or branch switches with large diffs. yysun's checkpoint model assumes linear history.
- **Embedding invalidation coupling**: the patterns above cover textual memories; if onememory also stores vector embeddings of code chunks, the staleness rule must additionally cover "embedding model version changed" (Turbo analog: tool/config inputs in the hash). Which model-version key belongs in the fingerprint?
- **llm-wiki-loop maturity**: it is a 13-star, single-maintainer project; its numbers (0.01s checks, 99% savings) are unbenchmarked. We should cite it as design inspiration (as our spec does) but not treat its claims as measured results. Source: https://github.com/PALAN-K/llm-wiki-loop
- **stack-graphs/precise-analysis value**: SCIP-style precise indexing is heavyweight (per-language indexers); for onememory v1, tree-sitter tags + git fingerprints may suffice — but "find references" quality memories may eventually want SCIP. Is incremental SCIP upload worth integrating, given stack-graphs is archived and SCIP indexers are per-language compilers? Sources: https://sourcegraph.com/blog/announcing-scip , https://github.com/github/stack-graphs
