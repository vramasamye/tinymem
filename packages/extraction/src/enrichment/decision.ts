/**
 * Decision enrichment (M3b): capture **alternatives considered and rationale** from natural
 * decision language ("we chose X over Y because Z") in the transcript that already trips the
 * decision rules — `alternatives` + `rationale` are what memory-model.md §9 requires before a
 * decision may be promoted beyond `proposed`, and they are exactly the `decisions` payload table
 * columns (`decision`, `alternatives [{option, why_rejected?}]`, `rationale`). The payload emitted
 * here is the bounded extraction-time subset of core's `DecisionPayloadSchema`
 * (`DecisionExtractionSchema`), so STORE can fill the payload table without re-parsing prose.
 *
 * Rules are deterministic, local, and narrow (patterns.ts philosophy: a miss costs recall — the
 * LLM extractor covers the long tail — while a false alternative pollutes durable memory):
 *
 * 1. the chosen option is the first `DECISION_PATTERNS` capture, cut at a rationale connective;
 * 2. the alternative is the `over` capture, cut the same way;
 * 3. the rationale is the clause after the decision phrase **within the same sentence** (or the
 *    rationale that the phrase itself carried);
 * 4. further alternatives come from rejection statements within 400 characters after the decision
 *    ("we ruled out SQLite because …"), each with its `why_rejected`;
 * 5. an alternative is dropped when it is a pronoun/filler ("it", "the other"), repeats the chosen
 *    option, or is shorter than two characters.
 *
 * `parseDecisionPayload()` is the tolerant boundary for LLM output: garbage in → `undefined` out,
 * never an invalid candidate.
 */

import { DecisionExtractionSchema, type DecisionAlternative, type DecisionExtraction } from '@onememory/core';

import {
  DECISION_CLAUSE_BREAK,
  DECISION_NOISE_PATTERNS,
  DECISION_OPTION_NOISE,
  DECISION_PATTERNS,
  DECISION_RATIONALE_PATTERNS,
  DECISION_RATIONALE_SPLIT,
  DECISION_REJECTION_PATTERNS,
  firstMatch,
  matchAll,
  significantTokens,
  type PatternMatch,
} from '../heuristic/patterns';

/** Bounds (each ≤ the canonical schema's limits in `core/schema/extraction.ts`). */
export const MAX_DECISION_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 200;
export const MAX_OPTION_LENGTH = 120;
export const MAX_ALTERNATIVES = 3;

/** How far after the decision phrase rejection statements are collected. */
export const REJECTION_WINDOW = 400;

const OPTION_NOISE = new Set(DECISION_OPTION_NOISE);

