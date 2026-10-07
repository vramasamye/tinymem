/**
 * Unit tests for the release tooling's manifest rules (M16, ADR-0014). These are the rules that
 * decide what a published tarball contains, so they are pinned against the real manifests in the
 * workspace — a manifest that grows an entry the tooling cannot classify fails here, not at
 * publish time.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  binTargets,
  deriveTargets,
  distEntryOf,
  distTypesOf,
  isTestSupportKey,
  normalizeTarget,
  publishableDirs,
  readManifest,
  workspaceDirs,
  type SourceManifest,
} from './manifest';

const repoRoot = join(import.meta.dir, '..', '..');

function manifestOf(relativeDir: string): SourceManifest {
  return readManifest(repoRoot, relativeDir);
}

describe('manifest target derivation', () => {
  test('a plain package exports src/index.ts only', () => {
    expect(deriveTargets({ name: '@onememory/core', version: '0.1.0', exports: { '.': './src/index.ts' } })).toEqual({
      entries: ['src/index.ts'],
      bins: [],
    });
  });

  test('subpath exports are entries; the ./testing family is not', () => {
    const targets = deriveTargets({
      name: '@onememory/api',
      version: '0.1.0',
      exports: { '.': './src/index.ts', './runtime': './src/runtime/index.ts', './testing': './src/testing.ts' },
    });
    expect(targets.entries).toEqual(['src/index.ts', 'src/runtime/index.ts']);
    expect(isTestSupportKey('./testing')).toBe(true);
    expect(isTestSupportKey('./testing/helpers')).toBe(true);
    expect(isTestSupportKey('./runtime')).toBe(false);
  });

  test('bins are entries, named from the bin map (or the package name for a bare string)', () => {
    expect(
      deriveTargets({
        name: 'onememory',
        version: '0.1.0',
        exports: { '.': './src/index.ts' },
        bin: { onemem: './src/bin.ts' },
      }),
    ).toEqual({ entries: ['src/bin.ts', 'src/index.ts'], bins: [{ name: 'onemem', target: 'src/bin.ts' }] });

    expect(binTargets({ name: 'onememory', version: '0.1.0', bin: './src/bin.ts' })).toEqual([
      { name: 'onememory', target: 'src/bin.ts' },
    ]);
  });

  test('condition objects flatten to every target they name', () => {
    expect(
      deriveTargets({
        name: '@onememory/x',
        version: '0.1.0',
        exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
      }).entries,
    ).toEqual(['src/index.ts']);
  });

  test('dist paths mirror the src layout', () => {
    expect(distEntryOf('src/index.ts')).toBe('dist/index.js');
    expect(distEntryOf('src/runtime/index.ts')).toBe('dist/runtime/index.js');
    expect(distEntryOf('src/bin.ts')).toBe('dist/bin.js');
    expect(distTypesOf('src/runtime/index.ts')).toBe('dist/runtime/index.d.ts');
    expect(normalizeTarget('./src/bin.ts')).toBe('src/bin.ts');
    expect(() => distEntryOf('scripts/build.ts')).toThrow(/outside src\//);
  });
});

describe('the workspace manifests', () => {
  test('membership comes from the workspace globs, not the private guard', () => {
    const members = workspaceDirs(repoRoot);
    expect(members).toContain('packages/core');
    expect(members).toContain('packages/adapters/pi');
    expect(members).toContain('apps/cli');
    expect(members).toContain('apps/web');
    const publishable = publishableDirs(repoRoot);
    expect(publishable).not.toContain('apps/web');
    expect(publishable).not.toContain('benchmarks/eval');
    expect(publishable.length).toBeGreaterThanOrEqual(18);
  });

  test('every publishable package derives at least one entry, all under src/', () => {
    const dirs = publishableDirs(repoRoot);
    for (const dir of dirs) {
      const manifest = manifestOf(dir);
      const { entries, bins } = deriveTargets(manifest);
      expect(entries.length, `${dir} has no publishable entry`).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsWith('src/'), `${dir}: ${entry} is not under src/`).toBe(true);
      }
      // Every declared bin must be a real file (the build bundles it and npm links it).
      for (const bin of bins) {
        expect(() => readFileSync(join(repoRoot, dir, bin.target)), `${dir}: bin ${bin.name} → ${bin.target}`).not.toThrow();
      }
    }
  });

  test('every publishable package carries the private guard (M16 staging rule)', () => {
    for (const dir of publishableDirs(repoRoot)) {
      const manifest = manifestOf(dir);
      expect(manifest.private, `${dir} must set "private": true so only the staged manifest publishes`).toBe(true);
    }
  });
});
