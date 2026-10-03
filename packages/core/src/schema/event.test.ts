import { describe, expect, test } from 'bun:test';

import {
  EVENT_KINDS,
  EventPayloadSchema,
  OnememoryEventSchema,
  normalizeUnknownKind,
  validateOnememoryEvent,
} from './event';
import { eventContentHash } from '../model/hashing';
import type { OnememoryEvent } from './event';

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '0192f3c0-0000-7000-8000-000000000001',
    kind: 'conversation.message',
    occurred_at: '2026-10-03T12:00:00.000Z',
    ingested_at: '2026-10-03T12:00:01.000Z',
    source: { runtime: 'claude-code', adapter_version: '1.0.0' },
    scope: { project_id: '0192f3c0-0000-7000-8000-000000000002', agent_id: 'claude-code' },
    payload: { role: 'user', content: 'Use Node 20 for this project' },
    redactions: [],
    ...overrides,
  };
}

describe('event envelope validation', () => {
  test('a valid doc-shaped event validates (kind injected into the payload)', () => {
    const raw = baseEvent({ content_hash: eventContentHash(baseEvent().payload) });
    const result = validateOnememoryEvent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as OnememoryEvent;
    expect(value.kind).toBe('conversation.message');
    // self-describing payload: the discriminator is present
    expect(value.payload.kind).toBe('conversation.message');
    if (value.payload.kind === 'conversation.message') {
      expect(value.payload.role).toBe('user');
      expect(value.payload.content).toBe('Use Node 20 for this project');
    }
    // unknown fields are tolerated, not dropped
    expect((value as Record<string, unknown>).extra_adapter_field).toBeUndefined();
  });

  test('unknown envelope fields survive (forward compatibility, §8)', () => {
    const raw = baseEvent({
      content_hash: eventContentHash(baseEvent().payload),
      future_field: { nested: true },
    });
    const result = validateOnememoryEvent(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as unknown as Record<string, unknown>).future_field).toEqual({
        nested: true,
      });
    }
  });

  test('malformed event → dead-letter record with validation issues, never a throw', () => {
    const malformed = baseEvent({ id: 'not-a-uuid' });
    const result = validateOnememoryEvent(malformed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dead_letter.stage).toBe('ingest.validate');
    expect(result.dead_letter.reason).toBeString();
    expect(result.dead_letter.issues.length).toBeGreaterThan(0);
    expect(result.dead_letter.issues.some((i) => i.path === 'id')).toBe(true);
    expect(result.dead_letter.received_at).toBeString();
  });

  test('missing payload or wrong payload shape → dead-letter', () => {
    const noPayload = baseEvent({ payload: undefined, content_hash: 'a'.repeat(64) });
    expect(validateOnememoryEvent(noPayload).ok).toBe(false);

    const wrongShape = baseEvent({
      payload: { role: 'wizard', content: 'hi' }, // role not in (user|assistant)
      content_hash: eventContentHash({ role: 'wizard', content: 'hi' }),
    });
    const result = validateOnememoryEvent(wrongShape);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dead_letter.issues.some((i) => i.path.startsWith('payload'))).toBe(true);
  });

  test('non-object payload for a known kind → dead-letter', () => {
    const result = validateOnememoryEvent(
      baseEvent({ payload: 'just a string', content_hash: eventContentHash('just a string') }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('unknown-kind tolerance (§1: never drop unknown kinds)', () => {
  test('an unknown kind is normalized to raw.unknown and stored raw', () => {
    const rawPayload = { mystery: 'data', more: [1, 2, 3] };
    const raw = baseEvent({
      kind: 'design.tool_used',
      payload: rawPayload,
      content_hash: eventContentHash(rawPayload),
    });
    const result = validateOnememoryEvent(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('raw.unknown');
    if (result.value.payload.kind !== 'raw.unknown') throw new Error('expected raw.unknown');
    expect(result.value.payload.original_kind).toBe('design.tool_used');
    expect(result.value.payload.mystery).toBe('data');
  });

  test('a non-object payload under an unknown kind is wrapped, not dropped', () => {
    const result = validateOnememoryEvent(
      baseEvent({ kind: 'future.kind', payload: 42, content_hash: eventContentHash(42) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload.kind).toBe('raw.unknown');
    if (result.value.payload.kind === 'raw.unknown') {
      expect(result.value.payload.data).toBe(42);
      expect(result.value.payload.original_kind).toBe('future.kind');
    }
  });

  test('normalizeUnknownKind keeps the original kind inside the payload', () => {
    const normalized = normalizeUnknownKind('weird.kind', { a: 1 });
    expect(normalized.kind).toBe('raw.unknown');
    expect(normalized.payload).toEqual({ a: 1, original_kind: 'weird.kind' });
  });
});

describe('the §2 discriminated union', () => {
  test('every known kind has a payload schema and rejects foreign payloads', () => {
    // union discriminates on kind
    const sample: Record<string, unknown> = {
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 0,
      output_digest: 'all passing',
    };
    expect(EventPayloadSchema.safeParse(sample).success).toBe(true);

    // wrong field types for the discriminated kind fail
    expect(EventPayloadSchema.safeParse({ ...sample, exit_code: 'zero' }).success).toBe(false);
    // unknown discriminator fails the union
    expect(EventPayloadSchema.safeParse({ kind: 'nope.nope', data: 1 }).success).toBe(false);
  });

  test('document.added requires exactly one of path or uri', () => {
    const both = {
      kind: 'document.added',
      path: '/a.md',
      uri: 'file:///a.md',
      mime: 'text/markdown',
      content_digest: 'doc text',
    };
    const neither = { kind: 'document.added', mime: 'text/markdown', content_digest: 'doc text' };
    const one = { kind: 'document.added', path: '/a.md', mime: 'text/markdown', content_digest: 'x' };
    expect(EventPayloadSchema.safeParse(both).success).toBe(false);
    expect(EventPayloadSchema.safeParse(neither).success).toBe(false);
    expect(EventPayloadSchema.safeParse(one).success).toBe(true);
  });

  test('truncation budgets are enforced (digests carry explicit limits)', () => {
    const longDigest = { kind: 'terminal.output', command: 'c', exit_code: null, output_digest: 'x'.repeat(2001) };
    expect(EventPayloadSchema.safeParse(longDigest).success).toBe(false);

    const tooManyFiles = {
      kind: 'git.commit',
      sha: 'abc123',
      message: 'm',
      author_name: 'a',
      files: Array.from({ length: 501 }, (_, i) => `f${i}`),
    };
    expect(EventPayloadSchema.safeParse(tooManyFiles).success).toBe(false);
  });

  test('EVENT_KINDS covers the doc vocabulary including the raw.unknown escape hatch', () => {
    expect(EVENT_KINDS).toContain('conversation.message');
    expect(EVENT_KINDS).toContain('conversation.tool_call');
    expect(EVENT_KINDS).toContain('conversation.tool_result');
    expect(EVENT_KINDS).toContain('terminal.output');
    expect(EVENT_KINDS).toContain('error.raised');
    expect(EVENT_KINDS).toContain('test.results');
    expect(EVENT_KINDS).toContain('file.changed');
    expect(EVENT_KINDS).toContain('git.commit');
    expect(EVENT_KINDS).toContain('pull_request');
    expect(EVENT_KINDS).toContain('document.added');
    expect(EVENT_KINDS).toContain('explicit.remember');
    expect(EVENT_KINDS).toContain('explicit.forget');
    expect(EVENT_KINDS).toContain('session.start');
    expect(EVENT_KINDS).toContain('session.end');
    expect(EVENT_KINDS).toContain('raw.unknown');
    expect(EVENT_KINDS).toHaveLength(15);
  });
});

describe('content_hash discipline', () => {
  test('the canonical event hash is key-order independent', () => {
    expect(eventContentHash({ a: 1, b: 2 })).toBe(eventContentHash({ b: 2, a: 1 }));
    expect(eventContentHash({ a: 1, b: 2 })).not.toBe(eventContentHash({ a: 1, b: 3 }));
  });

  test('an envelope whose content_hash is not sha256 hex is dead-lettered', () => {
    const result = validateOnememoryEvent(baseEvent({ content_hash: 'not-a-hash' }));
    expect(result.ok).toBe(false);
  });

  test('payload.kind inconsistent with the envelope kind is dead-lettered', () => {
    const raw = baseEvent({
      payload: { kind: 'session.end', cwd: '/x' },
      content_hash: eventContentHash({ kind: 'session.end', cwd: '/x' }),
    });
    const result = validateOnememoryEvent(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.dead_letter.issues.some((i) => i.path === 'payload.kind')).toBe(true);
  });

  test('a fully-tagged payload (kind inside) validates against the strict schema directly', () => {
    const tagged = {
      id: '0192f3c0-0000-7000-8000-000000000003',
      kind: 'explicit.remember',
      occurred_at: '2026-10-03T12:00:00.000Z',
      ingested_at: '2026-10-03T12:00:01.000Z',
      source: { runtime: 'cli', adapter_version: '1.0.0' },
      scope: {},
      payload: { kind: 'explicit.remember', content: 'prefer bun over npm', type: 'preference' },
      content_hash: eventContentHash({
        kind: 'explicit.remember',
        content: 'prefer bun over npm',
        type: 'preference',
      }),
      redactions: [],
    };
    expect(OnememoryEventSchema.safeParse(tagged).success).toBe(true);
  });
});
