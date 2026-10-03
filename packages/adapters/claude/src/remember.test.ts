/**
 * Explicit-remember utterance detection: anchored, imperative requests only. The extractor stores
 * explicit.remember at high importance/confidence, so every false positive is durable pollution —
 * these tests pin the negatives as tightly as the positives.
 */

import { describe, expect, test } from 'bun:test';

import { eventContentHash, validateOnememoryEvent } from '@onememory/core';

import { extractRememberUtterance } from './remember';

describe('extractRememberUtterance', () => {
  test.each([
    ['Remember that we use bun test over jest', 'we use bun test over jest'],
    ['Remember to run bun install before bun test', 'run bun install before bun test'],
    ['please remember that the API root is /v1', 'the API root is /v1'],
    ["Don't forget to pin zod to 4.x", 'pin zod to 4.x'],
    ['dont forget that the daemon binds loopback only', 'the daemon binds loopback only'],
    ['Keep in mind that PGlite is single-owner', 'PGlite is single-owner'],
    ['Always remember that Postgres is the only dialect', 'Postgres is the only dialect'],
    ['Make sure you remember to run migrations after schema changes', 'run migrations after schema changes'],
    ['For future reference: hooks exit 0 always', 'hooks exit 0 always'],
    ['Note that the retry budget is 2', 'the retry budget is 2'],
  ])('imperative: %s → %s', (utterance, expected) => {
    expect(extractRememberUtterance(utterance)).toBe(expected);
  });

  test('multi-line utterances keep their structure', () => {
    const clause = extractRememberUtterance('Remember that we ship on Fridays\nand the release branch is protected');
    expect(clause).toBe('we ship on Fridays\nand the release branch is protected');
  });

  test.each([
    'Do you remember yesterday?',
    "I don't remember where I put it",
    'Remember.', // no clause
    'Ok', // no pattern
    'Maybe we should remember something',
    'the memory of that failure is fuzzy',
  ])('conversational/negative: %s stays a plain message', (utterance) => {
    expect(extractRememberUtterance(utterance)).toBeNull();
  });

  test('the extracted clause mints a valid explicit.remember payload', () => {
    const clause = extractRememberUtterance('Remember that we use bun test');
    expect(clause).not.toBeNull();
    const payload = { kind: 'explicit.remember', content: clause };
    const validation = validateOnememoryEvent({
      id: '0195a7f0-9f5e-7a1d-bc2d-0000000000b1',
      kind: 'explicit.remember',
      occurred_at: '2026-10-03T10:00:00.000Z',
      ingested_at: '2026-10-03T10:00:00.000Z',
      source: { runtime: 'claude-code', adapter_version: '0.1.0' },
      scope: { project_id: '0195a7f0-9f5e-7a1d-bc2d-0000000000aa' },
      payload,
      content_hash: eventContentHash(payload),
      redactions: [],
    });
    expect(validation.ok).toBeTrue();
  });

  test('very long utterances are clamped to the adapter policy bound', () => {
    const long = extractRememberUtterance(`Remember that ${'x'.repeat(3000)}`);
    expect(long).not.toBeNull();
    expect(long!.length).toBeLessThanOrEqual(2000);
  });
});
