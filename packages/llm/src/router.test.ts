/**
 * Router tests: routing-table resolution, fail-closed behaviour (no provider, hosted in `local`
 * profile, non-loopback URL, missing API key), the zero-network guarantee, and the bounded
 * retry/typed-failure contract. Every test uses an injected fake provider — no network, ever.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { ModelProviderError, RouterUnavailableError } from './errors';
import type { ModelProvider, ModelProviderRequest } from './provider';
import { generateStructuredWithRetry, createModelRouter, MAX_STRUCTURED_RETRIES } from './router';
import type { ProviderKind, RouterConfig } from './types';

const OutputSchema = z.object({ answer: z.string(), confidence: z.number() });
type Output = z.infer<typeof OutputSchema>;

interface FakeOptions {
  /** Per-attempt responses: a value, or an error to throw. Last entry repeats. */
  attempts: Array<{ value: Output } | { error: ModelProviderError }>;
  kind?: ProviderKind;
}

function fakeProvider(options: FakeOptions): { provider: ModelProvider; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const provider: ModelProvider = {
    id: 'fake-local',
    kind: options.kind ?? 'openai-compatible',
    model: 'fake-model',
    async generate<T>(request: ModelProviderRequest<T>) {
      prompts.push(request.prompt);
      const index = Math.min(call, options.attempts.length - 1);
      const step = options.attempts[index]!;
      call += 1;
      if ('error' in step) throw step.error;
      return { value: step.value as unknown as T, raw: JSON.stringify(step.value) };
    },
  };
  return { provider, prompts };
}

function routerWith(provider: ModelProvider, overrides: Partial<RouterConfig> = {}) {
  return createModelRouter(
    {
      profile: 'local',
      providers: [{ id: 'fake-local', kind: 'openai-compatible', base_url: 'http://127.0.0.1:9999/v1' }],
      routes: { extract: { provider: 'fake-local', model: 'fake-model' } },
      ...overrides,
    },
    { providerFactory: () => provider },
  );
}

const valid: Output = { answer: 'yes', confidence: 0.9 };

describe('routing table', () => {
  test('resolves a configured operation to provider + model', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }] });
    const router = routerWith(provider);
    const route = router.resolve('extract');
    expect(route.operation).toBe('extract');
    expect(route.provider.id).toBe('fake-local');
    expect(route.model).toBe('fake-model');
    expect(route.hosted).toBe(false);
    expect(router.isConfigured('extract')).toBe(true);
    expect(router.configuredOperations()).toEqual(['extract']);
  });

  test('unresolved operation throws RouterUnavailable (fail closed)', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }] });
    const router = routerWith(provider);
    expect(router.isConfigured('consolidate')).toBe(false);
    expect(() => router.resolve('consolidate')).toThrow(RouterUnavailableError);
    expect(() => router.resolve('consolidate')).toThrow(/no provider route configured/);
  });

  test('route referencing an unknown provider id throws', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }] });
    const router = createModelRouter(
      {
        profile: 'local',
        providers: [],
        routes: { extract: { provider: 'ghost', model: 'm' } },
      },
      { providerFactory: () => provider },
    );
    expect(() => router.resolve('extract')).toThrow(/unknown provider 'ghost'/);
  });

  test('duplicate provider ids are rejected at construction', () => {
    expect(() =>
      createModelRouter({
        profile: 'local',
        providers: [
          { id: 'dup', kind: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1' },
          { id: 'dup', kind: 'openai-compatible', base_url: 'http://127.0.0.1:2/v1' },
        ],
        routes: {},
      }),
    ).toThrow(/duplicate provider id/);
  });
});

