import { expect, test } from 'bun:test';
import { type ExtractedMemory, type FailurePayload } from '@onememory/core';
import { buildEvidence, normalizeEvent } from '../events';
import { createHeuristicExtractor } from '../heuristic/extractor';
import { goldenSession, makeInput, testFailureSession, toolFailureSession } from '../testing/transcripts';
import { storePayloadFor } from './store-payload';
import { failureSignatureForEvents } from './failure';

test('golden failure stores cited command output without inventing a cause', async () => {
  const inputs = goldenSession();
  const candidate = (await createHeuristicExtractor().extract(inputs)).memories
    .find((memory) => memory.type === 'failure')!;
  const payload = storePayloadFor(candidate, inputs.map(normalizeEvent), inputs[0]!.event.occurred_at) as FailurePayload;
  expect(payload.status).toBe('verified');
  expect(payload.solution).toBe('Successful retry: bun test');
  expect(payload.verification).toBe('Command bun test exited 0: 87 pass, 0 fail (1.4s)');
  expect(payload.root_cause).toBeUndefined();
  expect(payload.signature_hash).toBe(candidate.failure_signature!.hash);
  expect(payload.first_seen_at).toBe('2026-10-03T09:00:36.000Z');
  expect(payload.last_seen_at).toBe(payload.first_seen_at);
});

test('test proof is verified; tool-name-only recovery is mitigation, not a verified fix', async () => {
  for (const [inputs, status, proof] of [
    [testFailureSession(), 'verified', 'bun: 5 passed, 0 failed'],
    [toolFailureSession(), 'mitigated', 'Tool Edit reported ok: true: edited src/store.ts'],
  ] as const) {
    const candidate = (await createHeuristicExtractor().extract(inputs)).memories
      .find((memory) => memory.type === 'failure')!;
    const payload = storePayloadFor(candidate, inputs.map(normalizeEvent), inputs[0]!.event.occurred_at) as FailurePayload;
    expect(payload.status).toBe(status);
    expect(payload.verification).toBe(proof);
    expect(payload.occurrence_count).toBe(1);
  }
});

test('a successful command is not recovery when it is only part of the command in the error context', () => {
  const failure = makeInput(
    'error.raised',
    {
      kind: 'error.raised',
      origin: 'build',
      message: 'Cannot find module "./schema"',
      context: 'bun test --filter saves in packages/storage',
    },
  );
  const success = makeInput(
    'terminal.output',
    { kind: 'terminal.output', command: 'bun test', exit_code: 0, output_digest: '87 pass' },
    { offsetSeconds: 10 },
  );
  const normalized = [failure, success].map(normalizeEvent);
  const candidate: ExtractedMemory = {
    type: 'failure',
    content: 'Missing module was not fixed by the unrelated full suite',
    importance: 0.8,
    confidence: 0.8,
    entities: [],
    evidence: [
      buildEvidence(failure.event, failure.source.id, 'failure'),
      buildEvidence(success.event, success.source.id, 'success'),
    ],
    failure_signature: failureSignatureForEvents(normalized),
  };

  const payload = storePayloadFor(candidate, normalized, failure.event.occurred_at) as FailurePayload;
  expect(payload.status).toBe('open');
  expect(payload.solution).toBeUndefined();
  expect(payload.verification).toBeUndefined();
});

test('uncited success, different command arguments, or prose claiming fixed never prove resolution', () => {
  const failure = makeInput('terminal.output', {
    kind: 'terminal.output', command: 'bun test --filter saves', exit_code: 1, output_digest: 'Cannot find module x',
  });
  const success = makeInput('terminal.output', {
    kind: 'terminal.output', command: 'bun test --filter reads', exit_code: 0, output_digest: '1 pass',
  }, { offsetSeconds: 10 });
  const normalized = [failure, success].map(normalizeEvent);
  const candidate: ExtractedMemory = {
    type: 'failure', content: 'Fixed completely by installing a module', importance: 0.8,
    confidence: 0.8, entities: [], evidence: [buildEvidence(failure.event, failure.source.id, 'fixed')],
    failure_signature: failureSignatureForEvents(normalized),
  };
  for (const evidence of [
    candidate.evidence,
    [...candidate.evidence, buildEvidence(success.event, success.source.id, 'proof')],
  ]) {
    const payload = storePayloadFor({ ...candidate, evidence }, normalized, failure.event.occurred_at) as FailurePayload;
    expect(payload.status).toBe('open');
    expect(payload.solution).toBeUndefined();
    expect(payload.verification).toBeUndefined();
    expect(payload.root_cause).toBeUndefined();
  }
  expect(storePayloadFor({
    ...candidate, failure_signature: { ...candidate.failure_signature!, hash: 'not-the-event-hash' },
  }, normalized, failure.event.occurred_at)).toBeUndefined();
});
