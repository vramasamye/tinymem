/**
 * Explicit "remember" utterance detection for OpenCode user messages.
 *
 * The canonical pattern is `@onememory-ai/adapter-claude/src/remember.ts` (mission 6); adapters do
 * not import each other (repository-structure rule), so the same contract is reimplemented here —
 * exactly as `@onememory-ai/adapter-codex`, `@onememory-ai/adapter-cursor` and `@onememory-ai/adapter-pi`
 * did (their files are the byte-identical contract; the conformance suite asserts the resulting
 * clause is the same). Only imperative remember requests anchored at the START of a user
 * utterance qualify: a conversational "do you remember yesterday?" must not mint an
 * `explicit.remember` (the extractor stores those at importance 0.9 / confidence 0.95, so a loose
 * pattern is a pollution risk — AGENTS.md rule 8). A matching utterance becomes an
 * `explicit.remember` and is NOT additionally emitted as `conversation.message` (one utterance,
 * one authoritative capture).
 */

/** Clamp for the remember clause — the future-value gate clamps memory content downstream too. */
const REMEMBER_CONTENT_MAX = 2000;

const REMEMBER_PATTERNS: readonly RegExp[] = [
  /^(?:please\s+)?(?:remember|note)\s+(?:that\s+|to\s+)?([\s\S]+)/i,
  /^don'?t\s+forget\s+(?:that\s+|to\s+)?([\s\S]+)/i,
  /^keep\s+in\s+mind\s+(?:that\s+)?([\s\S]+)/i,
  /^make\s+sure\s+(?:you\s+)?(?:always\s+)?remember\s+(?:that\s+|to\s+)?([\s\S]+)/i,
  /^always\s+remember\s+(?:that\s+)?([\s\S]+)/i,
  /^for\s+future\s+reference[,:]?\s*(?:remember\s+)?(?:that\s+)?([\s\S]+)/i,
];

/**
 * Extract the remembered clause from a user utterance, or `null` when the utterance is not an
 * imperative remember request. Trailing punctuation/whitespace is trimmed; the clause keeps its
 * internal structure (multi-line utterances stay multi-line).
 */
export function extractRememberUtterance(utterance: string): string | null {
  const trimmed = utterance.trim();
  if (trimmed.length === 0) return null;
  for (const pattern of REMEMBER_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match === null) continue;
    const clause = (match[1] ?? '').trim().replace(/[.!?]+$/, '').trim();
    if (clause.length < 3) return null; // "remember." and friends are not requests
    return clause.slice(0, REMEMBER_CONTENT_MAX);
  }
  return null;
}
