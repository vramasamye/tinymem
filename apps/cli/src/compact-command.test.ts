/**
 * `onemem compact` end to end through the real CLI: the local preset project (no raw events
 * ingested by hand — the data path is covered by the consolidation integration suite) still
 * exercises the full command surface: backend resolution, the typed dry-run plan, the executing
 * run, the window validation, and the duration parser.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { jsonOf, runMain, type Captured } from './test-support';
import { parseWindowDays } from './commands/compact';

async function cli(argv: string[]): Promise<Captured> {
  return runMain(argv);
}

let root: string;

beforeAll(() => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-compact-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('onemem compact', () => {
  test('dry-run prints the typed plan and changes nothing', async () => {
    expect((await cli(['init', '--preset', 'local', '--name', 'compact-demo', '--cwd', root, '--json'])).exitCode).toBe(0);

    const planned = await cli(['compact', '--cwd', root, '--dry-run', '--json']);
    expect(planned.exitCode).toBe(0);
    const report = jsonOf(planned);
    expect(report.dry_run).toBeTrue();
    expect(report.scope.project_id).toMatch(/^[0-9a-f]{8}-/); // the registered project's pass
    expect(report.windows).toEqual({ summary_window_days: 30, retention_window_days: 90 });
    expect(report.plan.summary_cutoff < report.ran_at).toBeTrue();
    expect(report.plan.retention_cutoff! < report.plan.summary_cutoff).toBeTrue();
    expect(report.plan.to_summarize).toBe(0); // no raw events ingested by hand
    expect(report.plan.to_purge).toBe(0);
    expect(report.plan.entries).toEqual([]);
    expect(report.plan.blocked).toEqual([]);
    expect(report.summarized).toBe(0);
    expect(report.purged).toBe(0);
    expect(report.batches).toBe(0);
    expect(report.raw_events_remaining).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  test('the executing run reports the same shape and exits clean', async () => {
    const executed = await cli(['compact', '--cwd', root, '--json']);
    expect(executed.exitCode).toBe(0);
    const report = jsonOf(executed);
    expect(report.dry_run).toBeFalse();
    expect(report.summarized).toBe(0);
    expect(report.purged).toBe(0);
    expect(report.raw_events_remaining).toBe(0);
  });

  test('human mode prints the pass summary in both modes', async () => {
    const planned = await cli(['compact', '--cwd', root, '--dry-run']);
    expect(planned.exitCode).toBe(0);
    expect(planned.out).toContain('events compaction planned (dry run — nothing was changed)');
    expect(planned.out).toContain('windows:    summarize older than 30d, purge older than 90d');

    const executed = await cli(['compact', '--cwd', root]);
    expect(executed.exitCode).toBe(0);
    expect(executed.out).toContain('events compaction compacted for project');
    expect(executed.out).toContain('raw events: 0 remain in scope');
  });

  test('custom windows ride through, including keep-forever retention', async () => {
    const forever = await cli([
      'compact', '--cwd', root, '--json', '--dry-run',
      '--retention-window', '0', '--summary-window', '7d',
    ]);
    expect(forever.exitCode).toBe(0);
    const report = jsonOf(forever);
    expect(report.windows).toEqual({ summary_window_days: 7, retention_window_days: 0 });
    expect(report.plan.retention_cutoff).toBeNull(); // 0 = keep forever
  });

  test('rejects a summary window longer than the retention window with a clear message', async () => {
    const result = await cli([
      'compact', '--cwd', root, '--json',
      '--summary-window', '90', '--retention-window', '30',
    ]);
    expect(result.exitCode).toBe(1);
    const document = jsonOf(result);
    expect(document.error.code).toBe('invalid_request');
    expect(document.error.message).toContain('must be at most retentionWindowDays (30)');
  });

  test('refuses cleanly without an initialized project', async () => {
    const empty = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-compact-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      const result = await cli(['compact', '--cwd', empty, '--json']);
      expect(result.exitCode).toBe(1);
      const document = jsonOf(result);
      expect(document.error.code).toBe('invalid_request');
      expect(document.error.message).toContain('init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('parseWindowDays', () => {
  test('accepts whole days with an optional d suffix, case-insensitive', () => {
    expect(parseWindowDays('90', '--retention-window')).toBe(90);
    expect(parseWindowDays('90d', '--retention-window')).toBe(90);
    expect(parseWindowDays('7D', '--summary-window')).toBe(7);
    expect(parseWindowDays('0', '--retention-window')).toBe(0); // keep forever
  });

  test('rejects everything else with the option named in the message', () => {
    for (const bad of ['abc', '90 days', '-5', '1.5', '', '9d0']) {
      expect(() => parseWindowDays(bad, '--summary-window')).toThrow(/--summary-window/);
    }
  });
});
