/**
 * Wire-schema tests: the mirrors accept the verified Pi payload shapes and tolerate unknown fields
 * (Pi may add fields without breaking capture); malformed payloads fail closed.
 */

import { describe, expect, test } from 'bun:test';

import {
  PiBashToolInputSchema,
  PiCaptureEventSchema,
  PiEditToolInputSchema,
  PiMessageSchema,
  PiToolResultEventSchema,
  PI_CAPTURE_EVENT_NAMES,
} from './pi-wire';

describe('PiCaptureEventSchema', () => {
  test('accepts the documented session_start shape with unknown fields tolerated', () => {
    const parsed = PiCaptureEventSchema.safeParse({
      type: 'session_start',
      reason: 'resume',
      previousSessionFile: '/sessions/old.json',
      futureField: { anything: true },
    });
    expect(parsed.success).toBeTrue();
  });

  test('accepts the documented tool_result shape', () => {
    const parsed = PiToolResultEventSchema.safeParse({
      type: 'tool_result',
      toolCallId: 'call_1',
      toolName: 'bash',
      parentToolCallId: 'call_codemode',
      input: { command: 'ls', timeout: 30 },
      content: [{ type: 'text', text: 'files' }],
      structuredContent: { output: 'files', truncated: false, exit_code: 0, wall_time_seconds: 0.2 },
      isError: false,
    });
    expect(parsed.success).toBeTrue();
  });

  test('rejects an unknown event type (fail closed)', () => {
    expect(PiCaptureEventSchema.safeParse({ type: 'turn_end', turnIndex: 1 }).success).toBeFalse();
  });

  test('rejects a malformed reason (fail closed)', () => {
    expect(PiCaptureEventSchema.safeParse({ type: 'session_start', reason: 'boot' }).success).toBeFalse();
  });
});

describe('per-tool input schemas', () => {
  test('bash input: command required, timeout optional seconds', () => {
    expect(PiBashToolInputSchema.safeParse({ command: 'ls' }).success).toBeTrue();
    expect(PiBashToolInputSchema.safeParse({ command: 'ls', timeout: 5 }).success).toBeTrue();
    expect(PiBashToolInputSchema.safeParse({ timeout: 5 }).success).toBeFalse();
  });

  test('edit input: path + at least one exact replacement', () => {
    expect(
      PiEditToolInputSchema.safeParse({ path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }).success,
    ).toBeTrue();
    expect(PiEditToolInputSchema.safeParse({ path: 'a.ts', edits: [] }).success).toBeFalse();
    expect(PiEditToolInputSchema.safeParse({ edits: [{ oldText: 'a', newText: 'b' }] }).success).toBeFalse();
  });
});

describe('PiMessageSchema', () => {
  test('accepts block content and plain-string content', () => {
    expect(PiMessageSchema.safeParse({ role: 'user', content: [{ type: 'text', text: 'hi' }] }).success).toBeTrue();
    expect(PiMessageSchema.safeParse({ role: 'assistant', content: 'hi' }).success).toBeTrue();
    expect(PiMessageSchema.safeParse({ role: 'user', content: 42 }).success).toBeFalse();
  });
});

describe('PI_CAPTURE_EVENT_NAMES', () => {
  test('is exactly the five-event subscription surface', () => {
    expect([...PI_CAPTURE_EVENT_NAMES].sort() as string[]).toEqual(
      ['before_agent_start', 'message_end', 'session_shutdown', 'session_start', 'tool_result'].sort(),
    );
  });
});
