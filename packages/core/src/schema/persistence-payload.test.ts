import { expect, test } from 'bun:test';
import { DecisionPayloadSchema, FailurePayloadSchema } from './memory';
import { NewMemorySchema, SupersedeInputSchema } from './persistence';

const time = '2026-10-03T09:00:00.000Z';
const source = '01900000-0000-7000-8000-0000000000aa';
const memory = {
  type: 'decision', content: 'Use Drizzle', importance: 0.8, confidence: 0.8,
  observed_at: time, source_id: source,
  evidence: [{ source_id: source, kind: 'event', locator: 'event:x', excerpt: 'Use Drizzle' }],
  extraction: { method: 'heuristic', prompt_version: 'test' },
};
const decision = {
  title: 'Drizzle', decision: 'Drizzle', alternatives: [{ option: 'Prisma' }],
  participants: [], decided_at: time, status: 'proposed',
};
const failure = {
  problem: 'Module missing', context: 'bun test', status: 'open', signature_hash: 'exact-hash',
  first_seen_at: time, last_seen_at: time, occurrence_count: 1,
};

test('STORE accepts matching payloads and legacy callers without payloads', () => {
  expect(NewMemorySchema.safeParse({ ...memory, payload: decision }).success).toBe(true);
  expect(NewMemorySchema.safeParse({ ...memory, type: 'failure', payload: failure }).success).toBe(true);
  for (const type of ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference']) {
    expect(NewMemorySchema.safeParse({ ...memory, type }).success).toBe(true);
  }
});

test('STORE and supersede reject mismatched or malformed payloads', () => {
  for (const input of [
    { ...memory, payload: failure },
    { ...memory, type: 'failure', payload: decision },
    { ...memory, type: 'semantic', payload: decision },
    { ...memory, payload: { ...decision, alternatives: 'Prisma' } },
    { ...memory, type: 'failure', payload: { ...failure, signature_hash: undefined } },
    { ...memory, type: 'failure', payload: { ...failure, occurrence_count: 0 } },
  ]) {
    expect(NewMemorySchema.safeParse(input).success).toBe(false);
    expect(SupersedeInputSchema.safeParse({
      winner: input, loser_id: source, actor: 'system',
    }).success).toBe(false);
  }
});

test('wire payloads represent unknown rationale and legacy absent hash honestly', () => {
  expect(DecisionPayloadSchema.safeParse({ ...decision, evidence: memory.evidence }).success).toBe(true);
  expect(FailurePayloadSchema.safeParse({ ...failure, signature_hash: undefined }).success).toBe(true);
  expect(FailurePayloadSchema.parse(failure).signature_hash).toBe('exact-hash');
});
