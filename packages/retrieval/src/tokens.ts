/**
 * Retrieval text shaping. Token estimation remains re-exported here for API compatibility; the
 * canonical implementation is shared from `@onememory/core`.
 */

export { estimateTokens } from '@onememory/core';

/** Split text into sentences (terminator + following whitespace). Empty sentences dropped. */
export function sentencesOf(text: string): string[] {
  const normalized = text.trim();
  if (normalized === '') return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Derive a summary for memories without a stored `content_summary`: whole sentences, in order,
 * while the total stays ≤ `maxChars`. NEVER truncates mid-sentence — if the first sentence alone
 * exceeds the cap, it is kept whole (the never-truncate invariant outranks the length convention).
 */
export function deriveSummary(content: string, maxChars: number): string {
  const sentences = sentencesOf(content);
  if (sentences.length === 0) return content.trim();
  let summary = '';
  for (const sentence of sentences) {
    const candidate = summary === '' ? sentence : `${summary} ${sentence}`;
    if (candidate.length > maxChars && summary !== '') break;
    summary = candidate;
  }
  return summary;
}

/** Word-boundary label cut (titles for the titles-only overflow line). */
export function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > maxChars * 0.5 ? lastSpace : maxChars;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}

/**
 * Resolve the label for a title-only (overflow) entry: the stored title if present, else the
 * first sentence of the content, capped at word boundaries. A whole first sentence when short.
 */
export function deriveLabel(title: string | undefined, content: string, maxChars = 60): string {
  const source = title && title.trim() !== '' ? title : (sentencesOf(content)[0] ?? content);
  return truncateAtWordBoundary(source.trim(), maxChars);
}
