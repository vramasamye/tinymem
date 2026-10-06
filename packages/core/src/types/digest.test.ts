/**
 * The digest entry projection (the `projects.digest` renderable record's key contract):
 * zero-padded `decision_NN` / `failure_NN` / `procedure_NN` keys in rollup priority order, so
 * jsonb's (length, bytewise) key order keeps each section's entries in pack order and the
 * session-context renderer turns `decision_01` into `decision 1: …`.
 */

import { describe, expect, test } from 'bun:test';

import {
  PROJECT_DIGEST_ENTRY_KEY,
  ProjectDigestEntriesSchema,
  projectDigestEntriesOf,
} from './digest';

describe('projectDigestEntriesOf', () => {
  test('projects each packed one-liner under its owned, zero-padded key', () => {
    const entries = projectDigestEntriesOf({
      decisions: ['Adopt Bun for install, test and dev.', 'Use PostgreSQL.'],
      failures: ['OOM on deploy → Raise the memory limit'],
      procedures: ['Run migrations before serve'],
    });
    expect(entries).toEqual({
      decision_01: 'Adopt Bun for install, test and dev.',
      decision_02: 'Use PostgreSQL.',
      failure_01: 'OOM on deploy → Raise the memory limit',
      procedure_01: 'Run migrations before serve',
    });
    for (const key of Object.keys(entries)) {
      expect(PROJECT_DIGEST_ENTRY_KEY.test(key)).toBe(true);
    }
    expect(ProjectDigestEntriesSchema.safeParse(entries).success).toBe(true);
  });

  test('empty sections project to an empty record (a valid clear of the owned namespace)', () => {
    const entries = projectDigestEntriesOf({ decisions: [], failures: [], procedures: [] });
    expect(entries).toEqual({});
    expect(ProjectDigestEntriesSchema.safeParse(entries).success).toBe(true);
  });

  test('the boundary schema rejects keys outside the owned namespace and non-strings', () => {
    expect(ProjectDigestEntriesSchema.safeParse({ summary: 'a foreign key' }).success).toBe(false);
    expect(ProjectDigestEntriesSchema.safeParse({ decision_1: 'unpadded' }).success).toBe(false);
    expect(ProjectDigestEntriesSchema.safeParse({ decision_01: 42 }).success).toBe(false);
  });

  test('more than 99 entries per section are dropped by the two-digit key contract', () => {
    const lines = Array.from({ length: 105 }, (_, index) => `line ${index + 1}`);
    const entries = projectDigestEntriesOf({ decisions: lines, failures: [], procedures: [] });
    expect(Object.keys(entries)).toHaveLength(99);
    expect(entries.decision_99).toBe('line 99');
    expect(entries.decision_100).toBeUndefined();
  });
});
