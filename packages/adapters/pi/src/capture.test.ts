/**
 * Capture-pipeline tests: translate → path-exclude → redact → deliver against the fake daemon.
 * The security boundary is the point: excluded paths never leave the process, redaction failures
 * are drops (never unredacted sends), and the sentinel-prefixed injection never loops back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { buildSessionInjection, capturePiEvent } from './capture';
import { startFakeDaemon, writeOnememoryProject, writeProjectWithoutDaemon, bashToolResultEvent, userMessageEndEvent, sessionStartEvent, FIXTURE_PROJECT_ID, FIXTURE_CWD } from './testing';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-pi-capture-'));
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

describe('capturePiEvent', () => {
  test('translates, redacts, and delivers one tool event end-to-end', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await capturePiEvent(
        bashToolResultEvent({ command: 'bun test' }, { output: '12 pass', exitCode: 0 }),
        { cwd: root, projectId: FIXTURE_PROJECT_ID, env: {} },
      );
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.stored).toBe(1);
      expect(outcome.delivered).toHaveLength(1);
      expect(outcome.delivered[0]!.kind).toBe('terminal.output');
      expect(daemon.receivedEvents).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('a secret in the command output is redacted before it leaves the process', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await capturePiEvent(
        bashToolResultEvent(
          { command: `curl -H "Authorization: Bearer ${FAKE_KEY}" https://example.invalid` },
          { output: 'HTTP 200', exitCode: 0 },
        ),
        { cwd: root, projectId: FIXTURE_PROJECT_ID, env: {} },
      );
      expect(outcome.delivery.ok).toBeTrue();
      const sent = JSON.stringify(daemon.receivedEvents);
      expect(sent).not.toContain(FAKE_KEY);
      expect(sent).not.toContain('sk-ant-');
      expect(outcome.delivered[0]!.redactions.length).toBeGreaterThan(0);
    } finally {
      await daemon.close();
    }
  });

  test('an excluded path (.env edit) never leaves the process', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await capturePiEvent(
        {
          type: 'tool_result',
          toolCallId: 'call_env',
          toolName: 'write',
          input: { path: `${FIXTURE_CWD}/.env`, content: 'API_KEY=secret' },
          content: [{ type: 'text', text: 'Successfully wrote to .env' }],
          isError: false,
        },
        { cwd: root, projectId: FIXTURE_PROJECT_ID, env: {} },
      );
      expect(outcome.excluded).toBe(1);
      expect(outcome.delivered).toHaveLength(0);
      expect(daemon.receivedEvents).toHaveLength(0);
      expect(outcome.dropped).toContainEqual({ reason: 'excluded-path:file.changed', count: 1 });
    } finally {
      await daemon.close();
    }
  });

  test('session and message events flow with the same pipeline', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      await capturePiEvent(sessionStartEvent(), { cwd: root, projectId: FIXTURE_PROJECT_ID, env: {} });
      const outcome = await capturePiEvent(userMessageEndEvent('Remember that PGlite is the embedded engine'), {
        cwd: root,
        projectId: FIXTURE_PROJECT_ID,
        env: {},
      });
      expect(outcome.delivery.ok).toBeTrue();
      expect(outcome.delivered.map((event) => event.kind)).toEqual(['explicit.remember']);
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

  test('an unreachable daemon → no injection, no error (fail-soft)', async () => {
    writeProjectWithoutDaemon(root);
    const injection = await buildSessionInjection({ cwd: root, env: {} });
    expect(injection.text).toBeNull();
  });
});
