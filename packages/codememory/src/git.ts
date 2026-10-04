import { execFile } from 'node:child_process';
import { promisify, TextDecoder } from 'node:util';

import { FingerprintError, ObjectIdSchema, RepositoryPathSchema } from './schema';

const execute = promisify(execFile);
const utf8 = new TextDecoder('utf-8', { fatal: true });

interface CommandError { code?: number | string }

export interface GitResult {
  stdout: string;
  code: number | string;
}

/** All calls are local/read-only argv calls. Disable configured fsmonitor helpers, not hooks. */
export async function runGit(root: string, args: readonly string[]): Promise<GitResult> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE',
  ]) {
    delete (env as Record<string, string | undefined>)[key];
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) {
      delete (env as Record<string, string | undefined>)[key];
    }
  }
  try {
    const result = await execute('git', [
      '--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never', '-C', root, ...args,
    ], { env, encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    try {
      return { stdout: utf8.decode(result.stdout), code: 0 };
    } catch {
      throw new FingerprintError('unsupported_path', 'Git emitted a non-UTF-8 path; refusing a lossy fingerprint');
    }
  } catch (error) {
    if (error instanceof FingerprintError) throw error;
    const failure = error as CommandError;
    // Never surface stderr: config/remote URLs and paths can carry credentials.
    return { stdout: '', code: failure.code ?? 'failed' };
  }
}

export async function requireGit(root: string, args: readonly string[]): Promise<string> {
  const result = await runGit(root, args);
  if (result.code !== 0) throw new FingerprintError('git_failed', `local Git inspection failed (${String(result.code)})`);
  return result.stdout;
}

export interface IndexEntry {
  path: string;
  blob_sha: string;
  mode: string;
  stage: number;
}

function records(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0')) throw new FingerprintError('invalid_git_output', 'Git output is not NUL terminated');
  return output.slice(0, -1).split('\0');
}

/** `ls-files --stage -z`: metadata + TAB + unquoted filename, with no whitespace splitting. */
export function parseIndex(output: string): IndexEntry[] {
  return records(output).map((record) => {
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || !ObjectIdSchema.safeParse(match[2]).success ||
      !RepositoryPathSchema.safeParse(match[4]).success) {
      throw new FingerprintError('invalid_git_output', 'invalid Git index record');
    }
    return { mode: match[1]!, blob_sha: match[2]!, stage: Number(match[3]), path: match[4]! };
  });
}

export interface GitRename {
  previous_path: string;
  path: string;
}

/** With `--name-status -z`, status, old path, and new path are separate NUL fields. */
export function parseRenames(output: string): GitRename[] {
  const fields = records(output);
  const renames: GitRename[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (!/^(?:[ACDMRTUXB]|[RC]\d{1,3})$/.test(status)) {
      throw new FingerprintError('invalid_git_output', 'invalid Git diff status');
    }
    const before = fields[index++];
    const after = status.startsWith('R') || status.startsWith('C') ? fields[index++] : undefined;
    if (!RepositoryPathSchema.safeParse(before).success ||
      (after !== undefined && !RepositoryPathSchema.safeParse(after).success) ||
      ((status.startsWith('R') || status.startsWith('C')) && after === undefined)) {
      throw new FingerprintError('invalid_git_output', 'invalid Git diff path');
    }
    if (status.startsWith('R')) renames.push({ previous_path: before!, path: after! });
  }
  return renames;
}

export function parsePaths(output: string): string[] {
  return records(output).map((path) => RepositoryPathSchema.parse(path));
}
