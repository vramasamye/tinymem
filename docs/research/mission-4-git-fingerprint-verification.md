# Mission 4 — Git fingerprint contract verification (primary sources)

Date: 2026-10-04 · Scope: implementation-contract check for ADR-0008 (`docs/adr/0008-code-memory-git-fingerprints.md`).
This is not a new architectural decision; it verifies the exact machine contracts of the ADR's commands.

Method: official Git documentation (git-scm.com, fetched) + the man pages and binary of the locally installed
**git 2.39.5 (Apple Git-154)**, verified byte-level (`od -c`) on throwaway fixture repos under `/tmp` covering:
regular/executable/symlink/UTF-8/newline-in-name paths, submodules, conflicts, unborn and detached HEAD,
shallow clones, SHA-256 repositories, clean/external-diff/textconv filters, and index-write probes
(mtime + md5 of `.git/index` in isolated repos). Every claim below is either quoted from a cited page/man
page or directly observed on 2.39.5.

## 1. Verdict — exact command contracts (argv arrays, never shell)

All invocations spawn via `execFile`/`Bun.spawn` with argv arrays (dependency-verification §10 verdict).
`-z` output is never line-split: paths may contain LF and raw UTF-8 (verified), so the only legal
tokenizer is NUL. Exit codes distinguish the failure classes below.

