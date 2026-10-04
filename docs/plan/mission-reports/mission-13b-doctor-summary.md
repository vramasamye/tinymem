# Mission 13b report — the doctor summary counts the daemon/worker check (backlog #12)

**Branch:** `mission/13b-doctor-summary` (based on `main` `133b4cb`)
**Scope delivered:** the summary derivation seam in `apps/api/src/runtime/doctor.ts` (+ its public
export), the CLI consumption of that seam in `apps/cli/src/commands/doctor.ts`, focused tests for
both, this report. Nothing outside `apps/api/src/runtime/**` and `apps/cli/src/**` was touched.
**Backlog item:** #12 — "Doctor summary includes daemon checks [P2]: the CLI appends its
daemon/worker result after calculating `summary`, so the displayed counts omit that check. AC:
compute summary after all checks are assembled and cover daemon-present / daemon-absent cases."

---

## 1. The defect (confirmed, then fixed)

`runDoctor` called `backend.doctor(...)` (which returns a `DoctorReport` whose `summary`, `status`
and `exit_code` are already computed), then **pushed** its own check onto `report.checks` —
`daemon` (pass) in daemon mode, `worker` (warn) in direct mode — and displayed the *stale* summary
through both output paths (`io.emit(report)` for `--json`, `printReport(io, report)` for humans).
The report therefore listed N+1 checks while its counts covered N. Pre-fix runs of the new tests
fail with `pass: 2` where `pass: 3` is required (daemon mode) and with a warn count one short of the
printed `[warning]` lines (direct mode).

## 2. The seam chosen, and why

`summary`/`status`/`exit_code` now have exactly one definition, and every assembly site routes
through it:

```ts
// apps/api/src/runtime/doctor.ts
export type DoctorDraft = Omit<DoctorReport, 'status' | 'exit_code' | 'summary'>;

export function finalizeDoctorReport(report: DoctorDraft, extra: readonly DoctorCheck[] = []): DoctorReport
```

- The derivation (`summarise` over `checks + runtimes`, plus the `outcome()` rule `fail → failed/1`,
  `warn → degraded/0`, else `ok/0`) lives only in `apps/api` — the CLI neither forked nor copied it.
- `extra` is appended to `report.checks` inside the runtime function, so the caller says *what* to
  add and the runtime owns *how counts are derived*. `inspectRuntime` and `failedDoctorReport` were
  rerouted through the same function, so there is no second place a summary can be computed.
- Pure: the input report and its arrays are never mutated; the result is a new object. That matters
  because the CLI's input is a report decoded from a backend (in-process object or REST JSON), and
  `finalizeDoctorReport` also accepts an already-finished `DoctorReport` — the stale derived fields
  are replaced by the recomputed ones (pinned by a test).
- Chosen over "widen `doctor()` options so the backend appends the mode check" because the backend
  does not know how the CLI resolved itself (the daemon's own report is produced on the other side
  of the REST boundary in daemon mode), and over "recompute in the CLI" because that forks the
  derivation. The runtime-side `finalize` keeps one definition and one call site in the CLI.

CLI side (`apps/cli/src/commands/doctor.ts`): the push was replaced by an exported pure
`modeCheck(mode, daemonUrl)` plus one call —

```ts
const finalized = finalizeDoctorReport(report, [modeCheck(mode, daemonUrl)]);
io.emit(finalized);
printReport(io, finalized);
return finalized.exit_code;
```

**Exit-code semantics are unchanged:** the `worker` warning still yields `status: 'degraded'`,
`exit_code: 0` (degraded-but-usable is the product's default state); only a `fail` produces
`failed`/`1`. Asserted in both the API and CLI tests.

## 3. Tests

| File | Covers |
|---|---|
| `apps/api/src/runtime/doctor-summary.test.ts` (8 tests) | The seam itself: appended `warn` (direct) and `pass` (daemon) shapes, the runtimes group counted alongside checks, a failing appended check as the only error path, no-op append, **no mutation of the input**, and re-finalizing a finished report replacing its stale fields |
| `apps/cli/src/doctor-summary.test.ts` (4 tests) | End to end through `main()`: **daemon-absent** (real local project, direct mode) — the emitted document counts the appended worker warning (`summary` equals a recount of `checks + runtimes`, and exactly one less warn without it), and the printed report's `N passed, N warnings, N failed` equals the number of printed `[ok]/[warning]/[FAIL]/[info]` check lines; **daemon-present** — a fake loopback daemon plus a real `daemon.json` (`writeDaemonLock`) so the CLI discovers it as it would a real one, then both output paths show the appended `daemon: pass` counted (3 passes, not 2) |

Daemon-present is exercised against a fake loopback daemon rather than an in-process
`startDaemon()` on purpose: a real daemon installs the process-wide privacy guard, which has no
loopback allowance in Phase 1 (documented in `runtime.test.ts`), so the CLI's own `probeDaemon`
and REST calls would be blocked from inside the same test process. Pre-fix, all four CLI tests fail.

## 4. Validation

- Focused: `bun test src/runtime/doctor-summary.test.ts` (apps/api) — **8 pass / 0 fail**;
  `bun test src/doctor-summary.test.ts` (apps/cli) — **4 pass / 0 fail**. Both files were also run
  against the pre-fix CLI code (temporary local revert, not committed) to prove they fail — 4 fail.
- Focused neighbours: `bun test apps/api/src/runtime apps/api/src/server apps/cli/src` — 96 pass /
  0 fail (includes the pre-existing `cli.test.ts` and `init-wiring.test.ts` doctor paths).
- Typechecks: `cd apps/api && bun run typecheck` and `cd apps/cli && bun run typecheck` — clean.
- Full suite at the worktree root: `bun test` — **984 pass / 19 skip / 0 fail** (1003 tests, 74
  files). Baseline at `main` `133b4cb`: 972 pass / 19 skip / 0 fail (991 tests, 72 files); this
  mission adds 12 tests in 2 files.

## 5. Out of scope / follow-ups

- No change to which checks exist or how they are worded, and no change to `status`/`exit_code`
  semantics — only the counts/status display became accurate.
- The `runDoctor` command still owns the text of its mode check; if a future caller (an adapter, the
  MCP surface) needs the same treatment, it should call `finalizeDoctorReport` rather than
  re-deriving counts.
- `apps/cli/src/commands/doctor.ts` in `--json` mode emits the report as the single document; the
  `no_config` early exit (`reportNoConfig`) is a different document and was left as-is.
- No TODO markers were added to shipped code.
