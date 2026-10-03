/**
 * Router config schema tests — the fragment `packages/config` (M16) will validate inside
 * `onememory.config.yaml`.
 */

import { describe, expect, test } from 'bun:test';

import { parseRouterConfig, RouterConfigSchema } from './config';
import { isLoopbackBaseUrl, MODEL_OPERATIONS, PROVIDER_KINDS, ROUTER_PROFILES } from './types';

describe('router config schema', () => {
  test('accepts a minimal local config', () => {
    const parsed = parseRouterConfig({
      providers: [{ id: 'ollama', kind: 'ollama' }],
      routes: { extract: { provider: 'ollama', model: 'llama3.1:8b' } },
    });
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.routes.extract?.model).toBe('llama3.1:8b');
  });

  test('accepts the full routing table', () => {
    const routes = Object.fromEntries(
      MODEL_OPERATIONS.map((operation) => [operation, { provider: 'local', model: 'm' }]),
    );
    const parsed = parseRouterConfig({
      profile: 'hybrid',
      providers: [{ id: 'local', kind: 'openai-compatible', base_url: 'http://127.0.0.1:1234/v1' }],
      routes,
      defaults: { temperature: 0.2, max_retries: 3, max_output_tokens: 2048, timeout_ms: 30_000 },
    });
    expect(Object.keys(parsed.routes)).toHaveLength(MODEL_OPERATIONS.length);
    expect(parsed.defaults?.max_retries).toBe(3);
  });

  test('rejects an unknown provider kind, an unknown operation, and out-of-range retries', () => {
    expect(
      RouterConfigSchema.safeParse({
        providers: [{ id: 'x', kind: 'not-a-provider' }],
        routes: {},
      }).success,
    ).toBe(false);

    expect(
      RouterConfigSchema.safeParse({
        providers: [],
        routes: { nope: { provider: 'x', model: 'm' } },
      }).success,
    ).toBe(false);

    expect(
      RouterConfigSchema.safeParse({
        providers: [],
        routes: {},
        defaults: { max_retries: 99 },
      }).success,
    ).toBe(false);
  });

  test('rejects a route without a model', () => {
    expect(
      RouterConfigSchema.safeParse({
        providers: [],
        routes: { extract: { provider: 'x' } },
      }).success,
    ).toBe(false);
  });

  test('vocabulary constants are complete', () => {
    expect(MODEL_OPERATIONS).toContain('embedding');
    expect(MODEL_OPERATIONS).toContain('conflict');
    expect(PROVIDER_KINDS).toContain('ollama');
    expect(ROUTER_PROFILES).toEqual(['local', 'hybrid', 'server']);
  });
});

describe('loopback detection', () => {
  test('accepts loopback hosts and rejects everything else', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://127.1.2.3:8080/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:1234/v1')).toBe(true);
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false);
    expect(isLoopbackBaseUrl('http://192.168.1.10:1234/v1')).toBe(false);
    expect(isLoopbackBaseUrl('http://0.0.0.0:1234/v1')).toBe(false);
    expect(isLoopbackBaseUrl('not a url')).toBe(false);
  });
});
