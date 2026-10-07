/**
 * `onemem doctor` summary counts (backlog #12).
 *
 * The runtime derives `summary`/`status`/`exit_code`, but the CLI appends one check of its own
 * after that — `daemon` (pass) when it ran against a daemon, `worker` (warn) in direct mode. These
 * tests pin the user-visible contract: BOTH output paths (the `--json` document and the printed
 * report) count that check, the printed counts match the printed checks, and a warned worker stays
 * a warning (degraded-but-usable, exit 0) rather than becoming an error.
 *
 * Daemon mode is exercised against a fake loopback daemon plus a real `daemon.json` lock: an
 * in-process `startDaemon` would install the process-wide privacy guard, which has no loopback
 * allowance in Phase 1 and would block the CLI's own probe and REST calls.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeDaemonLock, type DoctorCheck, type DoctorReport } from '@onememory-ai/api/runtime';

import { main } from './bin';
import { jsonOf } from './test-support';

const BOOT_TIMEOUT = 60_000;

interface Captured {
  out: string;
  err: string;
  exitCode: number;
}

async function cli(argv: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  const exitCode = await main(argv, {
    interactive: false,
    env: {},
    write: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err, exitCode };
}

function projectDir(name: string): string {
  const dir = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-doctor-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Count the report's own checks + runtimes: what `summary` must be, appended check included. */
function recount(report: { checks: DoctorCheck[]; runtimes: DoctorCheck[] }): DoctorReport['summary'] {
  const all = [...report.checks, ...report.runtimes];
  return {
    pass: all.filter((entry) => entry.status === 'pass').length,
    warn: all.filter((entry) => entry.status === 'warn').length,
    fail: all.filter((entry) => entry.status === 'fail').length,
    info: all.filter((entry) => entry.status === 'info').length,
  };
}

/** Parse the printed "N passed, N warnings, N failed[, N informational]" line. */
function printedSummary(out: string): DoctorReport['summary'] {
  const match = out.match(/(\d+) passed, (\d+) warnings, (\d+) failed(?:, (\d+) informational)?/);
  if (match === null) throw new Error(`no summary line in output:\n${out}`);
  return {
    pass: Number(match[1]!),
    warn: Number(match[2]!),
    fail: Number(match[3]!),
    info: match[4] === undefined ? 0 : Number(match[4]!),
  };
}

/** Count the printed `[label] title: detail` lines (the checks the report lists). */
function printedChecks(out: string, label: string): number {
  return out.split('\n').filter((line) => line.startsWith(`[${label}]`)).length;
}

describe('direct mode (no daemon): the appended worker check is counted', () => {
  let root: string;

  beforeAll(async () => {
    root = projectDir('direct');
    const init = await cli(['init', '--preset', 'local', '--name', 'direct', '--cwd', root, '--json']);
    expect(init.exitCode).toBe(0);
  }, BOOT_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the emitted document counts it exactly once, as one more warning', async () => {
    const result = await cli(['doctor', '--cwd', root, '--no-probe', '--json']);
    expect(result.exitCode).toBe(0);
    const report = jsonOf(result) as DoctorReport;

    const worker = report.checks.find((entry) => entry.id === 'worker');
    expect(worker?.status).toBe('warn');

    // The counts are a function of every check the report shows.
    expect(report.summary).toEqual(recount(report));

    // Specifically: the appended check is the whole of its own +1 — a summary derived before the
    // append (the defect) is short by exactly this check.
    const withoutWorker = { checks: report.checks.filter((entry) => entry.id !== 'worker'), runtimes: report.runtimes };
    expect(recount(withoutWorker)).toEqual({ ...report.summary, warn: report.summary.warn - 1 });

    // Degraded-but-usable: a warned worker never becomes an error.
    expect(report.status).toBe('degraded');
    expect(report.exit_code).toBe(0);
  }, BOOT_TIMEOUT);

  test('the printed report shows the worker line and counts every printed check', async () => {
    const human = await cli(['doctor', '--cwd', root, '--no-probe']);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('[warning] job worker: not running');

    const summary = printedSummary(human.out);
    expect(summary.pass).toBe(printedChecks(human.out, 'ok'));
    expect(summary.warn).toBe(printedChecks(human.out, 'warning'));
    expect(summary.fail).toBe(printedChecks(human.out, 'FAIL'));
    expect(summary.info).toBe(printedChecks(human.out, 'info'));
  }, BOOT_TIMEOUT);
});

describe('daemon mode: the appended daemon check is counted', () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;

  // An honest daemon-shaped report: the CLI must end up counting one MORE pass than this, because
  // it appends its own `daemon: pass` check — and every listed check must be covered.
  const daemonReport: DoctorReport = {
    status: 'ok',
    exit_code: 0,
    generated_at: '2026-10-04T00:00:00.000Z',
    version: '0.1.0-test',
    config_path: '/tmp/fake-daemon/onememory.yaml',
    config: null,
    summary: { pass: 2, warn: 0, fail: 0, info: 0 },
    checks: [
      { id: 'config', title: 'configuration', status: 'pass', detail: 'loaded' },
      { id: 'storage', title: 'storage', status: 'pass', detail: 'reachable' },
    ],
    runtimes: [],
  };

  beforeAll(async () => {
    root = projectDir('daemon');
    const init = await cli(['init', '--preset', 'local', '--name', 'served', '--cwd', root, '--json']);
    expect(init.exitCode).toBe(0);

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === '/v1/health') return Response.json({ status: 'ok', version: '0.1.0-test' });
        if (pathname === '/v1/doctor') return Response.json(daemonReport);
        return new Response('not found', { status: 404 });
      },
    });

    // `writeDaemonLock` is the runtime's own writer: the CLI discovers the daemon exactly as it
    // would a real one (lock file → live pid → /v1/health answer).
    const port = server.port;
    if (port === undefined) throw new Error('Bun.serve did not report a TCP port');
    writeDaemonLock(join(root, '.onememory'), {
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port,
      url: `http://127.0.0.1:${port}`,
      started_at: new Date().toISOString(),
      version_string: '0.1.0-test',
    });
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('the emitted document counts the appended daemon check', async () => {
    const result = await cli(['doctor', '--cwd', root, '--json']);
    expect(result.exitCode).toBe(0);
    const report = jsonOf(result) as DoctorReport;

    expect(report.checks.map((entry) => [entry.id, entry.status])).toEqual([
      ['config', 'pass'],
      ['storage', 'pass'],
      ['daemon', 'pass'],
    ]);
    expect(report.checks[2]!.detail).toContain('ran against the daemon at http://127.0.0.1:');
    expect(report.summary).toEqual({ pass: 3, warn: 0, fail: 0, info: 0 });
    expect(report.summary).toEqual(recount(report));
    expect(report.status).toBe('ok');
    expect(report.exit_code).toBe(0);
  }, BOOT_TIMEOUT);

  test('the printed report shows the same three passes and the daemon line', async () => {
    const human = await cli(['doctor', '--cwd', root]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('[ok] daemon: this command ran against the daemon at http://127.0.0.1:');
    expect(printedSummary(human.out)).toEqual({ pass: 3, warn: 0, fail: 0, info: 0 });
    expect(printedChecks(human.out, 'ok')).toBe(3);
    expect(human.out).toContain('fully operational');
  }, BOOT_TIMEOUT);
});
