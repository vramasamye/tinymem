/**
 * Unit tests for the phantom-dependency check (M16, ADR-0014). The false-positive cases matter as
 * much as the true ones: the first ad-hoc scan flagged `fs` and `onemem inspect <id>` because they
 * appear inside strings, and a check that cries wolf gets ignored.
 */

import { describe, expect, test } from 'bun:test';
import { bareSpecifiers, packageNameOf, undeclaredDependencies } from './deps';

describe('bareSpecifiers', () => {
  test('finds imports, re-exports, side-effect imports and column-0 dynamic imports', () => {
    const bundle = [
      'import { z } from "zod";',
      'import { a as a2, b } from "@onememory/core";',
      'import "node:crypto";',
      'export { x } from "@onememory/config";',
      'import("@modelcontextprotocol/client");',
      'import("hono");',
      'import("smol-toml");',
    ].join('\n');
    expect(bareSpecifiers(bundle)).toEqual([
      '@modelcontextprotocol/client',
      '@onememory/config',
      '@onememory/core',
      'hono',
      'smol-toml',
      'zod',
    ]);
  });

  test('ignores relative paths, node builtins and bun builtins', () => {
    expect(bareSpecifiers('import { x } from "./sibling.js";\nimport "node:fs";\nimport "bun:test";\nimport "fs";')).toEqual(
      [],
    );
  });

  test('never mistakes strings, help text or template placeholders for imports', () => {
    const bundle = [
      'const help = "onemem inspect <id>";',
      'const text = `Run ${OPENCODE_ADAPTER_PACKAGE} now`;',
      'console.log("fs");',
      'const doc = "import { x } from \'fake-package\'";',
      // Embedded scaffold code is indented inside its template literal, so column-0 anchoring skips it.
      'const scaffold = `',
      '  import { readFileSync } from "fs";',
      '  const plugin = await import("@opencode-ai/plugin");',
      '`;',
    ].join('\n');
    expect(bareSpecifiers(bundle)).toEqual([]);
  });

  test('handles an import statement wrapped across lines', () => {
    expect(bareSpecifiers('import {\n  a,\n  b,\n} from "zod";')).toEqual(['zod']);
  });
});

describe('undeclaredDependencies', () => {
  test('reports only what the manifest does not declare', () => {
    const bundle = 'import { z } from "zod";\nimport { client } from "@modelcontextprotocol/client";';
    expect(undeclaredDependencies([bundle], ['zod'])).toEqual(['@modelcontextprotocol/client']);
    expect(undeclaredDependencies([bundle], ['zod', '@modelcontextprotocol/client'])).toEqual([]);
  });

  test('scoped subpath imports resolve to the package name', () => {
    expect(packageNameOf('@scope/pkg/sub/path')).toBe('@scope/pkg');
    expect(packageNameOf('pkg/sub')).toBe('pkg');
    expect(undeclaredDependencies(['import { x } from "@scope/pkg/sub";'], ['@scope/pkg'])).toEqual([]);
  });
});
