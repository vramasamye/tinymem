/**
 * `onemem consolidate` end to end through the real CLI: the local preset (no embedder
 * configured — the default, fully offline install) still resolves contradictions and runs
 * decay, degrades the vector-dependent passes with explicit warnings, and reports one JSON
 * document. The authority-resolved Node pair closes the loop: remember two version facts →
 * consolidate → the newer survives, the older is superseded and audited.
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
    `onemem-consolidate-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('onemem consolidate', () => {
  test('resolves a contradicted version fact by authority, audited, and degrades the vector passes honestly', async () => {
    expect((await cli(['init', '--preset', 'local', '--name', 'consolidate-demo', '--cwd', root, '--json'])).exitCode).toBe(0);

    const older = await cli(['remember', 'Version: Node 20', '--cwd', root, '--json']);
    expect(older.exitCode).toBe(0);
    const newer = await cli(['remember', 'Version: Node 22', '--cwd', root, '--json']);
    expect(newer.exitCode).toBe(0);
    const olderId: string = jsonOf(older).memory_id;
    const newerId: string = jsonOf(newer).memory_id;
    expect(olderId).not.toBe(newerId);

    // The local preset has no embedding provider: the vector-dependent passes degrade with an
    // explicit warning; contradiction resolution and decay still run (zero network, zero models).
    const consolidated = await cli(['consolidate', '--cwd', root, '--json']);
    expect(consolidated.exitCode).toBe(0);
    const report = jsonOf(consolidated);
    expect(report.scope.project_id).toMatch(/^[0-9a-f]{8}-/); // the registered project's pass
    expect(report.contradictions.resolved).toBe(1);
    expect(report.contradictions.disputed_pairs).toBe(0);
    expect(report.contradictions.records[0].outcome).toBe('superseded');
    expect(report.contradictions.records[0].rule).toBe('newer');
    expect(report.merge.clusters).toBe(0);
    expect(report.derivations.derived).toBe(0);
    expect(report.decay.archived).toBe(0);
    expect(report.warnings.some((warning: string) => warning.includes('no embedding provider'))).toBeTrue();
    expect(report.pool.active).toBe(2);

    // The newer fact won: the older row is superseded, pointing at the winner, audited.
    const inspected = await cli(['inspect', olderId, '--cwd', root, '--json']);
    expect(inspected.exitCode).toBe(0);
    const memory = jsonOf(inspected).memory;
    expect(memory.status).toBe('superseded');
    expect(memory.superseded_by).toBe(newerId);
    const audit = jsonOf(inspected).audit as Array<{ action: string; to_status?: string; details: Record<string, unknown> }>;
    const transition = audit.find((event) => event.action === 'status_changed');
    expect(transition?.to_status).toBe('superseded');
    expect(transition?.details['rule']).toBe('newer');

    // Current answers see the winner only; the loser stays in history.
    const winner = await cli(['inspect', newerId, '--cwd', root, '--json']);
    expect(jsonOf(winner).memory.status).toBe('active');
  });

  test('human mode prints the pass summary and the same warnings on stderr', async () => {
    const result = await cli(['consolidate', '--cwd', root]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain('consolidated project');
    expect(result.out).toContain('conflicts:  0 resolved by authority');
    expect(result.out).toContain('decay:      0 archived');
    expect(result.err).toContain('warning:');
    expect(result.err).toContain('no embedding provider');
  });

  test('refuses cleanly without an initialized project', async () => {
    // A directory OUTSIDE the initialized root — config discovery walks up the tree and would
    // find the root's config from any nested path.
    const empty = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-consolidate-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      const result = await cli(['consolidate', '--cwd', empty, '--json']);
      expect(result.exitCode).toBe(1);
      const document = jsonOf(result);
      expect(document.error.code).toBe('invalid_request');
      expect(document.error.message).toContain('init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
