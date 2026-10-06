/**
 * The pure classification matrix (AC 1): given `now`, `summaryWindow`, `retentionWindow`, the
 * planner decides summarize vs. purge vs. keep for every candidate row — no SQL, no clock reads.
 */

import { describe, expect, test } from 'bun:test';

import { eventContentHash, type StoredEvent } from '@onememory/core';

import { classifyEvent, compactionCutoffs, planBatch } from './plan';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

let counter = 0;

/** A pipeline-clean processed event `daysAgo` days old (the default candidate). */
function event(daysAgo: number, overrides: Partial<StoredEvent> = {}): StoredEvent {
  counter += 1;
  return {
    id: `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    kind: 'conversation.message',
    runtime: 'claude-code',
    adapter_version: '1.0.0',
    payload: { kind: 'conversation.message', role: 'user', content: `note ${counter}` },
    content_hash: eventContentHash({ kind: 'conversation.message', role: 'user', content: `note ${counter}` }),
    redactions: [],
    occurred_at: at(daysAgo),
    ingested_at: at(daysAgo),
    processed_at: at(daysAgo),
    needs_review: false,
    ...overrides,
  };
}

/** `daysAgo`-old event that the pipeline never consumed. */
function unprocessed(daysAgo: number): StoredEvent {
  const { processed_at: _processed, ...rest } = event(daysAgo);
  return rest;
}

describe('compactionCutoffs', () => {
  test('derives both cutoffs from the injected clock', () => {
    const cutoffs = compactionCutoffs(NOW, 30, 90);
    expect(cutoffs.summaryCutoff).toBe(at(30));
    expect(cutoffs.retentionCutoff).toBe(at(90));
  });

  test('retention 0 means keep forever — the retention cutoff is null, never a purge', () => {
    const cutoffs = compactionCutoffs(NOW, 30, 0);
    expect(cutoffs.summaryCutoff).toBe(at(30));
    expect(cutoffs.retentionCutoff).toBeNull();
  });
});

describe('classifyEvent', () => {
  const cutoffs = compactionCutoffs(NOW, 30, 90);

  test('older than the retention window, pipeline-clean, undigested → summarize then purge', () => {
    const entry = classifyEvent(event(100), false, cutoffs);
    expect(entry.action).toBe('summarize_and_purge');
    expect(entry.event_id).toBe('00000000-0000-7000-8000-000000000001');
    expect(entry.kind).toBe('conversation.message');
    expect(entry.occurred_at).toBe(at(100));
  });

  test('older than the retention window, pipeline-clean, already digested → purge only', () => {
    expect(classifyEvent(event(100), true, cutoffs).action).toBe('purge');
  });

  test('between the windows, undigested → summarize, keep the raw row', () => {
    const entry = classifyEvent(event(40), false, cutoffs);
    expect(entry.action).toBe('summarize');
    expect(entry.reason).toBe('older than the summary window');
  });

  test('between the windows, already digested → keep (awaiting the retention window)', () => {
    const entry = classifyEvent(event(40), true, cutoffs);
    expect(entry.action).toBe('keep');
    expect(entry.reason).toBe('already summarized — awaiting the retention window');
  });

  test('younger than the summary window → keep (defensive: the scan never lists these)', () => {
    const entry = classifyEvent(event(5), false, cutoffs);
    expect(entry.action).toBe('keep');
    expect(entry.reason).toBe('within the summary window');
  });

  test('an unprocessed event is never purged — the raw row is the pipeline work order', () => {
    const entry = classifyEvent(unprocessed(100), false, cutoffs);
    expect(entry.action).toBe('keep');
    expect(entry.reason).toBe('unprocessed');
  });

  test('a needs_review event is never purged', () => {
    const entry = classifyEvent(event(100, { needs_review: true }), false, cutoffs);
    expect(entry.action).toBe('keep');
    expect(entry.reason).toBe('needs_review');
  });

  test('an event with a process_error is never purged', () => {
    const entry = classifyEvent(event(100, { process_error: 'boom' }), false, cutoffs);
    expect(entry.action).toBe('keep');
    expect(entry.reason).toBe('process_error');
  });

  test('retention 0 (keep forever) still summarizes but never purges', () => {
    const forever = compactionCutoffs(NOW, 30, 0);
    expect(classifyEvent(event(400), false, forever).action).toBe('summarize');
    expect(classifyEvent(event(400), true, forever).action).toBe('keep');
  });

  test('the boundary is strict: exactly summary-window-old is NOT summarized', () => {
    expect(classifyEvent(event(30), false, cutoffs).action).toBe('keep');
    expect(classifyEvent(event(31), false, cutoffs).action).toBe('summarize');
    expect(classifyEvent(event(90), false, cutoffs).action).toBe('summarize');
    expect(classifyEvent(event(91), false, cutoffs).action).toBe('summarize_and_purge');
  });
});

describe('planBatch', () => {
  const cutoffs = compactionCutoffs(NOW, 30, 90);

  test('counts every tier and separates the blocked keeps', () => {
    const batch = [
      event(100), // summarize_and_purge (clean, undigested, past retention)
      event(100), // purge (clean, digested, past retention)
      event(40), // summarize (between the windows)
      event(40), // keep (digested, awaiting retention)
      event(5), // keep (young — defensive: the scan never lists these)
      unprocessed(100), // keep (blocked)
      event(100, { needs_review: true }), // keep (blocked)
      event(100, { process_error: 'boom' }), // keep (blocked)
    ];
    const plan = planBatch(batch, new Set([batch[1]!.id, batch[3]!.id]), cutoffs);
    expect(plan.entries).toHaveLength(8);
    expect(plan.toSummarize).toBe(2); // the summarize_and_purge + the between-windows summarize
    expect(plan.toPurge).toBe(2); // the summarize_and_purge + the already-digested purge
    expect(plan.kept).toBe(5);
    expect(plan.blocked.map((entry) => entry.reason)).toEqual([
      'unprocessed',
      'needs_review',
      'process_error',
    ]);
  });

  test('an empty batch plans to nothing', () => {
    const plan = planBatch([], new Set(), cutoffs);
    expect(plan.entries).toHaveLength(0);
    expect(plan.toSummarize).toBe(0);
    expect(plan.toPurge).toBe(0);
    expect(plan.kept).toBe(0);
    expect(plan.blocked).toHaveLength(0);
  });
});
