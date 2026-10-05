/**
 * `createPiExtension` wiring tests: a fake Pi `ExtensionAPI` records registrations; a loopback fake
 * daemon receives what the handlers deliver. The git-commit enrichment path runs against a real
 * throwaway git repository (the only honest way to prove the [branch sha] ↔ HEAD agreement gate).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createPiExtension, type PiExtensionApi, type PiExtensionContext } from './extension';
import {
  bashToolResultEvent,
  sessionStartEvent,
  startFakeDaemon,
  writeOnememoryProject,
} from './testing';

/** Records registrations and lets tests fire events the way Pi would. */
class FakePi implements PiExtensionApi {
  readonly handlers = new Map<string, Array<(event: never, ctx: PiExtensionContext) => Promise<void> | void>>();
  readonly sent: Array<{ content: string; deliverAs?: string }> = [];

  on(
    event: string,
    handler: (event: never, ctx: PiExtensionContext) => Promise<void> | void,
  ): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const next = (this.handlers.get(event) ?? []).filter((h) => h !== handler);
      this.handlers.set(event, next);
    };
  }

  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void {
    this.sent.push({ content, ...(options === undefined ? {} : { deliverAs: options.deliverAs }) });
  }

  async fire(event: unknown, ctx: PiExtensionContext): Promise<void> {
    const list = this.handlers.get((event as { type: string }).type) ?? [];
    for (const handler of list) {
      await handler(event as never, ctx);
    }
  }
}

function extensionCtx(root: string, sessionId = 'sess_1'): PiExtensionContext {
  return {
    cwd: root,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, 'session.json') },
    mode: 'tui',
    ui: { notify: () => {} },
  };
}

let root: string;
let daemon: Awaited<ReturnType<typeof startFakeDaemon>>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'onemem-pi-ext-'));
  daemon = await startFakeDaemon();
  writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
});

afterAll(async () => {
  await daemon.close();
  rmSync(root, { recursive: true, force: true });
});

describe('createPiExtension — registration', () => {
  test('registers exactly the five documented capture handlers', () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    expect([...pi.handlers.keys()].sort()).toEqual(
      ['before_agent_start', 'message_end', 'session_shutdown', 'session_start', 'tool_result'].sort(),
    );
  });
});

describe('createPiExtension — capture', () => {
  test('session_start lands at the daemon as a session.start event', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    await pi.fire(sessionStartEvent(), extensionCtx(root));
    expect(daemon.receivedEvents.at(-1)).toMatchObject({
      kind: 'session.start',
      source: { runtime: 'pi' },
      scope: { session_id: 'sess_1' },
    });
  });

  test('bash tool results flow through the same pipeline', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    await pi.fire(
      bashToolResultEvent({ command: 'bun test packages/adapters/pi' }, { output: 'all pass', exitCode: 0 }),
      extensionCtx(root),
    );
    expect(daemon.receivedEvents.at(-1)).toMatchObject({
      kind: 'terminal.output',
      payload: { command: 'bun test packages/adapters/pi', exit_code: 0 },
    });
  });

  test('a git commit bash result is enriched into a git.commit event (real repo)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'onemem-pi-git-'));
    try {
      const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
      git(['init', '--quiet', '--initial-branch=main']);
      writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf8');
      git(['add', 'README.md']);
      git(['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--quiet', '-m', 'feat(pi): first']);
      const shortSha = git(['rev-parse', '--short', 'HEAD']).trim();
      // Delivery discovers the project from the session cwd, so the repo needs its own world.
      writeOnememoryProject(repo, { url: daemon.url, pid: process.pid });
      const subject = git(['log', '-1', '--pretty=%s']).trim();

      const pi = new FakePi();
      createPiExtension(pi, { env: {} });
      await pi.fire(
        bashToolResultEvent(
          { command: 'git commit -m "feat(pi): first"' },
          { output: `[main ${shortSha}] ${subject}\n 1 file changed, 1 insertion(+)`, exitCode: 0 },
        ),
        extensionCtx(repo, 'sess_git'),
      );
      const kinds = daemon.receivedEvents.slice(-2).map((event) => event.kind);
      expect(kinds).toEqual(['terminal.output', 'git.commit']);
      expect(daemon.receivedEvents.at(-1)).toMatchObject({
        payload: { sha: expect.stringMatching(/^[0-9a-f]{40}$/), author_name: 'Dev', message: subject },
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('createPiExtension — session context injection', () => {
  test('the first before_agent_start of a session injects once, as a steering user message', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    await pi.fire({ type: 'before_agent_start', prompt: 'fix the tests' }, extensionCtx(root, 'sess_inj'));
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]!.deliverAs).toBe('steer');
    expect(pi.sent[0]!.content).toContain('[onememory:project-memory-context]');

    await pi.fire({ type: 'before_agent_start', prompt: 'also the lints' }, extensionCtx(root, 'sess_inj'));
    expect(pi.sent).toHaveLength(1); // once per session

    await pi.fire({ type: 'before_agent_start', prompt: 'new session' }, extensionCtx(root, 'sess_inj_2'));
    expect(pi.sent).toHaveLength(2); // a new session injects again
  });

  test('an unreachable daemon never blocks the prompt (no send, no throw)', async () => {
    const orphan = mkdtempSync(join(tmpdir(), 'onemem-pi-orphanproj-'));
    try {
      // No .onememory project here: discovery fails → injection is a no-op.
      const pi = new FakePi();
      createPiExtension(pi, { env: {} });
      await expect(
        pi.fire({ type: 'before_agent_start', prompt: 'hello' }, extensionCtx(orphan, 'sess_none')),
      ).resolves.toBeUndefined();
      expect(pi.sent).toHaveLength(0);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  test('capture failures are reported, never thrown (the fail-soft contract)', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    // A directory with no onememory project: delivery resolves {ok:false}; the handler must not throw.
    const orphan = mkdtempSync(join(tmpdir(), 'onemem-pi-noconf-'));
    try {
      await expect(
        pi.fire(bashToolResultEvent({ command: 'bun test' }, { output: 'ok', exitCode: 0 }), extensionCtx(orphan, 'sess_x')),
      ).resolves.toBeUndefined();
      expect(pi.sent).toHaveLength(0);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
