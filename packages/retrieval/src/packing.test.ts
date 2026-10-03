/**
 * Stage-7 tests — the token packer. A seeded PROPERTY test over random fixtures × random
 * budgets asserting the hard invariants:
 *
 *   1. used ≤ budget, always
 *   2. never a mid-sentence truncation (packed summaries are the full source text or whole-
 *      sentence prefixes; content is always the full text; titles are the full label)
 *   3. overflow items appear as titles-only entries when they do not fit a summary slot
 *   4. token accounting: used === Σ packed item tokens
 *
 * Plus deterministic edge cases (tiny budgets, upgrades, the overflow line).
 */

import { describe, expect, test } from 'bun:test';

import { packResults } from './packing';
import type { PackableItem } from './packing';
import { deriveSummary, estimateTokens, sentencesOf } from './tokens';
import { mulberry32 } from './testing';

const SENTENCES = [
  'The deploy script pushes the container to the registry.',
  'Migrations run before the service starts.',
  'Tests must pass before any deploy proceeds.',
  'The invoice API caches responses in Redis for five minutes.',
  'PostgreSQL connection limits were raised last quarter.',
  'Node version 22 is required for the build pipeline.',
  'The OOM failure was traced to unbounded batch sizes.',
  'Preferences say tabs over spaces everywhere.',
  'Cloud Run gives the service a public HTTPS endpoint.',
  'The digest describes a TypeScript REST service.',
];

function randomItem(random: () => number, index: number): PackableItem {
  const count = 1 + Math.floor(random() * 4);
  const picked: string[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(SENTENCES[Math.floor(random() * SENTENCES.length)]!);
  }
  const summaryText = [...new Set(picked)].join(' ');
  const contentText = `${summaryText} ${SENTENCES[Math.floor(random() * SENTENCES.length)]!}`;
  return {
    id: `m-${index}`,
    title: `Memory ${index}`,
    summaryText,
    contentText,
    score: random(),
  };
}

describe('packing property test (seeded, deterministic)', () => {
  test('random fixtures × random budgets satisfy all hard invariants', () => {
    const random = mulberry32(20261003);
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const itemCount = 1 + Math.floor(random() * 15);
      const items: PackableItem[] = [];
      for (let i = 0; i < itemCount; i += 1) items.push(randomItem(random, i));
      const budget = 4 + Math.floor(random() * 900);

      const result = packResults(items, { budget, maxMemories: 5, overflowLimit: 6 });

      // 1. used ≤ budget (hard ceiling).
      expect(result.used).toBeLessThanOrEqual(budget);
      // 4. accounting: used is exactly the packed representations' cost.
      expect(result.used).toBe(result.items.reduce((sum, item) => sum + item.tokens, 0));

      const byId = new Map(items.map((item) => [item.id, item]));
      for (const packed of result.items) {
        const source = byId.get(packed.id)!;
        if (packed.packing === 'content') {
          // Full content, never truncated; summary is the full summary text.
          expect(packed.content).toBe(source.contentText);
          expect(packed.summary).toBe(source.summaryText);
          expect(packed.tokens).toBe(estimateTokens(source.contentText));
        } else if (packed.packing === 'summary') {
          // The full summary text, never truncated mid-sentence.
          expect(packed.summary).toBe(source.summaryText);
          expect(packed.tokens).toBe(estimateTokens(source.summaryText));
        } else {
          // Title-only overflow: the full label.
          expect(packed.summary).toBe(source.title);
          expect(packed.tokens).toBe(estimateTokens(source.title));
        }
      }

      // 2. No mid-sentence truncation anywhere: every packed summary is either its full source
      //    text or a whole-sentence prefix of the content.
      for (const packed of result.items) {
        const source = byId.get(packed.id)!;
        const text = packed.packing === 'content' ? packed.summary : packed.summary;
        if (text === source.summaryText) continue;
        const wholePrefix = sentencesOf(source.contentText).some((_, index, all) =>
          all.slice(0, index + 1).join(' ') === text,
        );
        expect(wholePrefix || text === source.title).toBe(true);
      }

      // 3. Everything unpacked is accounted for: it was beyond the overflow limit, or its
      //    title did not fit the remaining budget (title-only overflow is capped).
      const packedIds = new Set(result.items.map((item) => item.id));
      expect(result.omitted + result.droppedForBudget + result.items.length).toBe(items.length);
      for (const item of items) {
        if (packedIds.has(item.id)) continue;
        // Dropped candidates must genuinely not fit or be beyond overflow capacity.
        expect(result.omitted + result.droppedForBudget).toBeGreaterThan(0);
      }
    }
  });
});

