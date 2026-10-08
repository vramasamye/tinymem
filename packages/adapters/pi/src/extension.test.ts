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

import { createPiExtension, PI_CONTEXT_SECTION, type PiExtensionApi, type PiExtensionContext } from './extension';
import {
  bashToolResultEvent,
  beforeAgentStartEvent,
  beforeAgentStartEventWithoutOptions,
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
    // Real pi 1.0.4 (verified live, mission 23): sendUserMessage "always triggers a turn" and can
    // only queue via deliverAs WHILE STREAMING. At before_agent_start the agent is *processing*
    // the prompt, and the call throws — the failure that killed every `pi -p` run.
    if (this.processing) {
      throw new Error(
        'Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.',
      );
    }
    this.sent.push({ content, ...(options === undefined ? {} : { deliverAs: options.deliverAs }) });
  }

  /** True while a before_agent_start handler runs — pi is processing the prompt then. */
  processing = false;

  async fire(event: unknown, ctx: PiExtensionContext): Promise<void> {
    const list = this.handlers.get((event as { type: string }).type) ?? [];
    const previous = this.processing;
    if ((event as { type: string }).type === 'before_agent_start') this.processing = true;
    try {
      for (const handler of list) {
        await handler(event as never, ctx);
      }
    } finally {
      this.processing = previous;
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
  test('the first before_agent_start of a session injects as a system-prompt section — sendUserMessage would throw (real pi 1.0.4)', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    const event = beforeAgentStartEvent('fix the tests');
    // Real pi is processing the prompt at before_agent_start; the old steer channel threw here
    // and killed the turn. The handler must not throw and must not call sendUserMessage.
    await pi.fire(event, extensionCtx(root, 'sess_inj'));
    expect(pi.sent).toHaveLength(0);
    expect(event.systemPromptOptions.sections[PI_CONTEXT_SECTION]).toContain('[onememory:project-memory-context]');
    expect(event.systemPromptOptions.sections[PI_CONTEXT_SECTION]).toContain('PostgreSQL with pgvector');
  });

  test('every agent start re-applies the section, but the daemon is fetched once per session', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    const contextFetches = () =>
      daemon.requests.filter((request) => request.method === 'GET' && request.path.endsWith('/context')).length;
    const before = contextFetches();
    const first = beforeAgentStartEvent('fix the tests');
    const second = beforeAgentStartEvent('also the lints');
    await pi.fire(first, extensionCtx(root, 'sess_re'));
    await pi.fire(second, extensionCtx(root, 'sess_re'));
    // pi re-normalizes systemPromptOptions per agent run, so both runs must carry the section…
    expect(first.systemPromptOptions.sections[PI_CONTEXT_SECTION]).toContain('[onememory:project-memory-context]');
    expect(second.systemPromptOptions.sections[PI_CONTEXT_SECTION]).toContain('[onememory:project-memory-context]');
    // …while the context is fetched from the daemon exactly once for the session.
    expect(contextFetches()).toBe(before + 1);

    const freshSession = beforeAgentStartEvent('new session');
    await pi.fire(freshSession, extensionCtx(root, 'sess_re_2'));
    expect(contextFetches()).toBe(before + 2); // a new session fetches again
  });

  test('a pi without the systemPromptOptions surface fails soft: no throw, no injection, no message', async () => {
    const pi = new FakePi();
    createPiExtension(pi, { env: {} });
    await expect(
      pi.fire(beforeAgentStartEventWithoutOptions('hello'), extensionCtx(root, 'sess_old')),
    ).resolves.toBeUndefined();
    expect(pi.sent).toHaveLength(0);
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
