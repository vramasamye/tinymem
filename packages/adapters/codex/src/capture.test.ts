import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSessionStartOutput,
  captureHook,
  captureRollout,
  deliveryDiagnostic,
  deliverySummary,
  type CaptureOutcome,
} from './capture';
import {
  bashToolResponse,
  FIXTURE_PROJECT_ID,
  goldenRollout,
  postToolUseHookInput,
  sessionStartHookInput,
  startFakeDaemon,
  userPromptSubmitHookInput,
  writeOnememoryProject,
} from './testing';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-codex-cap-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Count drops for a reason prefix (excluded paths are ledgered as `excluded-path:<kind>`). */
function dropCount(outcome: CaptureOutcome, prefix: string): number {
  return outcome.dropped
    .filter((record) => record.reason.startsWith(prefix))
    .reduce((sum, record) => sum + record.count, 0);
}

/**
 * A credential in every family the security package knows: any of these reaching the daemon
 * would be a P1 leak, so the firewall tests use realistic shapes.
 */
const SECRET = `sk-ant-${'b'.repeat(40)}`;

describe('captureHook — the redaction firewall', () => {
  test('a secret in a hook payload never reaches the daemon', async () => {
    const daemon = await startFakeDaemon();
    try {
      const outcome = await captureHook(
        postToolUseHookInput({
          name: 'Bash',
          input: { command: `openai api test --key ${SECRET}` },
          response: bashToolResponse(`accepted: ${SECRET}`, 0),
        }),
        { env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID } },
      );
      expect(outcome.stored).toBeGreaterThan(0);
      const wire = JSON.stringify(daemon.receivedEvents);
      expect(wire).not.toContain('sk-ant-');
      expect(wire).toContain('[REDACTED');
    } finally {
      await daemon.close();
    }
  });

  test('already-redacted payloads reach a redaction fixpoint (no nested markers, no regrowth)', async () => {
    const daemon = await startFakeDaemon();
    try {
      const outcome = await captureHook(
        postToolUseHookInput({
          name: 'Bash',
          input: { command: 'deploy' },
          response: bashToolResponse('key=[REDACTED::api_key] then [REDACTED:api-key]', 0),
        }),
        { env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID } },
      );
      expect(outcome.stored).toBe(1);
      const digest = (daemon.receivedEvents[0] as { payload: { output_digest: string } }).payload.output_digest;
      // The security package canonicalizes `::` to `:` on first redaction; the result must be a
      // fixpoint: re-redacting (the daemon redacts again on arrival) changes nothing and never
      // nests a marker inside a marker.
      expect(digest).not.toMatch(/REDACTED[^[\]]*REDACTED/);
      expect(digest).toContain('[REDACTED:api-key]');
    } finally {
      await daemon.close();
    }
  });

  test('path-excluded events are filtered before delivery (never sent)', async () => {
    const daemon = await startFakeDaemon();
    try {
      const outcome = await captureHook(
        postToolUseHookInput({
          name: 'apply_patch',
          input: { command: '*** Begin Patch\n*** Update File: .env\n+API_KEY=1\n*** End Patch' },
          response: 'Success',
        }),
        { env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID } },
      );
      expect(outcome.stored).toBe(0);
      expect(outcome.excluded).toBe(1);
      expect(dropCount(outcome, 'excluded-path:')).toBe(1);
      expect(daemon.requests).toHaveLength(0); // nothing was even attempted
    } finally {
      await daemon.close();
    }
  });

  test('exclusion matches exact paths, not substrings', async () => {
    const daemon = await startFakeDaemon();
    try {
      // A file path that CONTAINS ".env" inside a different component must still be captured —
      // the exclusion list is exact (".env", key files), not a substring filter.
      const outcome = await captureHook(
        postToolUseHookInput({
          name: 'apply_patch',
          input: {
            command:
              '*** Begin Patch\n*** Update File: src/env.loader.test.ts\n+it(".env is excluded")\n*** End Patch',
          },
          response: 'Success',
        }),
        { env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID } },
      );
      expect(outcome.excluded).toBe(0);
      expect(outcome.stored).toBe(1);
    } finally {
      await daemon.close();
    }
  });
});

