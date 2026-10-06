/**
 * The failures surface: the API's kind-filtered, token-budgeted failure list
 * (`GET /v1/projects/:id/failures`, ADR-0010). Pass-through — the rows, tokens and
 * warnings are exactly the API's response.
 */

import type { ApiClient } from '../../api/client';
import type { MemorySearchResponse } from '../../api/schemas';

export interface FailuresViewModel {
  readonly memories: MemorySearchResponse['memories'];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

export interface FailuresOptions {
  /** Free-text override; the API synthesizes the per-kind query when absent. */
  q?: string;
  maxTokens?: number;
  maxMemories?: number;
}

export async function loadFailures(
  api: ApiClient,
  projectId: string,
  options: FailuresOptions = {},
): Promise<FailuresViewModel> {
  const response = await api.failures(projectId, {
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
