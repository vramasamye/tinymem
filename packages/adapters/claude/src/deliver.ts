/**
 * Event delivery over the daemon's public REST surface (mission-13):
 * `POST /v1/projects/{id}/events` with `{ events: [...] }`, answered with the per-event outcome
 * document. Everything here is bounded and fail-soft: a timeout, a dead daemon, or a non-2xx
 * response resolves to `{ delivered: false, error }` — the caller prints one stderr line and
 * exits 0. The adapter never opens storage itself (ADR-0002: the daemon owns the data dir).
 */

export interface DaemonTarget {
  /** Daemon base URL (no trailing slash), e.g. `http://127.0.0.1:7331`. */
  url: string;
  /** Project id (the ingest endpoint's path project is authoritative server-side too). */
  projectId: string;
}

/** What the daemon's IngestResult tells us (loose: the adapter only reads the counts). */
export interface DeliverSummary {
  stored: number;
  duplicates: number;
  excluded: number;
  deadLettered: number;
  warnings: string[];
}

export interface DeliverResult extends DeliverSummary {
  delivered: boolean;
  /** Present only when delivery failed (bounded message, never payload contents). */
  error?: string;
}

export interface DeliverOptions {
  /** Hard per-request cap (default 1000ms — hooks must never block the agent). */
  timeoutMs?: number;
  /** Injectable fetch (tests drive a fake daemon). */
  fetch?: typeof fetch;
}

/** The hook budget: one second per request, bounded, no retries (fail-soft wins over blocking). */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 1000;

export async function deliverEvents(
  target: DaemonTarget,
  events: readonly unknown[],
  options: DeliverOptions = {},
): Promise<DeliverResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${target.url}/v1/projects/${encodeURIComponent(target.projectId)}/events`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { delivered: false, stored: 0, duplicates: 0, excluded: 0, deadLettered: 0, warnings: [], error: `POST ${urlForDiag(target)} returned status ${response.status}` };
    }
    const payload = (await response.json()) as Partial<DeliverSummary> & { dead_lettered?: number };
    return {
      delivered: true,
      stored: numberOrZero(payload.stored),
      duplicates: numberOrZero(payload.duplicates),
      excluded: numberOrZero(payload.excluded),
      deadLettered: numberOrZero(payload.dead_lettered ?? payload.deadLettered),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    };
  } catch (error) {
    return {
      delivered: false,
      stored: 0,
      duplicates: 0,
      excluded: 0,
      deadLettered: 0,
      warnings: [],
      error: `cannot reach the onememory daemon at ${urlForDiag(target)}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Diagnostics echo the origin, not the full URL path (no project ids in logs). */
function urlForDiag(target: DaemonTarget): string {
  return target.url;
}
