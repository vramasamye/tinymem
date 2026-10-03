/**
 * Zod validation for the router config fragment. `packages/config` (M16) will validate the whole
 * `onememory.config.yaml`; this schema is the normative shape for the `llm:` section and is what
 * the router itself parses, so a hand-built config object is validated at the same boundary.
 */

import { z } from 'zod';

import { MODEL_OPERATIONS, PROVIDER_KINDS, ROUTER_PROFILES } from './types';

export const ProviderConfigSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(PROVIDER_KINDS),
  base_url: z.string().min(1).optional(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const RouteConfigSchema = z.looseObject({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const RouterDefaultsSchema = z.looseObject({
  temperature: z.number().min(0).max(2).optional(),
  max_retries: z.number().int().min(0).max(5).optional(),
  max_output_tokens: z.number().int().min(1).optional(),
  timeout_ms: z.number().int().min(1).optional(),
});

const routesShape = Object.fromEntries(
  MODEL_OPERATIONS.map((operation) => [operation, RouteConfigSchema.optional()]),
) as { [K in (typeof MODEL_OPERATIONS)[number]]: z.ZodOptional<typeof RouteConfigSchema> };

export const RouterConfigSchema = z.looseObject({
  profile: z.enum(ROUTER_PROFILES).optional(),
  providers: z.array(ProviderConfigSchema),
  /**
   * Strict: an unknown operation key is a typo in a routing table, not forward compatibility —
   * fail loudly rather than silently serving an operation from no provider.
   */
  routes: z.strictObject(routesShape),
  defaults: RouterDefaultsSchema.optional(),
});

export function parseRouterConfig(input: unknown): z.infer<typeof RouterConfigSchema> {
  return RouterConfigSchema.parse(input);
}
