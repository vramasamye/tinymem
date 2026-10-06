/**
 * `onemem digest` end to end through the real CLI (the local preset — no embedder, no model,
 * no network — is the honest default install, and the digest needs none of them): remember
 * procedural facts → build the digest → inspect the durable row → re-run (unchanged) → tighten
 * the budget (audited supersede) → refuse cleanly without an initialized project.
 *
 * Decisions and failures remembered via `onemem remember` carry no `decisions`/`failures`
 * payload rows (the payload write path is the extraction pipeline's, M3d), so the curated reads
 * the digest rides (`latestAcceptedDecisions` / `recentFailures`) do not see them — the same
 * boundary fact the `memory_decisions` / `memory_failures` tool surface already documents. The
 * procedure section reads plain memories and needs no payload, so the CLI scenario uses those;
 * the decisions/failures halves of the rollup are covered by the package-level suites over
 * payload-seeded storage.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { jsonOf, runMain, type Captured } from './test-support';

async function cli(argv: string[]): Promise<Captured> {
  return runMain(argv);
}

let root: string;

beforeAll(() => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-digest-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('onemem digest', () => {
  test('creates the in-budget digest, reports unchanged on re-run, and supersedes on a tighter budget', async () => {
    expect((await cli(['init', '--preset', 'local', '--name', 'digest-demo', '--cwd', root, '--json'])).exitCode).toBe(0);

    // Three procedural facts — the section the curated read surfaces without payload rows.
    for (const [content, title] of [
      ['Run migrations before the service starts, every deploy.', 'Run migrations before serve'],
      ['Ship new endpoints behind the API gateway with an allow-list.', 'Ship behind the gateway'],
      ['Run the full test suite before tagging a release.', 'Test before release tags'],
    ] as const) {
      const remembered = await cli(['remember', content, '--type', 'procedural', '--title', title, '--cwd', root, '--json']);
      expect(remembered.exitCode).toBe(0);
    }

    const created = await cli(['digest', '--cwd', root, '--json']);
    expect(created.exitCode).toBe(0);
    const report = jsonOf(created);
    expect(report.outcome).toBe('created');
    expect(report.digest.used).toBeLessThanOrEqual(750);
    expect(report.digest.sources.procedures).toBe(3);
    expect(report.digest.text).toContain('procedures:');
    expect(report.digest.text).toContain('Run migrations before serve');
    expect(report.digest.kind).toBe('project_context');
    expect(report.memory_id).toMatch(/^[0-9a-f]{8}-/);
    const memoryId: string = report.memory_id;

    // The durable row: semantic / project_context, current, budget-accounted.
    const inspected = await cli(['inspect', memoryId, '--cwd', root, '--json']);
    expect(inspected.exitCode).toBe(0);
    const memory = jsonOf(inspected).memory;
    expect(memory.type).toBe('semantic');
    expect(memory.subtype).toBe('project_context');
    expect(memory.status).toBe('active');
    expect(memory.token_estimate).toBe(report.digest.used);

    // Re-run: the content hash did not change — unchanged, never a second row.
    const rerun = await cli(['digest', '--cwd', root, '--json']);
    expect(jsonOf(rerun).outcome).toBe('unchanged');
    expect(jsonOf(rerun).memory_id).toBe(memoryId);

    // A tighter budget that actually drops lines changes the text: the predecessor closes into
    // the winner, audited. (A 60-token budget would NOT change it here — the roll-forward
    // allowances still fit every line, so the text stays identical and the outcome stays
    // unchanged. 20 tokens is where the procedures section genuinely shrinks.)
    const tightened = await cli(['digest', '--budget', '20', '--cwd', root, '--json']);
    expect(tightened.exitCode).toBe(0);
    const tighter = jsonOf(tightened);
    expect(tighter.outcome).toBe('refreshed');
    expect(tighter.digest.used).toBeLessThanOrEqual(20);
    expect(tighter.digest.text).toContain('Test before release tags'); // the top line survives
    expect(tighter.digest.text).not.toContain('Ship behind the gateway'); // whole lines dropped
    expect(tighter.memory_id).not.toBe(memoryId);

    // The predecessor closed into the winner — its audit carries the superseded transition.
    const supersededRow = await cli(['inspect', memoryId, '--cwd', root, '--json']);
    expect(jsonOf(supersededRow).memory.status).toBe('superseded');
    expect(jsonOf(supersededRow).memory.superseded_by).toBe(tighter.memory_id);
    const transition = (jsonOf(supersededRow).audit as Array<{ action: string; to_status?: string }>).find(
      (event) => event.action === 'status_changed' && event.to_status === 'superseded',
    );
    expect(transition).toBeDefined();
  });

  test('human mode prints the pass summary and the digest text itself', async () => {
    // The previous test left the current digest at the 20-token budget; re-run at the same
    // budget so the outcome is honestly 'unchanged' (a different budget means a changed text).
    const result = await cli(['digest', '--budget', '20', '--cwd', root]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain('project digest unchanged for project');
    expect(result.out).toContain('budget:     ');
    expect(result.out).toContain('sources:    0 decisions');
    // The digest text is printed verbatim for inspection.
    expect(result.out).toContain('project: digest-demo');
  });

  test('refuses cleanly without an initialized project', async () => {
    // A directory OUTSIDE the initialized root — config discovery walks up the tree and would
    // find the root's config from any nested path.
    const empty = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-digest-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      const result = await cli(['digest', '--cwd', empty, '--json']);
      expect(result.exitCode).toBe(1);
      const document = jsonOf(result);
      expect(document.error.code).toBe('invalid_request');
      expect(document.error.message).toContain('init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
