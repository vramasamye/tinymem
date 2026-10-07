/**
 * Stage-1 unit tests — intent classification, keyword extraction, time-scope parsing, and the
 * in-memory entity index. Pure; no database.
 */

import { describe, expect, test } from 'bun:test';

import type { EntityRecord } from '@onememory-ai/core';

import { EntityIndex } from './entity-index';
import { classifyIntent, extractKeywords, parseTimeScope, understandQuery } from './understand';

const NOW = new Date('2027-01-15T00:00:00.000Z');

describe('classifyIntent (keyword table)', () => {
  test('how_to', () => {
    expect(classifyIntent('how do we deploy the api')).toBe('how_to');
    expect(classifyIntent('steps to configure redis')).toBe('how_to');
  });

  test('decision', () => {
    expect(classifyIntent('why did we choose postgresql for the database')).toBe('decision');
    expect(classifyIntent('what was the rationale for the adr')).toBe('decision');
  });

  test('failure beats how_to on ties (precedence order)', () => {
    // 'deploy' (how_to) vs 'failed' (failure) — one match each; failure wins the tie-break.
    expect(classifyIntent('the deploy failed')).toBe('failure');
    expect(classifyIntent('error during the gcloud migration')).toBe('failure');
  });

  test('history phrases flip to history', () => {
    expect(classifyIntent('what did we use last year')).toBe('history');
    expect(classifyIntent('node version history')).toBe('history');
  });

  test('preference and context', () => {
    expect(classifyIntent('what formatting convention do we prefer')).toBe('preference');
    expect(classifyIntent('give me an overview of the project')).toBe('context');
  });

  test('default is fact', () => {
    expect(classifyIntent('which node version does the project use')).toBe('fact');
  });
});

describe('extractKeywords (simple-dictionary normalization)', () => {
  test('lowercases, strips stopwords, dedupes', () => {
    expect(extractKeywords('What Node version do we use for the Node build?')).toEqual([
      'node', 'version', 'use', 'build',
    ]);
  });

  test('keeps technical tokens like node.js intact', () => {
    expect(extractKeywords('node.js and postgres')).toEqual(['node.js', 'postgres']);
  });
});

describe('parseTimeScope (deterministic UTC ranges)', () => {
  test('"last year" → previous calendar year', () => {
    expect(parseTimeScope('what did we run last year', NOW)).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      until: '2027-01-01T00:00:00.000Z',
      mode: 'historical',
    });
  });

  test('"last 30 days" → rolling range ending now', () => {
    const scope = parseTimeScope('errors from the last 30 days', NOW);
    expect(scope?.mode).toBe('historical');
    expect(Date.parse(scope?.until ?? '')).toBe(Date.parse('2027-01-15T00:00:00.000Z'));
    expect(Date.parse(scope?.from ?? '')).toBe(Date.parse('2026-12-16T00:00:00.000Z'));
  });

  test('"in 2025" → that calendar year', () => {
    expect(parseTimeScope('what did we use in 2025', NOW)).toEqual({
      from: '2025-01-01T00:00:00.000Z',
      until: '2026-01-01T00:00:00.000Z',
      mode: 'historical',
    });
  });

  test('"before X" / "since X" bounds', () => {
    expect(parseTimeScope('what was true before 2025-06', NOW)).toEqual({
      until: '2025-07-01T00:00:00.000Z',
      mode: 'historical',
    });
    expect(parseTimeScope('everything since 2025-06-01', NOW)).toEqual({
      from: '2025-06-01T00:00:00.000Z',
      mode: 'historical',
    });
  });

  test('"now/current" → current mode, no bounds', () => {
    expect(parseTimeScope('what are we currently using', NOW)).toEqual({ mode: 'current' });
  });

  test('no temporal language → undefined', () => {
    expect(parseTimeScope('deploy the api', NOW)).toBeUndefined();
  });
});

describe('EntityIndex (in-memory registry match)', () => {
  const entities: EntityRecord[] = [
    {
      id: '00000000-0000-0000-0000-0000000000a1',
      project_id: null,
      kind: 'library',
      name: 'PostgreSQL',
      normalized_name: 'postgresql',
      aliases: ['postgres', 'pg'],
      description: null,
      confidence: 0.9,
      merged_into: null,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    },
    {
      id: '00000000-0000-0000-0000-0000000000a2',
      project_id: null,
      kind: 'language',
      name: 'Node.js',
      normalized_name: 'node.js',
      aliases: ['node', 'nodejs'],
      description: null,
      confidence: 0.9,
      merged_into: null,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    },
  ];

  test('matches by canonical name, alias, and multi-word phrase with word boundaries', async () => {
    const index = new EntityIndex(async () => entities);
    const byName = await index.matchText('postgres is the database');
    expect(byName.map((entity) => entity.name)).toEqual(['PostgreSQL']);
    const byAlias = await index.matchText('we use pg and node.js');
    expect(new Set(byAlias.map((entity) => entity.name))).toEqual(new Set(['PostgreSQL', 'Node.js']));
    // No substring false positives: "nodefish" must not match Node.js.
    const none = await index.matchText('nodefish and postgresql');
    expect(none.map((entity) => entity.name)).toEqual(['PostgreSQL']);
  });

  test('longest surface form wins the ordering (specific alias before short one)', async () => {
    const withLongAlias: EntityRecord[] = [
      { ...entities[0]!, aliases: ['postgres', 'postgresql server'] },
      entities[1]!,
    ];
    const index = new EntityIndex(async () => withLongAlias);
    const matches = await index.matchText('the postgresql server and node');
    expect(matches[0]?.name).toBe('PostgreSQL');
  });

  test('resolveNames: exact normalized name or alias; null when unknown', async () => {
    const index = new EntityIndex(async () => entities);
    const resolved = await index.resolveNames(['PostgreSQL', 'node', 'SQLite']);
    expect(resolved.get('PostgreSQL')?.id).toBe('00000000-0000-0000-0000-0000000000a1');
    expect(resolved.get('node')?.id).toBe('00000000-0000-0000-0000-0000000000a2');
    expect(resolved.get('SQLite')).toBeNull();
  });

  test('TTL reload picks up new entities', async () => {
    let version = 0;
    const index = new EntityIndex(async () => (version === 0 ? [] : entities), { ttlMs: 10 });
    expect((await index.matchText('postgres')).length).toBe(0);
    version = 1;
    index.invalidate();
    expect((await index.matchText('postgres')).length).toBe(1);
  });
});

describe('understandQuery (assembles the wire block)', () => {
  test('intent + keywords + entity matches + time scope', () => {
    const understanding = understandQuery('why did we choose postgresql last year', {
      matchedEntities: [{ id: '00000000-0000-0000-0000-0000000000a1', name: 'PostgreSQL' }],
      now: NOW,
    });
    expect(understanding.intent).toBe('decision');
    expect(understanding.entities).toEqual([
      { name: 'PostgreSQL', matched_id: '00000000-0000-0000-0000-0000000000a1' },
    ]);
    expect(understanding.keywords).toContain('postgresql');
    expect(understanding.time_scope?.mode).toBe('historical');
  });
});
