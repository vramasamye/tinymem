/**
 * Capture-pipeline tests: translate → path-exclude → redact → deliver against the fake daemon.
 * The security boundary is the point: excluded paths never leave the process, secrets are
 * redacted before delivery, and the sentinel-prefixed injection never loops back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  buildSessionInjection,
  captureOpenCodeChatMessage,
  captureOpenCodeEvent,
  captureOpenCodeToolAfter,
  deliveryDiagnostic,
} from './capture';
import { createOpenCodeTranslator } from './translate';
import {
  bashToolAfter,
  chatMessageHook,
  eventHookInput,
  sessionCreatedEvent,
  startFakeDaemon,
  textPartUpdatedEvent,
  writeToolAfter,
  writeOnememoryProject,
  writeProjectWithoutDaemon,
  FIXTURE_PROJECT_ID,
  FIXTURE_CWD,
} from './testing';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-opencode-capture-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A synthetic Anthropic-key-shaped credential assembled at runtime — `sk-ant-` plus a repeated
 * character, the same convention as the security package's own fixtures
 * (packages/security/src/redactor.test.ts). Never a real credential, and the complete literal
 * never appears in this source; the joined value still exercises the anthropic-key redaction
 * pattern (packages/security/src/patterns.ts).
 */
const FAKE_KEY = `sk-ant-${'b'.repeat(40)}`;

const options = (): { cwd: string; projectId: string; projectRoot: string; env: Record<string, string> } => ({
  cwd: root,
  projectId: FIXTURE_PROJECT_ID,
  projectRoot: FIXTURE_CWD,
  env: {},
});

