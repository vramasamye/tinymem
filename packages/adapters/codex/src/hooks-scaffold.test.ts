import { describe, expect, test } from 'bun:test';

import {
  buildCodexHooksFile,
  patchCodexHooksJson,
  PROJECT_CAPTURE_COMMAND,
  renderCodexHooksJson,
} from './hooks-scaffold';

describe('buildCodexHooksFile', () => {
  test('registers the five verified hook events with one capture command', () => {
    const file = buildCodexHooksFile();
    expect(Object.keys(file.hooks!).sort()).toEqual([
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    const handlers = JSON.stringify(file);
    expect(handlers).not.toContain('onemem-mcp'); // the MCP bin never captures
    expect(handlers).toContain('onemem-codex-capture');
  });

  test('the default capture command resolves the published bin in the project (no PATH assumption)', () => {
    const file = buildCodexHooksFile();
    for (const group of Object.values(file.hooks!)) {
      for (const matcher of group) {
        for (const handler of matcher.hooks) {
          expect(handler.command).toBe(PROJECT_CAPTURE_COMMAND);
          expect(handler.command).toContain('node_modules/.bin/onemem-codex-capture');
          // Codex runs hook commands through a shell with the session cwd, and documents
          // git-root resolution for repo-local hooks ("Codex may be started from a
          // subdirectory"); the pwd fallback covers non-git projects launched at the root.
          expect(handler.command).toContain('git rev-parse --show-toplevel');
          expect(handler.command).not.toMatch(/src\//);
        }
      }
    }
  });

  test('SessionStart runs synchronously with a bounded timeout (it injects context)', () => {
    const start = buildCodexHooksFile().hooks!['SessionStart']!;
    const handler = start[0]!.hooks[0]!;
    expect(handler.async).toBeUndefined();
    expect(handler.timeout).toBe(10);
    expect(handler.statusMessage).toBe('Loading onememory project context');
  });

  test('capture handlers run async so they can never block the agent', () => {
    const file = buildCodexHooksFile();
    for (const group of [...file.hooks!['UserPromptSubmit']!, ...file.hooks!['PostToolUse']!, ...file.hooks!['Stop']!]) {
      for (const handler of group.hooks) {
        expect(handler.async).toBe(true);
      }
    }
  });

  test('SessionEnd stays inside Codex’s 3s synchronous ceiling', () => {
    const end = buildCodexHooksFile().hooks!['SessionEnd']!;
    expect(end[0]!.hooks[0]!.timeout).toBeLessThanOrEqual(3);
    expect(end[0]!.hooks[0]!.async).toBeUndefined();
  });

  test('PostToolUse matchers cover Bash and the apply_patch aliases', () => {
    const matchers = buildCodexHooksFile().hooks!['PostToolUse']!.map((group) => group.matcher);
    expect(matchers).toContain('^Bash$');
    expect(matchers).toContain('^(apply_patch|Edit|Write)$');
  });

  test('handlers can be individually disabled', () => {
    const file = buildCodexHooksFile({ includeSessionStart: false, includeCapture: false });
    expect(file.hooks).toEqual({});
  });
});

describe('patchCodexHooksJson', () => {
  test('creates the file when empty', () => {
    const result = patchCodexHooksJson('');
    expect('error' in result).toBe(false);
    const created = result as { content: string; action: string };
    expect(created.action).toBe('created');
    expect(JSON.parse(created.content).hooks.SessionStart).toBeDefined();
  });

  test('merging into a user hooks.json preserves other tools and is idempotent', () => {
    const existing = JSON.stringify(
      {
        description: 'team policy hooks',
        hooks: {
          PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'python3 policy.py' }] }],
          PostToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'python3 review.py' }] }],
        },
      },
      null,
      2,
    );
    const first = patchCodexHooksJson(existing);
    expect('error' in first).toBe(false);
    const patched = first as { content: string; action: string };
    expect(patched.action).toBe('patched');
    const merged = JSON.parse(patched.content);
    expect(merged.description).toBe('team policy hooks');
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe('python3 policy.py');
    // PostToolUse carries the user's group AND ours.
    expect(merged.hooks.PostToolUse).toHaveLength(3);
    expect(merged.hooks.PostToolUse[0].hooks[0].command).toBe('python3 review.py');
    expect(merged.hooks.PostToolUse[0].hooks[0].command).not.toContain('onememory');

    const second = patchCodexHooksJson(patched.content);
    expect((second as { content: string; action: string }).action).toBe('unchanged');
    const remerged = JSON.parse((second as { content: string }).content);
    expect(remerged.hooks.PostToolUse).toHaveLength(3);
  });

  test('replaces its own stale handlers with the current ones (old default and stray flags)', () => {
    const stale = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'onemem-codex-capture --old-flag' }] }],
      },
    });
    const result = patchCodexHooksJson(stale) as { content: string };
    const merged = JSON.parse(result.content);
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe(PROJECT_CAPTURE_COMMAND);
  });

  test('a config from the previous default (bare bin name on PATH) migrates without duplicates', () => {
    // Before the published-layout contract, init scaffolded the bare bin name, assuming PATH.
    // Re-running init must replace those handlers with the current command, never duplicate them.
    const previous = JSON.stringify({
      description: 'onememory capture hooks (generated by onemem init)',
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'onemem-codex-capture', timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'onemem-codex-capture', async: true, timeout: 30 }] }],
      },
    });
    const result = patchCodexHooksJson(previous) as { content: string; action: string };
    const merged = JSON.parse(result.content);
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.SessionStart[0].hooks[0].command).toBe(PROJECT_CAPTURE_COMMAND);
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe(PROJECT_CAPTURE_COMMAND);
    // And the migrated file is stable: a third pass changes nothing.
    expect((patchCodexHooksJson(result.content) as { action: string }).action).toBe('unchanged');
  });

  test('a custom capture command replaces entries registered with that command', () => {
    const existing = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/opt/onemem/capture.js' }] }] },
    });
    const result = patchCodexHooksJson(existing, { captureCommand: '/opt/onemem/capture.js' }) as { content: string };
    const merged = JSON.parse(result.content);
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.Stop[0].hooks[0].command).toBe('/opt/onemem/capture.js');
  });

  test('an unparseable hooks.json is reported and left untouched', () => {
    const broken = '{ not json';
    const result = patchCodexHooksJson(broken);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('left untouched');
  });

  test('a hooks.json without a hooks object is reported and left untouched', () => {
    const result = patchCodexHooksJson('{"description": "x"}');
    expect('error' in result).toBe(true);
  });

  test('renderCodexHooksJson round-trips through JSON.parse', () => {
    expect(() => JSON.parse(renderCodexHooksJson())).not.toThrow();
  });
});
