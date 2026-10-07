/**
 * Unit tests for the staged publish manifest + publish order (M16, ADR-0014). These rules decide
 * what npm receives, so they are pinned against the real workspace manifests as well as synthetic
 * edge cases.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { publishableDirs, readManifest } from './manifest';
import { publishOrder, publishableDependencySpec, stagedManifest, extraPublishedFiles } from './publish';

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
