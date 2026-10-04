/**
 * Decision-enrichment tests (M3b): alternatives considered and rationale captured from natural
 * decision language, plus the negative cases — chatter must never grow a decision payload.
 */

import { describe, expect, test } from 'bun:test';
import { DecisionExtractionSchema } from '@onememory/core';

import { DECISION_PATTERNS, firstMatch } from '../heuristic/patterns';

import {
  decisionContent,
  decisionPayloadFromText,
  enrichDecision,
  parseDecisionPayload,
  splitDecisionRationale,
  MAX_ALTERNATIVES,
} from './decision';

/** Enrich the first decision-language match in `text` (the extractor's own path). */
function enrich(text: string) {
  const match = firstMatch(text, DECISION_PATTERNS);
  if (!match) return undefined;
  const index = text.indexOf(match.match);
  return enrichDecision({ match, text, index: index < 0 ? 0 : index });
}

describe('enrichDecision — alternatives and rationale', () => {
  test('"chose X over Y because Z" yields the chosen option, the alternative and the rationale', () => {
    const payload = enrich('We chose Drizzle over Prisma because Drizzle generates plain SQL migrations.');
    expect(payload).toEqual({
      decision: 'Drizzle',
      alternatives: [{ option: 'Prisma' }],
      rationale: 'Drizzle generates plain SQL migrations',
    });
    expect(decisionContent(payload!)).toBe(
      'Decision: Drizzle over Prisma — because Drizzle generates plain SQL migrations',
    );
  });

  test('the rationale is attributed as why_rejected when it names the rejected option', () => {
    const payload = enrich('We chose Bun over Node because Node is slow at startup.');
    expect(payload?.alternatives).toEqual([{ option: 'Node', why_rejected: 'Node is slow at startup' }]);
    expect(payload?.rationale).toBe('Node is slow at startup');
  });

  test('a rationale stated in the same sentence but after the option is captured', () => {
    const payload = enrich('We settled on Hono for the HTTP layer since it runs on Bun natively.');
    expect(payload).toEqual({
      decision: 'Hono for the HTTP layer',
      alternatives: [],
      rationale: 'it runs on Bun natively',
    });
  });

  test('rejection statements after the decision become alternatives with why_rejected', () => {
    const payload = enrich(
      'We decided to use PGlite for embedded mode. We ruled out SQLite because it has no vector support.',
    );
    expect(payload).toEqual({
      decision: 'use PGlite for embedded mode',
      alternatives: [{ option: 'SQLite', why_rejected: 'it has no vector support' }],
    });
  });

  test('a clause break ends the option and keeps the later clause out of the rationale', () => {
    const payload = enrich(
      'We went with Zod over a hand-rolled validator, and we excluded AJV because it bundles a compiler.',
    );
    expect(payload).toEqual({
      decision: 'Zod',
      alternatives: [{ option: 'a hand-rolled validator' }, { option: 'AJV', why_rejected: 'it bundles a compiler' }],
    });
    expect(decisionContent(payload!)).toBe(
      'Decision: Zod over a hand-rolled validator — also rejected: AJV',
    );
  });

  test('a decision without alternatives or rationale stays a plain statement', () => {
    const payload = enrich('We decided to use PostgreSQL with pgvector as the only database dialect.');
    expect(payload).toEqual({
      decision: 'use PostgreSQL with pgvector as the only database dialect',
      alternatives: [],
    });
    expect(decisionContent(payload!)).toBe(
      'Decision: use PostgreSQL with pgvector as the only database dialect',
    );
  });

  test('the infinitive marker after "decision is"/"decision:" is not part of the option', () => {
    expect(enrich('The decision is to ship embedded mode as experimental.')?.decision).toBe(
      'ship embedded mode as experimental',
    );
    expect(enrich('Decision: to keep the extraction package LLM-free by default.')?.decision).toBe(
      'keep the extraction package LLM-free by default',
    );
  });

  test('pronoun and filler "options" are dropped', () => {
    const payload = enrich('We chose Postgres over it because the team knows it.');
    expect(payload?.alternatives).toEqual([]);
  });

  test('alternatives are bounded and de-duplicated', () => {
    const payload = enrich(
      'We decided to use Drizzle. We ruled out Prisma because of the engine, ruled out Kysely because of the types, ruled out Drizzle because it is the same, ruled out TypeORM because of decorators.',
    );
    expect(payload!.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    const options = payload!.alternatives.map((alternative) => alternative.option.toLowerCase());
    expect(new Set(options).size).toBe(options.length);
    expect(options).not.toContain('drizzle');
  });

  test('every payload is schema-valid and bounded', () => {
    const payload = enrich(`We chose Drizzle over ${'B'.repeat(400)} because ${'c'.repeat(400)}.`);
    expect(() => DecisionExtractionSchema.parse(payload)).not.toThrow();
    expect(payload!.decision.length).toBeLessThanOrEqual(300);
    expect(payload!.alternatives[0]!.option.length).toBeLessThanOrEqual(200);
    expect(payload!.rationale!.length).toBeLessThanOrEqual(300);
  });
});

describe('decisionPayloadFromText — negative cases', () => {
  test('chatter with "because", "ruled out" or "prefer" yields no decision payload', () => {
    expect(decisionPayloadFromText('Thanks, that makes sense because it is simpler.')).toBeUndefined();
    expect(decisionPayloadFromText('We ruled out Docker because the daemon is slow.')).toBeUndefined();
    expect(decisionPayloadFromText('I prefer bun test over jest because it is faster.')).toBeUndefined();
    expect(decisionPayloadFromText('I always forget where I put my keys.')).toBeUndefined();
    expect(decisionPayloadFromText('Should we ship the embedded profile as experimental?')).toBeUndefined();
    expect(decisionPayloadFromText('')).toBeUndefined();
  });

  test('decision noise ("we decided to take a break") never becomes a durable decision', () => {
    expect(decisionPayloadFromText('We decided to take a break because we are tired.')).toBeUndefined();
  });

  test('an explicit decision statement is parsed with the same rules', () => {
    expect(
      decisionPayloadFromText('We decided to keep PGlite as the embedded profile because it needs no daemon.'),
    ).toEqual({
      decision: 'keep PGlite as the embedded profile',
      alternatives: [],
      rationale: 'it needs no daemon',
    });
  });
});

describe('splitDecisionRationale', () => {
  test('splits on the documented connectives and stops the option at a clause break', () => {
    expect(splitDecisionRationale('Bun because it is faster')).toEqual({
      option: 'Bun',
      rationale: 'it is faster',
    });
    expect(splitDecisionRationale('Bun due to startup time')).toEqual({
      option: 'Bun',
      rationale: 'startup time',
    });
    expect(splitDecisionRationale('a validator, and we excluded AJV because it compiles')).toEqual({
      option: 'a validator',
    });
    expect(splitDecisionRationale('Node')).toEqual({ option: 'Node' });
  });
});

describe('parseDecisionPayload — the tolerant LLM boundary', () => {
  test('salvages a usable payload from loosely shaped model output', () => {
    expect(
      parseDecisionPayload({
        decision: '  Use PGlite for embedded mode. ',
        alternatives: [{ option: 'SQLite', why_rejected: null }, { option: 'it' }, null, 'nope'],
        rationale: null,
      }),
    ).toEqual({
      decision: 'Use PGlite for embedded mode',
      alternatives: [{ option: 'SQLite' }],
    });
  });

  test('drops garbage instead of emitting an invalid candidate', () => {
    expect(parseDecisionPayload(undefined)).toBeUndefined();
    expect(parseDecisionPayload(null)).toBeUndefined();
    expect(parseDecisionPayload('Use PGlite')).toBeUndefined();
    expect(parseDecisionPayload({ decision: '' })).toBeUndefined();
    expect(parseDecisionPayload({ decision: 42 })).toBeUndefined();
  });

  test('caps over-long model output to the canonical bounds', () => {
    const payload = parseDecisionPayload({
      decision: 'd'.repeat(400),
      alternatives: [{ option: 'o'.repeat(400), why_rejected: 'w'.repeat(400) }],
      rationale: 'r'.repeat(400),
    });
    expect(() => DecisionExtractionSchema.parse(payload)).not.toThrow();
    expect(payload!.decision.length).toBeLessThanOrEqual(300);
    expect(payload!.rationale!.length).toBeLessThanOrEqual(300);
  });
});
