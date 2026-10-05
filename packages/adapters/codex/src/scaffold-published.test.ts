/**
 * The published hook-invocation contract for Codex (backlog cross-follow-up #9): a clean
 * EXTERNAL project that installed the published packages must be able to run every generated
 * command — no PATH-only assumption, no monorepo-relative path.
 *
 * Each test lays out a temp directory exactly like a clean install — `node_modules/.bin/<name>`
 * symlinked to the real bin entrypoint, the way npm/bun link every `bin` declared in package.json —
 * then runs the generated hooks.json command EXACTLY as Codex does: a shell string (`sh -c`) with
 * the session cwd as the working directory, the hook payload on stdin. The generated config.toml
 * stdio command is spawned the way Codex launches it: as a path resolved against the working
 * directory, with the env table the block emits.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { PROJECT_MCP_COMMAND, renderCodexMcpServerToml } from './config-scaffold';
import { buildCodexHooksFile, PROJECT_CAPTURE_COMMAND } from './hooks-scaffold';

const tempDirs: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'onemem-codex-published-'));
  tempDirs.push(root);
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  // What npm does for a published install: every declared `bin` gets a link in .bin. The
  // symlinked targets are the real entrypoints, executable through their bun shebangs.
  symlinkSync(join(import.meta.dir, 'bin.ts'), join(binDir, 'onemem-codex-capture'));
  symlinkSync(join(import.meta.dir, '..', '..', '..', 'mcp', 'src', 'bin.ts'), join(binDir, 'onemem-mcp'));
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface SpawnResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** Any subprocess with piped output, whatever its stdin mode ('pipe' for hooks, 'ignore' for the server). */
type PipedStdoutProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'> | Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

/** Run a shell command exactly as Codex runs command hooks: `sh -c`, session cwd, payload on stdin. */
function runShellCommand(root: string, command: string, stdin: string): Promise<SpawnResult> {
  const proc = Bun.spawn(['sh', '-c', command], {
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

describe('the generated capture hooks run in a clean external project', () => {
  test('the default command executes through a shell from the session cwd and exits 0 (fail-soft)', async () => {
    const root = tempProject();
    const file = buildCodexHooksFile();
    // The wire shape Codex sends (common input fields: transcript_path is always present, nullable).
    const payload = JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 's-published',
      transcript_path: null,
      cwd: root,
      reason: 'other',
    });

    // Every registered handler uses the same command; run the synchronous SessionEnd one
    // (Codex's tightest timeout) plus the async Stop one.
    for (const handler of [
      file.hooks!['SessionEnd']![0]!.hooks[0]!,
      file.hooks!['Stop']![0]!.hooks[0]!,
    ]) {
      expect(handler.command).toBe(PROJECT_CAPTURE_COMMAND);
      // The command is project-relative (never PATH-only, never a repo source path).
      expect(handler.command).toContain('node_modules/.bin/onemem-codex-capture');
      expect(handler.command).not.toMatch(/src\//);
      const result = await runShellCommand(root, handler.command, payload);
      expect(result.exitCode).toBe(0);
      // Fail-soft diagnostics on stderr; stdout stays empty outside SessionStart.
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  }, 60_000);

  test('the git-root fallback keeps a non-git project working when launched at the root', async () => {
    const root = tempProject();
    // `git rev-parse` fails (no repo) → the || pwd fallback resolves the root → the bin runs.
    const result = await runShellCommand(
      root,
      PROJECT_CAPTURE_COMMAND,
      JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 's-ng',
        transcript_path: null,
        cwd: root,
        reason: 'other',
      }),
    );
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe('the generated config.toml stdio command runs in a clean external project', () => {
  test('boots the installed onemem-mcp bin link and exits cleanly on stdin EOF', async () => {
    const root = tempProject();
    const toml = renderCodexMcpServerToml({ projectId: '01900000-0000-7000-8000-000000000c07' });
    expect(toml).toContain(`command = "${PROJECT_MCP_COMMAND}"`);

    // Read the generated block back the way Codex reads config.toml: a real TOML parse.
    const parsed = parseToml(toml) as {
      mcp_servers: { onememory: { command: string; env?: Record<string, string> } };
    };
    const server = parsed.mcp_servers['onememory'];
    expect(server.command).toBe(PROJECT_MCP_COMMAND);
    // The command resolves inside the clean install's node_modules — never a repo-local path.
    expect(server.command.startsWith('./node_modules/.bin/')).toBeTrue();
    expect(server.command).not.toContain('src/');
    expect(existsSync(join(root, server.command))).toBeTrue();

    // Launch it exactly as Codex does: the command as a path against the working directory,
    // with the block's env table applied over a clean user environment.
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ['ONEMEMORY_DATA_DIR', 'ONEMEMORY_PG_URL', 'ONEMEMORY_PROJECT_ID']) delete env[key];
    for (const [key, value] of Object.entries(server.env ?? {})) {
      env[key] = value;
    }
    const proc = Bun.spawn([server.command], {
      cwd: root,
      env,
      stdin: 'ignore', // runtime launches keep the pipe open; EOF is the documented shutdown signal
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = await consume(proc);

    expect(result.exitCode).toBe(0);
    // The server really booted embedded storage through the published layout (the default data
    // dir the block documents — `.onememory` under the launch dir — now exists), and no daemon
    // lock exists in a clean project, so the owner guard passed.
    expect(existsSync(join(root, '.onememory'))).toBeTrue();
    expect(readdirSync(join(root, '.onememory')).length).toBeGreaterThan(0);
  }, 60_000);
});
