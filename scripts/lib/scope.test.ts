/**
 * Scope guard (M19, ADR-0014 amendment): every internal package lives under ONE scope.
 *
 * The npm org `onememory` was already claimed when the release was prepared, so the workspace
 * scope is `@onememory-ai`. The CLI lives in that scope too (`@onememory-ai/cli`): the registry
 * refused the unscoped name as too similar to an existing package, and names inside our own scope
 * are not subject to that check. A half-done rename — one manifest left behind, one doc still
 * advertising the old name — is exactly the kind of thing that passes a build and breaks an
 * install, so it is asserted here against the real files.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { publishableDirs, readManifest } from './manifest';

const repoRoot = join(import.meta.dir, '..', '..');
export const SCOPE = '@onememory-ai';
export const CLI_PACKAGE = `${SCOPE}/cli`;
export const INSTALL_COMMAND = `npx ${CLI_PACKAGE} init`;
/** The refused unscoped CLI name, fragmented for the same reason as the abandoned scope below. */
const REFUSED_INSTALL_PATTERN = new RegExp(`npx ${'one' + 'memory'}(?![-\\w/])`);

/**
 * The ABANDONED scope, assembled from fragments on purpose: written as one literal it is the old
 * scope token followed by a hyphen, so any future scope sweep (including the one that produced this
 * file) rewrites the guard into searching for the NEW scope — which matches everything and reports
 * the whole tree as stale. Fragments keep the guard immune to its own subject matter, and the
 * literal is kept out of comments for the same reason.
 */
const ABANDONED_SCOPE = '@' + 'onememory';
const ABANDONED_SCOPE_PATTERN = new RegExp(`${ABANDONED_SCOPE}(?![-\\w])`);

/**
 * Directories that are not source (build output, dependencies, VCS, generated data), plus `docs`:
 * the ADRs and mission reports are historical records that must be able to NAME the abandoned
 * scope while documenting the migration, so the stale-reference scan covers code and config only.
 * The root entry docs (`README.md`, `AGENTS.md`) are not under `docs/` and stay covered.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.release',
  'dist',
  'coverage',
  '.pgdata',
  '.onememory',
  'tmp',
  'docs',
]);
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.mdc', '.yaml', '.yml', '.toml'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(path, out);
      continue;
    }
    if (entry.name === 'bun.lock' || TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
  }
  return out;
}

describe('the workspace scope', () => {
  test('every published package name is in the new scope, the CLI included', () => {
    const names = publishableDirs(repoRoot).map((dir) => readManifest(repoRoot, dir).name);
    const outside = names.filter((name) => !name.startsWith(`${SCOPE}/`));
    // Unscoped names go through the registry's similar-name check; scoped ones do not.
    expect(outside, `packages outside ${SCOPE}: ${outside.join(', ')}`).toEqual([]);
    expect(names).toContain(CLI_PACKAGE);
  });

  test('the root entry docs advertise the scoped install command, never the refused name', () => {
    for (const doc of ['README.md', 'AGENTS.md']) {
      const text = readFileSync(join(repoRoot, doc), 'utf8');
      expect(text, `${doc} must not advertise the refused CLI name`).not.toMatch(REFUSED_INSTALL_PATTERN);
      expect(text, `${doc} must show ${INSTALL_COMMAND}`).toContain(INSTALL_COMMAND);
    }
  });

  test('no source file still references the abandoned scope', () => {
    const stale: string[] = [];
    for (const file of sourceFiles(repoRoot)) {
      // Match the abandoned scope as a complete token (the old name not followed by a word
      // character or a hyphen), so the new scope — which CONTAINS the old name — never matches.
      const matches = readFileSync(file, 'utf8').match(ABANDONED_SCOPE_PATTERN);
      if (matches !== null) stale.push(`${relative(repoRoot, file)} (${matches.length})`);
    }
    expect(stale, `files still importing the old scope:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  test('the release tooling and smoke target the new scope path', () => {
    // The smoke's hygiene scan must look under the new scope directory in node_modules.
    const smoke = readFileSync(join(repoRoot, 'scripts', 'smoke-packed.ts'), 'utf8');
    expect(smoke).toContain(`'${SCOPE}'`);
    expect(smoke).not.toMatch(ABANDONED_SCOPE_PATTERN);
    // The smoke must exercise the documented install command, not the refused name.
    expect(smoke).toContain(`'${CLI_PACKAGE}'`);
    expect(smoke).not.toMatch(REFUSED_INSTALL_PATTERN);
    // The scoped-package guard in the manifest tooling keys off the leading '@', not a fixed name.
    expect(existsSync(join(repoRoot, 'scripts', 'lib', 'publish.ts'))).toBe(true);
  });

  test('the CLI manifest carries the scoped name and the onemem bin', () => {
    const cli = readManifest(repoRoot, 'apps/cli');
    expect(cli.name).toBe(CLI_PACKAGE);
    const bin = cli.bin;
    expect(typeof bin === 'object' && bin !== null ? Object.keys(bin) : []).toEqual(['onemem']);
  });

  test('the guard actually scans the tree (a vacuous test would pass on an empty set)', () => {
    const files = sourceFiles(repoRoot);
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => file.endsWith('package.json'))).toBe(true);
    expect(statSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')).isFile()).toBe(true);
  });
});
