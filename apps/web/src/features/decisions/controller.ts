/**
 * The decisions surface: the API's kind-filtered, token-budgeted decision list
 * (`GET /v1/projects/:id/decisions`, ADR-0010). Pass-through — the rows, tokens and
 * warnings are exactly the API's response.
 */

import type { ApiClient } from '../../api/client';
import type { MemorySearchResponse } from '../../api/schemas';

export interface DecisionsViewModel {
  readonly memories: MemorySearchResponse['memories'];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

export interface DecisionsOptions {
  /** Free-text override; the API synthesizes the per-kind query when absent. */
  q?: string;
  maxTokens?: number;
  maxMemories?: number;
}

export async function loadDecisions(
  api: ApiClient,
  projectId: string,
  options: DecisionsOptions = {},
): Promise<DecisionsViewModel> {
  const response = await api.decisions(projectId, {
    ...(options.q === undefined || options.q === '' ? {} : { q: options.q }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.maxMemories === undefined ? {} : { max_memories: options.maxMemories }),
  });
  return {
    memories: response.memories,
    tokens: response.tokens,
    warnings: response.warnings,
  };
}
