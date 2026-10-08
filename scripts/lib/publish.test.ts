/**
 * Unit tests for the staged publish manifest + publish order (M16, ADR-0014). These rules decide
 * what npm receives, so they are pinned against the real workspace manifests as well as synthetic
 * edge cases.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { publishableDirs, readManifest } from './manifest';
import { publishOrder, publishableDependencySpec, stagedManifest, extraPublishedFiles, selectPlanned, resumeFrom, githubRepoOf, repoMetadataOf, type PlannedPackage, type RepoMetadata } from './publish';

const repoRoot = join(import.meta.dir, '..', '..');

describe('dependency spec rewriting', () => {
  test('workspace protocol becomes a caret range on the published version', () => {
    expect(publishableDependencySpec('workspace:*', '0.1.0')).toBe('^0.1.0');
    expect(publishableDependencySpec('workspace:^', '0.1.0')).toBe('^0.1.0');
    expect(publishableDependencySpec('workspace:^1.2.3', '0.1.0')).toBe('^1.2.3');
  });

  test('ordinary specs pass through untouched', () => {
    expect(publishableDependencySpec('^4.6.5', '0.1.0')).toBe('^4.6.5');
    expect(publishableDependencySpec('2.3.0', '0.1.0')).toBe('2.3.0');
  });
});

describe('staged manifest', () => {
  test('paths, bins and dev-only fields are rewritten for a package with a bin', () => {
    const staged = stagedManifest({
      name: 'onememory',
      version: '0.1.0',
      description: 'cli',
      license: 'Apache-2.0',
      type: 'module',
      private: true,
      exports: { '.': './src/index.ts', './testing': './src/testing.ts' },
      bin: { onemem: './src/bin.ts' },
      main: './src/index.ts',
      types: './src/index.ts',
      scripts: { test: 'bun test' },
      dependencies: { commander: '^15.0.0', '@onememory-ai/core': 'workspace:*' },
      devDependencies: { '@types/bun': '^1.4.2' },
    });

    expect(staged).toEqual({
      name: 'onememory',
      version: '0.1.0',
      description: 'cli',
      license: 'Apache-2.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      bin: { onemem: './dist/bin.js' },
      files: ['dist'],
      engines: { node: '>=22' },
      dependencies: { '@onememory-ai/core': '^0.1.0', commander: '^15.0.0' },
    });
    // No dev-only field survives.
    expect(staged.private).toBeUndefined();
    expect(staged.scripts).toBeUndefined();
    expect(staged.devDependencies).toBeUndefined();
  });

  test('subpath exports are kept and scoped names get public access', () => {
    const staged = stagedManifest({
      name: '@onememory-ai/api',
      version: '0.1.0',
      exports: { '.': './src/index.ts', './runtime': './src/runtime/index.ts', './testing': './src/testing.ts' },
    });
    expect(staged.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './runtime': { types: './dist/runtime/index.d.ts', import: './dist/runtime/index.js' },
    });
    expect(staged.publishConfig).toEqual({ access: 'public' });
    expect(staged.bin).toBeUndefined();
  });

  test('a condition-object export target fails loudly instead of publishing something wrong', () => {
    expect(() =>
      stagedManifest({
        name: '@onememory-ai/x',
        version: '0.1.0',
        exports: { '.': { import: './src/index.ts' } },
      }),
    ).toThrow(/must be a string target/);
  });

  test('the version can be overridden at stage time (single-version workspace)', () => {
    const staged = stagedManifest({ name: '@onememory-ai/core', version: '0.1.0', exports: { '.': './src/index.ts' } }, '0.2.0');
    expect(staged.version).toBe('0.2.0');
  });

  test('a manifest can publish runtime assets beyond dist/ (storage ships its migrations)', () => {
    const staged = stagedManifest({
      name: '@onememory-ai/storage',
      version: '0.1.0',
      exports: { '.': './src/index.ts' },
      files: ['dist', 'migrations'],
    });
    expect(staged.files).toEqual(['dist', 'migrations']);
    expect(extraPublishedFiles({ name: '@onememory-ai/storage', version: '0.1.0', files: ['dist', 'migrations'] })).toEqual([
      'migrations',
    ]);
    expect(extraPublishedFiles({ name: '@onememory-ai/core', version: '0.1.0' })).toEqual([]);
  });

  test('a files list without dist/ is refused', () => {
    expect(() =>
      stagedManifest({ name: '@onememory-ai/x', version: '0.1.0', exports: { '.': './src/index.ts' }, files: ['migrations'] }),
    ).toThrow(/must include 'dist'/);
  });
});

describe('repository metadata (trusted publishing + the npm page)', () => {
  test('a GitHub remote in any usual form normalizes to the canonical https URL', () => {
    expect(githubRepoOf('git+https://github.com/vramasamye/tinymem.git')).toBe('https://github.com/vramasamye/tinymem');
    expect(githubRepoOf('https://github.com/vramasamye/tinymem')).toBe('https://github.com/vramasamye/tinymem');
    expect(githubRepoOf('git+ssh://git@github.com/vramasamye/tinymem.git')).toBe('https://github.com/vramasamye/tinymem');
    expect(githubRepoOf('git@github.com:vramasamye/tinymem.git')).toBe('https://github.com/vramasamye/tinymem');
    // Trailing path/query decoration on a browser URL still resolves to the repo.
    expect(githubRepoOf('https://github.com/vramasamye/tinymem/tree/main')).toBe('https://github.com/vramasamye/tinymem');
  });

  test('a non-GitHub or unresolvable remote fails loudly — trusted publishing is GitHub-only', () => {
    expect(() => githubRepoOf('git@gitlab.com:vramasamye/tinymem.git')).toThrow(/github\.com/);
    // The `github.com-personal` SSH alias cannot be resolved to a URL; it must be refused,
    // not silently published as some other repository.
    expect(() => githubRepoOf('git@github.com-personal:vramasamye/tinymem.git')).toThrow(/github\.com/);
    expect(() => githubRepoOf('')).toThrow(/github\.com/);
  });

  test('repoMetadataOf derives the per-package repository, homepage and bugs from the root manifest', () => {
    const root = { name: 'onememory', version: '0.0.0', repository: { type: 'git', url: 'git+https://github.com/vramasamye/tinymem.git' } };
    expect(repoMetadataOf(root, 'packages/core')).toEqual({
      repository: { type: 'git', url: 'git+https://github.com/vramasamye/tinymem.git', directory: 'packages/core' },
      homepage: 'https://github.com/vramasamye/tinymem#readme',
      bugs: { url: 'https://github.com/vramasamye/tinymem/issues' },
    } satisfies RepoMetadata);
    // A plain-string repository (npm shorthand form) is accepted too.
    expect(repoMetadataOf({ name: 'onememory', version: '0.0.0', repository: 'https://github.com/vramasamye/tinymem' }, 'apps/cli').repository.directory).toBe('apps/cli');
  });

  test('a root manifest without a repository is refused — staged manifests must not ship bare', () => {
    expect(() => repoMetadataOf({ name: 'onememory', version: '0.0.0' }, 'packages/core')).toThrow(/repository/);
  });

  test('staged manifests carry the repository metadata, and omit it only when no context is given', () => {
    const meta = repoMetadataOf(
      { name: 'onememory', version: '0.0.0', repository: { type: 'git', url: 'git+https://github.com/vramasamye/tinymem.git' } },
      'packages/core',
    );
    const staged = stagedManifest({ name: '@onememory-ai/core', version: '0.1.0', exports: { '.': './src/index.ts' } }, '0.1.0', meta);
    expect(staged.repository).toEqual(meta.repository);
    expect(staged.homepage).toBe('https://github.com/vramasamye/tinymem#readme');
    expect(staged.bugs).toEqual({ url: 'https://github.com/vramasamye/tinymem/issues' });
    // Without context (unit calls) no repository fields are invented.
    expect(stagedManifest({ name: '@onememory-ai/core', version: '0.1.0', exports: { '.': './src/index.ts' } }).repository).toBeUndefined();
  });
});

describe('resumable publish selection', () => {
  const plan: PlannedPackage[] = ['@onememory-ai/core', '@onememory-ai/storage', 'onememory'].map((name) => ({
    name,
    dir: name,
    tarball: `${name}.tgz`,
  }));

  test('no flags publishes the whole plan in order', () => {
    expect(selectPlanned(plan).map((pkg) => pkg.name)).toEqual(plan.map((pkg) => pkg.name));
  });

  test('--from resumes at a package and keeps the order', () => {
    expect(selectPlanned(plan, { from: '@onememory-ai/storage' }).map((pkg) => pkg.name)).toEqual([
      '@onememory-ai/storage',
      'onememory',
    ]);
    expect(selectPlanned(plan, { from: '@onememory-ai/core' })).toHaveLength(3);
  });

  test('--only re-runs a single package', () => {
    expect(selectPlanned(plan, { only: '@onememory-ai/storage' }).map((pkg) => pkg.name)).toEqual(['@onememory-ai/storage']);
  });

  test('an unknown name or a contradictory flag pair is an error, never a silent no-op', () => {
    expect(() => selectPlanned(plan, { from: 'nope' })).toThrow(/not in the plan/);
    expect(() => selectPlanned(plan, { only: 'nope' })).toThrow(/not in the plan/);
    expect(() => selectPlanned(plan, { from: '@onememory-ai/core', only: 'onememory' })).toThrow(/mutually exclusive/);
  });

  test('resumeFrom names the package after the last success, and null once complete', () => {
    expect(resumeFrom(plan, 0)?.name).toBe('@onememory-ai/core');
    expect(resumeFrom(plan, 1)?.name).toBe('@onememory-ai/storage');
    expect(resumeFrom(plan, 2)?.name).toBe('onememory');
    expect(resumeFrom(plan, 3)).toBeNull();
  });
});

describe('publish order', () => {
  const pkg = (name: string, deps: string[] = []) => ({
    dir: name,
    manifest: { name, version: '0.1.0', dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])) },
  });

  test('dependencies come before dependents, deterministically', () => {
    const order = publishOrder([pkg('onememory', ['@onememory-ai/api', '@onememory-ai/core']), pkg('@onememory-ai/api', ['@onememory-ai/core']), pkg('@onememory-ai/core')]);
    expect(order).toEqual(['@onememory-ai/core', '@onememory-ai/api', 'onememory']);
  });

  test('external dependencies are ignored; independent packages sort alphabetically', () => {
    expect(publishOrder([pkg('@onememory-ai/security', ['zod']), pkg('@onememory-ai/core', ['zod'])])).toEqual([
      '@onememory-ai/core',
      '@onememory-ai/security',
    ]);
  });

  test('a cycle is an error, not an arbitrary order', () => {
    expect(() => publishOrder([pkg('a', ['b']), pkg('b', ['a'])])).toThrow(/cycle/);
  });
});

describe('the real workspace', () => {
  test('every publishable manifest stages cleanly and the order covers them all', () => {
    const packages = publishableDirs(repoRoot).map((dir) => ({ dir, manifest: readManifest(repoRoot, dir) }));
    for (const pkg of packages) {
      const staged = stagedManifest(pkg.manifest);
      expect(staged.name).toBe(pkg.manifest.name);
      for (const spec of Object.values(staged.dependencies ?? {})) {
        expect(String(spec)).not.toContain('workspace:');
      }
    }
    const order = publishOrder(packages);
    expect(order.length).toBe(packages.length);
    // The CLI is the entry point: it must come after everything it depends on.
    expect(order.indexOf('onememory')).toBeGreaterThan(order.indexOf('@onememory-ai/api'));
    expect(order.indexOf('@onememory-ai/api')).toBeGreaterThan(order.indexOf('@onememory-ai/core'));
  });
});
