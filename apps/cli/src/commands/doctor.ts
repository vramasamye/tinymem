/**
 * `onemem doctor` — the full diagnostic report, printed (or emitted as JSON), with the exit code
 * the report itself prescribes: 0 when onememory is usable, 1 when a check failed. Warnings are
 * surfaced, not fatal — a usable-but-degraded setup (no embedder, heuristic extraction) is the
 * product's default state, not an error.
 *
 * The runtime computes summary/status/exit_code; the CLI adds one check of its own — how it
 * resolved the backend — and hands the assembled report back to the runtime's `finalize` seam so
 * the displayed counts cover every check shown (backlog #12).
 */

import { ConfigError, ConfigNotFoundError } from '@onememory-ai/config';
import { finalizeDoctorReport, type DoctorCheck, type DoctorReport } from '@onememory-ai/api/runtime';

import type { Io } from '../io';
import { printConfigError, resolveBackend } from '../resolve';

export interface DoctorOptions {
  cwd?: string;
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  /** `--no-probe`: skip probing the configured embedder (dimension discovery). */
  probeEmbedder?: boolean;
}

/**
 * The check the CLI contributes: it is the only layer that knows whether this invocation ran
 * against a daemon or opened storage directly. Pass (the daemon owns storage and drains the job
 * queue) or warn (direct mode leaves queued jobs waiting) — never a failure: direct mode is the
 * supported default, not an error.
 */
export function modeCheck(mode: 'daemon' | 'local', daemonUrl: string | null): DoctorCheck {
  if (mode === 'daemon') {
    return {
      id: 'daemon',
      title: 'daemon',
      status: 'pass',
      detail: `this command ran against the daemon at ${daemonUrl}; storage and the job worker live there`,
    };
  }
  return {
    id: 'worker',
    title: 'job worker',
    status: 'warn',
    detail:
      'not running (direct mode) — normalize/extract/re_embed jobs stay queued until an onememory daemon runs',
    remediation: 'start one with: onemem serve',
  };
}

export async function runDoctor(options: DoctorOptions, io: Io): Promise<number> {
  const { backend, mode, daemonUrl } = await resolveBackend(options);
  try {
    const report = await backend.doctor({
      ...(options.probeEmbedder === undefined ? {} : { probeEmbedder: options.probeEmbedder }),
    });
    // Counts must be derived after the CLI's own check is appended, so both output paths (the JSON
    // document and the printed report) agree with the checks they list.
    const finalized = finalizeDoctorReport(report, [modeCheck(mode, daemonUrl)]);
    io.emit(finalized);
    printReport(io, finalized);
    return finalized.exit_code;
  } finally {
    await backend.close();
  }
}

export function printReport(io: Io, report: DoctorReport): void {
  io.out(`onemem doctor ${report.version} — ${report.status}`);
  io.out(`  config: ${report.config_path ?? '(built-in defaults)'}`);
  io.blank();
  for (const check of report.checks) printCheck(io, check);
  if (report.runtimes.length > 0) {
    io.blank();
    io.out('agent runtimes (opt-in wiring; MCP must point at the configured daemon):');
    for (const check of report.runtimes) printCheck(io, check);
  }
  io.blank();
  io.out(
    `${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed${
      report.summary.info > 0 ? `, ${report.summary.info} informational` : ''
    } — onememory is ${
      report.status === 'ok' ? 'fully operational' : report.status === 'degraded' ? 'usable but degraded' : 'not usable'
    }`,
  );
}

const STATUS_LABELS: Record<DoctorCheck['status'], string> = {
  pass: 'ok',
  warn: 'warning',
  fail: 'FAIL',
  info: 'info',
};

function printCheck(io: Io, check: DoctorCheck): void {
  io.out(`[${STATUS_LABELS[check.status]}] ${check.title}: ${check.detail}`);
  if (check.remediation !== undefined) {
    io.out(`       ${check.status === 'info' ? 'hint' : 'fix'}: ${check.remediation}`);
  }
}

/**
 * The no-configuration case is a *finding*, not a crash: the message names the fix and the exit
 * code is 1 (doctor is usable precisely when it can say what is wrong).
 */
export function reportNoConfig(error: ConfigNotFoundError, io: Io): number {
  printConfigError(error, (line) => io.out(line));
  io.emit({ status: 'failed', exit_code: 1, no_config: true, config: null });
  return 1;
}

export type { ConfigError };
