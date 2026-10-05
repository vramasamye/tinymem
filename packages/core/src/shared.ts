import type { MemoryType } from './model/types';

/** Conservative token estimate: ceil(chars / 4), shared by retrieval and persistence paths. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Maximum extracted text carried in a `document.added` event. */
export const MAX_DOCUMENT_CHARS = 8000;

/** Default recency half-life per memory type, in days. */
export const DEFAULT_HALF_LIFE_DAYS: Record<MemoryType, number> = {
  episodic: 30,
  semantic: 400,
  procedural: 180,
  decision: 400,
  failure: 180,
  preference: 400,
  working: 7,
};
