# Mission 4 — Drift event-scan plumbing contract verification (primary sources)

Date: 2026-10-04 · Scope: implementation-contract check for the code-memory drift watcher
(`packages/codememory`) under ADR-0008 (`docs/adr/0008-code-memory-git-fingerprints.md`).
This is not a new architectural decision. It verifies the exact machine contracts of the plumbing
commands deferred by `docs/research/mission-4-git-fingerprint-verification.md` (hereafter **[FP]**).
Claims already pinned there are referenced, not repeated: `ls-files --stage -z --full-name` (FP §2),
`rev-parse --verify --quiet` preflights (FP §1 #2–#5), trailing `--` (FP §1 #7), `--ignore-submodules=dirty`
(FP §6), `hash-object --no-filters` (FP §5), the porcelain index-write finding (FP §7), SHA-1/SHA-256 rules (FP §8).

Method: (1) man pages of the locally installed **git 2.39.5 (Apple Git-154)** (`git --version`), rendered
from `/Library/Developer/CommandLineTools/usr/share/man/` (git-diff-files(1), git-diff-index(1),
gitdiffcore(7), git-config(1), git(1); page footer "Git 2.39.0"); (2) git source at tag **v2.39.5** from the
canonical mirror (`https://raw.githubusercontent.com/git/git/v2.39.5/<file>`): `builtin/diff-files.c`,
`builtin/diff-index.c`, `builtin/diff.c`, `diff-lib.c`; (3) empirical probes on throwaway repos under
`/tmp/des/*` with the 2.39.5 binary. Index-write checks compare `md5 -q .git/index` and
`stat -f %m .git/index` before/after each command. Every claim below cites one of these three.

## 1. Verdict — event-scan argv set (argv arrays, never shell; `GIT_OPTIONAL_LOCKS=0` on every spawn per FP #12)

| # | Comparison | Command (argv) | Result contract |
|---|---|---|---|
| E1 | Index vs worktree (unstaged) | `git diff-files --raw -z --no-renames --no-ext-diff --no-textconv --ignore-submodules=dirty` | raw records (§2); never writes `.git/index`, never takes `index.lock` (§3); **stat-only changes are reported** as `M` with all-zero dst sha (§3.2) — not a content verdict |
| E2 | Checkpoint tree vs worktree (staged + unstaged combined) | `git diff-index --raw -z -M100% --no-ext-diff --no-textconv --ignore-submodules=dirty <checkpoint> --` | tree-vs-(index+worktree); stats the worktree (§4); exact renames only (§6); never writes index |
| E3 | Checkpoint tree vs index only (staged) | `git diff-index --cached --raw -z -M100% --no-ext-diff --no-textconv --ignore-submodules=dirty <checkpoint> --` | "Do not consider the on-disk file at all" (§4); never writes index; on unborn HEAD pass the empty-tree id instead of `HEAD` (§4.3) |
| E4 | Cheap dirty gate | any of E1–E3 with `--quiet` replacing `--raw -z` | exit 0 = no differences, 1 = differences (stat-only counts, §3.2), 128 = fatal (bad/missing object, ambiguity) |
| E5 | Rename-precision variant (optional, E3 only) | E3 with `-M -l<n>` instead of `-M100%` | inexact renames; reads blob contents → exit 128 if a blob is missing, **lazy network fetch in partial clones** (§6.3); on exit 128 retry E3 as written |

Contract pins (verbatim argv → rule):

- `git diff-files --raw -z …` → record = `:<srcmode> SP <dstmode> SP <srcsha> SP <dstsha> SP <status>[score] NUL <path> NUL [<path2> NUL]`; src = **index**, dst = worktree; dst sha all-zero whenever the worktree side is not known to equal the index (§2).
- `git diff-files …` / `git diff-index …` (any mode) → **never** writes `.git/index` and ignores a foreign `index.lock` (§3).
- `git diff-files` stat-dirty → `M` with zero dst sha, `--quiet` exits 1; consumer must re-verify content before declaring drift (§3.2).
- `git diff-index <tree> --` → stats worktree; dst sha = index sha when worktree matches index stat, else all-zero (§4).
- `git diff-index --cached <tree> --` → index only, worktree never examined (§4).
- `T` = mode-family change (`100644|100755` ↔ `120000` ↔ `160000`); `M` with differing modes = executable-bit flip only (§5).
- Plumbing ignores `diff.renames`; it does **not** ignore `diff.renameLimit` or `submodule.<name>.ignore` — always pass explicit `-M…`/`--no-renames` and `--ignore-submodules=dirty` (§6, §7).
- Rename limit exceeded → exact renames still `R100`; inexact pairs silently become `D`+`A`, exit 0, warning only on stderr (§6.2).
- Missing checkpoint commit → exit 128 `fatal: bad object <sha>`; missing tree → exit 128 `error: bad tree object <sha>`; missing blob with inexact `-M` → exit 128 `fatal: unable to read <sha>`; raw scan without inexact renames needs no blobs (§8).

## 2. Raw output format (`--raw`, `-z`)

Doc (git-diff-files(1) / git-diff-index(1), RAW OUTPUT FORMAT): "`in-place edit :100644 100644 bcd1234 0123456 M file0`",
fields "1. a colon. 2. mode for 'src'; 000000 if creation or unmerged. … 4. mode for 'dst'; 000000 if deletion or
unmerged. … 6. sha1 for 'src'; 0{40} if creation or unmerged. … 8. sha1 for 'dst'; 0{40} if deletion, unmerged or
'work tree out of sync with the index'. … 10. status, followed by optional 'score' number. 11. a tab or a NUL when
-z option is used. 12. path for 'src' 13. a tab or a NUL when -z option is used; only exists for C or R. 14. path for
'dst'; only exists for C or R. 15. an LF or a NUL when -z option is used, to terminate the record." `--raw`: "Generate
the diff in raw format. This is the default." (git-diff-files(1)); source sets it as default when no format is given
(`rev.diffopt.output_format = DIFF_FORMAT_RAW`, builtin/diff-files.c and builtin/diff-index.c).

Verified bytes (`git diff-index --cached -M -z --raw HEAD -- ren ren_new | od -c`):

```
:100644 100644 998f9709…34d7 998f9709…34d7 R100\0ren\0ren_new\0
```

and `git diff-files --raw -z | tr '\0' '|'` over a state matrix (staged+unstaged, deletion, typechanges, chmod):

```
:100644 100644 ea0fb330…6dd2 0000…0000 M|both|
:100644 000000 644b0c25…5573 0000…0000 D|gone|
:120000 100644 c7e58fc9…dcb  0000…0000 T|link2t|        symlink → regular file
:100644 100755 78297da7…c51  0000…0000 M|mode|          chmod +x only
:100644 120000 f0773dc4…ff8  0000…0000 T|t2link|        regular file → symlink
:100644 100644 06d3804f…73a  0000…0000 M|unstaged|
```

Parser contract:

- With `-z` the status token is followed by **NUL, not TAB** (bytes above); the header token is
  `:` + 2 modes + 2 shas + status, space-separated; then exactly one path token, or two for `R`/`C`; every record
  NUL-terminated. Paths are verbatim (FP §3 quoting rules apply identically: "Using -z the filename is output
  verbatim and the line is terminated by a NUL byte", git-diff-files(1)).
- **Full hashes always.** Source: `rev.abbrev = 0;` in both builtin/diff-files.c and builtin/diff-index.c. Probe:
  `git -c core.abbrev=7 diff-files --raw` printed 40-hex; only an explicit `--abbrev` shortened it. Never pass
  `--abbrev`; accept 40 or 64 hex (FP §8).
- **Paths are always repo-root-relative and cover the whole repo, regardless of CWD.** `diff-files` has no
  `--full-name` option: `git diff-files --full-name` → exit 129 with the usage line (probe). Run from `sub/`,
  `git diff-files --name-only` listed root-relative paths for the whole repository including `sub/z`;
  `-c diff.relative=true` did not change that (plumbing reads only `git_diff_basic_config`, builtin/diff-files.c
  comment "no 'diff' UI options"); only an explicit `--relative` produced CWD-relative `z`. Never pass `--relative`.
- `--name-status` (FP #8) discards the sha columns, and the zero dst sha is the only signal separating
  "stat-dirty, re-verify" from "content known" (§3.2), so the event scan uses `--raw`.

### 2.1 Staged and unstaged changes to the same path

`diff-files` compares index→worktree, so its src sha is the **index (staged) blob**, not HEAD. Path `both`
(staged edit, then a further unstaged edit) showed `src = ea0fb330…` (index blob) in `diff-files`, while
`diff-index HEAD` showed `src = ac659ea8…` (HEAD blob) → zero dst, and `diff-index --cached HEAD` showed
`ac659ea8… → ea0fb330…` (probe, state matrix above). A path changed **only** in the index (`staged`) is absent
from `diff-files` and appears in `diff-index HEAD` with a **real** dst sha (`a17d53a2… → a440d899…`), because its
worktree stat matches the index. git-diff-index(1) NON-CACHED MODE: "You can always tell which file is in which
state, since the 'has been updated' ones show a valid sha1, and the 'not in sync with the index' ones will always
have the special all-zero sha1."

### 2.2 Unmerged paths

Doc: "The option -0 can be given to omit diff output for unmerged entries and just show 'Unmerged'"; default
diffs "against our branch (-2)" (git-diff-files(1)). Probe after a conflicting merge:

```
diff-files:          :000000 100644 0{40} 0{40} U  c.txt
                     :100644 100644 950b81b7… 0{40} M  c.txt     (stage 2 vs worktree)
diff-files -0:       :000000 100644 0{40} 0{40} U  c.txt
diff-index HEAD:     :100644 100644 950b81b7… 0{40} M  c.txt
diff-index --cached: :100644 000000 950b81b7… 0{40} U  c.txt
```

The `U` record's dst mode is the **worktree mode** (`100644`), not the documented `000000`. Source explains it:
`pair = diff_unmerge(...); if (wt_mode) pair->two->mode = wt_mode;` (diff-lib.c, `run_diff_files`). The parser must
key on the status letter `U`, not on `000000` modes. `--quiet` exits 1 with an unmerged path (probe).

### 2.3 Intent-to-add (`git add -N`)

`diff-files` reports an i-t-a path as `:000000 100644 0{40} 0{40} A` (probe). Source: builtin/diff-files.c sets
`rev.diffopt.ita_invisible_in_index = 1` ("Consider 'intent-to-add' files as new by default"). `diff-index
--cached HEAD` does **not** set that flag (builtin/diff-index.c) and showed it as an addition of the empty blob
`e69de29b…` (probe). Consequence: an i-t-a path is the only way `diff-files` can emit `A`, which is the only way
rename pairing can occur in `diff-files` (§6.1).

## 3. Read-only operation — `diff-files` / `diff-index` never write the index

### 3.1 Source and probe

- builtin/diff-files.c reads the index with `repo_read_index_preload(...)` and calls `run_diff_files(&rev, options)`;
  builtin/diff-index.c reads it with `repo_read_index_preload` (non-cached) or `repo_read_index` (`--cached`) and
  calls `run_diff_index`. Neither file contains a lockfile, `refresh_index`, or `repo_update_index_if_able` call.
  In `run_diff_files` (diff-lib.c) an unchanged entry is only marked in memory (`ce_mark_uptodate(ce);
  mark_fsmonitor_valid(istate, ce);`) and the index is never written back.
- The porcelain write comes from `refresh_index_quietly()` in builtin/diff.c, which calls
  `repo_hold_locked_index(...)`, `refresh_index(...)`, `repo_update_index_if_able(...)` whenever
  `1 < rev.diffopt.skip_stat_unmatch`. It does not check `GIT_OPTIONAL_LOCKS`. This is the source-level
  explanation of the FP §7 surprise. The trigger is `rev.diffopt.skip_stat_unmatch = !!diff_auto_refresh_index;`,
  and the config key behind it is documented as "Note that this affects only git diff Porcelain, and not lower
  level diff commands such as git diff-files" (git-config(1), `diff.autoRefreshIndex`).
- Probe (stat-dirty `f1`, content-changed `f2`; both with and without `GIT_OPTIONAL_LOCKS=0`):

| Command | rc | `.git/index` written |
|---|---|---|
| `git diff-files --raw -z` | 0 | no |
| `git diff-files --raw -z -M --no-ext-diff --no-textconv --ignore-submodules=dirty` | 0 | no |
| `git diff-files --quiet` | 1 | no |
| `git diff-files -p` | 0 | no |
| `git diff-index --raw -z -M HEAD` | 0 | no |
| `git diff-index --cached --raw -z -M HEAD` | 0 | no |
| `git diff-index --quiet HEAD` | 1 | no |
| `GIT_OPTIONAL_LOCKS=0 git diff --name-only` (porcelain control) | 0 | **yes** (reconfirms FP §7) |
| `git -c diff.autoRefreshIndex=false diff --name-only` (porcelain) | 0 | no |

- **Lock contention:** with a foreign `.git/index.lock` present (simulating a concurrent `git add`),
  `diff-files`, `diff-index HEAD`, and `diff-index --cached HEAD` all succeeded with exit 0 and normal output
  (probe). Porcelain `git diff` also exited 0 and skipped the write, because `refresh_index_quietly` returns when
  `fd < 0` (builtin/diff.c). Plumbing never touches the lock at all.

### 3.2 Stat-dirty entries are reported (contradicts the FP §7 note)

Doc: "As with other commands of this type, git diff-index does not actually look at the contents of the file at
all. So maybe kernel/sched.c hasn't actually changed, and it's just that you touched it." (git-diff-index(1),
NON-CACHED MODE Note). Source: in `run_diff_files`, `changed = match_stat_with_submodule(...)` (a stat compare via
`ie_match_stat`) and then `new_oid = changed ? null_oid() : &ce->oid;` (diff-lib.c). The `skip_stat_unmatch`
content re-check that porcelain uses is never enabled in plumbing (§3.1).

Probe: after `touch -t 202001010000 a.txt` with **unchanged content**:

```
git diff-files --raw -z          → :100644 100644 ce013625…464a 0{40} M\0a.txt\0
git diff-files --name-status -M  → M a.txt          (exit 0; with --exit-code → exit 1)
git diff-files --quiet           → exit 1
git diff-index --raw HEAD        → :100644 100644 ce013625…464a 0{40} M  a.txt
git diff-files -p                → (empty; the patch path compares content)
git diff (porcelain, copy)       → --quiet exit 0 (it refreshes, and writes the index)
```

After all plumbing runs the stat-dirty paths were **still** reported (`f1` listed after nine plumbing
invocations), which proves the index stat cache was not refreshed. Only porcelain `git diff` cleared `f1`.

**Surprise vs FP §7:** FP states "with stale stat and unchanged content the worktree scans returned empty (content
compared, not just stat)". On 2.39.5 that holds for porcelain `git diff` only. `git diff-files` reports the
stat-only path as `M`. Neither FP's `--name-status` scan (#8) nor `--quiet` can tell the difference.
**Contract:** a `diff-files`/`diff-index` row with an all-zero dst sha means "possibly changed". The watcher
confirms the change by re-hashing (FP #10, `hash-object --no-filters`) and comparing against its own stored
worktree-tier hash (FP §5 tier discipline). It must not compare against the index blob from the src column,
which would false-positive under clean/CRLF filters. Rows with a real dst sha are content-exact.

Related findings outside the plumbing set:

- `git -c diff.autoRefreshIndex=false diff` does not write the index but also reports stat-only paths (it listed
  touched `f3`), so it gives no gain over plumbing (probe).
- `GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2 -z --untracked-files=no` content-filtered the touched paths
  (reported only the really changed `f2`) **without** writing the index. The same command without the env var
  **did** write it (probe). This matches git(1): "this will prevent git status from refreshing the index as a side
  effect". It is a possible content-exact alternative to E1. It is outside this document's plumbing scope and its
  record format is not verified here.

### 3.3 Entries the worktree scan never examines

`run_diff_files` skips `if (ce_uptodate(ce) || ce_skip_worktree(ce)) continue;` and treats
`CE_VALID | CE_FSMONITOR_VALID` entries as unchanged without `lstat` (diff-lib.c). Probe: after
`git update-index --skip-worktree a` and `--assume-unchanged b`, edits to both produced **empty** `diff-files`
output, exit 0 (`ls-files -v` showed `S a`, `h b`). `diff-index` (non-cached) does the same: "if the entry is not
checked out, don't examine work tree" (`cached = … (idx->ce_flags & CE_VALID) || ce_skip_worktree(idx)`, diff-lib.c
`do_oneway_diff`). These are user-declared blind spots. The event scan cannot see them, and a periodic
`hash-object --no-filters` sweep is the only detector.

## 4. `diff-index` vs `diff-index --cached` vs porcelain `diff --cached`

- Doc: `git-diff-index <tree-ish>` "compares the <tree-ish> and the files on the filesystem"; `git-diff-index
  --cached <tree-ish>` "compares the <tree-ish> and the index"; `--cached` "Do not consider the on-disk file at
  all." (git-diff-index(1)). Non-cached mode answers "show me the differences between HEAD and the currently
  checked out tree - index contents _and_ files that aren't up to date" (NON-CACHED MODE).
- Source: builtin/diff-index.c calls `setup_work_tree()` + `repo_read_index_preload` only when
  `!(option & DIFF_INDEX_CACHED)`. In diff-lib.c `get_stat_data`, `if (!cached && !ce_uptodate(ce))` is the only
  place `check_removed()`/`lstat` and `match_stat_with_submodule` run. `--cached` sets `opts.index_only = cached`.
- Probe (state matrix §2): non-cached `diff-index HEAD` reported worktree-only deletions (`D gone`), chmod
  (`M mode`), typechanges, and unstaged edits. `--cached` reported only `both`, `staged`, and the staged rename.
- Porcelain `git diff --cached [<commit>]` is the same engine. builtin/diff.c documents
  "N=1, M=0, --cached: tree vs cache (diff-index --cached)" and dispatches to `run_diff_index(revs, option)`.
  Porcelain additionally applies UI config (`git_diff_ui_config`: `diff.renames`, `diff.ignoreSubmodules`,
  `diff.relative`, …), which plumbing does not read. FP #9 (porcelain `--cached`) is safe from index writes
  because `skip_stat_unmatch` never exceeds 1 without worktree reads, but plumbing E3 removes the config
  dependency.

### 4.1 Exact argv

- (a) checkpoint tree vs worktree, staged + unstaged combined:
  `git diff-index --raw -z -M100% --no-ext-diff --no-textconv --ignore-submodules=dirty <checkpoint> --`
- (b) checkpoint tree vs index only:
  `git diff-index --cached --raw -z -M100% --no-ext-diff --no-textconv --ignore-submodules=dirty <checkpoint> --`

The trailing `--` matters for `diff-index` exactly as in FP #7. With a worktree file literally named `HEAD~0`,
`git diff-index --cached --raw HEAD~0` → exit 128 `fatal: ambiguous argument 'HEAD~0': both revision and
filename`. With `--` the command succeeded (exit 0, probe). `<checkpoint>` should be a full sha validated by FP #3.

### 4.2 Not needed: `-m`, `--merge-base`

`-m`: "By default, files recorded in the index but not checked out are reported as deleted. This flag makes git
diff-index say that all non-checked-out files are up to date." `--merge-base`: compares against the merge base
with HEAD (git-diff-index(1)). The watcher wants neither, so it never passes them.

### 4.3 Unborn HEAD

`git diff-index --cached --raw HEAD` on an unborn repo → exit 128 `fatal: ambiguous argument 'HEAD': unknown
revision …`. With the empty-tree id (`git hash-object -t tree /dev/null`, format-specific per FP §8),
`git diff-index --cached --raw -z <empty-tree> --` → `:000000 100644 0{40} 78981922…85e A\0a\0`, exit 0.
`git cat-file -e <empty-tree>` exit 0, so the empty tree is resolvable without being written. `diff-files` works on
unborn HEAD (exit 0). This is the plumbing equivalent of the porcelain "Eek" fallback in builtin/diff.c
(`lookup_tree(..., the_repository->hash_algo->empty_tree)`).

## 5. Symlinks, typechanges, mode-only changes, gitlinks

Doc: "M: modification of the contents or mode of a file … T: change in the type of the file (regular file,
symbolic link or submodule)" (git-diff-files(1), RAW OUTPUT FORMAT). Verified encodings (probe §2, §7):

