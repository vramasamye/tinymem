/**
 * `isMainModule` (M16) — the portable replacement for Bun's `import.meta.main`.
 *
 * Published bins must run under Node LTS (ADR-0001, ADR-0014): Node leaves `import.meta.main`
 * `undefined`, so a bin guarded by it exits silently instead of doing its job. The check compares
 * the module's own real path with `process.argv[1]` (real paths, so an npm bin symlink in
 * `node_modules/.bin` still matches).
 */

import { describe, expect, test } from 'bun:test';
import { isMainModule, isMainModulePath } from './is-main-module';

const identity = (path: string): string => path;

describe('isMainModulePath', () => {
  test('the module and the argv entry are the same file', () => {
    expect(isMainModulePath('file:///app/dist/bin.js', '/app/dist/bin.js', identity)).toBe(true);
  });

  test('an npm bin symlink resolves to the same file', () => {
    const links: Record<string, string> = {
      '/app/node_modules/.bin/onemem': '/app/node_modules/onememory/dist/bin.js',
      '/app/node_modules/onememory/dist/bin.js': '/app/node_modules/onememory/dist/bin.js',
    };
    expect(
      isMainModulePath('file:///app/node_modules/onememory/dist/bin.js', '/app/node_modules/.bin/onemem', (p) => {
        const target = links[p];
        if (target === undefined) throw new Error(`ENOENT: ${p}`);
        return target;
      }),
    ).toBe(true);
  });

  test('a different entry point is not the main module', () => {
    expect(isMainModulePath('file:///app/dist/bin.js', '/app/dist/other.js', identity)).toBe(false);
  });

  test('an imported module (no argv entry, or the test runner) is never the main module', () => {
    expect(isMainModulePath('file:///app/dist/bin.js', undefined, identity)).toBe(false);
    expect(isMainModulePath('file:///app/dist/bin.js', '', identity)).toBe(false);
    // `bun test` / `vitest` run with the runner as argv[1] — importing a bin must not run it.
    expect(isMainModulePath('file:///app/src/bin.ts', '/usr/local/bin/bun', identity)).toBe(false);
  });

  test('an unresolvable argv path is false, never a throw', () => {
    expect(
      isMainModulePath('file:///app/dist/bin.js', '/app/gone.js', () => {
        throw new Error('ENOENT');
      }),
    ).toBe(false);
  });

  test('a non-file module URL cannot be the main module', () => {
    expect(isMainModulePath('node:internal/process', '/app/dist/bin.js', identity)).toBe(false);
  });

  test('the default resolver follows the real filesystem', () => {
    // The test file itself is the running module here; argv[1] is the runner.
    expect(isMainModulePath(import.meta.url, import.meta.path)).toBe(true);
  });

  test('isMainModule judges the URL it is GIVEN, never its own module', () => {
    // Regression: `import.meta.url` inside the helper names the helper's file, so a zero-arg
    // wrapper silently reported "not the entry point" for every caller. The URL is a parameter.
    const original = process.argv[1];
    try {
      process.argv[1] = import.meta.path;
      expect(isMainModule(import.meta.url)).toBe(true);
      expect(isMainModule('file:///somewhere/else/bin.js')).toBe(false);
      process.argv[1] = '/definitely/not/this/file.js';
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      if (original === undefined) process.argv.splice(1, 1);
      else process.argv[1] = original;
    }
  });
});