describe('captureHook — delivery outcomes', () => {
  test('no daemon at all is a quiet, counted no-op (the bin still exits 0)', async () => {
    const outcome = await captureHook(sessionStartHookInput(), { cwd: tempDir(), env: {}, timeoutMs: 250 });
    const delivery = outcome.delivery;
    expect(delivery.ok).toBe(false);
    if (delivery.ok) throw new Error('unreachable');
    expect(delivery.code).toBe('no-config');
    expect(outcome.stored).toBe(0);
    expect(deliveryDiagnostic(delivery)).toContain('onemem init');
  });

  test('an HTTP failure is fail-soft: reported, never thrown', async () => {
    const daemon = await startFakeDaemon({ failIngest: true });
    try {
      const outcome = await captureHook(userPromptSubmitHookInput('hello'), {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(outcome.delivery.ok).toBe(false);
      if (!outcome.delivery.ok) expect(outcome.delivery.code).toBe('http-error');
      expect(outcome.stored).toBe(0);
      expect(dropCount(outcome, 'redaction-failed')).toBe(0); // the events were safe; delivery failed
    } finally {
      await daemon.close();
    }
  });

  test('capture works via filesystem discovery (no env hints)', async () => {
    const daemon = await startFakeDaemon();
    try {
      const root = tempDir();
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const outcome = await captureHook(userPromptSubmitHookInput('decide the storage layer'), {
        cwd: root,
        env: {},
      });
      expect(outcome.stored).toBe(1);
      expect(daemon.receivedEvents).toHaveLength(1);
      expect((daemon.receivedEvents[0] as { payload: { kind: string } }).payload.kind).toBe('conversation.message');
    } finally {
      await daemon.close();
    }
  });
});

describe('captureRollout — backfill', () => {
  test('delivers the golden rollout through the same firewall', async () => {
    const daemon = await startFakeDaemon();
    try {
      const outcome = await captureRollout(goldenRollout(), {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(outcome.delivery.ok).toBe(true);
      expect(outcome.stored).toBeGreaterThan(5);
      const wire = JSON.stringify(daemon.receivedEvents);
      expect(wire).not.toContain('sk-ant-');
      const kinds = daemon.receivedEvents.map((event) => (event as { kind: string }).kind);
      expect(kinds).toContain('session.start');
      expect(kinds).toContain('terminal.output');
      expect(kinds).toContain('file.changed');
      expect(kinds).toContain('conversation.message');
      expect(kinds).toContain('error.raised');
    } finally {
      await daemon.close();
    }
  });

  test('duplicates across two backfills are the daemon’s call, not ours', async () => {
    const daemon = await startFakeDaemon();
    try {
      const env = { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID };
      const first = await captureRollout(goldenRollout(), { env });
      const again = await captureRollout(goldenRollout(), { env });
      expect(first.stored).toBeGreaterThan(0);
      // Second pass: every event is content-identical → the daemon reports duplicates.
      expect(again.delivery.ok).toBe(true);
      expect(again.duplicates).toBe(again.delivered.length);
      expect(again.stored).toBe(0);
      expect(
        daemon.receivedEvents.filter((event) => (event as { kind: string }).kind === 'session.start'),
      ).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('an empty rollout is a quiet no-op', async () => {
    const outcome = await captureRollout('', {
      env: { ONEMEMORY_DAEMON_URL: 'http://127.0.0.1:9', ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      timeoutMs: 50,
    });
    expect(outcome.delivery.ok).toBe(true);
    expect(outcome.delivered).toHaveLength(0);
  });
});

describe('buildSessionStartOutput — context injection', () => {
  test('injects packed project context under the marker as additionalContext', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- pgvector only. Never MySQL.' });
    try {
      const result = await buildSessionStartOutput(sessionStartHookInput(), {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.output).not.toBeNull();
      const injected = result.output?.hookSpecificOutput?.additionalContext;
      expect(injected).toBeDefined();
      expect(injected).toContain('pgvector only');
      expect(() => JSON.parse(JSON.stringify(result.output))).not.toThrow();
      // The session.start event itself was captured too.
      expect(result.capture.stored).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  test('missing daemon yields a hook output with no additionalContext (the session still runs)', async () => {
    const result = await buildSessionStartOutput(sessionStartHookInput(), {
      cwd: tempDir(),
      env: {},
      timeoutMs: 200,
    });
    expect(result.output).toBeNull();
    expect(result.contextText).toBeNull();
  });

  test('context text is clamped to the injection budget', async () => {
    const daemon = await startFakeDaemon({ contextText: 'x'.repeat(9_000) });
    try {
      const result = await buildSessionStartOutput(sessionStartHookInput(), {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      const injected = result.output?.hookSpecificOutput?.additionalContext;
      expect(injected).toBeDefined();
      expect(injected!.length).toBeLessThanOrEqual(6_200);
    } finally {
      await daemon.close();
    }
  });

  test('deliverySummary/deliveryDiagnostic cover every fail-soft mode', () => {
    const codes = [
      'no-config',
      'no-project',
      'no-daemon',
      'stale-lock',
      'timeout',
      'unreachable',
      'http-error',
      'bad-response',
    ] as const;
    for (const code of codes) {
      const line = deliveryDiagnostic({ ok: false, code, message: `why (${code})` });
      expect(line).toContain('[onememory]');
      expect(line).toContain(code);
      expect(line).toContain('why');
    }
    expect(
      deliverySummary({
        response: { stored: 3, duplicates: 1, excluded: 0, dead_lettered: 0 },
      }),
    ).toBe('[onememory] captured 3 event(s), 1 duplicate(s)');
  });
});
