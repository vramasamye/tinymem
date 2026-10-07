/**
 * `onemem export` end to end through the real CLI (the local preset — no embedder, no model,
 * no network — is the honest default install, and the export needs none of them): remember
 * facts → build the digest (the MEMORY.md header) → export → inspect the tree → re-run
 * (idempotent) → prune a stale owned file without touching the operator's → override the root
 * with --dir → refuse cleanly without an initialized project.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { jsonOf, runMain, type Captured } from './test-support';

async function cli(argv: string[]): Promise<Captured> {
  return runMain(argv);
}

let root: string;

beforeAll(() => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-export-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

describe('onemem export', () => {
  test('writes the deterministic tree at the project root default, idempotently, pruning only owned files', async () => {
    expect((await cli(['init', '--preset', 'local', '--name', 'export-demo', '--cwd', root, '--json'])).exitCode).toBe(0);

    // Three procedural facts — plain durable rows the CLI can remember without payload rows.
    for (const [content, title] of [
      ['Run migrations before the service starts, every deploy.', 'Run migrations before serve'],
      ['Ship new endpoints behind the API gateway with an allow-list.', 'Ship behind the gateway'],
      ['Run the full test suite before tagging a release.', 'Test before release tags'],
    ] as const) {
      const remembered = await cli(['remember', content, '--type', 'procedural', '--title', title, '--cwd', root, '--json']);
      expect(remembered.exitCode).toBe(0);
    }

    // The digest feeds the MEMORY.md header (the 'Procedures' section reads projects.digest).
    expect((await cli(['digest', '--cwd', root, '--json'])).exitCode).toBe(0);

    const exported = await cli(['export', '--cwd', root, '--json']);
    expect(exported.exitCode).toBe(0);
    const report = jsonOf(exported);
    expect(report.root).toBe(join(root, 'memory'));
    expect(report.root_source).toBe('project');
    // 3 procedural + the digest pass's own project_context semantic row — every durable memory.
    expect(report.memories).toBe(4);
    expect(report.by_type).toEqual({ procedural: 3, semantic: 1 });
    expect(report.files_written).toBe(7);
    expect(report.files_pruned).toBe(0);

    const index = readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8');
    expect(index).toContain('# export-demo memory');
    expect(index).toContain('## Procedures');
    expect(index).toContain('- Run migrations before serve');
    expect(index).toContain('- [procedural (3)](procedural.md)');
    expect(index).toContain('- [semantic (1)](semantic.md)');
    expect(existsSync(join(root, 'memory', 'procedural.md'))).toBeTrue();
    expect(existsSync(join(root, 'memory', 'semantic.md'))).toBeTrue();
    expect(walkFiles(join(root, 'memory', 'memories', 'procedural'))).toHaveLength(3);

    // A stale owned file and an operator file: only the owned one is ever pruned; everything
    // else must come back byte-identical (idempotence — stable sort, no wall clock).
    const memoryRoot = join(root, 'memory');
    writeFileSync(join(memoryRoot, 'NOTES.md'), 'operator notes — never touched by the export', 'utf8');
    writeFileSync(
      join(memoryRoot, 'memories', 'procedural', '0eadbeef-0ead-4ead-8ead-0eadbeef0ead.md'),
      '---\nonememory-export: true\n---\nstale owned file',
      'utf8',
    );
    const stable = new Map<string, string>();
    for (const abs of walkFiles(memoryRoot)) {
      if (abs.endsWith('NOTES.md') || abs.endsWith('0eadbeef-0ead-4ead-8ead-0eadbeef0ead.md')) continue;
      stable.set(abs.slice(memoryRoot.length + 1), readFileSync(abs, 'utf8'));
    }

    const rerun = await cli(['export', '--cwd', root, '--json']);
    expect(rerun.exitCode).toBe(0);
    const second = jsonOf(rerun);
    expect(second.files_written).toBe(7);
    expect(second.files_pruned).toBe(1);
    expect(existsSync(join(memoryRoot, 'memories', 'procedural', '0eadbeef-0ead-4ead-8ead-0eadbeef0ead.md'))).toBeFalse();
    expect(readFileSync(join(memoryRoot, 'NOTES.md'), 'utf8')).toBe('operator notes — never touched by the export');
    for (const [relative, content] of stable) {
      expect(readFileSync(join(memoryRoot, relative), 'utf8')).toBe(content);
    }
  });

  test('--dir overrides the root (flag wins) and human mode prints the summary', async () => {
    const flagged = await cli(['export', '--dir', 'custom-out', '--cwd', root, '--json']);
    expect(flagged.exitCode).toBe(0);
    const report = jsonOf(flagged);
    expect(report.root).toBe(join(root, 'custom-out'));
    expect(report.root_source).toBe('flag');
    expect(existsSync(join(root, 'custom-out', 'MEMORY.md'))).toBeTrue();

    const human = await cli(['export', '--cwd', root]);
    expect(human.exitCode).toBe(0);
    expect(human.out).toContain('exported project');
    expect(human.out).toContain('files:       7 written, 0 pruned');
    expect(human.out).toContain(join(root, 'memory', 'MEMORY.md'));
    expect(human.out).toContain('one-way projection');
  });

  test('refuses cleanly without an initialized project', async () => {
    // A directory OUTSIDE the initialized root — config discovery walks up the tree and would
    // find the root's config from any nested path.
    const empty = join(
      process.env.TMPDIR ?? '/tmp',
      `onemem-export-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(empty, { recursive: true });
    try {
      const result = await cli(['export', '--cwd', empty, '--json']);
      expect(result.exitCode).toBe(1);
      const document = jsonOf(result);
      expect(document.error.code).toBe('invalid_request');
      expect(document.error.message).toContain('init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
