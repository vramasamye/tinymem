import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_HALF_LIFE_DAYS,
  DocumentAddedPayloadSchema,
  estimateTokens,
  MAX_DOCUMENT_CHARS,
} from './index';

describe('shared engine utilities', () => {
  test('estimates tokens conservatively by rounding character quarters up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('provides the canonical retrieval half-life defaults', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toEqual({
      episodic: 30,
      semantic: 400,
      procedural: 180,
      decision: 400,
      failure: 180,
      preference: 400,
      working: 7,
    });
  });

  test('keeps the document extraction cap aligned with event validation', () => {
    expect(DocumentAddedPayloadSchema.safeParse({
      kind: 'document.added',
      path: 'test.ts',
      mime: 'text/plain',
      content_digest: 'x'.repeat(MAX_DOCUMENT_CHARS),
    }).success).toBe(true);
    expect(DocumentAddedPayloadSchema.safeParse({
      kind: 'document.added',
      path: 'test.ts',
      mime: 'text/plain',
      content_digest: 'x'.repeat(MAX_DOCUMENT_CHARS + 1),
    }).success).toBe(false);
  });
});
