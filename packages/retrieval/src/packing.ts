/**
 * Stage 7 — token budget packing, the anti-dump step (retrieval.md §7; ADR-0004). Knapsack by
 * score density (score/token):
 *
 *   1. summaries-first: pack `content_summary` (or the derived sentence-boundary summary) while
 *      it fits — greedy by density, skipping items that do not fit yet
 *   2. content upgrades: with remaining budget, upgrade packed items (highest score first) to
 *      full `content` when the upgrade cost fits and the content actually adds detail
 *   3. titles-only overflow: items that did not get a summary slot are packed as their TITLE only
 *      (whole first sentence or stored title — never mid-sentence), while they fit; the rest are
 *      dropped and counted
 *
 * Hard invariants: `used ≤ budget` ALWAYS (enforced by construction, property-tested); never
 * truncate a memory mid-sentence (summaries are whole texts or whole-sentence prefixes of
 * content); duplicates were removed at stage 4.
 */

import { estimateTokens } from './tokens';

export interface PackableItem {
  id: string;
  title: string;
  summaryText: string;
  contentText: string;
  score: number;
}

export interface PackedItem {
  id: string;
  title: string;
  /** The packed representation: summary, upgraded content, or title-only. */
  summary: string;
  /** Present only when the item was upgraded to full content. */
  content?: string;
  /** Token cost of the packed representation (counted toward `used`). */
  tokens: number;
  packing: 'summary' | 'content' | 'title-only';
  score: number;
}

export interface PackOptions {
  budget: number;
  /** Soft limit on summary/content-packed items (request `max_memories`, default 10). */
  maxMemories: number;
  /** Cap on title-only overflow entries. */
  overflowLimit: number;
}

export interface PackResult {
  items: PackedItem[];
  used: number;
  budget: number;
  /** Response-level packing: the best representation achieved. */
  packing: 'summary' | 'content' | 'title-only';
  /** Candidates beyond the overflow limit (never packed). */
  omitted: number;
  /** Candidates whose title did not fit the remaining budget (never packed). */
  droppedForBudget: number;
}

/** Deterministic base order: score desc, then id asc. */
function byScoreDesc<T extends { score: number; id: string }>(a: T, b: T): number {
  return b.score - a.score || (a.id < b.id ? -1 : 1);
}

export function packResults(items: readonly PackableItem[], options: PackOptions): PackResult {
  const budget = Math.max(0, options.budget);
  const ordered = [...items].sort(byScoreDesc);
  const head = ordered.slice(0, options.maxMemories);
  const tail = ordered.slice(options.maxMemories);

  // Phase 1 — summaries, greedy by score density (score per summary token).
  const density = [...head].sort((a, b) => {
    const da = a.score / Math.max(1, estimateTokens(a.summaryText));
    const db = b.score / Math.max(1, estimateTokens(b.summaryText));
    return db - da || byScoreDesc(a, b);
  });

  const packed = new Map<string, PackedItem>();
  const unpackedHead: PackableItem[] = [];
  let used = 0;
  for (const item of density) {
    const tokens = estimateTokens(item.summaryText);
    if (tokens > 0 && used + tokens <= budget) {
      packed.set(item.id, {
        id: item.id,
        title: item.title,
        summary: item.summaryText,
        tokens,
        packing: 'summary',
        score: item.score,
      });
      used += tokens;
    } else {
      unpackedHead.push(item);
    }
  }

  // Phase 2 — content upgrades, highest score first, when the delta fits.
  for (const item of head) {
    const entry = packed.get(item.id);
    if (entry === undefined) continue;
    const summaryTokens = estimateTokens(item.summaryText);
    const contentTokens = estimateTokens(item.contentText);
    if (item.contentText !== item.summaryText && contentTokens > summaryTokens) {
      const delta = contentTokens - summaryTokens;
      if (used + delta <= budget) {
        entry.content = item.contentText;
        entry.summary = item.summaryText;
        entry.tokens = contentTokens;
        entry.packing = 'content';
        used += delta;
      }
    }
  }

  // Phase 3 — titles-only overflow for everything that did not get a summary slot.
  const overflowCandidates = [...unpackedHead, ...tail]
    .filter((item) => !packed.has(item.id))
    .sort(byScoreDesc);
  let droppedForBudget = 0;
  let omitted = 0;
  let overflowCount = 0;
  for (const item of overflowCandidates) {
    if (overflowCount >= options.overflowLimit) {
      omitted += 1;
      continue;
    }
    const tokens = estimateTokens(item.title);
    if (tokens > 0 && used + tokens <= budget) {
      packed.set(item.id, {
        id: item.id,
        title: item.title,
        summary: item.title,
        tokens,
        packing: 'title-only',
        score: item.score,
      });
      used += tokens;
      overflowCount += 1;
    } else {
      droppedForBudget += 1;
    }
  }

  const packedItems: PackedItem[] = [];
  for (const item of ordered) {
    const entry = packed.get(item.id);
    if (entry !== undefined) packedItems.push(entry);
  }

  const hasContent = packedItems.some((entry) => entry.packing === 'content');
  const hasSummary = packedItems.some((entry) => entry.packing === 'summary');
  const packing: PackResult['packing'] = hasContent ? 'content' : hasSummary ? 'summary' : 'title-only';

  if (used > budget) {
    // Unreachable by construction; fail loudly rather than return a violated budget.
    throw new Error(`packing: budget invariant violated (used ${used} > budget ${budget})`);
  }
  return { items: packedItems, used, budget, packing, omitted, droppedForBudget };
}
