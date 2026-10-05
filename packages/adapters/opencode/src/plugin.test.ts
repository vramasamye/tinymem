/**
 * Plugin tests: `createOpenCodePlugin()` returns the hook surface OpenCode loads; every hook is
 * wired to capture/injection, holds ONE translator (the claim set), and is fail-soft (a broken
 * payload or an unreachable daemon is a diagnostic, never a thrown hook error).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createOpenCodePlugin,
  DEFAULT_CONTEXT_BUDGET,
  MAX_CONTEXT_BUDGET,
  type OpenCodePluginContext,
} from './plugin';
import {
  bashToolAfter,
  chatMessageHook,
  eventHookInput,
  sessionCreatedEvent,
  startFakeDaemon,
  textPartUpdatedEvent,
  writeOnememoryProject,
  writeProjectWithoutDaemon,
  FIXTURE_PROJECT_ID,
  FIXTURE_SESSION_ID,
} from './testing';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-opencode-plugin-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A recording stand-in for the SDK client's structured logger. */
function recordingContext(): { ctx: OpenCodePluginContext; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    ctx: {
      directory: root,
      client: {
        app: {
          log: async ({ body }: { body: { level?: string; message: string } }) => {
            logs.push({ level: body.level ?? 'info', message: body.message });
          },
        },
      },
    },
    logs,
  };
}

const OPTIONS = { env: {} } as const;

describe('createOpenCodePlugin — the hook surface', () => {
  test('returns the four documented hooks as functions', async () => {
    const { ctx } = recordingContext();
    const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
    expect(typeof hooks['event']).toBe('function');
    expect(typeof hooks['tool.execute.after']).toBe('function');
    expect(typeof hooks['chat.message']).toBe('function');
    expect(typeof hooks['experimental.chat.system.transform']).toBe('function');
  });

  test('the budget constants are exported (the env override clamps into them)', () => {
    expect(DEFAULT_CONTEXT_BUDGET).toBe(750);
    expect(MAX_CONTEXT_BUDGET).toBe(4000);
  });
});

describe('createOpenCodePlugin — capture hooks against the fake daemon', () => {
  test('the event hook delivers a session.start for session.created', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx } = recordingContext();
      const hooks = await createOpenCodePlugin({ ...OPTIONS, projectId: FIXTURE_PROJECT_ID })(ctx);
      await hooks['event']!(eventHookInput(sessionCreatedEvent()));
      expect(daemon.receivedEvents).toHaveLength(1);
      expect(daemon.receivedEvents[0]).toMatchObject({
        kind: 'session.start',
        source: { runtime: 'opencode' },
      });
    } finally {
      await daemon.close();
    }
  });

  test('the tool hook delivers terminal.output + error.raised for a failed bash call', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx } = recordingContext();
      const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
      const pair = bashToolAfter({ command: 'bun test' }, { output: '3 failures', exit: 1 });
      await hooks['tool.execute.after']!(pair.input, pair.output);
      expect(daemon.receivedEvents.map((event) => event['kind'])).toEqual(['terminal.output', 'error.raised']);
    } finally {
      await daemon.close();
    }
  });

  test('the chat hook captures the user message ONCE; its parts never double-capture', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx } = recordingContext();
      const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
      const chatPair = chatMessageHook('a user turn');
      await hooks['chat.message']!(chatPair.input, chatPair.output);
      expect(daemon.receivedEvents).toHaveLength(1);
      // The plugin holds ONE translator: the claimed id drops the part channel's copy.
      await hooks['event']!(
        eventHookInput(textPartUpdatedEvent('a user turn', { messageID: 'msg_user_01JOPENCODEFIXTURE00' })),
      );
      expect(daemon.receivedEvents).toHaveLength(1);
      // The assistant's parts on the same session still flow.
      await hooks['event']!(eventHookInput(textPartUpdatedEvent('an assistant turn')));
      expect(daemon.receivedEvents.map((event) => event['kind'])).toEqual([
        'conversation.message',
        'conversation.message',
      ]);
    } finally {
      await daemon.close();
    }
  });
});

describe('createOpenCodePlugin — the injection hook', () => {
  test('injects the sentinel-prefixed context once per session', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- PGlite embedded.' });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx } = recordingContext();
      const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
      const system: string[] = [];
      await hooks['experimental.chat.system.transform']!({ sessionID: FIXTURE_SESSION_ID }, { system });
      expect(system).toHaveLength(1);
      expect(system[0]).toContain('[onememory:project-memory-context]');
      expect(system[0]).toContain('PGlite embedded');
      // Same session: the injection is deduplicated.
      const again: string[] = [];
      await hooks['experimental.chat.system.transform']!({ sessionID: FIXTURE_SESSION_ID }, { system: again });
      expect(again).toHaveLength(0);
      // A different session injects afresh.
      const next: string[] = [];
      await hooks['experimental.chat.system.transform']!({ sessionID: 'ses_other' }, { system: next });
      expect(next).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('an unreachable daemon leaves the system prompt untouched (fail-soft)', async () => {
    writeProjectWithoutDaemon(root);
    const { ctx, logs } = recordingContext();
    const hooks = await createOpenCodePlugin({ ...OPTIONS, contextTimeoutMs: 300 })(ctx);
    const system: string[] = ['you are a senior engineer'];
    await hooks['experimental.chat.system.transform']!({ sessionID: FIXTURE_SESSION_ID }, { system });
    expect(system).toEqual(['you are a senior engineer']);
  });
});

describe('createOpenCodePlugin — fail-soft invariants', () => {
  test('malformed payloads never throw from any hook', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx } = recordingContext();
      const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
      // Deliberately malformed payloads, typed `as never` to bypass the production hook types:
      // fail-soft must hold for garbage too, not just for well-typed-but-invalid input.
      await expect(hooks['event']!({} as never)).resolves.toBeUndefined();
      await expect(hooks['event']!(eventHookInput({}))).resolves.toBeUndefined();
      await expect(hooks['tool.execute.after']!({ tool: 'bash' } as never, {} as never)).resolves.toBeUndefined();
      await expect(hooks['chat.message']!({} as never, {} as never)).resolves.toBeUndefined();
      const system: string[] = [];
      await expect(
        hooks['experimental.chat.system.transform']!({ sessionID: FIXTURE_SESSION_ID }, { system }),
      ).resolves.toBeUndefined();
    } finally {
      await daemon.close();
    }
  });

  test('a failed delivery is one diagnostic through the client logger, value-free', async () => {
    const daemon = await startFakeDaemon({ failIngest: true });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const { ctx, logs } = recordingContext();
      const hooks = await createOpenCodePlugin(OPTIONS)(ctx);
      const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
      await hooks['tool.execute.after']!(pair.input, pair.output);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((entry) => entry.level === 'warn')).toBeTrue();
      expect(logs.map((entry) => entry.message).join('\n')).toContain('[onememory] capture skipped');
    } finally {
      await daemon.close();
    }
  });

  test('an unreachable daemon makes capture a counted no-op, never a throw', async () => {
    writeProjectWithoutDaemon(root);
    const { ctx } = recordingContext();
    const hooks = await createOpenCodePlugin({ ...OPTIONS, deliveryTimeoutMs: 300 })(ctx);
    const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
    await expect(hooks['tool.execute.after']!(pair.input, pair.output)).resolves.toBeUndefined();
  });
});
