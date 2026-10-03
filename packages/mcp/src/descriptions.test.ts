/**
 * The description-budget suite (ADR-0010 consequence: "Tool descriptions are a maintained
 * artifact with length tests (≤ 2,048 chars) — the model's UX depends on them as much as on
 * results"). Claude Code truncates at 2,048; Codex reads the first 512 chars of `instructions`
 * standalone. Also pins the forget ≠ delete first-sentence rule and the annotation contract.
 */

import { describe, expect, test } from 'bun:test';

import {
  MAX_INSTRUCTIONS_CHARS,
  MAX_TOOL_DESCRIPTION_CHARS,
  SERVER_INSTRUCTIONS,
  TOOL_ANNOTATIONS,
  TOOL_DESCRIPTIONS,
  TOOL_TITLES,
} from './descriptions';
import { DEFAULT_TOOLS, FULL11_EXTRA_TOOLS, toolsForProfile } from './schemas';

const ALL_TOOLS = [...DEFAULT_TOOLS, ...FULL11_EXTRA_TOOLS];

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s+/)[0] ?? '').trim();
}

describe('tool descriptions (the maintained artifact)', () => {
  test('every profile tool has a non-empty description and title', () => {
    for (const name of ALL_TOOLS) {
      expect((TOOL_DESCRIPTIONS[name] ?? '').length).toBeGreaterThan(40);
      expect((TOOL_TITLES[name] ?? '').length).toBeGreaterThan(3);
    }
  });

  test(`every description is ≤ ${MAX_TOOL_DESCRIPTION_CHARS} chars (Claude Code truncation point)`, () => {
    for (const name of ALL_TOOLS) {
      const length = (TOOL_DESCRIPTIONS[name] ?? '').length;
      expect(length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
      // Token-efficiency target: descriptions are context tokens — stay well under the cap.
      expect(length).toBeLessThanOrEqual(1200);
    }
  });

  test('the forget ≠ delete difference is the FIRST sentence of both descriptions (ADR-0010 §5)', () => {
    const forgetSentence = firstSentence(TOOL_DESCRIPTIONS.memory_forget);
    const deleteSentence = firstSentence(TOOL_DESCRIPTIONS.memory_delete);
    expect(forgetSentence).toMatch(/soft forget/i);
    expect(forgetSentence).toMatch(/recoverable|tombstone/i);
    expect(deleteSentence).toMatch(/hard delete/i);
    expect(deleteSentence).toMatch(/permanently|unrecoverable/i);
    // Each states the difference (mentions the other operation).
    expect(TOOL_DESCRIPTIONS.memory_forget).toMatch(/memory_delete/);
    expect(TOOL_DESCRIPTIONS.memory_delete).toMatch(/memory_forget/);
  });

  test('memory_store states the never-silent outcome vocabulary', () => {
    expect(TOOL_DESCRIPTIONS.memory_store).toMatch(/new\|"merged"|"superseded"|new \| merged \| superseded/);
    expect(TOOL_DESCRIPTIONS.memory_store).toMatch(/never silent/i);
  });

  test('memory_update states the revision check', () => {
    expect(TOOL_DESCRIPTIONS.memory_update).toMatch(/expected_revision/);
    expect(TOOL_DESCRIPTIONS.memory_update).toMatch(/revision_conflict/);
  });

  test('memory_search states the progressive-disclosure contract (ID-index → memory_get)', () => {
    expect(TOOL_DESCRIPTIONS.memory_search).toMatch(/ID-index/);
    expect(TOOL_DESCRIPTIONS.memory_search).toMatch(/memory_get/);
    expect(TOOL_DESCRIPTIONS.memory_search).toMatch(/max_tokens/);
  });
});

describe('tool annotations (MCP advisory metadata)', () => {
  test('every tool has complete annotations', () => {
    for (const name of ALL_TOOLS) {
      const annotations = TOOL_ANNOTATIONS[name];
      expect(annotations).toBeDefined();
      expect(typeof annotations!.readOnlyHint).toBe('boolean');
      expect(typeof annotations!.destructiveHint).toBe('boolean');
      expect(typeof annotations!.idempotentHint).toBe('boolean');
      expect(typeof annotations!.openWorldHint).toBe('boolean');
    }
  });

  test('memory_delete and memory_forget carry destructiveHint: true (ADR-0010 §5)', () => {
    expect(TOOL_ANNOTATIONS.memory_delete.destructiveHint).toBe(true);
    expect(TOOL_ANNOTATIONS.memory_forget.destructiveHint).toBe(true);
  });

  test('memory_store is idempotent (dedupe); memory_update is not (revision conflicts)', () => {
    expect(TOOL_ANNOTATIONS.memory_store.idempotentHint).toBe(true);
    expect(TOOL_ANNOTATIONS.memory_update.idempotentHint).toBe(false);
  });

  test('read tools are readOnly', () => {
    for (const name of ['memory_search', 'memory_get', 'memory_related', 'memory_project_context'] as const) {
      expect(TOOL_ANNOTATIONS[name].readOnlyHint).toBe(true);
      expect(TOOL_ANNOTATIONS[name].destructiveHint).toBe(false);
    }
  });

  test('no tool claims openWorldHint (onememory is local-first, closed world)', () => {
    for (const name of ALL_TOOLS) {
      expect(TOOL_ANNOTATIONS[name].openWorldHint).toBe(false);
    }
  });
});

describe('server instructions', () => {
  test(`instructions are ≤ ${MAX_INSTRUCTIONS_CHARS} chars (Codex standalone-first-512 budget)`, () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(100);
  });

  test('instructions are self-contained: session-start channel, progressive disclosure, write rules', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_project_context/);
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_search/);
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_store/);
    expect(SERVER_INSTRUCTIONS).toMatch(/forget/);
  });
});

describe('profile completeness (the registry has no holes)', () => {
  test('descriptions, titles, annotations, and schemas exist for every profile tool', async () => {
    const { TOOL_SCHEMAS } = await import('./schemas');
    for (const name of toolsForProfile('full11')) {
      expect(TOOL_DESCRIPTIONS[name]).toBeDefined();
      expect(TOOL_TITLES[name]).toBeDefined();
      expect(TOOL_ANNOTATIONS[name]).toBeDefined();
      expect(TOOL_SCHEMAS[name].input).toBeDefined();
      expect(TOOL_SCHEMAS[name].output).toBeDefined();
    }
  });
});
