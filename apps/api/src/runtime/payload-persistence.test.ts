/** M3d acceptance: actual INGEST → EXTRACT → STORE → read, without a hosted model. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRecordSchema, type Extractor, type FailurePayload } from '@onememory-ai/core';
import { createModelRouter, type ModelProvider } from '@onememory-ai/llm';
import { createEmbeddedDb } from '@onememory-ai/storage';
import {
  createExtractHandler, createHeuristicClassifier, createHeuristicExtractor, createLlmExtractor,
} from '@onememory-ai/extraction';
import {
  decisionSession, testFailureSession, FIXTURE_PROJECT_ID,
} from '../../../../packages/extraction/src/testing/transcripts';

function llmExtractor(): Extractor {
  const output = {
    memories: [
      {
        type: 'decision', content: 'Use Drizzle instead of Prisma', importance: 0.8, confidence: 0.8,
        entities: [], event_indexes: [0], future_value_rationale: 'settled database choice',
        decision_payload: {
          decision: 'Drizzle', alternatives: [
            { option: 'Prisma' }, { option: 'Kysely', why_rejected: 'the team already knows Drizzle' },
          ], rationale: 'Drizzle generates plain SQL migrations',
        },
      },
      {
        type: 'failure', content: 'Tests recovered', importance: 0.8, confidence: 0.8,
        entities: [], event_indexes: [1, 2], future_value_rationale: 'reusable test recovery',
      },
    ],
    working: [],
  };
  const provider: ModelProvider = {
    id: 'fixture', kind: 'openai-compatible', model: 'fixture',
    async generate(request) {
      return { value: request.schema.parse(output), raw: JSON.stringify(output) };
    },
  };
  return createLlmExtractor({
    router: createModelRouter({
      profile: 'local',
      providers: [{ id: 'fixture', kind: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1' }],
      routes: { extract: { provider: 'fixture', model: 'fixture' } },
    }, { providerFactory: () => provider }),
  });
}

for (const method of ['heuristic', 'llm'] as const) {
  test(`${method}: alternatives, rationale and evidence-backed failure payload survive durable storage`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'onemem-m3d-'));
    let storage: Awaited<ReturnType<typeof createEmbeddedDb>> | undefined;
    try {
      storage = await createEmbeddedDb(dir);
      await storage.store.createProject({ id: FIXTURE_PROJECT_ID, name: 'payload-fixture' });
      const inputs = [...decisionSession(), ...testFailureSession().map((input, index) => ({
        ...input, event: { ...input.event, occurred_at: `2026-10-03T09:00:${index === 0 ? '05' : '15'}.000Z` },
      }))];
      for (const input of inputs) expect((await storage.store.ingestEvent(input.event)).status).toBe('stored');
      const handler = createExtractHandler(storage.store, storage.jobs,
        method === 'heuristic' ? createHeuristicExtractor() : llmExtractor(),
        createHeuristicClassifier(), { enqueueReEmbed: false });
      const result = await handler({ id: 'payload-fixture', kind: 'extract', payload: {} });
      expect(result.memories_inserted).toBe(2);
      const memories = await storage.store.queryCurrent({ project_id: FIXTURE_PROJECT_ID });
      const decision = memories.find((memory) => memory.type === 'decision')!;
      expect(decision.payload?.decision).toBe('Drizzle');
      expect(decision.payload?.alternatives).toEqual([
        { option: 'Prisma' }, { option: 'Kysely', why_rejected: 'the team already knows Drizzle' },
      ]);
      expect(decision.payload?.rationale).toBe('Drizzle generates plain SQL migrations');
      expect(decision.payload?.participants).toEqual([]);
      expect(decision.payload?.status).toBe('proposed');
      expect(decision.status).toBe('active');
      expect(decision.payload?.evidence).toEqual(decision.provenance.evidence);
      const failure = memories.find((memory) => memory.type === 'failure')!;
      const payload = failure.payload as FailurePayload;
      // Stored exactly as the engine computed it from the cited events — both extractor paths.
      expect(payload.signature_hash).toBe('74062a795a33e048');
      expect(JSON.parse(payload.context)).toEqual({
        type: 'TEST_FAILURE', normalized_message: 'bun: saves rows | reads rows', origin: 'test', tool: 'bun',
      });
      expect(payload.solution).toBe('Successful bun test rerun');
      expect(payload.verification).toBe('bun: 5 passed, 0 failed');
      expect(payload.root_cause).toBeUndefined();
      expect(payload.status).toBe('verified');
      expect(payload.first_seen_at).toBe('2026-10-03T09:00:05.000Z');
      expect(payload.last_seen_at).toBe(payload.first_seen_at);
      expect(payload.occurrence_count).toBe(1);
      for (const memory of memories) {
        expect(MemoryRecordSchema.safeParse(memory).success).toBe(true);
        expect((await storage.store.getMemory(memory.id))?.payload).toEqual(memory.payload);
        expect((await storage.store.historyOf(memory.id))[0]?.payload).toEqual(memory.payload);
      }
      expect((await storage.store.queryAsOf('2026-10-03T09:01:00.000Z', {
        project_id: FIXTURE_PROJECT_ID,
      })).find((memory) => memory.id === failure.id)?.payload).toEqual(payload);
      expect((await handler({ id: 'retry', kind: 'extract', payload: {} })).memories_inserted).toBe(0);
    } finally {
      await storage?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
