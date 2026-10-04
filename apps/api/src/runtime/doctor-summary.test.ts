/**
 * The doctor summary seam (backlog #12): `finalizeDoctorReport` is the one place `summary`,
 * `status` and `exit_code` are derived, so a caller that appends a check of its own after
 * inspecting the runtime (the CLI's daemon/worker mode check) gets counts that cover the check it
 * shows. These tests pin the derivation itself, including the exit-code rule that makes a `warn`
 * degraded-but-usable rather than an error.
 */

import { describe, expect, test } from 'bun:test';

import {
  failedDoctorReport,
  finalizeDoctorReport,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorDraft,
} from './doctor';

function check(id: string, status: DoctorCheckStatus): DoctorCheck {
  return { id, title: id, status, detail: `${id} detail` };
}

function draft(checks: DoctorCheck[], runtimes: DoctorCheck[] = []): DoctorDraft {
  return {
    generated_at: '2026-10-04T00:00:00.000Z',
    version: '0.1.0-test',
    config_path: '/tmp/project/.onememory/onememory.yaml',
    config: null,
    checks,
    runtimes,
  };
}

describe('finalizeDoctorReport', () => {
  test('counts an appended warn check — the daemon-absent (direct mode) shape', () => {
    const report = finalizeDoctorReport(draft([check('config', 'pass'), check('storage', 'pass')]), [
      check('worker', 'warn'),
    ]);

    expect(report.checks.map((entry) => entry.id)).toEqual(['config', 'storage', 'worker']);
    expect(report.summary).toEqual({ pass: 2, warn: 1, fail: 0, info: 0 });
    // A warned worker is the product's default degraded state, never an error.
    expect(report.status).toBe('degraded');
    expect(report.exit_code).toBe(0);
  });

  test('counts an appended pass check — the daemon-present shape', () => {
    const report = finalizeDoctorReport(draft([check('config', 'pass'), check('storage', 'pass')]), [
      check('daemon', 'pass'),
    ]);

    expect(report.summary).toEqual({ pass: 3, warn: 0, fail: 0, info: 0 });
    expect(report.status).toBe('ok');
    expect(report.exit_code).toBe(0);
  });

  test('counts the runtime wiring group alongside the checks', () => {
    const report = finalizeDoctorReport(
      draft([check('config', 'pass')], [check('runtime-claude-code', 'info'), check('runtime-codex', 'warn')]),
      [check('daemon', 'pass')],
    );

    expect(report.summary).toEqual({ pass: 2, warn: 1, fail: 0, info: 1 });
    expect(report.status).toBe('degraded');
  });

  test('a failing appended check is the only thing that makes the report unusable', () => {
    const report = finalizeDoctorReport(draft([check('config', 'pass')]), [check('storage', 'fail')]);

    expect(report.summary).toEqual({ pass: 1, warn: 0, fail: 1, info: 0 });
    expect(report.status).toBe('failed');
    expect(report.exit_code).toBe(1);
  });

  test('appending nothing re-derives from the draft alone', () => {
    const report = finalizeDoctorReport(draft([check('config', 'pass'), check('embedder', 'warn')]));

    expect(report.summary).toEqual({ pass: 1, warn: 1, fail: 0, info: 0 });
    expect(report.status).toBe('degraded');
  });

  test('does not mutate the report it is given', () => {
    const checks = [check('config', 'pass')];
    const input = draft(checks);
    const report = finalizeDoctorReport(input, [check('worker', 'warn')]);

    expect(input.checks).toBe(checks);
    expect(checks).toHaveLength(1);
    expect(input).not.toHaveProperty('summary');
    expect(report).not.toBe(input);
    expect(report.checks).not.toBe(checks);
  });

  test('re-finalizing a finished report replaces its stale derived fields', () => {
    // The CLI receives a complete report from the backend, appends its mode check and re-derives:
    // the stale summary must not survive the spread.
    const stale = finalizeDoctorReport(draft([check('config', 'pass')]));
    expect(stale.summary).toEqual({ pass: 1, warn: 0, fail: 0, info: 0 });

    const refreshed = finalizeDoctorReport(stale, [check('worker', 'warn')]);
    expect(refreshed.summary).toEqual({ pass: 1, warn: 1, fail: 0, info: 0 });
    expect(refreshed.status).toBe('degraded');
    expect(refreshed.exit_code).toBe(0);
  });
});

describe('failedDoctorReport', () => {
  test('a report that could not be opened stays failed with exit code 1', () => {
    const report = failedDoctorReport('/tmp/x/onememory.yaml', 'storage is not usable', 'fix it');

    expect(report.summary).toEqual({ pass: 0, warn: 0, fail: 1, info: 0 });
    expect(report.status).toBe('failed');
    expect(report.exit_code).toBe(1);
    expect(report.checks.map((entry) => entry.id)).toEqual(['storage']);
  });
});