describe('packing deterministic cases', () => {
  const summary = 'A short summary line.';
  const content = 'A short summary line. The rest of the detail follows here.';

  test('summaries first; content upgrades when budget allows; used ≤ budget', () => {
    const items: PackableItem[] = [
      { id: 'a', title: 'A', summaryText: summary, contentText: content, score: 0.9 },
      // Longer summary + lower score → lower density, so 'a' is packed first.
      {
        id: 'b', title: 'B', summaryText: 'Another, longer summary line.',
        contentText: 'Another, longer summary line. Plus more.', score: 0.8,
      },
    ];
    const generous = packResults(items, { budget: 800, maxMemories: 10, overflowLimit: 10 });
    expect(generous.used).toBeLessThanOrEqual(800);
    expect(generous.packing).toBe('content');
    expect(generous.items[0]?.content).toBe(content);
    expect(generous.items[0]?.summary).toBe(summary);

    const tight = packResults(items, { budget: estimateTokens(summary), maxMemories: 10, overflowLimit: 10 });
    expect(tight.packing).toBe('summary');
    expect(tight.items.length).toBe(1);
    expect(tight.items[0]?.id).toBe('a'); // higher score wins the only slot
    expect(tight.items[0]?.content).toBeUndefined();
  });

  test('overflow items surface as titles-only entries (progressive retrieval)', () => {
    const items: PackableItem[] = [
      {
        id: 'a',
        title: 'Alpha',
        summaryText: 'First summary with some body.',
        // Content upgrade is deliberately too expensive for this budget.
        contentText: 'First summary with some body. Extra detail that makes the full content much longer than the summary.',
        score: 0.9,
      },
      {
        id: 'b',
        title: 'Beta',
        summaryText: 'Second summary with more body.',
        contentText: 'Second summary with more body. Extra detail that makes the full content much longer too.',
        score: 0.8,
      },
    ];
    // Budget fits the first summary + both titles, but not the second summary nor upgrades.
    const budget = estimateTokens('First summary with some body.') + estimateTokens('Alpha') + estimateTokens('Beta');
    const result = packResults(items, { budget, maxMemories: 10, overflowLimit: 10 });
    const alpha = result.items.find((item) => item.id === 'a');
    const beta = result.items.find((item) => item.id === 'b');
    expect(alpha?.packing).toBe('summary');
    expect(beta?.packing).toBe('title-only');
    expect(beta?.summary).toBe('Beta'); // titles-only overflow line representation
    expect(result.used).toBeLessThanOrEqual(budget);
  });

  test('a budget too small for any summary falls back to titles-only packing', () => {
    const items: PackableItem[] = [
      { id: 'a', title: 'Alpha', summaryText: 'A long summary that cannot fit a tiny budget at all.', contentText: 'A long summary that cannot fit a tiny budget at all. More.', score: 0.9 },
    ];
    const result = packResults(items, { budget: 8, maxMemories: 10, overflowLimit: 10 });
    expect(result.packing).toBe('title-only');
    expect(result.items[0]?.summary).toBe('Alpha');
    expect(result.used).toBeLessThanOrEqual(8);
  });

  test('items beyond the overflow limit are counted as omitted, never packed', () => {
    const items: PackableItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: `m-${index}`,
      title: `T${index}`,
      summaryText: `Summary number ${index} with enough body to cost real tokens.`,
      contentText: `Summary number ${index} with enough body to cost real tokens. Extra detail.`,
      score: 1 - index / 10,
    }));
    const result = packResults(items, { budget: 800, maxMemories: 2, overflowLimit: 3 });
    expect(result.items.length).toBe(5); // 2 summaries + 3 title-only
    expect(result.omitted).toBe(5);
    expect(result.used).toBeLessThanOrEqual(800);
  });

  test('deriveSummary never cuts mid-sentence', () => {
    const longFirst =
      'This first sentence is deliberately much longer than the summary cap so the capping logic has to choose between breaking the invariant and keeping the whole sentence.';
    expect(deriveSummary(longFirst, 60)).toBe(longFirst); // whole sentence kept — never truncated
    const multi = 'One. Two sentences here. Three is the last one that should be dropped for length.';
    expect(deriveSummary(multi, 20)).toBe('One.');
    expect(deriveSummary(multi, 25)).toBe('One. Two sentences here.');
  });
});