describe('local-first fail-closed guarantees', () => {
  test('profile local refuses a hosted provider kind', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }], kind: 'openai' });
    const router = createModelRouter(
      {
        profile: 'local',
        providers: [{ id: 'cloud', kind: 'openai', api_key: 'sk-test' }],
        routes: { extract: { provider: 'cloud', model: 'gpt-4o-mini' } },
      },
      { providerFactory: () => provider },
    );
    expect(router.isConfigured('extract')).toBe(false);
    expect(() => router.resolve('extract')).toThrow(/refuses hosted provider/);
  });

  test('profile local refuses a non-loopback base URL', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }] });
    const router = createModelRouter(
      {
        profile: 'local',
        providers: [{ id: 'lan', kind: 'openai-compatible', base_url: 'http://192.168.1.50:1234/v1' }],
        routes: { extract: { provider: 'lan', model: 'local-model' } },
      },
      { providerFactory: () => provider },
    );
    expect(() => router.resolve('extract')).toThrow(/non-loopback base URL/);
  });

  test('hybrid profile allows a hosted provider but requires an API key', () => {
    const { provider } = fakeProvider({ attempts: [{ value: valid }], kind: 'openai' });
    const missingKey = createModelRouter(
      {
        profile: 'hybrid',
        providers: [{ id: 'cloud', kind: 'openai' }],
        routes: { extract: { provider: 'cloud', model: 'gpt-4o-mini' } },
      },
      { providerFactory: () => provider, env: {} },
    );
    expect(() => missingKey.resolve('extract')).toThrow(/no API key/);

    const withKey = createModelRouter(
      {
        profile: 'hybrid',
        providers: [{ id: 'cloud', kind: 'openai', api_key_env: 'MY_OPENAI_KEY' }],
        routes: { extract: { provider: 'cloud', model: 'gpt-4o-mini' } },
      },
      { providerFactory: () => provider, env: { MY_OPENAI_KEY: 'sk-test' } },
    );
    expect(withKey.isConfigured('extract')).toBe(true);
    expect(withKey.resolve('extract').hosted).toBe(true);
  });

  test('zero network when no provider is configured', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('network access is forbidden in this test');
    }) as unknown as typeof fetch;
    try {
      const router = createModelRouter({ profile: 'local', providers: [], routes: {} });
      expect(router.configuredOperations()).toEqual([]);
      await expect(
        router.generateStructured({ operation: 'extract', schema: OutputSchema, prompt: 'hi' }),
      ).rejects.toThrow(RouterUnavailableError);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('structured generation', () => {
  test('returns the parsed object on the first valid attempt', async () => {
    const { provider, prompts } = fakeProvider({ attempts: [{ value: valid }] });
    const router = routerWith(provider);
    const result = await router.generateStructured({
      operation: 'extract',
      schema: OutputSchema,
      prompt: 'extract memories',
      schemaName: 'ExtractionResult',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(valid);
    expect(result.attempts).toBe(1);
    expect(result.route).toEqual({
      operation: 'extract',
      provider_id: 'fake-local',
      model: 'fake-model',
      hosted: false,
    });
    expect(prompts).toHaveLength(1);
  });

  test('retries on invalid JSON and appends a corrective instruction', async () => {
    const { provider, prompts } = fakeProvider({
      attempts: [
        { error: new ModelProviderError('model returned prose', 'invalid-output', 'fake-local', 'not json') },
        { error: new ModelProviderError('truncated JSON', 'invalid-output', 'fake-local', '{"answer":') },
        { value: valid },
      ],
    });
    const router = routerWith(provider);
    const result = await router.generateStructured({
      operation: 'extract',
      schema: OutputSchema,
      prompt: 'extract memories',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(3);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('could not be used: model returned prose');
    expect(prompts[2]).toContain('ONLY valid JSON');
  });

  test('returns a typed failure when every attempt is schema-invalid', async () => {
    const { provider } = fakeProvider({
      attempts: [{ error: new ModelProviderError('bad shape', 'invalid-output', 'fake-local', '{"nope":1}') }],
    });
    const router = routerWith(provider);
    const result = await router.generateStructured({
      operation: 'extract',
      schema: OutputSchema,
      prompt: 'extract memories',
      maxRetries: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-output');
    expect(result.error.attempts).toBe(2);
    expect(result.error.provider_id).toBe('fake-local');
    expect(result.error.operation).toBe('extract');
    expect(result.error.last_raw).toBe('{"nope":1}');
  });

  test('reports provider errors with their kind', async () => {
    const { provider } = fakeProvider({
      attempts: [{ error: new ModelProviderError('connection refused', 'provider-error', 'fake-local') }],
    });
    const router = routerWith(provider);
    const result = await router.generateStructured({
      operation: 'extract',
      schema: OutputSchema,
      prompt: 'extract memories',
      maxRetries: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-error');
    expect(result.error.attempts).toBe(1);
    expect(result.error.message).toContain('connection refused');
  });

  test('aborts without retrying', async () => {
    const { provider, prompts } = fakeProvider({ attempts: [{ value: valid }] });
    const controller = new AbortController();
    controller.abort();
    const result = await generateStructuredWithRetry(
      provider,
      { operation: 'extract', schema: OutputSchema, prompt: 'x', abortSignal: controller.signal },
      3,
    );
    expect(result.ok).toBe(false);
    expect(prompts).toHaveLength(0);
  });

  test('retry budget is capped', async () => {
    const { provider, prompts } = fakeProvider({
      attempts: [{ error: new ModelProviderError('always bad', 'invalid-output', 'fake-local') }],
    });
    const result = await generateStructuredWithRetry(
      provider,
      { operation: 'extract', schema: OutputSchema, prompt: 'x' },
      999,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.attempts).toBe(MAX_STRUCTURED_RETRIES + 1);
    expect(prompts).toHaveLength(MAX_STRUCTURED_RETRIES + 1);
  });

  test('a generic provider throw is retried and reported as provider-error', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: 'exploding',
      kind: 'openai-compatible',
      model: 'm',
      async generate() {
        calls += 1;
        throw new Error('socket hang up');
      },
    };
    const result = await generateStructuredWithRetry(
      provider,
      { operation: 'extract', schema: OutputSchema, prompt: 'x' },
      1,
    );
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('provider-error');
    expect(result.error.message).toContain('socket hang up');
  });
});
