/**
 * Explicit "remember" utterance detection for user prompts.
 *
 * DELIBERATE DUPLICATE of `@onememory-ai/adapter-claude/src/remember.ts` (mission-8 reuse note):
 * adapters depend on `@onememory-ai/core` only, so an adapter may not import a sibling adapter's
 * helper, and the alternative — a new shared package — is a coordinator-level change outside this
 * mission's file lane. The semantics are kept byte-identical on purpose: the same utterance must
 * mint the same `explicit.remember` content in every runtime, which is exactly what the
 * cross-adapter conformance suite asserts. Hoisting this into a shared adapter kit is a recorded
 * follow-up in the mission report.
 *
 * Only imperative remember requests anchored at the START of a user utterance qualify — a
 * conversational "do you remember yesterday?" must not mint an `explicit.remember` event (the
 * extractor stores those at importance 0.9 / confidence 0.95, so a loose pattern is a pollution
 * risk, AGENTS.md rule 8). An utterance that matches becomes an explicit.remember event and is NOT
 * additionally emitted as conversation.message (one utterance, one authoritative capture).
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
