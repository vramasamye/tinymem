/**
 * Model-router vocabulary (ADR-0006 §1): the operation classes the routing table is keyed by,
 * the provider kinds the router can load, and the deployment profiles that gate network access.
 */

/** The per-operation routing table keys (ADR-0006 §1). */
export const MODEL_OPERATIONS = [
  'embedding',
  'classify',
  'extract',
  'consolidate',
  'conflict',
  'summarize',
] as const;
export type ModelOperation = (typeof MODEL_OPERATIONS)[number];

/**
 * Provider kinds the AI SDK implementation can load.
 *
 * `ollama` is not a first-party AI SDK provider: it is routed through the OpenAI-compatible
 * provider against Ollama's `/v1` surface (ADR-0006 §2). Embeddings never go through that surface
 * — Ollama embeddings use the native `/api/embed` in `@onememory/embeddings`.
 */
export const PROVIDER_KINDS = [
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
  'ollama',
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Alias kept for call sites that read "provider kind" from the router's perspective. */
export type ModelProviderKind = ProviderKind;

/** Deployment profiles. `local` is the default and the local-first invariant's enforcement point. */
export const ROUTER_PROFILES = ['local', 'hybrid', 'server'] as const;
export type RouterProfile = (typeof ROUTER_PROFILES)[number];

/** Hosted provider kinds transmit prompts outside the machine — opt-in only. */
export function isHostedProviderKind(kind: ProviderKind): boolean {
  return kind === 'openai' || kind === 'anthropic' || kind === 'google';
}

/** Loopback-only check for `local`-profile base URLs (localhost / 127.0.0.0-8 / ::1 / [::1]). */
export function isLoopbackBaseUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host === '0.0.0.0') return false;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** One configured provider instance (id is what routes reference). */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Default base URL when the kind has one (LM Studio, llama.cpp, vLLM, Ollama /v1). */
  base_url?: string;
  /** Prefer `api_key_env`; `api_key` exists for local endpoints that demand a dummy key. */
  api_key?: string;
  api_key_env?: string;
  headers?: Record<string, string>;
}

/** A routing-table row: which provider instance + model serves an operation. */
export interface RouteConfig {
  provider: string;
  model: string;
}

export interface RouterDefaults {
  temperature?: number;
  /** Bounded retries on invalid structured output (default 2; hard cap 5). */
  max_retries?: number;
  max_output_tokens?: number;
  /** Per-attempt timeout in milliseconds (default 120000). */
  timeout_ms?: number;
}

export interface RouterConfig {
  profile?: RouterProfile;
  providers: ProviderConfig[];
  routes: Partial<Record<ModelOperation, RouteConfig>>;
  defaults?: RouterDefaults;
}

/** A resolved routing-table row (what the router hands to the provider layer). */
export interface ResolvedRoute {
  operation: ModelOperation;
  provider: ProviderConfig;
  model: string;
  /** True when the provider kind is hosted (profile `local` never resolves one). */
  hosted: boolean;
}
