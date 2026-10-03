/**
 * Privacy network gate tests: zero-outbound enforcement for the `local` profile.
 * No test performs a real outbound call — the guard must block first.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { installNetworkGuard, NetworkGuardError } from './index';

let activeGuard: { restore(): void } | null = null;

afterEach(() => {
  activeGuard?.restore();
  activeGuard = null;
});

describe('installNetworkGuard', () => {
  test('a fetch attempt throws, is recorded as origin-only, and assertZeroCalls fails', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    expect(() =>
      fetch('https://api.example.com/v1/data?api_key=SYNTHETIC-SECRET-1234', { method: 'POST' }),
    ).toThrow(NetworkGuardError);

    expect(guard.count).toBe(1);
    const attempt = guard.attempts[0]!;
    expect(attempt.url).toBe('https://api.example.com'); // origin only
    expect(attempt.url).not.toContain('api_key'); // taint: query string never recorded
    expect(attempt.url).not.toContain('SYNTHETIC-SECRET-1234');
    expect(attempt.method).toBe('POST');

    expect(() => guard.assertZeroCalls()).toThrow(NetworkGuardError);
    try {
      guard.assertZeroCalls();
      throw new Error('assertZeroCalls should have thrown');
    } catch (error) {
      // The report lists origins — never the path or query, so never the secret.
      expect(String(error)).toContain('https://api.example.com');
      expect(String(error)).not.toContain('SYNTHETIC-SECRET-1234');
    }
  });

  test('assertZeroCalls passes when nothing tried to call out', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;
    guard.assertZeroCalls(); // no throw
    expect(guard.count).toBe(0);
    expect(guard.attempts).toEqual([]);
  });

  test('reject mode returns a rejected promise and still records the attempt', async () => {
    const guard = installNetworkGuard({ mode: 'reject' });
    activeGuard = guard;

    await expect(fetch('http://localhost:9999/x')).rejects.toBeInstanceOf(NetworkGuardError);
    expect(guard.count).toBe(1);
    expect(guard.attempts[0]!.method).toBe('GET');
  });

  test('multiple attempts accumulate; Request-like inputs give method and origin', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    const requestLike = { url: 'https://cdn.example.net/a.js', method: 'GET' };
    expect(() => fetch(requestLike as unknown as Parameters<typeof fetch>[0])).toThrow(NetworkGuardError);
    expect(() => fetch('postgres://db.example.com:5432/app')).toThrow(NetworkGuardError);

    expect(guard.count).toBe(2);
    expect(guard.attempts.map((attempt) => attempt.url)).toEqual([
      'https://cdn.example.net',
      'postgres://db.example.com:5432',
    ]);
  });

  test('double install is rejected; restore returns the original fetch and is idempotent', () => {
    const original = globalThis.fetch;
    const guard = installNetworkGuard();

    expect(() => installNetworkGuard()).toThrow(NetworkGuardError);

    guard.restore();
    expect(globalThis.fetch).toBe(original);

    guard.restore(); // idempotent
    expect(globalThis.fetch).toBe(original);

    // re-installable after restore
    const second = installNetworkGuard();
    expect(() => fetch('https://x.example.org/')).toThrow(NetworkGuardError);
    second.restore();
    activeGuard = null; // both restored already
  });

  test('the patched fetch is re-entrant for callers that catch and retry', () => {
    const guard = installNetworkGuard();
    activeGuard = guard;

    let attempts = 0;
    try {
      fetch('https://a.example.com/1');
    } catch {
      attempts += 1;
    }
    try {
      fetch('https://a.example.com/2');
    } catch {
      attempts += 1;
    }

    expect(attempts).toBe(2);
    expect(guard.count).toBe(2);
  });
});