const LEADING_NOISE = /^[\s'"`([{<—–]+/;
const TRAILING_NOISE = /[\s'"`)\]}>—–.,;:!?]+$/;

/** Collapse whitespace, drop wrapping punctuation, cap the length. Empty string when unusable. */
function cleanPhrase(value: string | undefined, max: number): string {
  if (value === undefined) return '';
  const collapsed = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_NOISE, '')
    .replace(TRAILING_NOISE, '')
    .trim();
  return collapsed.length > max ? collapsed.slice(0, max).trim() : collapsed;
}

/**
 * Split `"Y because Z"` into `{ option: 'Y', rationale: 'Z' }`. The option also stops at the next
 * clause boundary, and the rationale is only kept when it sits in the **same clause** as the
 * option — a rationale behind a clause break belongs to that later clause (usually a rejection
 * statement), which the rejection rule captures with its own `why_rejected`.
 */
export function splitDecisionRationale(phrase: string): { option: string; rationale?: string } {
  const split = DECISION_RATIONALE_SPLIT.exec(phrase);
  const head = split ? phrase.slice(0, split.index) : phrase;
  const tail = split ? phrase.slice(split.index + split[0].length) : undefined;
  const clauseBreak = DECISION_CLAUSE_BREAK.exec(head);
  const option = clauseBreak ? head.slice(0, clauseBreak.index) : head;
  const rationale = tail !== undefined && clauseBreak === null ? tail : undefined;
  return {
    option,
    ...(rationale === undefined || rationale.trim().length === 0 ? {} : { rationale }),
  };
}

/** A rationale clause stops at the next clause boundary: it describes the decision, not the rest. */
function clauseOnly(text: string): string {
  const clauseBreak = DECISION_CLAUSE_BREAK.exec(text);
  return clauseBreak ? text.slice(0, clauseBreak.index) : text;
}

function isUsableOption(option: string, chosen: string): boolean {
  const lower = option.toLowerCase();
  if (option.length < 2) return false;
  if (OPTION_NOISE.has(lower)) return false;
  return lower !== chosen.toLowerCase();
}

function sameOption(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True when the rationale names the rejected option (so it can be attributed as `why_rejected`). */
function rationaleNamesOption(rationale: string, option: string): boolean {
  const optionTokens = significantTokens(option);
  const rationaleTokens = significantTokens(rationale);
  for (const token of optionTokens) {
    if (rationaleTokens.has(token)) return true;
  }
  return false;
}

export interface DecisionEnrichmentInput {
  /** The `DECISION_PATTERNS` match (captures: 1 = chosen, 2 = rejected option when present). */
  match: PatternMatch;
  /** The prose the match came from (message, document, session summary). */
  text: string;
  /** Index of the match inside `text`. */
  index: number;
}

/**
 * Build the structured decision payload for a decision-language match, or `undefined` when the
 * phrase carries no usable decision statement.
 */
export function enrichDecision(input: DecisionEnrichmentInput): DecisionExtraction | undefined {
  const { match, text, index } = input;

  // A `DECISION_PATTERNS` capture can swallow the rationale ("chose X over Y because Z"); split it.
  const chosen = splitDecisionRationale(match.captures[0] ?? match.match);
  const rejected = match.captures[1] === undefined ? undefined : splitDecisionRationale(match.captures[1]);
  // "the decision is to ship X" / "decision: to ship X" — the infinitive marker is not the option.
  const decision = cleanPhrase(chosen.option.replace(/^to\s+/i, ''), MAX_DECISION_LENGTH);
  if (decision.length < 2) return undefined;

  // The rationale lives in the decision's own clause: everything up to the next terminator, and
  // never past a clause break (a later clause is a different statement — usually a rejection).
  const tail = text.slice(index + match.match.length);
  const clause = tail.split(/[.!?\n]/)[0] ?? '';
  const rationale = cleanPhrase(
    clauseOnly(
      firstMatch(clause, DECISION_RATIONALE_PATTERNS)?.captures[0] ??
        chosen.rationale ??
        rejected?.rationale ??
        '',
    ),
    MAX_RATIONALE_LENGTH,
  );

  const alternatives: DecisionAlternative[] = [];
  const rejectedOption = rejected === undefined ? '' : cleanPhrase(rejected.option, MAX_OPTION_LENGTH);
  if (isUsableOption(rejectedOption, decision)) {
    alternatives.push({
      option: rejectedOption,
      ...(rationale.length > 0 && rationaleNamesOption(rationale, rejectedOption)
        ? { why_rejected: rationale }
        : {}),
    });
  }

  for (const rejection of matchAll(
    text.slice(index, index + REJECTION_WINDOW),
    DECISION_REJECTION_PATTERNS,
    MAX_ALTERNATIVES,
  )) {
    const option = cleanPhrase(rejection.captures[0], MAX_OPTION_LENGTH);
    if (!isUsableOption(option, decision)) continue;
    if (alternatives.some((alternative) => sameOption(alternative.option, option))) continue;
    const why = cleanPhrase(clauseOnly(rejection.captures[1] ?? ''), MAX_RATIONALE_LENGTH);
    alternatives.push({ option, ...(why.length > 0 ? { why_rejected: why } : {}) });
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }

  return DecisionExtractionSchema.parse({
    decision,
    alternatives: alternatives.slice(0, MAX_ALTERNATIVES),
    ...(rationale.length > 0 ? { rationale } : {}),
  });
}

/**
 * Decision payload for a piece of prose, when that prose trips the decision rules (noise-filtered).
 * Used for `explicit.remember --type decision`, where the statement itself is the source text and
 * the user-authored content is never rewritten.
 */
export function decisionPayloadFromText(text: string): DecisionExtraction | undefined {
  if (firstMatch(text, DECISION_NOISE_PATTERNS)) return undefined;
  const match = firstMatch(text, DECISION_PATTERNS);
  if (!match) return undefined;
  const index = text.indexOf(match.match);
  return enrichDecision({ match, text, index: index < 0 ? 0 : index });
}

/**
 * The durable statement for a decision candidate. The chosen option, the primary rejected
 * alternative and the rationale are in the content (that is what is persisted today); any further
 * alternatives are named in a bounded clause. Token efficiency: no restating, no duplication.
 */
export function decisionContent(payload: DecisionExtraction): string {
  const primary = payload.alternatives[0];
  let content = `Decision: ${payload.decision}`;
  if (primary !== undefined) content += ` over ${primary.option}`;
  if (payload.rationale !== undefined) content += ` — because ${payload.rationale}`;
  const others = payload.alternatives.slice(1);
  if (others.length > 0) {
    content += ` — also rejected: ${others.map((alternative) => alternative.option).join(', ')}`;
  }
  return content;
}

/**
 * Tolerance boundary for LLM output: accept anything object-shaped, salvage what is usable, and
 * return the canonical payload — or `undefined` when no decision statement survives.
 */
export function parseDecisionPayload(value: unknown): DecisionExtraction | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const decision = cleanPhrase(
    typeof raw.decision === 'string' ? raw.decision : undefined,
    MAX_DECISION_LENGTH,
  );
  if (decision.length < 2) return undefined;

  const alternatives: DecisionAlternative[] = [];
  if (Array.isArray(raw.alternatives)) {
    for (const entry of raw.alternatives) {
      if (typeof entry !== 'object' || entry === null) continue;
      const candidate = entry as Record<string, unknown>;
      const option = cleanPhrase(
        typeof candidate.option === 'string' ? candidate.option : undefined,
        MAX_OPTION_LENGTH,
      );
      if (!isUsableOption(option, decision)) continue;
      if (alternatives.some((alternative) => sameOption(alternative.option, option))) continue;
      const why = cleanPhrase(
        typeof candidate.why_rejected === 'string' ? candidate.why_rejected : undefined,
        MAX_RATIONALE_LENGTH,
      );
      alternatives.push({ option, ...(why.length > 0 ? { why_rejected: why } : {}) });
      if (alternatives.length >= MAX_ALTERNATIVES) break;
    }
  }

  const rationale = cleanPhrase(
    typeof raw.rationale === 'string' ? raw.rationale : undefined,
    MAX_RATIONALE_LENGTH,
  );

  return DecisionExtractionSchema.parse({
    decision,
    alternatives,
    ...(rationale.length > 0 ? { rationale } : {}),
  });
}