| Transition | Raw record (worktree view) |
|---|---|
| regular → symlink | `:100644 120000 <idx> 0{40} T` |
| symlink → regular | `:120000 100644 <idx> 0{40} T` |
| `chmod +x` (content unchanged) | `:100644 100755 <idx> 0{40} M` — mode-only is **M**, not T |
| symlink retarget | `M` with both modes `120000` (FP §3) |
| gitlink pointer moved (worktree) | `:160000 160000 <recorded> 0{40} M` |
| gitlink, inner dirt only (default/`none`) | `:160000 160000 <recorded> <recorded> M` — src sha == dst sha |

Rules:

- `T` ⇔ the high mode bits differ between {`100644`,`100755`}, `120000`, and `160000`. An executable-bit flip is
  `M` with differing modes, and is the only `M` whose two modes differ. The dst mode is the worktree mode
  (`newmode = ce_mode_from_stat(ce, st.st_mode)`, diff-lib.c).
- In the worktree view a moved submodule HEAD shows an **all-zero** dst sha, not the new commit
  (`new_oid = changed ? null_oid() : &ce->oid`, diff-lib.c). To learn the new pointer, read the submodule's HEAD.
  `--cached` and tree views carry real gitlink shas (FP §6).
- `src sha == dst sha` with `M` on a `160000` entry means inner dirtiness only. `--ignore-submodules=dirty`
  suppresses it (probe: empty output) while keeping pointer moves (probe: zero-dst `M`). This is consistent
  with FP §6.