describe('captureOpenCode* — the pipeline against the fake daemon', () => {
  test('event hook: session.created is translated, redacted, and delivered', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await captureOpenCodeEvent(eventHookInput(sessionCreatedEvent()), options());
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.stored).toBe(1);
      expect(outcome.delivered).toHaveLength(1);
      expect(outcome.delivered[0]!.kind).toBe('session.start');
      expect(daemon.receivedEvents).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('tool hook: bash exit 0 delivers exactly one terminal.output', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = bashToolAfter({ command: 'bun test' }, { output: '96 pass', exit: 0 });
      const outcome = await captureOpenCodeToolAfter(pair.input, pair.output, options());
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.stored).toBe(1);
      expect(outcome.delivered.map((event) => event.kind)).toEqual(['terminal.output']);
    } finally {
      await daemon.close();
    }
  });

  test('chat hook: a remember request is captured as explicit.remember', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = chatMessageHook('Remember that OpenCode maps session.idle to session.end');
      const outcome = await captureOpenCodeChatMessage(pair.input, pair.output, options());
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.delivered.map((event) => event.kind)).toEqual(['explicit.remember']);
    } finally {
      await daemon.close();
    }
  });

  test('the claimed user message part never double-captures through the event hook', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      // ONE translator per plugin (the claim set is instance state, like the real plugin holds).
      const translator = createOpenCodeTranslator(options());
      const translatorOptions = { ...options(), translator };
      const chatPair = chatMessageHook('user text that must be captured once');
      const first = await captureOpenCodeChatMessage(chatPair.input, chatPair.output, translatorOptions);
      expect(first.stored).toBe(1);
      const part = await captureOpenCodeEvent(
        eventHookInput(
          textPartUpdatedEvent('user text that must be captured once', {
            messageID: 'msg_user_01JOPENCODEFIXTURE00',
          }),
        ),
        translatorOptions,
      );
      expect(part.stored).toBe(0);
      expect(part.dropped).toContainEqual({ reason: 'user_message_via_chat_hook', count: 1 });
      expect(daemon.receivedEvents).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('a secret in a bash command is redacted before it leaves the process', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = bashToolAfter(
        { command: `curl -H "Authorization: Bearer ${FAKE_KEY}" https://example.invalid` },
        { output: 'HTTP 200', exit: 0 },
      );
      const outcome = await captureOpenCodeToolAfter(pair.input, pair.output, options());
      expect(outcome.delivery.ok).toBeTrue();
      const sent = JSON.stringify(daemon.receivedEvents);
      expect(sent).not.toContain(FAKE_KEY);
      expect(sent).not.toContain('sk-ant-');
      expect(outcome.delivered[0]!.redactions.length).toBeGreaterThan(0);
    } finally {
      await daemon.close();
    }
  });

  test('a secret in the user message text is redacted before it leaves the process', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = chatMessageHook(`deploy with the key ${FAKE_KEY} please`);
      const outcome = await captureOpenCodeChatMessage(pair.input, pair.output, options());
      expect(outcome.delivery.ok).toBeTrue();
      const sent = JSON.stringify(daemon.receivedEvents);
      expect(sent).not.toContain(FAKE_KEY);
      expect(sent).not.toContain('sk-ant-');
    } finally {
      await daemon.close();
    }
  });

  test('an excluded path (a .env write) never leaves the process', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = writeToolAfter({ filePath: `${FIXTURE_CWD}/.env`, content: 'API_KEY=secret' }, { exists: false });
      const outcome = await captureOpenCodeToolAfter(pair.input, pair.output, options());
      expect(outcome.excluded).toBe(1);
      expect(outcome.delivered).toHaveLength(0);
      expect(daemon.receivedEvents).toHaveLength(0);
      expect(outcome.dropped).toContainEqual({ reason: 'excluded-path:file.changed', count: 1 });
    } finally {
      await daemon.close();
    }
  });

  test('no daemon → {ok:false} no-daemon (fail-soft: never a throw, never a block)', async () => {
    writeProjectWithoutDaemon(root);
    const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
    const outcome = await captureOpenCodeToolAfter(pair.input, pair.output, { ...options(), timeoutMs: 300 });
    expect(outcome.delivery.ok).toBeFalse();
    if (outcome.delivery.ok) return;
    expect(['no-daemon', 'unreachable', 'timeout']).toContain(outcome.delivery.code);
    expect(deliveryDiagnostic(outcome.delivery)).toContain('[onememory] capture skipped');
  });

  test('a daemon 500 is http-error, and the daemon-reported duplicates ride the outcome', async () => {
    const daemon = await startFakeDaemon({ failIngest: true });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = bashToolAfter({ command: 'ls' }, { output: '', exit: 0 });
      const outcome = await captureOpenCodeToolAfter(pair.input, pair.output, options());
      expect(outcome.delivery).toMatchObject({ ok: false, code: 'http-error' });
      expect(outcome.stored).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  test('re-capturing identical content is reported as a duplicate (the daemon decides)', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const pair = bashToolAfter({ command: 'bun test' }, { output: 'ok', exit: 0 });
      await captureOpenCodeToolAfter(pair.input, pair.output, options());
      const again = await captureOpenCodeToolAfter(pair.input, pair.output, options());
      expect(again.delivery.ok).toBeTrue();
      expect(again.duplicates).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  test('malformed payloads are counted drops, never throws', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await captureOpenCodeEvent({}, options());
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.delivered).toHaveLength(0);
      expect(outcome.dropped).toEqual([{ reason: 'malformed_event_wrapper', count: 1 }]);
    } finally {
      await daemon.close();
    }
  });
});

describe('buildSessionInjection', () => {
  test('fetches the context and prefixes the sentinel', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- PGlite everywhere.' });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const injection = await buildSessionInjection({ cwd: root, env: {} }, { budget: 750 });
      expect(typeof injection.text).toBe('string');
      expect((injection.text ?? '').startsWith('[onememory:project-memory-context]')).toBeTrue();
    } finally {
      await daemon.close();
    }
  });

  test('an empty context is no injection (zero-cost absence)', async () => {
    const daemon = await startFakeDaemon({ contextText: '   ' });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const injection = await buildSessionInjection({ cwd: root, env: {} }, { budget: 750 });
      expect(injection.text).toBeNull();
    } finally {
      await daemon.close();
    }
  });

  test('an unreachable daemon → no injection, no error (fail-soft)', async () => {
    writeProjectWithoutDaemon(root);
    const injection = await buildSessionInjection({ cwd: root, env: {}, timeoutMs: 300 });
    expect(injection.text).toBeNull();
  });
});
