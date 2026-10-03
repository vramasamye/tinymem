/**
 * Stage 1 — query understanding, rules-first and zero-LLM (retrieval.md §1). The LLM-enhanced
 * variant is a later quality tier (M-llm router); everything here is deterministic keyword/regex
 * work so retrieval never requires a model call in the hot path.
 *
 *   intent      : keyword table → one of the 7 wire intents
 *   time scope  : regex ranges ("last year", "in 2025", "before X", "since X") → [from, until)
 *   keywords    : tokenize + stopword strip + `simple`-dictionary-style normalization (lowercase;
 *                 PG's 'simple' config does no stemming, so neither do we)
 *   entities    : matched by the caller against the storage entity registry (EntityIndex) — the
 *                 pure part of this module just consumes the matches
 */

import type { SearchIntent } from '@onememory/core';

export interface TimeScope {
  from?: string;
  until?: string;
  mode: 'current' | 'historical';
}

export interface QueryUnderstanding {
  intent: SearchIntent;
  entities: Array<{ name: string; matched_id?: string }>;
  time_scope?: TimeScope;
  keywords: string[];
}

/** Intent keyword table. Order = tie-break precedence (most specific temporal/urgent first). */
const INTENT_KEYWORDS: ReadonlyArray<{ intent: SearchIntent; phrases: readonly string[] }> = [
  {
    intent: 'history',
    phrases: [
      'last year', 'last month', 'last week', 'yesterday', 'previously', 'before', 'history',
      'used to', 'last time', 'ago', 'when did', 'back in', 'earlier', 'original',
    ],
  },
  {
    intent: 'failure',
    phrases: [
      'error', 'errors', 'failed', 'failing', 'fails', 'fail', 'oom', 'out of memory',
      'crash', 'crashes', 'crashed', 'exception', 'bug', 'broken', 'panic', 'traceback',
      'stack trace', 'segfault', 'timeout', 'denied',
    ],
  },
  {
    intent: 'how_to',
    phrases: [
      'how do', 'how to', 'how can', 'how does', 'steps to', 'run', 'deploy', 'deploying',
      'configure', 'install', 'set up', 'setup', 'debug', 'fix', 'command to', 'script to',
      'procedure for',
    ],
  },
  {
    intent: 'decision',
    phrases: [
      'why did', 'why do', 'why does', 'why are', 'decision', 'decided', 'decide', 'choose',
      'chose', 'chosen', 'rationale', 'alternative', 'alternatives', 'adr', 'trade-off',
      'tradeoff', 'architectural',
    ],
  },
  {
    intent: 'preference',
    phrases: [
      'prefer', 'prefers', 'preference', 'style', 'convention', 'conventions', 'guideline',
      'guidelines', 'formatting', 'lint', 'standard for',
    ],
  },
  {
    intent: 'context',
    phrases: [
      'context', 'overview', 'summarize', 'summary', 'onboard', 'catch up', 'project digest',
      'what is this project', 'what are we building', 'tell me about the project',
    ],
  },
  {
    intent: 'fact',
    phrases: [
      'what', 'which', 'when', 'where', 'who', 'how many', 'version', 'uses', 'running on',
      'does the project',
    ],
  },
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase: string): RegExp {
  const pattern = phrase
    .split(/\s+/)
    .map(escapeRegex)
    .join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

/** Intent = the keyword table's best match; ties resolved by precedence order. */
export function classifyIntent(query: string): SearchIntent {
  let best: SearchIntent = 'fact';
  let bestScore = 0;
  for (const { intent, phrases } of INTENT_KEYWORDS) {
    let score = 0;
    for (const phrase of phrases) {
      if (phraseRegex(phrase).test(query)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
  }
  return best;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'we', 'you', 'he', 'she', 'it',
  'they', 'me', 'us', 'him', 'her', 'them', 'my', 'our', 'your', 'his', 'its', 'their', 'of',
  'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'up', 'down', 'out', 'off', 'over',
  'under', 'again', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'because', 'as', 'all',
  'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'into', 'about',
  'there', 'here', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
]);

/** Tokenize + stopword strip + lowercase (the `simple` dictionary's own normalization). */
export function extractKeywords(query: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const token of query.toLowerCase().split(/[^a-z0-9.]+/)) {
    if (token.length === 0 || STOPWORDS.has(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      keywords.push(token);
    }
    if (keywords.length >= 32) break;
  }
  return keywords;
}

function iso(year: number, month = 1, day = 1): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

function endOfGranularity(year: number, month?: string, day?: string): string {
  if (day !== undefined) return iso(year, Number(month), Number(day));
  if (month !== undefined) {
    const m = Number(month);
    return m === 12 ? iso(year + 1, 1, 1) : iso(year, m + 1, 1);
  }
  return iso(year + 1, 1, 1);
}

const DATE_PATTERN = '(20\\d{2})(?:-(\\d{2}))?(?:-(\\d{2}))?';

/**
 * Parse the wire time_scope from natural language: "last year" → calendar-year range, "last N
 * <unit>s" / "N <unit>s ago" → rolling range, "in/during YYYY" → that year, "before X" → open
 * range ending at X, "after/since X" → open range from X, "now/today/currently" → current mode.
 * Deterministic; UTC.
 */
export function parseTimeScope(query: string, now: Date): TimeScope | undefined {
  const q = query.toLowerCase();
  const nowYear = now.getUTCFullYear();

  // "last year" (calendar) — before "last N units" so it wins.
  if (/\blast year\b/.test(q)) {
    return { from: iso(nowYear - 1), until: iso(nowYear), mode: 'historical' };
  }

  const units: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };
  const rolling = /\b(?:last|past)\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/.exec(q)
    ?? /\b(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/.exec(q);
  if (rolling) {
    const count = Number(rolling[1]);
    const unitKey = rolling[2] ?? 'day';
    const unitDays = units[unitKey] ?? 1;
    const fromMs = now.getTime() - count * unitDays * 86_400_000;
    return { from: new Date(fromMs).toISOString(), until: now.toISOString(), mode: 'historical' };
  }

  const inYear = new RegExp(`\\b(?:in|during)\\s+${DATE_PATTERN}\\b`).exec(q);
  if (inYear) {
    const year = Number(inYear[1]);
    let from = iso(year);
    let until = iso(year + 1);
    if (inYear[2] !== undefined) {
      from = iso(year, Number(inYear[2]));
      until = endOfGranularity(year, inYear[2], inYear[3]);
    }
    return { from, until, mode: 'historical' };
  }

  let scope: TimeScope | undefined;
  const before = new RegExp(`\\b(?:before|until)\\s+${DATE_PATTERN}\\b`).exec(q);
  if (before) {
    const year = Number(before[1]);
    scope = { until: endOfGranularity(year, before[2], before[3]), mode: 'historical' };
  }
  const since = new RegExp(`\\b(?:after|since)\\s+${DATE_PATTERN}\\b`).exec(q);
  if (since) {
    const year = Number(since[1]);
    scope = {
      ...(scope ?? {}),
      from: since[3] !== undefined
        ? iso(year, Number(since[2]), Number(since[3]))
        : iso(year, since[2] !== undefined ? Number(since[2]) : 1),
      mode: 'historical',
    };
  }
  if (scope) return scope;

  if (/\b(now|today|currently|current)\b/.test(q)) {
    return { mode: 'current' };
  }
  return undefined;
}

/** Matched-entity input to `understandQuery` (resolution itself lives in EntityIndex). */
export interface MatchedEntity {
  id: string;
  name: string;
}

/** Assemble the wire `query_understanding` block (event-memory-schemas.md §6). */
export function understandQuery(
  query: string,
  input: { matchedEntities: readonly MatchedEntity[]; now: Date },
): QueryUnderstanding {
  const intent = classifyIntent(query);
  const time_scope = parseTimeScope(query, input.now);
  const understanding: QueryUnderstanding = {
    intent,
    entities: input.matchedEntities.map((entity) => ({ name: entity.name, matched_id: entity.id })),
    keywords: extractKeywords(query),
  };
  if (time_scope !== undefined) understanding.time_scope = time_scope;
  return understanding;
}