| # | Purpose | Command (argv) | Result contract |
|---|---------|----------------|-----------------|
| 1 | Repo preflight | `git rev-parse --is-inside-work-tree` | `true` exit 0; non-repo → exit 128 `fatal: not a git repository (or any of the parent directories): .git` (same preflight llm-wiki-loop uses) |
| 2 | HEAD preflight (unborn) | `git rev-parse --verify --quiet HEAD^{commit}` | exit 0 born (attached **or** detached); exit 1 silent unborn. `--quiet`: "Do not output an error message … instead exit with non-zero status silently" (git-rev-parse(1)) |
| 3 | Checkpoint presence | `git rev-parse --verify --quiet <last_ingested_commit>^{commit}` | exit 0 present; exit 1 missing (shallow/squashed-away). Never feed the missing sha to `diff` (exit 128, §4) |
| 4 | Shallow check | `git rev-parse --is-shallow-repository` | `true`/`false`, exit 0 ("When the repository is shallow print 'true', otherwise 'false'" — git-rev-parse(1)) |
| 5 | Ancestor check (rebases/squashes) | `git merge-base --is-ancestor <checkpoint> HEAD` | exit 0 ancestor / 1 not (fall back to content-hash tier); missing object → exit 128 `fatal: Not a valid commit name <sha>` |
| 6 | Committed-tier snapshot | `git ls-files --stage -z --full-name` | `<mode> SP <sha> SP <stage> TAB <path> NUL` per entry (§2) |
| 7 | Checkpoint drift | `git diff --name-status -z -M --no-ext-diff --no-textconv --ignore-submodules=dirty -- <old-rev> <new-rev>` | records per §3; trailing `--` disambiguates revision-vs-path (a worktree file named like the sha made the bare form fail with `fatal: ambiguous argument '<sha>': both revision and filename`, exit 128; with `--` it succeeded) |
| 8 | Worktree-tier event scan (unstaged) | `git diff-files --name-status -z -M --no-ext-diff --no-textconv --ignore-submodules=dirty` | plumbing twin of `git diff` — identical flags/output, but never writes `.git/index` (§7); explicit `-M` overrides the `diff.renames` default because "this [config] affects only git diff Porcelain … and not lower level commands such as git-diff-files(1)" (git-diff(1)) |
| 9 | Staged view | `git diff --name-status -z -M --no-ext-diff --no-textconv --ignore-submodules=dirty --cached` | index vs HEAD; works on unborn HEAD (diffs the empty tree → `A` records; verified); no worktree reads → no filter execution, no index write (both verified) |
| 10 | Worktree-tier re-hash (dirty paths only) | `git hash-object --no-filters -- <path>` | raw-bytes blob sha; **never executes clean/smudge**, writes nothing to the object DB, works outside any repo (serves the ADR's non-git content-hash fallback). Accepts `--`. Without `--no-filters` the clean filter **does** run (§5) |
| 11 | Object format | `git rev-parse --show-object-format` | `sha1`/`sha256`; parsers accept `[0-9a-f]{40}` or `[0-9a-f]{64}`, lowercase (§4) |
| 12 | Environment | `GIT_OPTIONAL_LOCKS=0` on every spawn | documented equivalent of `--no-optional-locks` ("Do not perform optional operations that require locks" — git(1)); harmless insurance, though on 2.39.5 it does *not* stop the porcelain worktree diff from writing the index (§7) — hence #8 |

## 2. `git ls-files --stage -z` — exact format

Doc: `-s --stage` "Show staged contents' mode bits, object name and stage number in the output"; OUTPUT
"`[<tag> ]<mode> <object> <stage> <file>`"; `-z` "\0 line termination on output and do not quote filenames";
"Using `-z` the filename is output verbatim and the line is terminated by a NUL byte." (git-ls-files(1),
https://git-scm.com/docs/git-ls-files )

Verified bytes (git 2.39.5, `od -c`):

```
100644 9145fdb3…fb96 0\tfile with space.txt\0
100755 4163036e…a55c 0\tscript.sh\0
120000 397e1077…2159 0\tlink.txt\0                  symlink: blob = the target-path string
160000 f0666b9e…eabe 0\tsubm\0                      submodule gitlink: "sha" = submodule commit
100644 d5f5c2a1…5c84 0\tnew\nline.txt\0            literal LF inside the path, raw, unquoted
```

- Separator contract: `<mode>` SP `<sha>` SP `<stage>` TAB `<path>` NUL. No quoting, no escaping, no
  line endings; split on `\0`, then TAB (paths cannot contain TAB before it — fields are mode/sha/stage),
  never on LF.
- `--full-name` is **required** for stable root-relative keys: run from a subdirectory, the default
  output is CWD-relative *and limited to that subtree* (verified from `d/`: default listed `inner.txt`;
  `--full-name` listed `d/inner.txt`). "This option forces paths to be output relative to the project top
  directory." (git-ls-files(1))
- Conflicts: "the index records up to three such pairs; one from tree O in stage 1, A in stage 2, and B
  in stage 3" — verified: three records for the same path with stages 1/2/3 plus stage-0 records for clean
  paths. Parser must keep multiple records per path; any non-0 stage ⇒ treat the path as conflicted/dirty.
- Symlink entry is just a blob (content = target string); worktree-side hashing of symlinks is a trap (§6).
- No filter execution ever (index data only — verified with a live clean filter); never writes `.git/index`
  (verified with stale stat under `GIT_OPTIONAL_LOCKS=0`).
- Sparse checkout: `ls-files --stage` listed the **full** tracked inventory under cone-mode sparse checkout
  (verified) — the committed tier is unaffected by sparse checkouts.

## 3. `git diff --name-status -z -M` — exact format

Doc (diff-format, https://git-scm.com/docs/diff-format — "Raw output format" field list): after the
optional score, "a tab or a NUL when `-z` option is used", then "path for src", then "a tab or a NUL when
`-z` option is used; only exists for C or R", then "path for dst; only exists for C or R", then "an LF or
a NUL when `-z` option is used, to terminate the record." Also: "Status letters `C` and `R` are always
followed by a score (denoting the percentage of similarity between the source and target of the move or
copy). Status letter `M` may be followed by a score (denoting the percentage of dissimilarity) for file
rewrites." "Using `-z` the filename is output verbatim and the line is terminated by a NUL byte."

Verified bytes (`od -c`, `git diff --name-status -z -M HEAD~1 HEAD` over A/M/D/R/T, symlink retarget,
submodule pointer move):

```
A\0added.txt\0
M\0file with space.txt\0
M\0link.txt\0                symlink retarget: M (mode unchanged, blob changed)
R100\0regular.txt\0renamed.txt\0     rename: letter+score NUL src NUL dst NUL
D\0script.sh\0
M\0subm\0                    submodule gitlink move
T\0uni\303\251\303\270.txt\0  type change (regular↔symlink↔submodule); raw UTF-8 path
```

Parser contract: NUL-tokenize; first field = one status letter + optional digits (`R100`, `C68`; a `M`
score appears only with rewrite detection — tolerate digits everywhere); R/C records have exactly two
paths (src=old, dst=new) and every other status exactly one; every record is NUL-terminated, so a
trailing empty token after the final `\0` is expected. Status letters and semantics: "A: addition …
C: copy … D: deletion … M: modification of the contents or mode … R: renaming … T: change in the type of
the file (regular file, symbolic link or submodule) … U: file is unmerged" (diff-format). `--name-status`
is "Show only names and status of changed files." (git-diff(1)).

- Conflicts (verified): the index-vs-worktree view emits **two** records for an unmerged path —
  `U\0c.txt\0M\0c.txt\0` — matching the doc: "except `git diff-files` in the case of an unmerged file, which
  prints both an 'unmerged' and an 'in-place edit' line." Dedupe per path (U ⇒ conflicted ⇒ dirty). The
  `HEAD`/`--cached` views collapse this to `M\0c.txt\0` / `U\0c.txt\0`.
- No `numstat`-style leading NUL: `--numstat -z` inserts an extra NUL *before* the preimage path for
  rename records ("to allow scripts … to tell if the current record … is a single-path record or a
  rename/copy record", diff-format); `--name-status` does not need it — the status+score token is first.
  Do not reuse a numstat parser.
- Merge-commit endpoints never produce concatenated statuses; that happens only under `-c`/`--cc`
  ("status is concatenated status characters for each parent", diff-format), which we never pass. A
  two-endpoint diff of a merge commit is a plain tree-vs-tree diff with single-letter statuses.
- Renames: pass `-M` explicitly. `git diff` porcelain defaults to rename detection via `diff.renames`
  (default true, user-configurable to false) — verified: `-c diff.renames=false` + explicit `-M` still
  detected `R100`. `-M[<n>]`, `--find-renames[=<n>]`: "Detect renames. If n is specified, it is a threshold
  on the similarity index (i.e. amount of addition/deletions compared to the file's size)." (git-diff(1)).
- Unstaged worktree renames are invisible as `R`: the new path is untracked, so the worktree view shows
  only `D\0old\0` (verified); rename-aware successor resolution applies to staged (`--cached`, verified
  `R100\0a.txt\0b.txt\0`) and committed (checkpoint) renames only.

## 4. HEAD states (unborn, detached) and missing checkpoints

- Unborn HEAD: `git rev-parse HEAD` → exit 128 `fatal: ambiguous argument 'HEAD': unknown revision or path
  not in the working tree.`; `git diff … HEAD` → same fatal (exit 128). Meanwhile `git ls-files --stage -z`
  works and includes staged entries (verified: `100644 587be6… 0\ta.txt\0` with no commits); the no-endpoint
  worktree scan works; `--cached` works by diffing the empty tree (`A\0a.txt\0`, verified).
  **Contract:** preflight #2; on unborn, snapshot `ls-files --stage` as the baseline and skip the
  checkpoint tier entirely (there is no `last_ingested_commit` yet).
- Detached HEAD: `rev-parse HEAD` exit 0, `symbolic-ref -q HEAD` exit 1 (silent), `--abbrev-ref HEAD`
  prints `HEAD`; every diff/ls-files command works unchanged (verified). Keys are SHAs (ADR's
  `repositories.last_ingested_commit`), so detached needs **no** special handling — never key on branch
  names.
- Missing checkpoint / shallow clone (`git clone --depth 1`, verified): `git rev-parse --is-shallow-repository`
  → `true`; a root commit absent from the shallow cut: preflight #3 → exit 1 silent. Feeding it onward:
  `git diff … <full-sha> HEAD` → exit 128 `fatal: bad object <sha>`; `<short-sha>` or garbage → exit 128
  `fatal: ambiguous argument '<x>': unknown revision or path not in the working tree.` (+ "Use '--' to
  separate paths" hint); `git cat-file -e <sha>^{commit}` → exit 128 `fatal: Not a valid object name …`;
  `git merge-base --is-ancestor <sha> HEAD` → exit 128 `fatal: Not a valid commit name <sha>`.
  **Contract:** preflight #3/#4/#5; on missing checkpoint take the ADR's content-hash fallback (per-file
  blob-SHA comparison, no history needed) — exactly llm-wiki-loop's `fetch-depth: 1` "invalid hash" CI
  incident class; `git fetch --unshallow origin` was verified to restore both #3 (exit 0) and #5.

## 5. Non-executing hash path (avoid clean/smudge/external filters)

Verified with a live filter (`filter.side.clean = "tee -a clean.log | tr a-z A-Z"`, attribute
`f.filtered filter=side`, control `git add` ran it: log created, committed blob = cleaned content):

- `git hash-object <path>` (default): **runs the clean filter** — returned the cleaned blob sha
  (`43d5a8ed…`, not raw `72943a16…`) and executed the command. `--path=<path>` also runs it.
- `git hash-object --no-filters <path>`: **never executes** — raw bytes, raw sha. Doc: "Hash the contents
  as is, ignoring any input filter that would have been chosen by the attributes mechanism, including the
  end-of-line conversion." (git-hash-object(1), https://git-scm.com/docs/git-hash-object )
  ⇒ Worktree-tier hashes must always use `--no-filters`; without `-w` it writes nothing to the object DB
  (verified `count-objects` unchanged), and it works outside any repo (verified) for the non-git tier.
- `git ls-files --stage -z`: index data only — filter never ran (verified).
- Checkpoint diff (#7) and `--cached` (#9): tree/index data only — clean filter never ran (verified),
  external diff/textconv never ran — even with `GIT_EXTERNAL_DIFF` exported and a
  `diff.<driver>.command`/`textconv` configured (verified: no side-effect logs). Belt-and-suspenders
  `--no-ext-diff` ("Disallow external diff drivers") and `--no-textconv` are accepted with `--name-status`
  (verified).
- **Residual (documented):** any *worktree-view* comparison — porcelain `git diff` (no endpoints or `HEAD`)
  and plumbing `git diff-files` — reads modified worktree files through Git's conversion machinery, so a
  user-configured clean filter executes (verified for both; `diff-files` even reported *no* change when
  raw bytes differed but clean-normalized content matched the index). There is no Git flag that disables
  repo `.gitattributes` filters for diffs (`GIT_ATTR_NOSYSTEM` only covers `/etc/gitattributes`). This is
  the same code path the user's own `git status`/`git diff` runs, in the user's own repo/config trust
  domain — accepted, but it must stay confined to the *event scan*; hashes (#10) and every other tier stay
  non-executing.
- Tier discipline (why `--no-filters` raw hashes must only be compared against stored *worktree* hashes):
  under a clean filter or CRLF conversion the index blob (cleaned) and raw worktree hash legitimately
  differ — verified: raw `8efdaaf2…` vs cleaned `fb1d537f…` for the same file. Cross-tier comparison would
  false-positive.

## 6. Symlinks and submodules

- Symlink: index entry `120000 <blob> 0\tpath\0` where the blob is the **target-path string** (verified:
  index blob `be0747ec…` == `hash-object --stdin` of the literal string `added.txt`). Diff statuses
  verified: `M` on retarget, `T` on file↔symlink↔submodule type change.
- **Symlink trap (verified):** `git hash-object` **follows** symlinks — hashing `link.txt` returned the
  *target file's* content sha (`3e757656…`), not the index blob. Never `hash-object` a symlink for the
  worktree tier: `readlink` + hash the target string, or (simpler, recommended) rely on the diff event —
  `M`/`T` on a 120000 entry already proves drift. A dangling symlink would make `hash-object` fail outright.
- Submodule gitlink: entry `160000 <submodule-commit> 0\tpath\0`; pointer moves show `M` in the checkpoint
  diff (pure tree data — works with uninitialized submodules in a fresh clone, verified), `M` in the
  staged view, and `M` in the worktree scan. Inner dirtiness (uncommitted content inside the submodule,
  tracked or untracked) also surfaces as `M` on the submodule path **by default** — noise, since only the
  gitlink is fingerprinted.
- `--ignore-submodules` (state-verified matrix, git 2.39.5): default/`none` ⇒ `M` for pointer move *or*
  inner dirt; `=dirty` ⇒ hides inner dirt, **keeps pointer moves** (`M subm` in all three pointer-moved
  states); `=all` ⇒ hides everything including gitlink moves. Doc: "Using 'dirty' ignores all changes to
  the work tree of submodules, only changes to the commits stored in the superproject are shown … Using
  'all' hides all changes to submodules." (git-diff(1), https://git-scm.com/docs/git-diff )
- **Determinism hazard (verified):** user config `diff.ignoreSubmodules=all` silently hid even the
  *committed* gitlink move from the checkpoint diff (`HEAD~1 HEAD`). An explicit flag overrides the config
  (verified: `=dirty` and `=none` both restored `M subm` under `config=all`) ⇒ every diff invocation
  passes `--ignore-submodules=dirty` explicitly.
- Inner submodule files are not fingerprinted by the parent pass (only the gitlink); `git ls-files
  --recurse-submodules` exists if that ever becomes a goal ("Recursively calls ls-files on each active
  submodule", git-ls-files(1)) — out of scope here.

## 7. Read-only operation — who writes `.git/index`

md5+mtime probes in isolated repos (stale stat, `touch -t 202001010000`):

| Command | Writes `.git/index` |
|---|---|
| `git diff --name-status -z -M` (worktree view) | **yes** (opportunistic stat-cache refresh; md5 changed; no leftover `.git/index.lock`) |
| same under `GIT_OPTIONAL_LOCKS=0` **or** `git --no-optional-locks diff …` | **still yes on 2.39.5 (Apple Git-154)** — md5 changed despite the documented "Do not perform optional operations that require locks" (git(1)); surprising, hence #8 |
| `git diff --name-status -z -M HEAD` (worktree vs HEAD) | **yes** |
| `git diff --name-status -z -M <old> <new> --` (tree-vs-tree) | **no** (verified) |
| `git diff … --cached` (index vs HEAD) | **no** (verified md5 unchanged) |
| `git ls-files --stage -z` (stale stat) | **no** (verified) |
| `git diff-files --name-status -z -M` (plumbing, accepts all guard flags, verified) | **no** (verified) |

Correctness of the no-write paths is unaffected: with stale stat and unchanged content the worktree scans
returned empty (content compared, not just stat); with a real change they returned `M`. **Contract:** use
`git diff-files` (#8) for the worktree event scan so the daemon never mutates the host repo's index and
never contends on `.git/index.lock` with a concurrent editor/agent Git process; keep `GIT_OPTIONAL_LOCKS=0`
on every spawn as insurance.

## 8. SHA-1 vs SHA-256 object formats

Verified on 2.39.5 with `git init --object-format=sha256`: `--show-object-format` → `sha256`; `rev-parse HEAD`,
`ls-files --stage`, `hash-object` all emit 64-hex ids; `HEAD^{commit}` peeling, `-z -M` diffs, and every
preflight behave identically. The empty-tree hash differs per format — `4b825dc642cb6eb9a060e54bf8d69288fbee4904`
(sha1) vs `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321` (sha256), both verified via
`git hash-object -t tree /dev/null` — never hardcode either. **Contract:** blob/commit parsers accept 40
or 64 lowercase hex; record the object format (or infer from length) with each stored fingerprint; never
compare fingerprints across repositories/branches of different formats. SHA-256 repos require git ≥ 2.29.

## 9. Risks / residual items

1. **Clean-filter execution during the worktree event scan** (§5 residual): user-configured filter
   commands run on modified files, as in the user's own `git status`. Confined to the event scan; hashes,
   snapshot, and checkpoint tiers never execute anything.
2. **`--no-optional-locks` not honored by the porcelain worktree diff on 2.39.5 (Apple Git-154)** (§7):
   mitigated by plumbing `git diff-files`; re-verify when bumping the minimum Git version.
3. **Rename limit:** `diff.renameLimit` — "The number of files to consider in the exhaustive portion of
   copy/rename detection; equivalent to the git diff option -l. If not set, the default value is currently
   1000." (git-config(1)). Beyond it, `R` degrades to separate `A`+`D` — staleness stays correct, but
   rename successor resolution loses precision; pass an explicit `-l<n>` if pairing matters on huge diffs.
4. **Unstaged renames are invisible as `R`** (§3): the new path is untracked. Successor-path resolution
   applies to staged/committed renames only; the old path still flags `D` (never misses drift).
5. **Conflict double-report** (`U` then `M` for the same path in the worktree view) and multi-stage
   `ls-files` records: dedupe per path, treat as conflicted ⇒ dirty.
6. **SHA-1/SHA-256 cross-format comparisons** would silently mismatch — enforce per-repo format (§8).
7. **Symlink worktree hashing** must avoid `git hash-object` (follows links, §6).

## Sources

- Fetched official docs: https://git-scm.com/docs/diff-format (raw/-z format, status letters, score
  rules, unmerged lines, merge -c/--cc, numstat contrast), https://git-scm.com/docs/git-ls-files
  (--stage, OUTPUT format, -z quoting, --full-name, unmerged stages, --recurse-submodules, --sparse).
- Man pages of the tested binary, git 2.39.5 (Apple Git-154): git-hash-object(1) (--no-filters),
  git-rev-parse(1) (--verify --quiet, --is-shallow-repository), git-diff(1) (-M/--find-renames,
  --name-status, --no-ext-diff, --textconv/--no-textconv, --ignore-submodules, diff.renames),
  git-config(1) (diff.renameLimit), git(1) (--no-optional-locks/GIT_OPTIONAL_LOCKS).
  Canonical URLs: https://git-scm.com/docs/git-hash-object , https://git-scm.com/docs/git-rev-parse ,
  https://git-scm.com/docs/git-diff , https://git-scm.com/docs/git-config , https://git-scm.com/docs/git
- Byte-level empirical verification against the git 2.39.5 binary (all fixtures under `/tmp`, scripted and
  reproducible; `od -c`/md5/mtime evidence cited inline above).
- Repo context: docs/adr/0008-code-memory-git-fingerprints.md (the decision this verifies),
  docs/research/dependency-verification.md §10 (system-git-over-isomorphic verdict),
  docs/research/llm-wiki-loop.md (fingerprint/checkpoint model and the shallow-clone "invalid hash" incident).
