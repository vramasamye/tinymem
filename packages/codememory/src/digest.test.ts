/**
 * The architecture digest (M4.6): modules → responsibilities → entry points under a token budget,
 * assembled purely from persisted symbol/fingerprint data. These tests pin determinism, the
 * budget behavior (whole module lines dropped, never a mid-line cut), and the honesty flag.
 */

import { describe, expect, test } from 'bun:test';

import type { StoredSymbol } from '@onememory/core';

import { buildArchitectureDigest, estimateDigestTokens, moduleOfPath } from './index';
import type { DigestRepositoryInput } from './index';

function symbol(path: string, name: string, kind: string, line = 1): StoredSymbol {
  return {
    repository_id: '0195a7f0-9f5e-7a1d-bc2d-000000000000',
    path,
    name,
    kind,
    signature: `${name}()`,
    line_start: line,
    line_end: line,
    span_hash: 'a'.repeat(64),
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const repository: DigestRepositoryInput = {
  repository_id: '0195a7f0-9f5e-7a1d-bc2d-000000000001',
  root_path: '/tmp/project',
  head_commit: 'b'.repeat(40),
  paths: [
    'src/engine.ts',
    'src/retrieval.ts',
    'src/server/index.ts',
    'README.md',
  ],
  symbols: [
    symbol('src/engine.ts', 'createEngine', 'function'),
    symbol('src/engine.ts', 'EngineOptions', 'interface'),
    symbol('src/engine.ts', 'Engine', 'class', 20),
    symbol('src/retrieval.ts', 'search', 'function'),
    symbol('src/server/index.ts', 'startServer', 'function'),
  ],
};

describe('buildArchitectureDigest', () => {
  test('renders modules with responsibilities and entry points, deterministically', () => {
    const first = buildArchitectureDigest({ repositories: [repository], projectName: 'acme' });
    const second = buildArchitectureDigest({ repositories: [repository], projectName: 'acme' });

    expect(first.text).toBe(second.text);
    expect(first.text).toContain('project: acme');
    expect(first.text).toContain('3 module(s)');
    expect(first.text).toContain('4 file(s)');
    expect(first.text).toContain('5 symbol(s)');
    // The most substantial module (3 symbols) leads; entry points name declarations, not methods.
    expect(first.text).toContain('- src: 2 file(s), 2 function, 1 class, 1 interface; entry: createEngine, search, Engine');
    expect(first.text).toContain('- src/server: 1 file(s), 1 function; entry: startServer');
    expect(first.file_count).toBe(4);
    expect(first.symbol_count).toBe(5);
    expect(first.truncated).toBe(false);
    expect(first.tokens).toBeLessThanOrEqual(first.budget);
  });

  test('answers "what is this project" inside the default 300-token budget', () => {
    const digest = buildArchitectureDigest({ repositories: [repository], projectName: 'acme' });
    expect(digest.budget).toBe(300);
    expect(digest.tokens).toBeLessThan(300);
  });

  test('drops whole module lines when the budget is tight and reports truncation', () => {
    const digest = buildArchitectureDigest({
      repositories: [repository],
      projectName: 'acme',
      budgetTokens: 40,
    });

    expect(digest.truncated).toBe(true);
    expect(digest.tokens).toBeLessThanOrEqual(40);
    // Header identity survives; module lines are dropped whole, never cut mid-line.
    expect(digest.text).toContain('project: acme');
    for (const line of digest.text.split('\n')) {
      if (line.startsWith('- ')) expect(digest.modules.some((module) => line.includes(module.module))).toBe(true);
    }
    expect(digest.modules.length).toBeGreaterThan(0);
  });

  test('a repository with no symbols still renders its files and language mix', () => {
    const digest = buildArchitectureDigest({
      repositories: [{ ...repository, symbols: [] }],
    });
    expect(digest.text).toContain('languages:');
    expect(digest.text).toContain('(root): 1 file(s), no symbols');
    expect(digest.symbol_count).toBe(0);
  });

  test('moduleOfPath groups by containing directory, root files under (root)', () => {
    expect(moduleOfPath('src/engine.ts')).toBe('src');
    expect(moduleOfPath('packages/codememory/src/index.ts')).toBe('packages/codememory/src');
    expect(moduleOfPath('README.md')).toBe('(root)');
  });

  test('estimateDigestTokens is the repo quarter-of-characters heuristic', () => {
    expect(estimateDigestTokens('abcd')).toBe(1);
    expect(estimateDigestTokens('abcde')).toBe(2);
  });
});
