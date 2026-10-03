/**
 * CLI integration tests: the real `main()` argument dispatch over a real project directory.
 *
 * Every run goes through Commander parsing, backend resolution (no daemon → direct composition
 * root), the real PGlite pipeline, and the Io seam (human text by default, one JSON document with
 * `--json`). This is the Phase-1 story end to end: init → remember → search → forget → restore →
 * stats/doctor, plus the failure paths a user actually hits.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { main } from './bin';
import type { RememberOutcome } from '@onememory/api/runtime';

/** Captured process seam: everything `main()` prints, split by stream. */
interface Captured {
  out: string;
  err: string;
  exitCode: number;
}

const DEPS = { interactive: false, env: {} } as const;

async function cli(argv: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  const exitCode = await main(argv, {
    ...DEPS,
    write: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err, exitCode };
}

function jsonOf(captured: Captured): any {
  return JSON.parse(captured.out);
}

let root: string;

beforeAll(() => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('onemem init', () => {
  test('writes the config, registers the project, and emits one JSON document', async () => {
    const result = await cli([
      'init',
      '--preset',
      'local',
      '--name',
      'demo',
      '--cwd',
      root,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.err).toContain('wrote');

    const document = jsonOf(result);
    expect(document.preset).toBe('local');
    expect(document.project.name).toBe('demo');
    expect(document.project.id).toMatch(/^[0-9a-f]{8}-/);

    expect(existsSync(join(root, '.onememory', 'onememory.yaml'))).toBeTrue();
    const state = JSON.parse(readFileSync(join(root, '.onememory', 'project.json'), 'utf8'));
    expect(state.project_id).toBe(document.project.id);
    expect(state.root_path).toBe(root);
  });

  test('non-interactive without --name names the project after the directory', async () => {
    const dir = join(root, 'solo');
    mkdirSync(dir, { recursive: true });
    const result = await cli(['init', '--preset', 'local', '--cwd', dir]);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("initialized project 'solo'");
  });

  test('a second init is a no-op that points at doctor', async () => {
    const human = await cli(['init', '--cwd', root]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('already initialized');
    expect(human.out).toContain('onemem doctor');

    const machine = await cli(['init', '--cwd', root, '--json']);
    expect(machine.exitCode).toBe(0);
    expect(jsonOf(machine).status).toBe('already-initialized');
  });

  test('the server preset fails closed when the URL environment variable is missing', async () => {
    const result = await cli([
      'init',
      '--preset',
      'server',
      '--pg-url-env',
      'ONEMEMORY_PG_URL',
      '--cwd',
      join(root, 'empty-a'),
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(jsonOf(result).error.code).toBe('invalid_request');
    expect(result.err).toContain('ONEMEMORY_PG_URL');
  });
});

describe('onemem remember / search / forget / restore / inspect / stats', () => {
  const secret = 'sk-ant-api03-' + 'B'.repeat(40);
  let memoryId: string;

  test('remember redacts the key and prints where to inspect it', async () => {
    const result = await cli([
      'remember',
      `Use Bun for tests. The key was ${secret}.`,
      '--type',
      'decision',
      '--cwd',
      root,
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const outcome: RememberOutcome = jsonOf(result);
    expect(outcome.outcome).toBe('inserted');
    expect(outcome.redactions.length).toBeGreaterThan(0);
    expect(result.out).not.toContain(secret);
    memoryId = outcome.memory_id;
  });

  test('the same statement twice reports a duplicate', async () => {
    const result = await cli([
      'remember',
      'Duplicate detection is content-hash based.',
      '--cwd',
      root,
      '--json',
    ]);
    expect(jsonOf(result).outcome).toBe('inserted');
    const again = await cli([
      'remember',
      'Duplicate detection is content-hash based.',
      '--cwd',
      root,
      '--json',
    ]);
    expect(jsonOf(again).outcome).toBe('duplicate');
  });

  test('search finds the decision inside the token budget', async () => {
    const result = await cli(['search', 'Bun for tests', '--cwd', root, '--json']);
    expect(result.exitCode).toBe(0);
    const response = jsonOf(result).response;
    expect(response.memories.length).toBeGreaterThan(0);
    expect(response.memories[0].id).toBe(memoryId);
    expect(response.tokens.used).toBeLessThanOrEqual(response.tokens.budget);
    expect(response.warnings.join(' ')).toContain('no embedding provider');
  });

  test('forget is audited, prints the undo path, and restore undoes it', async () => {
    const forgot = await cli(['forget', memoryId, '--reason', 'stale', '--cwd', root, '--json']);
    expect(forgot.exitCode).toBe(0);
    expect(jsonOf(forgot).to_status).toBe('archived');
    expect(jsonOf(forgot).restore_hint).toContain('onemem restore');

    const inspected = await cli(['inspect', memoryId, '--cwd', root]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.out).toContain('archived');
    expect(inspected.out).toContain('audit');

    const restored = await cli(['restore', memoryId, '--cwd', root, '--json']);
    expect(jsonOf(restored).to_status).toBe('active');
    expect((await cli(['inspect', memoryId, '--cwd', root])).out).toContain('active');
  });

  test('stats describes the project and doctor exits 0 while degraded', async () => {
    const stats = await cli(['stats', '--cwd', root, '--json']);
    expect(stats.exitCode).toBe(0);
    expect(jsonOf(stats).project_id).toBeDefined();
    expect(jsonOf(stats).memories.total).toBeGreaterThan(0);

    const doctor = await cli(['doctor', '--cwd', root]);
    expect(doctor.exitCode).toBe(0);
    expect(doctor.out).toContain('degraded');
    expect(doctor.out).toContain('worker: not running');
  });
});

describe('failure paths', () => {
  test('commands outside a project say what to run, as one JSON error document', async () => {
    // Outside `root` entirely: config discovery walks up the tree, so an empty directory under an
    // initialized project still resolves that project's config.
    const empty = join(process.env.TMPDIR ?? '/tmp', `onemem-cli-noconfig-${Date.now()}`);
    mkdirSync(empty, { recursive: true });
    try {
      const result = await cli(['search', 'anything', '--cwd', empty, '--json']);
      expect(result.exitCode).toBe(1);
      const document = jsonOf(result);
      expect(document.error.code).toBe('invalid_request');
      expect(document.error.message).toContain('onemem init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('an unknown memory type is rejected before anything is opened', async () => {
    const result = await cli(['remember', 'x', '--type', 'vibe', '--cwd', root, '--json']);
    expect(result.exitCode).toBe(1);
    expect(jsonOf(result).error.message).toContain("unknown memory type 'vibe'");
  });

  test('forget of an unknown id is a not-found error, not a crash', async () => {
    const result = await cli([
      'forget',
      '0195a7f0-9f5e-7a1d-bc2d-0000000000aa',
      '--cwd',
      root,
      '--json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(jsonOf(result).error.code).toBe('not_found');
  });

  test('forget --purge without --revision fails closed; with the right revision the row is deleted for real', async () => {
    const purgeable = await cli([
      'remember',
      'A statement destined for a hard purge.',
      '--type',
      'decision',
      '--cwd',
      root,
      '--json',
    ]);
    expect(purgeable.exitCode).toBe(0);
    const id = jsonOf(purgeable).memory_id;

    // A purge can never be accidental: no revision token, no purge.
    const noRevision = await cli(['forget', id, '--purge', '--cwd', root, '--json']);
    expect(noRevision.exitCode).toBe(1);
    expect(jsonOf(noRevision).error.code).toBe('invalid_request');

    const inspected = await cli(['inspect', id, '--cwd', root, '--json']);
    expect(inspected.exitCode).toBe(0);
    const revision = jsonOf(inspected).memory.updated_at;

    const purged = await cli([
      'forget',
      id,
      '--purge',
      '--revision',
      revision,
      '--reason',
      'test',
      '--cwd',
      root,
      '--json',
    ]);
    expect(purged.exitCode).toBe(0);
    expect(jsonOf(purged).purged).toBe(true);

    const gone = await cli(['inspect', id, '--cwd', root, '--json']);
    expect(gone.exitCode).toBe(1);
    expect(jsonOf(gone).error.code).toBe('not_found');
  });
});
