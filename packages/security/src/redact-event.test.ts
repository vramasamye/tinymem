/**
 * `redactEvent` ingest-helper tests: canonical output for the events repository, recomputed
 * content_hash, JSON-path locations, unknown-kind normalization, and the taint-safe error
 * path (issues never echo the input).
 */

import { describe, expect, test } from 'bun:test';

import { OnememoryEventSchema, eventContentHash, uuidv7 } from '@onememory/core';
import type { OnememoryEvent, Redaction } from '@onememory/core';

import { redactEvent, RedactEventError } from './index';

const A = (n: number, char = 'a'): string => char.repeat(n);

/** Doc-shaped event fixture (no payload discriminator — like a raw adapter emission). */
function envelope(kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuidv7(),
    kind,
    occurred_at: '2026-10-04T12:00:00.000Z',
    ingested_at: '2026-10-04T12:00:01.000Z',
    source: { runtime: 'claude-code', adapter_version: '0.1.0' },
    scope: {},
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
    ...overrides,
  };
}

describe('redactEvent', () => {
  test('returns a canonical event ready for the events repository', () => {
    const secret = `sk-ant-${A(40, 'b')}`;
    const { event, redactions } = redactEvent(
      envelope('conversation.message', { role: 'user', content: `use ${secret} for the client` }),
    );

    // Canonical shape: what `store.ingestEvent` re-validates must pass.
    expect(OnememoryEventSchema.safeParse(event).success).toBe(true);
    expect(event.kind).toBe('conversation.message');
    expect(event.payload.content).toBe('use [REDACTED:api-key] for the client');

    // Redactions attached on the envelope AND returned; kind + location + length only.
    expect(event.redactions).toBe(redactions);
    expect(redactions).toEqual([{ kind: 'api-key', location: '$.payload.content', length: secret.length }]);
    expect(JSON.stringify(redactions)).not.toContain(secret);

    // content_hash is recomputed over the REDACTED payload (dedupe + storage consistency).
    expect(event.content_hash).toBe(eventContentHash(event.payload));
    expect(event.content_hash).not.toBe(eventContentHash({ role: 'user', content: `use ${secret} for the client` }));
  });

  test('redacts the whole envelope, not only the payload', () => {
    const secret = `ghp_${A(36)}`;
    const { event, redactions } = redactEvent(
      envelope('session.start', {
        cwd: '/repo',
      }, {
        source: { runtime: 'claude-code', adapter_version: '0.1.0', instance_id: `machine-${secret}` },
      }),
    );

    expect(event.source.instance_id).toBe('machine-[REDACTED:token]');
    expect(redactions).toEqual([{ kind: 'token', location: '$.source.instance_id', length: secret.length }]);
  });

  test('nested payloads: locations are JSON paths from the envelope root', () => {
    const secret = `AKIA${A(16, 'B')}`;
    const { event, redactions } = redactEvent(
      envelope('conversation.tool_result', {
        call_id: 'call-1',
        ok: true,
        output_digest: `deploy failed: credentials AKIA${A(16, 'B')} rejected`,
        extra: { files: [`recheck ${secret}`] },
      }),
    );

    const locations = redactions.map((record) => record.location);
    expect(locations).toEqual(['$.payload.output_digest', '$.payload.extra.files[0]']);
    const payload = event.payload as unknown as { extra: { files: string[] } };
    expect(payload.extra.files[0]).toBe('recheck [REDACTED:api-key]');
  });

  test('unknown kinds normalize to raw.unknown and still redact', () => {
    const secret = `sk-${A(40)}`;
    const { event, redactions } = redactEvent(
      envelope('future.kind', { data: { note: `token ${secret}` } }),
    );

    expect(event.kind).toBe('raw.unknown');
    expect(event.payload.original_kind).toBe('future.kind');
    expect((event.payload as Record<string, unknown>).data).toEqual({ note: 'token [REDACTED:api-key]' });
    expect(redactions[0]!.location).toBe('$.payload.data.note');
  });

  test('malformed envelopes throw with taint-safe issues (never the input value)', () => {
    const secret = `sk-${A(40)}`;
    const bad = envelope('conversation.message', { role: 'user', content: `use ${secret}` }, { id: 'not-a-uuid' });

    try {
      redactEvent(bad);
      throw new Error('redactEvent should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RedactEventError);
      const redactError = error as RedactEventError;
      expect(redactError.issues.length).toBeGreaterThan(0);
      expect(redactError.issues[0]!.path).toBe('id');
      expect(redactError.message).not.toContain(secret);
      expect(JSON.stringify(redactError.issues)).not.toContain(secret);
      expect(JSON.stringify(redactError)).not.toContain(secret);
    }
  });

  test('pre-existing redactions are preserved (merge), and the helper is idempotent', () => {
    const secret = `sk-${A(40)}`;
    const existing: Redaction = { kind: 'token', location: '$.payload.content', length: 32 };

    const first = redactEvent(
      envelope('conversation.message', { role: 'user', content: `use ${secret}` }, { redactions: [existing] }),
    );
    expect(first.redactions).toEqual([existing, { kind: 'api-key', location: '$.payload.content', length: secret.length }]);

    // Second pass over its own output: nothing new, nothing lost, hashes stable.
    const second = redactEvent(first.event);
    expect(second.redactions).toEqual(first.redactions);
    expect(second.event.content_hash).toBe(first.event.content_hash);
    expect(second.event.payload).toEqual(first.event.payload);
  });

  test('documented edge: markers that would overflow a length-capped digest dead-letter loudly', () => {
    // A 390-char arguments_digest stuffed with short password flags passes initial validation,
    // but marker replacement grows it past the 400-char cap — re-validation must throw instead
    // of silently storing an invalid event. Ingest callers dead-letter this error.
    const digest = '--password x '.repeat(30); // 390 chars, all valid input
    expect(digest.length).toBeLessThanOrEqual(400);

    expect(() =>
      redactEvent(envelope('conversation.tool_call', { tool: 'bash', call_id: 'c1', arguments_digest: digest })),
    ).toThrow(RedactEventError);
  });
});
