/**
 * Wire-schema tests: the mirrors parse the verified OpenCode shapes and reject the shapes that
 * must never reach translation. All fixtures come from `testing.ts` (verified surfaces).
 */

import { describe, expect, test } from 'bun:test';

import {
  BashToolMetadataSchema,
  ChatMessageInputSchema,
  ChatMessageOutputSchema,
  EditToolArgsSchema,
  EventHookInputSchema,
  LoopbackHttpUrlSchema,
  MessagePartUpdatedEventSchema,
  OpenCodeConfigDocumentSchema,
  OpenCodeEventSchema,
  OpenCodeMcpLocalEntrySchema,
  OpenCodeMcpRemoteEntrySchema,
  SessionCreatedEventSchema,
  SessionIdleEventSchema,
  ToolAfterInputSchema,
  ToolAfterOutputSchema,
  UserMessageSchema,
  isLoopbackHostname,
} from './wire';
import {
  bashToolAfter,
  chatMessageHook,
  editToolAfter,
  eventHookInput,
  sessionCreatedEvent,
  sessionIdleEvent,
  textPartUpdatedEvent,
  toolPartUpdatedEvent,
  writeToolAfter,
} from './testing';

describe('OpenCode wire — the event channel', () => {
  test('session.created parses with the SDK Session shape', () => {
    const parsed = SessionCreatedEventSchema.safeParse(sessionCreatedEvent());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.properties.info.id).toBe('ses_01JOPENCODEFIXTURE00000');
  });

  test('session.idle parses (the quiescence signal)', () => {
    const parsed = SessionIdleEventSchema.safeParse(sessionIdleEvent());
    expect(parsed.success).toBe(true);
  });

  test('message.part.updated parses with a completed text part', () => {
    const parsed = MessagePartUpdatedEventSchema.safeParse(textPartUpdatedEvent('done'));
    expect(parsed.success).toBe(true);
  });

  test('the subscribed union recognizes the three subscribed types', () => {
    expect(OpenCodeEventSchema.safeParse(sessionCreatedEvent()).success).toBe(true);
    expect(OpenCodeEventSchema.safeParse(sessionIdleEvent()).success).toBe(true);
    expect(OpenCodeEventSchema.safeParse(textPartUpdatedEvent('done')).success).toBe(true);
  });

  test('the subscribed union rejects unknown types (they are counted drops upstream)', () => {
    expect(OpenCodeEventSchema.safeParse({ type: 'session.deleted', properties: {} }).success).toBe(false);
  });

  test('a tool part with an error state parses', () => {
    const parsed = MessagePartUpdatedEventSchema.safeParse(
      toolPartUpdatedEvent({ status: 'error', error: 'spawn ENOENT' }),
    );
    expect(parsed.success).toBe(true);
  });

  test('the event hook input wrapper requires { event }', () => {
    expect(EventHookInputSchema.safeParse(eventHookInput(sessionCreatedEvent())).success).toBe(true);
    expect(EventHookInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('OpenCode wire — the tool.execute.after channel', () => {
  test('input parses for bash', () => {
    const pair = bashToolAfter({ command: 'bun test' }, { output: 'ok', exit: 0 });
    expect(ToolAfterInputSchema.safeParse(pair.input).success).toBe(true);
  });

  test('output parses and keeps metadata as unknown (per-tool parsing happens in translate)', () => {
    const pair = editToolAfter({ filePath: '/w/a.ts', oldString: 'a', newString: 'b' });
    const parsed = ToolAfterOutputSchema.safeParse(pair.output);
    expect(parsed.success).toBe(true);
  });

  test('bash metadata exit is number|null (null = abort/timeout)', () => {
    expect(BashToolMetadataSchema.safeParse({ exit: 0 }).success).toBe(true);
    expect(BashToolMetadataSchema.safeParse({ exit: 3 }).success).toBe(true);
    expect(BashToolMetadataSchema.safeParse({ exit: null }).success).toBe(true);
    expect(BashToolMetadataSchema.safeParse({ exit: '0' }).success).toBe(false);
  });

  test('edit args require filePath/oldString/newString', () => {
    expect(EditToolArgsSchema.safeParse({ filePath: '/w/a.ts', oldString: 'a', newString: 'b' }).success).toBe(true);
    expect(EditToolArgsSchema.safeParse({ path: '/w/a.ts', oldString: 'a', newString: 'b' }).success).toBe(false);
    expect(EditToolArgsSchema.safeParse({ filePath: '/w/a.ts' }).success).toBe(false);
  });

  test('write metadata keeps the exists create signal', () => {
    const pair = writeToolAfter({ filePath: '/w/a.ts', content: 'a\nb\n' }, { exists: false });
    expect(ToolAfterOutputSchema.safeParse(pair.output).success).toBe(true);
  });

  test('tool input requires tool/sessionID/callID', () => {
    expect(ToolAfterInputSchema.safeParse({ tool: 'bash' }).success).toBe(false);
    expect(ToolAfterInputSchema.safeParse({ tool: 'bash', sessionID: 'ses_1', callID: 'cal_1', args: {} }).success).toBe(true);
  });
});

describe('OpenCode wire — the chat.message channel', () => {
  test('input parses with the hook fields', () => {
    const pair = chatMessageHook('hello');
    expect(ChatMessageInputSchema.safeParse(pair.input).success).toBe(true);
  });

  test('output parses with a UserMessage and its text parts', () => {
    const pair = chatMessageHook('why does the build fail?');
    const parsed = ChatMessageOutputSchema.safeParse(pair.output);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message.role).toBe('user');
      expect(parsed.data.message.id).toBe('msg_user_01JOPENCODEFIXTURE00');
    }
  });

  test('UserMessage is role "user" only (the SDK Message union arm we consume)', () => {
    expect(UserMessageSchema.safeParse({ id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 1 }, agent: 'build' }).success).toBe(false);
  });
});

describe('OpenCode wire — opencode.json mcp entries', () => {
  test('a loopback http URL parses', () => {
    expect(LoopbackHttpUrlSchema.safeParse('http://127.0.0.1:8787/mcp').success).toBe(true);
    expect(LoopbackHttpUrlSchema.safeParse('http://localhost:8787/mcp').success).toBe(true);
  });

  test('non-http and non-loopback URLs are rejected (Phase 1 has no auth)', () => {
    expect(LoopbackHttpUrlSchema.safeParse('https://127.0.0.1:8787/mcp').success).toBe(false);
    expect(LoopbackHttpUrlSchema.safeParse('http://10.0.0.5:8787/mcp').success).toBe(false);
    expect(LoopbackHttpUrlSchema.safeParse('http://memory.internal:8787/mcp').success).toBe(false);
  });

  test('isLoopbackHostname recognizes every loopback spelling', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.1.2.3')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
    expect(isLoopbackHostname('example.com')).toBe(false);
  });

  test('a remote entry REQUIRES type "remote" (the SDK requires it)', () => {
    const valid = OpenCodeMcpRemoteEntrySchema.safeParse({ type: 'remote', url: 'http://127.0.0.1:8787/mcp', enabled: true });
    expect(valid.success).toBe(true);
    // Without the discriminator the SDK's McpRemoteConfig would not select this arm at all.
    expect(OpenCodeMcpRemoteEntrySchema.safeParse({ url: 'http://127.0.0.1:8787/mcp', enabled: true }).success).toBe(false);
  });

  test('a local entry requires a command string array', () => {
    const valid = OpenCodeMcpLocalEntrySchema.safeParse({
      type: 'local',
      command: ['bun', 'node_modules/@onememory/mcp/src/bin.ts'],
      environment: { ONEMEMORY_MCP_AGENT_ID: 'opencode' },
      enabled: true,
    });
    expect(valid.success).toBe(true);
    expect(OpenCodeMcpLocalEntrySchema.safeParse({ type: 'local', command: 'bun run x' }).success).toBe(false);
  });

  test('strict entries reject unknown keys (typos must never silently disable capture)', () => {
    expect(
      OpenCodeMcpRemoteEntrySchema.safeParse({ type: 'remote', url: 'http://127.0.0.1:8787/mcp', enbled: true }).success,
    ).toBe(false);
  });

  test('a config document parses with mcp + instructions', () => {
    const parsed = OpenCodeConfigDocumentSchema.safeParse({
      $schema: 'https://opencode.ai/config.json',
      mcp: { onememory: { type: 'remote', url: 'http://127.0.0.1:8787/mcp', enabled: true } },
      instructions: ['.opencode/onememory.md'],
    });
    expect(parsed.success).toBe(true);
    expect(OpenCodeConfigDocumentSchema.safeParse({ instructions: 'AGENTS.md' }).success).toBe(false);
  });
});
