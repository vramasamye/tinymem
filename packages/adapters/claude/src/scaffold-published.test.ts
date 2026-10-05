/**
 * The published hook-invocation contract (backlog cross-follow-up #9): a clean EXTERNAL project
 * that installed the published packages must be able to run every generated hook.
 *
 * Each test lays out a temp directory exactly like a clean install — `node_modules/.bin/<name>`
 * symlinked to the real bin entrypoint, the way npm/bun link every `bin` declared in package.json —
 * then takes the generated settings.json/`.mcp.json` documents, expands the `${CLAUDE_PROJECT_DIR}`
 * placeholders the way Claude Code does (plain-string substitution into command/args/env), and
 * SPAWNS the generated command. No monorepo-relative path and no `src/*.ts` assumption may appear.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildClaudeHooksConfig, buildMcpJson, defaultHookCommand, defaultMcpServerCommand } from './scaffolds';

const tempDirs: string[] = [];

function tempProject(): { root: string; binDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'onemem-claude-published-'));
  tempDirs.push(root);
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  // What npm does for a published install: every declared `bin` gets a link in .bin. The
  // symlinked targets are the real entrypoints, executable through their bun shebangs.
  symlinkSync(join(import.meta.dir, 'bin.ts'), join(binDir, 'onemem-claude-hook'));
  symlinkSync(join(import.meta.dir, '..', '..', '..', 'mcp', 'src', 'bin.ts'), join(binDir, 'onemem-mcp'));
  return { root, binDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Expand the placeholder forms Claude Code substitutes as plain strings. */
function expand(text: string, root: string): string {
  return text
    .replaceAll('${CLAUDE_PROJECT_DIR:-.}', root)
    .replaceAll('${CLAUDE_PROJECT_DIR}', root);
}

interface SpawnResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** Any subprocess with piped output, whatever its stdin mode ('pipe' for hooks, 'ignore' for the server). */
type PipedStdoutProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'> | Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** Spawn exactly what Claude Code spawns: exec form (argv, no shell), cwd = the project root. */
function runHookCommand(root: string, command: string, args: readonly string[], stdin: string): Promise<SpawnResult> {
  const proc = Bun.spawn([command, ...args] as [string, ...string[]], {
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(stdin);
  void proc.stdin.end();
  return consume(proc);
}

async function consume(proc: PipedStdoutProcess): Promise<SpawnResult> {
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]);
  return { exitCode, stdout, stderr };
}

describe('the generated hooks run in a clean external project', () => {
  test('every scaffolded handler invokes the installed bin link and exits 0 (fail-soft contract)', async () => {
    const { root, binDir } = tempProject();
    const config = buildClaudeHooksConfig();
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's-published', cwd: root });

    // Every subscribed event carries the same invocation; run one representative of each
    // matcher-free event plus the matched PostToolUse group.
    const handlers = [
      config.hooks.SessionStart[0]!.hooks[0]!,
      config.hooks.SessionEnd[0]!.hooks[0]!,
      config.hooks.Stop[0]!.hooks[0]!,
      config.hooks.PostToolUse[0]!.hooks[0]!,
      config.hooks.PostToolUseFailure[0]!.hooks[0]!,
    ];
    for (const handler of handlers) {
      const command = expand(handler.command, root);
      const args = (handler.args ?? []).map((arg) => expand(arg, root));
      // The command resolves inside the clean install's node_modules — never a repo-local path.
      expect(existsSync(command)).toBeTrue();
      expect(command.startsWith(join(root, 'node_modules', '.bin'))).toBeTrue();
      expect(command).not.toContain('src/');

      const result = await runHookCommand(root, command, args, payload);
      expect(result.exitCode).toBe(0);
      // Fail-soft diagnostics go to stderr (stdout belongs to SessionStart JSON only).
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    expect(existsSync(join(binDir, 'onemem-claude-hook'))).toBeTrue();
  }, 60_000);

  test('the generated SessionStart handler produces the documented stdout JSON', async () => {
    const { root } = tempProject();
    const handler = buildClaudeHooksConfig().hooks.SessionStart[0]!.hooks[0]!;
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 's-published',
      cwd: root,
    });
    const result = await runHookCommand(
      root,
      expand(handler.command, root),
      (handler.args ?? []).map((a) => expand(a, root)),
      payload,
    );
    expect(result.exitCode).toBe(0);
    // No daemon and no .onememory in the clean project: nothing to inject, exit still 0.
    expect(result.stdout.trim().length === 0 || JSON.parse(result.stdout)).toBeDefined();
  }, 60_000);
});

describe('the generated .mcp.json stdio entry runs in a clean external project', () => {
  test('the installed onemem-mcp bin link boots embedded storage and exits cleanly on stdin EOF', async () => {
    const { root } = tempProject();
    const entry = buildMcpJson({}).mcpServers.onememory!;
    expect(entry.command).toBe(defaultMcpServerCommand());

    // Expand the entry exactly as Claude Code does (placeholders in command and env values), over
    // the user environment the way it spawns stdio servers: parent env + the entry's env map.
    // (The parent env is load-bearing — the bin's `#!/usr/bin/env bun` shebang resolves bun
    // through PATH; a stripped env makes the spawn die with 127.)
    const env: Record<string, string | undefined> = { ...process.env };
    // A clean install starts with none of onememory's control variables set.
    for (const key of ['ONEMEMORY_DATA_DIR', 'ONEMEMORY_PG_URL', 'ONEMEMORY_PROJECT_ID']) delete env[key];
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      env[key] = expand(value, root);
    }
    const proc = Bun.spawn([expand(entry.command, root), ...(entry.args ?? [])] as [string, ...string[]], {
      cwd: root,
      env: { ...env, ONEMEMORY_MCP_PROFILE: 'default8' },
      stdin: 'ignore', // runtime launches keep the pipe open; EOF is the documented shutdown signal
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = await consume(proc);

    expect(result.exitCode).toBe(0);
    // The server really booted embedded storage through the published layout (the data dir the
    // entry names now exists), and — no daemon lock in a clean project — the owner guard passed.
    expect(existsSync(join(root, '.onememory'))).toBeTrue();
    expect(readdirSync(join(root, '.onememory')).length).toBeGreaterThan(0);
  }, 60_000);
});
