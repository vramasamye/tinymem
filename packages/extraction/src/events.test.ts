/**
 * NORMALIZE tests: payload parsing through core's canonical schemas, command normalization, and
 * envelope reconstruction from an `events` row (including the malformed-event path).
 */

import { describe, expect, test } from 'bun:test';
import { eventContentHash, uuidv7, type StoredEvent } from '@onememory/core';

import {
  normalizeCommand,
  normalizeEvent,
  sourceKindForEvent,
  storedEventToEnvelope,
} from './events';
import { NormalizationError } from './types';
import { makeInput } from './testing/transcripts';

describe('normalizeCommand', () => {
  test('keeps the executable and subcommand, drops flags, paths and assignments', () => {
    expect(normalizeCommand('bun test --watch')).toBe('bun test');
    expect(normalizeCommand('  git   commit -m "x"  ')).toBe('git commit');
    expect(normalizeCommand('bunx tsc --noEmit')).toBe('bunx tsc');
    expect(normalizeCommand('NODE_ENV=test bun test')).toBe('');
    expect(normalizeCommand('cat ./package.json')).toBe('cat');
    expect(normalizeCommand('docker compose -f docker/compose.yaml up -d')).toBe('docker compose');
  });
});

describe('sourceKindForEvent', () => {
  test('maps event kinds to provenance anchor kinds', () => {
    expect(sourceKindForEvent('conversation.message')).toBe('conversation');
    expect(sourceKindForEvent('terminal.output')).toBe('terminal');
    expect(sourceKindForEvent('git.commit')).toBe('git');
    expect(sourceKindForEvent('document.added')).toBe('document');
    expect(sourceKindForEvent('explicit.remember')).toBe('explicit');
    expect(sourceKindForEvent('something.unknown')).toBe('api');
  });
});

describe('normalizeEvent', () => {
  test('structures a terminal command, its exit code, and its normalized form', () => {
    const input = makeInput(
      'terminal.output',
      { kind: 'terminal.output', command: 'bun test --watch', exit_code: 1, output_digest: 'error: nope' },
      { offsetSeconds: 3 },
    );
    const normalized = normalizeEvent(input);
    expect(normalized.kind).toBe('terminal.output');
    expect(normalized.command).toEqual({
      text: 'bun test --watch',
      normalized: 'bun test',
      exit_code: 1,
      output_digest: 'error: nope',
    });
    expect(normalized.source_id).toBe(input.source.id);
    expect(normalized.session_id).toBe('sess-m3-golden');
    expect(normalized.text).toContain('error: nope');
  });

  test('structures errors, file changes, test results, commits, PRs and documents', () => {
    const error = normalizeEvent(
      makeInput('error.raised', {
        kind: 'error.raised',
        origin: 'build',
        message: 'boom',
        context: 'in the build',
      }),
    );
    expect(error.error).toEqual({ origin: 'build', message: 'boom', context: 'in the build' });

    const file = normalizeEvent(
      makeInput('file.changed', { kind: 'file.changed', path: 'src/a.ts', change: 'modified' }),
    );
    expect(file.file).toEqual({ path: 'src/a.ts', change: 'modified' });

    const tests = normalizeEvent(
      makeInput('test.results', {
        kind: 'test.results',
        framework: 'bun',
        passed: 3,
        failed: 1,
        failures: [{ name: 'adds numbers', digest: 'expected 2' }],
      }),
    );
    expect(tests.tests).toEqual({
      framework: 'bun',
      passed: 3,
      failed: 1,
      failure_names: ['adds numbers'],
    });

    const commit = normalizeEvent(
      makeInput('git.commit', {
        kind: 'git.commit',
        sha: 'abc123',
        message: 'feat: add storage',
        author_name: 'A',
        files: ['src/a.ts'],
      }),
    );
    expect(commit.commit).toEqual({ sha: 'abc123', message: 'feat: add storage', files: ['src/a.ts'] });

    const pr = normalizeEvent(
      makeInput('pull_request', {
        kind: 'pull_request',
        number: 12,
        title: 'Add storage',
        state: 'merged',
      }),
    );
    expect(pr.pull_request).toEqual({ number: 12, title: 'Add storage', state: 'merged' });

    const doc = normalizeEvent(
      makeInput('document.added', {
        kind: 'document.added',
        path: 'docs/adr/0001.md',
        mime: 'text/markdown',
        title: 'ADR 1',
        content_digest: 'we decided to use Postgres',
      }),
    );
    expect(doc.document).toEqual({
      path: 'docs/adr/0001.md',
      title: 'ADR 1',
      text: 'we decided to use Postgres',
    });

    const explicit = normalizeEvent(
      makeInput('explicit.remember', { kind: 'explicit.remember', content: 'remember this', type: 'decision' }),
    );
    expect(explicit.explicit).toEqual({ content: 'remember this', type: 'decision' });
  });

  test('structures a tool result, carrying the tool name only when the payload named one', () => {
    const named = normalizeEvent(
      makeInput('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'c1',
        ok: false,
        tool: 'Edit',
        output_digest: 'string to replace not found in file',
        error: { message: 'String to replace not found in file src/store.ts' },
      }),
    );
    expect(named.tool_result).toEqual({
      call_id: 'c1',
      ok: false,
      tool: 'Edit',
      error_message: 'String to replace not found in file src/store.ts',
      output_digest: 'string to replace not found in file',
    });

    const unnamed = normalizeEvent(
      makeInput('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'c2',
        ok: true,
        output_digest: 'ok',
      }),
    );
    expect(unnamed.tool_result).toEqual({ call_id: 'c2', ok: true, output_digest: 'ok' });
  });

  test('throws NormalizationError for a payload that does not match its canonical schema', () => {
    const input = makeInput('terminal.output', {
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 0,
      output_digest: '',
    });
    // Corrupt the payload after construction: the NORMALIZE stage must flag, not crash the pipeline.
    const corrupted = {
      ...input,
      event: { ...input.event, payload: { kind: 'terminal.output', command: 42 } },
    } as unknown as typeof input;
    expect(() => normalizeEvent(corrupted)).toThrow(NormalizationError);
  });
});

describe('storedEventToEnvelope', () => {
  const base: StoredEvent = {
    id: uuidv7(),
    kind: 'terminal.output',
    runtime: 'claude-code',
    adapter_version: '1.0.0',
    project_id: '01900000-0000-7000-8000-0000000000aa',
    session_id: 's1',
    agent_id: 'claude-code',
    payload: {
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 0,
      output_digest: 'ok',
    },
    content_hash: eventContentHash({
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 0,
      output_digest: 'ok',
    }),
    redactions: [],
    occurred_at: '2026-10-03T09:00:00.000Z',
    ingested_at: '2026-10-03T09:00:01.000Z',
    needs_review: false,
  };

  test('rebuilds a validated envelope from a stored row', () => {
    const envelope = storedEventToEnvelope(base);
    expect(envelope.kind).toBe('terminal.output');
    expect(envelope.scope.session_id).toBe('s1');
    expect(envelope.content_hash).toBe(base.content_hash);
  });

  test('throws NormalizationError for a row whose payload no longer validates', () => {
    expect(() =>
      storedEventToEnvelope({ ...base, payload: { kind: 'terminal.output', command: 42 } }),
    ).toThrow(NormalizationError);
  });
});