- A typechange is never split into `D`+`A` by plumbing unless break detection (`-B`) is requested, which the
  watcher never does (gitdiffcore(7), diffcore-break).

## 6. Rename detection in plumbing

### 6.1 Defaults and config

- Plumbing does **not** detect renames by default. `diff.renames`: "Defaults to true. Note that this affects only
  git diff Porcelain like git-diff(1) and git-log(1), and not lower level commands such as git-diff-files(1)."
  (git-config(1)). Probe: `git -c diff.renames=true diff-index --cached --raw HEAD` printed `D ren` + `A ren_new`.
  Only explicit `-M` produced `R100 ren ren_new`. `--no-renames` after `-M` turned it off again (probe; doc:
  "Turn off rename detection, even when the configuration file gives the default to do so").
- Raw output **does** carry `R`/`C` when `-M`/`-C` is given ("Status letters C and R are always followed by a
  score", RAW OUTPUT FORMAT; gitdiffcore(7) shows `:100644 100644 0123456... 0123456... R100 fileX file0`).
- `diff-files` can only pair renames from `D` + i-t-a `A` (§2.3). Ordinary unstaged renames are invisible as `R`
  because the new path is untracked (FP §3). E1 therefore uses `--no-renames`: pairing adds nothing and would read
  worktree content.
- `diff-index` (non-cached) can pair staged renames (probe: `R100 ren ren_new` with `-M`). For a dst whose worktree
  sha is unknown (all-zero), rename pairing hashes the worktree file. Probe: `git mv a b` + `touch b`,
  `diff-index --raw -M100% HEAD` → `R100` with a **real** dst sha `e8823e17…` in place of zero. That read goes
  through Git's conversion machinery, the same residual as FP §5.

### 6.2 `-l<n>` and `diff.renameLimit`

- Doc: "-l<num> … This option prevents the exhaustive portion of rename/copy detection from running if the number of
  source/destination files involved exceeds the specified number. Defaults to diff.renameLimit. Note that a value of
  0 is treated as unlimited." (git-diff-files(1)). `diff.renameLimit`: "If not set, the default value is currently
  1000." (git-config(1); `merge.renameLimit` defaults differ, 7000, and are irrelevant here).
- Plumbing **honors** `diff.renameLimit` config even though it ignores `diff.renames` (probe:
  `git -c diff.renameLimit=2 diff-index --cached -M …` degraded exactly like `-l2`). Pass an explicit `-l<n>`
  for determinism if inexact detection is used.
- Over-limit behavior (probe, 5 exact + 5 inexact renames, `-M -l2`): the 5 exact renames stayed `R100`, and the 5
  inexact ones became `D x<i>` + `A x<i>_moved`. **Exit 0**. Stderr only:
  `warning: exhaustive rename detection was skipped due to too many files.` /
  `warning: you may want to set your diff.renameLimit variable to at least 5 and retry the command.`
  `-l0` → all 10 `R` (unlimited). Exact matching runs before the limited quadratic phase (gitdiffcore(7): "after
  exact rename detection, this preliminary step…"). Scripts cannot detect the degradation from the exit code. They
  either capture stderr or accept `D`+`A`, which is honest for staleness and imprecise only for successor
  resolution (FP §9 risk 3).

### 6.3 Exact-only renames (`-M100%`) and the partial-clone network hazard

- "To limit detection to exact renames, use -M100%." (git-diff-files(1), `-M`). Probe: `-M100%` on the 5+5 set →
  5 `R100`, the 5 inexact as `D`+`A`.
- **Inexact detection reads blobs, and in a partial clone a missing blob means a network fetch.** Probe:
  `git clone --filter=blob:none --no-checkout file:///tmp/des/pc-src pc`, then
  `GIT_TRACE=1 git diff-tree -r --raw -M HEAD~1 HEAD` traced
  `run_command: git -c fetch.negotiationAlgorithm=noop fetch origin --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin`
  and `in-pack` went 4 → 6. With `-M100%` and with `--no-renames`: no fetch, `in-pack` stayed 4, and raw `D`/`A`
  records were still produced from tree data alone. This breaks the local-first invariant (AGENTS.md rule 4) if
  E5 runs against a promisor remote. **Contract:** E1–E3 use exact-only `-M100%` (or `--no-renames`). E5 is used
  only when `git config --get-regexp '^remote\..*\.promisor$'` is empty. The probe was run with `diff-tree`; the
  same `diffcore_std` rename step serves `diff-index` (`run_diff_index` → `diffcore_std`, diff-lib.c), but the
  partial-clone probe was not repeated with `diff-index`.

## 7. Submodule ignore config also reaches plumbing

`diff.ignoreSubmodules` is porcelain-only: "Note that this affects only git diff Porcelain, and not lower level
diff commands such as git diff-files." (git-config(1)). Probe: `-c diff.ignoreSubmodules=all diff-files` still
showed inner dirt on `subm`. **However**, per-submodule `submodule.<name>.ignore` **is** applied by plumbing:
`if (!diffopt->flags.override_submodule_config) set_diffopt_flags_from_submodule_config(diffopt, ce->name);`
(diff-lib.c `match_stat_with_submodule`). Probe: with `submodule.subm.ignore=all` in `.gitmodules` **or** in
`.git/config`, a moved gitlink was **hidden** from both `diff-files` and `diff-index HEAD`. Adding an explicit
`--ignore-submodules=dirty` restored `:160000 160000 9b33e96b… 0{40} M subm` in both. FP's "every diff invocation
passes `--ignore-submodules=dirty` explicitly" is therefore mandatory for plumbing too, not just porcelain.

## 8. Exit codes and missing-object degradation

- `--exit-code`: "exits with 1 if there were differences and 0 means no differences." `--quiet`: "Disable all
  output of the program. Implies --exit-code." (git-diff-files(1)). Without either flag, a successful scan exits 0
  regardless of output (probe). Source: `result = diff_result_code(&rev.diffopt, result);` in both builtins.
- Missing **checkpoint commit**: `git diff-index --raw <missing-sha>` and `git diff-index --cached --raw
  <missing-sha> --` → exit 128 `fatal: bad object 0123456789abcdef…` (probe). Guard with FP #3 and take the FP §4
  content-hash fallback.
- Missing **checkpoint tree** (commit present): exit 128 `error: bad tree object f141d558…` (probe). Source:
  `return error("bad tree object %s", ...)` in `diff_cache`, then `if (diff_cache(...)) exit(128);`
  (diff-lib.c `run_diff_index`). FP #3 (`^{commit}`) does not catch this case. Treat any 128 from E2/E3 as
  "baseline unusable" and fall back to the content-hash tier.
- Missing **blob** (tree present): `git diff-index --cached --raw <c> --` (no renames) → exit 0 with correct
  `D a` / `A a2` records. The same with `-M` (inexact pair needed) → exit 128 `fatal: unable to read 96cc5588…`.
  `--quiet` → exit 1 (probe). Raw scans without inexact rename detection only compare oids, so they degrade safely.
  Retry rule: on exit 128 from E5, re-run E3 (`-M100%`). On exit 128 from E3, apply the tree/commit fallback above.
- `diff-files` never resolves a checkpoint object. Its only inputs are the index and worktree, so it cannot hit the
  missing-baseline cases.

## 9. Risks / residual items

1. **Stat-only false positives in plumbing** (§3.2): zero-dst rows must be confirmed by a worktree-tier re-hash.
   This contradicts FP §7's "worktree scans returned empty" note, which holds only for porcelain.
2. **User-declared blind spots** (§3.3): `--skip-worktree`, `--assume-unchanged`, and fsmonitor-valid entries are
   never examined by `diff-files`/`diff-index`.
3. **Partial clones** (§6.3): inexact rename detection triggers a lazy network fetch. E1–E3 stay exact-only.
4. **`submodule.<name>.ignore` reaches plumbing** (§7): the explicit `--ignore-submodules=dirty` is load-bearing.
5. **Silent rename-limit degradation** (§6.2): exit 0 with a stderr-only warning, and plumbing honors
   `diff.renameLimit` config.
6. **Unmerged `U` records carry the worktree dst mode** (§2.2), not the documented `000000`. Key on the letter.
7. **Worktree-side content reads** (rename pairing of zero-dst entries, §6.1) pass through clean filters, the same
   accepted residual as FP §5.
8. Version dependence: all behavior verified on 2.39.5 only. The i-t-a default (§2.3, source comment) and the
   `--ita-invisible-in-index` option are documented as "experimental and could be removed in future"
   (git-diff-files(1)). Re-run these probes when raising the minimum Git version.

## Not verified

- The `git status --porcelain=v2` record format and its filter/lock behavior beyond the single index-write probe (§3.2).
- Partial-clone lazy fetch was probed with `diff-tree`, not `diff-index` (§6.3). The shared code path is inferred
  from source (`diffcore_std`), not observed.
- Fsmonitor-enabled repositories (`core.fsmonitor`) were not probed. §3.3 rests on source alone.
- The location of every `use_optional_locks()` call site in git source was not audited. The claim that
  `refresh_index_quietly` ignores `GIT_OPTIONAL_LOCKS` rests on its body (builtin/diff.c v2.39.5) plus the probe.

## Sources

- Man pages of the tested binary, git 2.39.5 (Apple Git-154), `/Library/Developer/CommandLineTools/usr/share/man/`:
  git-diff-files(1) (SYNOPSIS, `--raw`, `-z`, `--no-renames`, `-M`, `-l<num>`, `--exit-code`, `--quiet`,
  `--ignore-submodules`, `--ita-invisible-in-index`, `-0/-1/-2/-3`, `-q`, RAW OUTPUT FORMAT), git-diff-index(1)
  (`--cached`, `-m`, `--merge-base`, OPERATING MODES, CACHED MODE, NON-CACHED MODE), gitdiffcore(7) (THE CHAIN OF
  OPERATION, DIFFCORE-RENAME), git-config(1) (`diff.autoRefreshIndex`, `diff.renames`, `diff.renameLimit`,
  `diff.ignoreSubmodules`, `merge.renameLimit`), git(1) (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS`).
  Canonical URLs: https://git-scm.com/docs/git-diff-files , https://git-scm.com/docs/git-diff-index ,
  https://git-scm.com/docs/gitdiffcore , https://git-scm.com/docs/git-config , https://git-scm.com/docs/git
- Git source at tag v2.39.5: https://github.com/git/git/blob/v2.39.5/builtin/diff-files.c ,
  https://github.com/git/git/blob/v2.39.5/builtin/diff-index.c , https://github.com/git/git/blob/v2.39.5/builtin/diff.c
  (`refresh_index_quietly`, `skip_stat_unmatch`, dispatch table), https://github.com/git/git/blob/v2.39.5/diff-lib.c
  (`run_diff_files`, `check_removed`, `match_stat_with_submodule`, `get_stat_data`, `do_oneway_diff`, `diff_cache`,
  `run_diff_index`).
- Empirical probes against the 2.39.5 binary, fixtures under `/tmp/des/` (`r`, `m`, `rl`, `s`, `c`, `w`, `mo`, `pc`,
  `pc2`, `ub`, `sw`, `ex`); `od -c` / `tr '\0' '|'` byte evidence, md5 + mtime index-write evidence, and
  `GIT_TRACE=1` fetch evidence are cited inline above.
- Repo context: docs/research/mission-4-git-fingerprint-verification.md (FP, the contracts this extends),
  docs/adr/0008-code-memory-git-fingerprints.md, AGENTS.md rule 4 (local-first invariant).
