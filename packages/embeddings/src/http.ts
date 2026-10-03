/**
 * Minimal JSON-over-HTTP helper shared by the network embedders. Deliberately tiny: the router
 * owns LLM traffic; embeddings are two well-known endpoints (`/api/embed`, `/embeddings`), so a
 * dependency-free `fetch` wrapper is the honest amount of machinery (ADR-0006 §2, §6).
 */

import { EmbedderError, type EmbedderProviderId } from './types';

export interface PostJsonOptions {
  provider: EmbedderProviderId;
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const { provider, url, body, headers, timeoutMs, fetchImpl } = options;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EmbedderError(
      `embedding provider '${provider}' could not reach ${url}: ${message}`,
      provider,
      'transport',
      { cause: error },
    );
  }

  if (!response.ok) {
    const text = await safeText(response);
    throw new EmbedderError(
      `embedding provider '${provider}' returned HTTP ${response.status} from ${url}${text ? `: ${text}` : ''}`,
      provider,
      'protocol',
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new EmbedderError(
      `embedding provider '${provider}' returned a non-JSON body from ${url}`,
      provider,
      'protocol',
      { cause: error },
    );
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '';
  }
}
