/**
 * The digest summary builder: per-kind one-liners reused from extraction, the byte audit, and
 * the digest row's verbatim lineage columns.
 */

import { describe, expect, test } from 'bun:test';

import { eventContentHash, type StoredEvent } from '@onememory/core';

import {
  buildEventDigest,
  digestSummaryLine,
  DIGEST_SUMMARY_MAX_CHARS,
  payloadByteSize,
} from './summary';

let counter = 0;

function event(overrides: Partial<StoredEvent> & Pick<StoredEvent, 'kind' | 'payload'>): StoredEvent {
  counter += 1;
  return {
    id: `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    runtime: 'claude-code',
    adapter_version: '1.2.3',
    content_hash: eventContentHash(overrides.payload),
    redactions: [],
    occurred_at: '2026-07-01T10:00:00.000Z',
    ingested_at: '2026-07-01T10:00:01.000Z',
    processed_at: '2026-07-01T10:00:02.000Z',
    needs_review: false,
    ...overrides,
  };
}

describe('digestSummaryLine', () => {
  test('a conversation message becomes the per-kind one-liner extraction already uses', () => {
    const line = digestSummaryLine(
      event({
        kind: 'conversation.message',
        payload: { kind: 'conversation.message', role: 'user', content: 'We use bun test' },
      }),
    );
    expect(line).toBe('[user] We use bun test');
  });

  test('a terminal output keeps its command shape', () => {
    const line = digestSummaryLine(
      event({
        kind: 'terminal.output',
        payload: { kind: 'terminal.output', command: 'bun test', exit_code: 0, output_digest: '42 passed' },
      }),
    );
    expect(line).toBe('$ bun test → exit 0 42 passed');
  });

  test('a commit keeps its sha + message shape', () => {
    const line = digestSummaryLine(
      event({
        kind: 'git.commit',
        payload: {
          kind: 'git.commit',
          sha: 'abcdef1234567890',
          message: 'feat: land compaction',
          author_name: ' contributor',
          files: ['packages/consolidation/src/compaction/run.ts'],
        },
      }),
    );
    expect(line).toBe('commit abcdef12: feat: land compaction');
  });

  test('long payloads collapse to one bounded line', () => {
    const line = digestSummaryLine(
      event({
        kind: 'conversation.message',
        payload: {
          kind: 'conversation.message',
          role: 'assistant',
          content: 'x'.repeat(2000),
        },
      }),
    );
    expect(line.length).toBe(DIGEST_SUMMARY_MAX_CHARS);
    expect(line.endsWith('…')).toBeTrue();
  });

  test('a payload that fails envelope re-validation falls back to its bounded JSON, never throws', () => {
    const line = digestSummaryLine(
      event({
        kind: 'conversation.message',
        // role outside the enum: storedEventToEnvelope re-validation throws → the fallback path
        payload: { kind: 'conversation.message', role: 'bogus', content: 'still lineaged' },
      }),
    );
    expect(line).toContain('still lineaged');
    expect(line.length).toBeLessThanOrEqual(DIGEST_SUMMARY_MAX_CHARS);
  });
});

describe('payloadByteSize', () => {
  test('is the UTF-8 size of the payload JSON', () => {
    expect(payloadByteSize({})).toBe(2);
    expect(payloadByteSize({ kind: 'conversation.message', role: 'user', content: 'ümlaut' })).toBe(
      new TextEncoder().encode(JSON.stringify({ kind: 'conversation.message', role: 'user', content: 'ümlaut' })).length,
    );
  });
});

describe('buildEventDigest', () => {
  test('preserves every identity, scope and hash column verbatim and carries the source linkage', () => {
    const raw = event({
      kind: 'conversation.message',
      project_id: '00000000-0000-7000-8000-0000000000aa',
      session_id: 'sess-1',
      agent_id: 'claude-code',
      user_id: '00000000-0000-7000-8000-0000000000bb',
      payload: { kind: 'conversation.message', role: 'user', content: 'We use bun test' },
      redactions: [
        { kind: 'api-key', location: 'payload.content', length: 41 },
        { kind: 'password', location: 'payload.content', length: 12 },
      ],
    });
    const digest = buildEventDigest(raw, ['00000000-0000-7000-8000-0000000000cc']);
    expect(digest).toEqual({
      event_id: raw.id,
      kind: 'conversation.message',
      runtime: 'claude-code',
      adapter_version: '1.2.3',
      project_id: '00000000-0000-7000-8000-0000000000aa',
      session_id: 'sess-1',
      agent_id: 'claude-code',
      user_id: '00000000-0000-7000-8000-0000000000bb',
      content_hash: raw.content_hash,
      occurred_at: raw.occurred_at,
      ingested_at: raw.ingested_at,
      summary: '[user] We use bun test',
      payload_bytes: payloadByteSize(raw.payload),
      redactions_count: 2,
      source_ids: ['00000000-0000-7000-8000-0000000000cc'],
    });
  });

  test('omits absent scope fields (the digest row has no phantom columns)', () => {
    const raw = event({
      kind: 'session.start',
      payload: { kind: 'session.start', cwd: '/tmp/project' },
    });
    const digest = buildEventDigest(raw, []);
    expect('project_id' in digest).toBeFalse();
    expect('session_id' in digest).toBeFalse();
    expect('agent_id' in digest).toBeFalse();
    expect('user_id' in digest).toBeFalse();
    expect(digest.source_ids).toEqual([]);
    expect(digest.redactions_count).toBe(0);
  });
});
