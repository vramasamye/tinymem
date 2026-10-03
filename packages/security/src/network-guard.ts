/**
 * The privacy network gate (ADR-0007 §4: "100% local mode is a profile, not a setting").
 *
 * `installNetworkGuard()` monkey-patches the global `fetch` so that ANY attempted outbound
 * call while the guard is installed is recorded and fails. Local-profile tests use it to
 * assert zero outbound network; the daemon (M13) will use it to enforce the `local` profile.
 *
 * Taint-safe by construction: attempts record the URL ORIGIN only (scheme://host:port) —
 * never the path or query string, which can themselves carry credentials.
 */

export interface NetworkAttempt {
  /** Scheme://host:port — path and query are deliberately NOT captured (they can carry secrets). */
  readonly url: string;
  readonly method: string;
  readonly at: string;
}

export interface NetworkGuard {
  /** Recorded outbound attempts (origin + method + timestamp only). */
  readonly attempts: readonly NetworkAttempt[];
  readonly count: number;
  /** Throws `NetworkGuardError` listing the recorded origins when any call was attempted. */
  assertZeroCalls(): void;
  /** Restore the original global `fetch`. Idempotent. */
  restore(): void;
}

export interface NetworkGuardOptions {
  /**
   * `'throw'` (default): the patched fetch throws synchronously — the loudest failure mode.
   * `'reject'`: returns a rejected promise (closer to native fetch failure semantics).
   * Both modes record the attempt before failing.
   */
  mode?: 'throw' | 'reject';
}

export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkGuardError';
  }
}

const GUARD_FLAG = Symbol.for('@onememory/security.networkGuard');

/** Structural fetch stand-in — no DOM/bun types required (Node LTS and Bun both ship fetch). */
type AnyFetch = (input: unknown, init?: unknown) => unknown;

const ORIGIN_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#\s]+/;

function hrefOf(input: unknown): string {
  if (typeof input === 'string') return input;
  const href = (input as { href?: unknown } | null)?.href;
  if (typeof href === 'string') return href;
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url === 'string') return url;
  return '(opaque-input)';
}

/** Origin only: scheme://host:port. Path and query are dropped — the guard's records must stay taint-free. */
function originOf(input: unknown): string {
  const match = ORIGIN_PATTERN.exec(hrefOf(input));
  return match ? match[0] : '(unparseable-url)';
}

function methodOf(input: unknown, init?: unknown): string {
  const fromInit = (init as { method?: unknown } | null)?.method;
  if (typeof fromInit === 'string' && fromInit.length > 0) return fromInit.toUpperCase();
  const fromRequest = (input as { method?: unknown } | null)?.method;
  if (typeof fromRequest === 'string' && fromRequest.length > 0) return fromRequest.toUpperCase();
  return 'GET';
}

/**
 * Install the guard. Throws `NetworkGuardError` if `fetch` is missing or another guard is
 * already installed. Always pair with `restore()` (typically in a `finally`).
 */
export function installNetworkGuard(options: NetworkGuardOptions = {}): NetworkGuard {
  const globalObject = globalThis as { fetch?: unknown };
  const current = globalObject.fetch;
  if (typeof current !== 'function') {
    throw new NetworkGuardError('global fetch is not available in this runtime');
  }
  if (GUARD_FLAG in (current as object)) {
    throw new NetworkGuardError('a network guard is already installed (call restore() first)');
  }

  const original = current as AnyFetch;
  const mode = options.mode === 'reject' ? 'reject' : 'throw';
  const attempts: NetworkAttempt[] = [];

  const patched = ((input: unknown, init?: unknown): unknown => {
    const attempt: NetworkAttempt = {
      url: originOf(input),
      method: methodOf(input, init),
      at: new Date().toISOString(),
    };
    attempts.push(attempt);
    const error = new NetworkGuardError(
      `outbound network call blocked by the onememory privacy guard (${attempt.method} ${attempt.url})`,
    );
    if (mode === 'reject') return Promise.reject(error);
    throw error;
  }) as AnyFetch;

  Object.defineProperty(patched, GUARD_FLAG, { value: 'onememory', enumerable: false });
  globalObject.fetch = patched;

  return {
    get attempts(): readonly NetworkAttempt[] {
      return attempts.slice();
    },
    get count(): number {
      return attempts.length;
    },
    assertZeroCalls(): void {
      if (attempts.length > 0) {
        const seen = attempts.map((attempt) => `${attempt.method} ${attempt.url}`).join(', ');
        throw new NetworkGuardError(
          `expected zero outbound network calls, recorded ${attempts.length}: ${seen}`,
        );
      }
    },
    restore(): void {
      if (globalObject.fetch === patched) {
        globalObject.fetch = original;
      }
    },
  };
}
