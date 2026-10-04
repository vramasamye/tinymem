/**
 * Failure-signature tests (M3b): incident recognition, the normalization rules, and the stability
 * that makes a signature a signature — trivial message noise must not change the digest.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FailureSignatureSchema } from '@onememory/core';

import { normalizeEvent } from '../events';
import { makeInput } from '../testing/transcripts';

import {
  classifyFailure,
  createFailureSignature,
  failureIncidentOf,
  failureSignatureForEvents,
  failureSignatureHash,
  failureSignatureOf,
  failureStatement,
  normalizeFailureMessage,
  FAILURE_SIGNATURE_VERSION,
  MAX_NORMALIZED_MESSAGE,
  type FailureIncident,
} from './failure';

function normalized(
  kind: Parameters<typeof makeInput>[0],
  payload: Parameters<typeof makeInput>[1],
  offsetSeconds = 0,
) {
  return normalizeEvent(makeInput(kind, payload, { offsetSeconds }));
}

function incident(overrides: Partial<FailureIncident> & Pick<FailureIncident, 'message'>): FailureIncident {
  return { origin: 'error', label: overrides.message, ...overrides };
}

describe('failureIncidentOf — what counts as a failure', () => {
  test('an error.raised is a failure carrying its origin and context', () => {
    const event = normalized('error.raised', {
      kind: 'error.raised',
      origin: 'build',
      message: 'Cannot find module "./schema" imported from src/store.ts',
      context: 'bun test in packages/storage',
    });
    const found = failureIncidentOf(event);
    expect(found).toEqual({
      origin: 'error',
      error_origin: 'build',
      message: 'Cannot find module "./schema" imported from src/store.ts bun test in packages/storage',
      label: 'Cannot find module "./schema" imported from src/store.ts',
    });
  });

  test('a tool-origin error records the failing tool from its context', () => {
    const found = failureIncidentOf(
      normalized('error.raised', {
        kind: 'error.raised',
        origin: 'tool',
        message: 'Edit failed: string not found in file',
        context: 'Edit src/store.ts',
      }),
    );
    expect(found?.tool).toBe('Edit');
    expect(found?.error_origin).toBe('tool');
  });

  test('a non-zero exit code is a command failure carrying the normalized command and executable', () => {
    const found = failureIncidentOf(
      normalized('terminal.output', {
        kind: 'terminal.output',
        command: 'bun test --watch',
        exit_code: 1,
        output_digest: 'error: Cannot find module "./schema"',
      }),
    );
    expect(found?.origin).toBe('command');
    expect(found?.command).toBe('bun test');
    expect(found?.tool).toBe('bun');
    expect(found?.label).toBe('`bun test --watch` failed');
  });

  test('a test run with failures is a test incident naming the failing tests', () => {
    const found = failureIncidentOf(
      normalized('test.results', {
        kind: 'test.results',
        framework: 'bun',
        passed: 3,
        failed: 2,
        failures: [{ name: 'adds numbers', digest: 'expected 2' }, { name: 'parses dates', digest: 'invalid date' }],
      }),
    );
    expect(found?.origin).toBe('test');
    expect(found?.tool).toBe('bun');
    expect(found?.label).toBe('2 failed: adds numbers, parses dates');
    expect(found?.message).toBe('bun: adds numbers | parses dates');
  });

  test('a test run without failure names still yields a bounded label', () => {
    const found = failureIncidentOf(
      normalized('test.results', { kind: 'test.results', passed: 1, failed: 3 }),
    );
    expect(found?.label).toBe('tests failed');
    expect(found?.tool).toBeUndefined();
  });

  test('a tool result the runtime marked ok:false is a tool incident naming the tool', () => {
    const found = failureIncidentOf(
      normalized('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'call-edit-1',
        ok: false,
        tool: 'Edit',
        output_digest: 'string to replace not found in file',
        error: { message: 'String to replace not found in file src/store.ts' },
      }),
    );
    expect(found).toEqual({
      origin: 'tool',
      tool: 'Edit',
      message: 'String to replace not found in file src/store.ts',
      label: 'Edit failed: String to replace not found in file src/store.ts',
    });
  });

  test('a successful tool result is never a failure', () => {
    expect(
      failureIncidentOf(
        normalized('conversation.tool_result', {
          kind: 'conversation.tool_result',
          call_id: 'call-edit-2',
          ok: true,
          tool: 'Edit',
          output_digest: 'edited src/store.ts',
        }),
      ),
    ).toBeUndefined();
  });

  test('a failing tool result without a tool name still yields an incident, name unset', () => {
    const found = failureIncidentOf(
      normalized('conversation.tool_result', {
        kind: 'conversation.tool_result',
        call_id: 'call-1',
        ok: false,
        output_digest: 'command exited with status 1',
      }),
    );
    expect(found?.origin).toBe('tool');
    expect(found?.tool).toBeUndefined();
    // The digest input falls back to the result text, never to a fabricated tool name.
    expect(found?.message).toBe('command exited with status 1');
  });

  test('a tool result is a failure only via ok:false, not via a result that mentions an error', () => {
    expect(
      failureIncidentOf(
        normalized('conversation.tool_result', {
          kind: 'conversation.tool_result',
          call_id: 'call-1',
          ok: true,
          tool: 'Bash',
          output_digest: 'error: Cannot find module "./schema"',
        }),
      ),
    ).toBeUndefined();
  });

  test('successes, chatter, and unknown exit codes are not failures', () => {
    expect(
      failureIncidentOf(
        normalized('terminal.output', {
          kind: 'terminal.output',
          command: 'bun test',
          exit_code: 0,
          output_digest: '87 pass, 0 fail',
        }),
      ),
    ).toBeUndefined();
    expect(
      failureIncidentOf(
        normalized('test.results', { kind: 'test.results', passed: 5, failed: 0 }),
      ),
    ).toBeUndefined();
    expect(
      failureIncidentOf(
        normalized('terminal.output', {
          kind: 'terminal.output',
          command: 'sleep 1',
          exit_code: null,
          output_digest: 'still running',
        }),
      ),
    ).toBeUndefined();
    expect(
      failureIncidentOf(
        normalized('conversation.message', {
          kind: 'conversation.message',
          role: 'user',
          content: 'That build failed yesterday.',
        }),
      ),
    ).toBeUndefined();
  });
});

describe('normalizeFailureMessage — documented noise rules', () => {
  test('paths, ports, hosts, numbers, durations, uuids, hex and ANSI codes are neutralized', () => {
    expect(normalizeFailureMessage('Cannot find module "./schema" imported from src/store.ts')).toBe(
      'cannot find module "<path>" imported from <path>',
    );
    expect(normalizeFailureMessage('ECONNREFUSED 127.0.0.1:11434')).toBe('econnrefused <host>:<port>');
    expect(
      normalizeFailureMessage('TypeError: x is not a function at /Users/dev/proj/src/index.ts:12:5'),
    ).toBe('typeerror: x is not a function at <path>:<line>:<col>');
    expect(normalizeFailureMessage('test timeout of 5000ms exceeded while running "parses dates"')).toBe(
      'test timeout of <duration> exceeded while running "parses dates"',
    );
    expect(normalizeFailureMessage('session 01900000-0000-7000-8000-0000000000aa aborted')).toBe(
      'session <uuid> aborted',
    );
    expect(normalizeFailureMessage('expected 3 to equal 4 (id 0x7ffee1b2c3d4)')).toBe(
      'expected <n> to equal <n> (id <hex>)',
    );
    expect(normalizeFailureMessage('\u001b[31mCannot find module "./schema"\u001b[0m')).toBe(
      'cannot find module "<path>"',
    );
  });

  test('identity is preserved: bare module names, identifiers and error codes survive', () => {
    expect(normalizeFailureMessage('Cannot find module "react"')).toBe('cannot find module "react"');
    expect(normalizeFailureMessage('error TS2345: bad argument')).toBe('error ts2345: bad argument');
    expect(normalizeFailureMessage('duplicate key value violates unique constraint "memories_pkey"')).toBe(
      'duplicate key value violates unique constraint "memories_pkey"',
    );
  });

  test('the normalized form is bounded and reproducible', () => {
    const long = `boom ${'x'.repeat(400)}`;
    const normalized = normalizeFailureMessage(long);
    expect(normalized.length).toBeLessThanOrEqual(MAX_NORMALIZED_MESSAGE);
    expect(normalizeFailureMessage(long)).toBe(normalized);
  });
});

describe('classifyFailure — normalized error classes', () => {
  const cases: Array<[string, string, FailureIncident['error_origin']]> = [
    ['Cannot find module "./schema"', 'MODULE_NOT_FOUND', 'build'],
    ['ECONNREFUSED 127.0.0.1:11434', 'NETWORK_ERROR', 'runtime'],
    ['EACCES: permission denied, open "/etc/hosts"', 'PERMISSION_DENIED', 'runtime'],
    ['ENOENT: no such file or directory, open "src/a.ts"', 'FILE_NOT_FOUND', 'runtime'],
    ['error TS2345: Argument of type string is not assignable', 'TYPECHECK_ERROR', 'build'],
    ['SyntaxError: Unexpected token }', 'SYNTAX_ERROR', 'build'],
    ['TypeError: x is not a function', 'TYPE_ERROR', 'runtime'],
    ['ReferenceError: y is not defined', 'REFERENCE_ERROR', 'runtime'],
    ['AssertionError: expected 1 to equal 2', 'ASSERTION_FAILURE', 'test'],
    ['JavaScript heap out of memory', 'OUT_OF_MEMORY', 'runtime'],
    ['deadlock detected', 'DEADLOCK', 'runtime'],
    ['operation timed out after 30s', 'TIMEOUT', 'runtime'],
  ];
  for (const [message, expected, errorOrigin] of cases) {
    test(`classifies ${JSON.stringify(message)} as ${expected}`, () => {
      expect(classifyFailure(incident({ message, error_origin: errorOrigin }))).toBe(expected);
    });
  }

  test('falls back to the event that carried the failure, never to a wrong class', () => {
    expect(classifyFailure(incident({ message: 'something went sideways', error_origin: 'build' }))).toBe(
      'BUILD_ERROR',
    );
    expect(classifyFailure(incident({ message: 'something went sideways', error_origin: 'tool' }))).toBe(
      'TOOL_ERROR',
    );
    expect(
      classifyFailure({ origin: 'test', label: 'tests failed', message: 'something went sideways' }),
    ).toBe('TEST_FAILURE');
    expect(
      classifyFailure({ origin: 'command', label: '`bun run x` failed', message: 'something went sideways' }),
    ).toBe('NONZERO_EXIT');
    expect(
      classifyFailure({ origin: 'tool', label: 'Edit call failed', message: 'something went sideways' }),
    ).toBe('TOOL_ERROR');
  });
});

describe('createFailureSignature — stability is the point', () => {
  test('trivial message noise does not change the signature', () => {
    const variants = [
      'Cannot find module "./schema" imported from src/store.ts',
      'Cannot find module "./schema" imported from /Users/dev/proj/packages/storage/src/store.ts',
      '\u001b[31mCannot find module "./schema" imported from src/store.ts\u001b[0m',
      'Cannot   find module "./schema"\n imported from src/store.ts',
    ];
    const signatures = variants.map((message) =>
      createFailureSignature(incident({ message, error_origin: 'build' })),
    );
    for (const signature of signatures) {
      expect(signature.type).toBe('MODULE_NOT_FOUND');
      expect(signature.hash).toBe(signatures[0]!.hash);
    }
    expect(new Set(signatures.map((signature) => signature.hash)).size).toBe(1);
  });

  test('volatile numbers, ports, timings and addresses do not change the signature', () => {
    const first = createFailureSignature(
      incident({ message: 'ECONNREFUSED 127.0.0.1:11434 after 1.2s', error_origin: 'runtime' }),
    );
    const second = createFailureSignature(
      incident({ message: 'ECONNREFUSED 127.0.0.1:5432 after 3.9s', error_origin: 'runtime' }),
    );
    expect(first.hash).toBe(second.hash);
    expect(first.normalized_message).toBe('econnrefused <host>:<port> after <duration>');
  });

  test('a different error class or a different message is a different signature', () => {
    const moduleNotFound = createFailureSignature(
      incident({ message: 'Cannot find module "react"', error_origin: 'build' }),
    );
    const otherModule = createFailureSignature(
      incident({ message: 'Cannot find module "react-dom"', error_origin: 'build' }),
    );
    const typeError = createFailureSignature(
      incident({ message: 'TypeError: x is not a function', error_origin: 'runtime' }),
    );
    expect(moduleNotFound.hash).not.toBe(otherModule.hash);
    expect(moduleNotFound.hash).not.toBe(typeError.hash);
    expect(moduleNotFound.type).not.toBe(typeError.type);
  });

  test('a path-like quoted literal is normalized as a path, a bare module name is identity', () => {
    // Documented consequence: `"./schema"` and `"./vectors"` are the same failure MODE (a missing
    // relative module) — the digest groups them, the candidate content keeps which one it was.
    const relative = createFailureSignature(
      incident({ message: 'Cannot find module "./schema"', error_origin: 'build' }),
    );
    const otherRelative = createFailureSignature(
      incident({ message: 'Cannot find module "./vectors"', error_origin: 'build' }),
    );
    expect(relative.normalized_message).toBe('cannot find module "<path>"');
    expect(relative.hash).toBe(otherRelative.hash);
  });

  test('the digest covers type + normalized_message and is reproducible from the stored fields', () => {
    const signature = createFailureSignature(
      incident({ message: 'TypeError: x is not a function', error_origin: 'runtime' }),
    );
    expect(signature.hash).toBe(failureSignatureHash(signature.type, signature.normalized_message));
    expect(signature.hash).toHaveLength(16);
    expect(signature.hash).toMatch(/^[0-9a-f]{16}$/);
    // Salted with the normalization version, so a normalization change cannot silently collide.
    const unsalted = createHash('sha256')
      .update(`${signature.type}\u0000${signature.normalized_message}`)
      .digest('hex')
      .slice(0, 16);
    expect(signature.hash).not.toBe(unsalted);
    expect(FAILURE_SIGNATURE_VERSION).toBe('failure-v1');
  });

  test('the failing command and tool are recorded but excluded from the digest', () => {
    const event = normalized('terminal.output', {
      kind: 'terminal.output',
      command: 'bun test',
      exit_code: 1,
      output_digest: 'error: Cannot find module "./schema"',
    });
    const signature = failureSignatureOf(event)!;
    expect(signature.origin).toBe('command');
    expect(signature.command).toBe('bun test');
    expect(signature.tool).toBe('bun');
    expect(signature.type).toBe('MODULE_NOT_FOUND');
    // The same message reached through a different tool collapses to one signature.
    const otherTool = createFailureSignature(
      incident({
        message: event.text,
        origin: 'command',
        command: 'bunx tsc',
        tool: 'bunx',
        label: '`bunx tsc` failed',
      }),
    );
    expect(otherTool.hash).toBe(signature.hash);
  });

  test('a tool-result failure records origin "tool" and keeps the tool out of the digest', () => {
    const event = normalized('conversation.tool_result', {
      kind: 'conversation.tool_result',
      call_id: 'call-edit-1',
      ok: false,
      tool: 'Edit',
      output_digest: 'string to replace not found in file',
      error: { message: 'String to replace not found in file src/store.ts' },
    });
    const signature = failureSignatureOf(event)!;
    expect(signature).toEqual({
      type: 'TOOL_ERROR',
      hash: failureSignatureHash('TOOL_ERROR', 'string to replace not found in file <path>'),
      normalized_message: 'string to replace not found in file <path>',
      origin: 'tool',
      tool: 'Edit',
    });
    // The digest covers type + normalized_message only: the same failure through another tool
    // collapses to one signature.
    const otherTool = createFailureSignature(
      incident({ origin: 'tool', tool: 'Write', message: event.tool_result!.error_message! }),
    );
    expect(otherTool.hash).toBe(signature.hash);
    expect(otherTool.error_origin).toBeUndefined();
  });

  test('every emitted signature is schema-valid and bounded', () => {
    const signature = createFailureSignature(
      incident({
        message: `Cannot find module "${'x'.repeat(400)}"`,
        error_origin: 'build',
      }),
    );
    expect(() => FailureSignatureSchema.parse(signature)).not.toThrow();
    expect(signature.normalized_message.length).toBeLessThanOrEqual(MAX_NORMALIZED_MESSAGE);
  });

  test('failureSignatureForEvents fingerprints the first failure among cited events', () => {
    const passing = normalized(
      'terminal.output',
      { kind: 'terminal.output', command: 'bun test', exit_code: 0, output_digest: '87 pass' },
      10,
    );
    const failing = normalized(
      'error.raised',
      { kind: 'error.raised', origin: 'runtime', message: 'TypeError: x is not a function' },
      20,
    );
    expect(failureSignatureForEvents([passing, failing])?.type).toBe('TYPE_ERROR');
    expect(failureSignatureForEvents([passing])).toBeUndefined();
    expect(failureSignatureForEvents([])).toBeUndefined();
  });

  test('failureStatement names the class, the label and the resolution', () => {
    const signature = createFailureSignature(
      incident({ message: 'Cannot find module "./schema"', error_origin: 'build' }),
    );
    expect(failureStatement(signature, 'Cannot find module "./schema"', '`bun test`')).toBe(
      'Failure: MODULE_NOT_FOUND — Cannot find module "./schema" — resolved by: `bun test`',
    );
  });
});
