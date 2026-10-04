/**
 * LLM extractor tests with an injected fake ModelProvider (no network, no model). The fake
 * validates its raw response with the router-supplied schema exactly like the AI SDK provider
 * does, so these tests exercise the real retry/validation contract.
 */

import { describe, expect, test } from 'bun:test';
import {
  ModelProviderError,
  createModelRouter,
  type ModelProvider,
  type ModelProviderRequest,
} from '@onememory/llm';
import type { ExtractionInput, FailureSignature } from '@onememory/core';

import { createFallbackExtractor } from '../fallback';
import { failureSignatureHash } from '../enrichment/failure';
import { createHeuristicExtractor } from '../heuristic/extractor';
import { ExtractionOutputError, ExtractionUnavailableError } from '../types';
import { makeInput } from '../testing/transcripts';

import { createLlmExtractor } from './extractor';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompt';

type FakeStep = { raw: unknown } | { error: Error };

function fakeRouter(steps: FakeStep[], options: { configured?: boolean } = {}) {
  const prompts: string[] = [];
  let calls = 0;
  const provider: ModelProvider = {
    id: 'fake',
    kind: 'openai-compatible',
    model: 'fake-model',
    async generate<T>(request: ModelProviderRequest<T>) {
      prompts.push(request.prompt);
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      if ('error' in step) throw step.error;
      const parsed = request.schema.safeParse(step.raw);
      if (!parsed.success) {
        throw new ModelProviderError(
          `model output failed schema validation: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
          'invalid-output',
          'fake',
          JSON.stringify(step.raw),
        );
      }
      return { value: parsed.data as T, raw: JSON.stringify(step.raw) };
    },
  };
  const router = createModelRouter(
    {
      profile: 'local',
      providers: [
        { id: 'fake', kind: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1' },
      ],
      routes: options.configured === false ? {} : { extract: { provider: 'fake', model: 'fake-model' } },
    },
    { providerFactory: () => provider },
  );
  return { router, prompts, provider };
}

function session(): ExtractionInput[] {
  return [
    makeInput('conversation.message', {
      kind: 'conversation.message',
      role: 'user',
      content: 'We decided to use PostgreSQL over SQLite for the storage layer.',
    }),
    makeInput('terminal.output', {
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 1,
      output_digest: 'error: cannot find module',
    }),
  ];
}

const validOutput = {
  memories: [
    {
      type: 'decision',
      content: 'Use PostgreSQL instead of SQLite for the storage layer.',
      importance: 0.8,
      confidence: 0.85,
      entities: ['PostgreSQL', 'SQLite'],
      event_indexes: [0],
      future_value_rationale: 'settled storage choice',
    },
  ],
  working: [{ kind: 'current_error', content: 'bun test is failing', event_indexes: [1] }],
};

describe('createLlmExtractor', () => {
  test('binds model output to real events and records LLM provenance', async () => {
    const { router } = fakeRouter([{ raw: validOutput }]);
    const extractor = createLlmExtractor({ router });
    const inputs = session();
    const result = await extractor.extract(inputs);

    expect(result.extraction_meta).toEqual({
      method: 'llm',
      model: 'fake/fake-model',
      prompt_version: EXTRACTION_PROMPT_VERSION,
    });
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.type).toBe('decision');
    expect(result.memories[0]!.evidence).toHaveLength(1);
    expect(result.memories[0]!.evidence[0]!.source_id).toBe(inputs[0]!.source.id);
    expect(result.memories[0]!.evidence[0]!.locator).toBe(`event:${inputs[0]!.event.id}`);
    expect(extractor.lastModel).toBe('fake/fake-model');
    expect(result.working).toEqual([
      { kind: 'current_error', content: 'bun test is failing', session_id: 'sess-m3-golden' },
    ]);
  });

  test('retries invalid JSON with a corrective instruction appended', async () => {
    const { router, prompts } = fakeRouter([
      { raw: { memories: 'not-an-array' } },
      { raw: validOutput },
    ]);
    const extractor = createLlmExtractor({ router });
    const result = await extractor.extract(session());
    expect(result.memories).toHaveLength(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('could not be used');
    expect(prompts[1]).toContain('ONLY valid JSON');
  });

  test('rejects `semantic` from the model (schema failure → retry → bounded failure)', async () => {
    const { router } = fakeRouter([
      { raw: { memories: [{ ...validOutput.memories[0], type: 'semantic' }], working: [] } },
    ]);
    const extractor = createLlmExtractor({ router, maxRetries: 1 });
    try {
      await extractor.extract(session());
      throw new Error('expected the extractor to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionOutputError);
      const outputError = error as ExtractionOutputError;
      expect(outputError.attempts).toBe(2);
      expect(outputError.providerId).toBe('fake');
      expect(outputError.message).toContain('semantic');
    }
  });

  test('raises ExtractionOutputError when the provider never produces valid output', async () => {
    const { router } = fakeRouter([{ raw: { nope: true } }]);
    const extractor = createLlmExtractor({ router });
    await expect(extractor.extract(session())).rejects.toThrow(ExtractionOutputError);
  });

  test('drops candidates whose event indexes do not resolve (provenance is mandatory)', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [{ ...validOutput.memories[0], event_indexes: [42] }],
          working: [{ kind: 'current_error', content: 'orphan', event_indexes: [42] }],
        },
      },
    ]);
    const extractor = createLlmExtractor({ router });
    const result = await extractor.extract(session());
    expect(result.memories).toEqual([]);
    expect(result.working).toEqual([]);
  });

  test('applies the future-value gate to model output', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            { ...validOutput.memories[0], importance: 0.05 },
            { ...validOutput.memories[0], content: 'Keep this one because it matters.', importance: 0.9 },
          ],
          working: [],
        },
      },
    ]);
    const extractor = createLlmExtractor({ router });
    const result = await extractor.extract(session());
    expect(result.memories.map((memory) => memory.content)).toEqual([
      'Keep this one because it matters.',
    ]);
  });

  test('an unconfigured router raises ExtractionUnavailableError (the caller degrades)', async () => {
    const { router } = fakeRouter([{ raw: validOutput }], { configured: false });
    const extractor = createLlmExtractor({ router });
    await expect(extractor.extract(session())).rejects.toThrow(ExtractionUnavailableError);
  });

  test('createFallbackExtractor degrades to heuristics and reports the fallback', async () => {
    const { router } = fakeRouter([{ error: new Error('socket hang up') }]);
    const llm = createLlmExtractor({ router });
    const failures: unknown[] = [];
    const extractor = createFallbackExtractor(llm, createHeuristicExtractor(), {
      onFallback: (error) => failures.push(error),
    });
    const result = await extractor.extract(session());
    expect(failures).toHaveLength(1);
    expect(result.extraction_meta.method).toBe('heuristic');
    expect(result.memories.some((memory) => memory.type === 'decision')).toBe(true);
  });

  test('createFallbackExtractor can be configured to surface the primary failure', async () => {
    const { router } = fakeRouter([{ error: new Error('socket hang up') }]);
    const extractor = createFallbackExtractor(
      createLlmExtractor({ router }),
      createHeuristicExtractor(),
      { degrade: false },
    );
    await expect(extractor.extract(session())).rejects.toThrow('socket hang up');
  });

  test('the prompt is bounded and numbered', () => {
    const inputs = session();
    const { prompt, included } = buildExtractionPrompt(
      inputs.map((input) => ({
        event_id: input.event.id,
        kind: input.event.kind,
        occurred_at: input.event.occurred_at,
        ingested_at: input.event.ingested_at,
        source_id: input.source.id,
        text: 'digest',
      })),
    );
    expect(included).toHaveLength(2);
    expect(prompt).toContain('[0] (conversation.message');
    expect(prompt).toContain('[1] (terminal.output');
  });
});

describe('createLlmExtractor — M3b enrichment', () => {
  test('a decision payload from the model is normalized and attached to the decision', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            {
              ...validOutput.memories[0],
              decision_payload: {
                decision: '  PostgreSQL over SQLite ',
                alternatives: [{ option: 'SQLite', why_rejected: null }, { option: 'it' }],
                rationale: 'pgvector support',
              },
            },
          ],
          working: [],
        },
      },
    ]);
    const result = await createLlmExtractor({ router }).extract(session());
    expect(result.memories[0]!.decision_payload).toEqual({
      decision: 'PostgreSQL over SQLite',
      alternatives: [{ option: 'SQLite' }],
      rationale: 'pgvector support',
    });
  });

  test('a decision payload on a non-decision candidate is dropped, never attached', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            {
              ...validOutput.memories[0],
              type: 'episodic',
              decision_payload: { decision: 'PostgreSQL', alternatives: [], rationale: null },
            },
          ],
          working: [],
        },
      },
    ]);
    const result = await createLlmExtractor({ router }).extract(session());
    expect(result.memories[0]!.decision_payload).toBeUndefined();
  });

  test('the failure signature is computed from the cited events, never asked of the model', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            {
              type: 'failure',
              content: '`bun test` fails on a missing module; the import path was fixed.',
              importance: 0.75,
              confidence: 0.7,
              entities: ['Bun'],
              event_indexes: [1],
              future_value_rationale: 'the fix is reusable',
            },
          ],
          working: [],
        },
      },
    ]);
    const result = await createLlmExtractor({ router }).extract(session());
    expect(result.memories[0]!.failure_signature).toEqual({
      type: 'MODULE_NOT_FOUND',
      hash: failureSignatureHash('MODULE_NOT_FOUND', '$ bun test → exit <n> error: cannot find module'),
      normalized_message: '$ bun test → exit <n> error: cannot find module',
      origin: 'command',
      tool: 'bun',
      command: 'bun test',
    });
  });

  test('a tool-result failure is fingerprinted from the cited events, identical to the heuristic path', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            {
              type: 'failure',
              content: 'The Edit tool failed; a later Edit succeeded.',
              importance: 0.75,
              confidence: 0.7,
              entities: ['Edit'],
              event_indexes: [0],
              future_value_rationale: 'the fix is reusable',
            },
          ],
          working: [],
        },
      },
    ]);
    const inputs: ExtractionInput[] = [
      makeInput('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'c1',
        ok: false,
        tool: 'Edit',
        output_digest: 'string to replace not found in file',
        error: { message: 'String to replace not found in file src/store.ts' },
      }),
      makeInput('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'c2',
        ok: true,
        tool: 'Edit',
        output_digest: 'edited',
      }, { offsetSeconds: 10 }),
    ];
    const llm = await createLlmExtractor({ router }).extract(inputs);
    const heuristic = await createHeuristicExtractor().extract(inputs);
    const expected: FailureSignature = {
      type: 'TOOL_ERROR',
      hash: failureSignatureHash('TOOL_ERROR', 'string to replace not found in file <path>'),
      normalized_message: 'string to replace not found in file <path>',
      origin: 'tool',
      tool: 'Edit',
    };
    expect(llm.memories[0]!.failure_signature).toEqual(expected);
    expect(
      heuristic.memories.find((memory) => memory.type === 'failure')!.failure_signature,
    ).toEqual(expected);
  });

  test('a failure candidate citing no failure event carries no signature (no invented provenance)', async () => {
    const { router } = fakeRouter([
      {
        raw: {
          memories: [
            {
              type: 'failure',
              content: 'The storage layer used to be flaky before the rewrite.',
              importance: 0.75,
              confidence: 0.7,
              entities: [],
              event_indexes: [0],
              future_value_rationale: 'explains the rewrite',
            },
          ],
          working: [],
        },
      },
    ]);
    const result = await createLlmExtractor({ router }).extract(session());
    expect(result.memories[0]!.failure_signature).toBeUndefined();
  });

  test('the prompt asks for a decision payload and forbids inventing signatures', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('decision_payload');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Never invent an alternative');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('Do NOT emit a failure signature or hash');
  });
});
