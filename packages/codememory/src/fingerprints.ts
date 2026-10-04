import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { createPathExclusionPolicy, isPathExcluded } from '@onememory/security';

import { parseIndex, parsePaths, parseRenames, requireGit, runGit } from './git';
import type { GitRename, IndexEntry } from './git';
import {
  FingerprintError,
  FingerprintOptionsSchema,
  ObjectIdSchema,
  RepositorySnapshotSchema,
} from './schema';
import type {
  FileChange,
  FileFingerprint,
  FingerprintChangeReport,
  FingerprintOptions,
  RepositorySnapshot,
  SkippedPath,
} from './schema';

const IGNORED_DIRECTORIES = new Set(['.git', '.onememory', 'node_modules', '.next', 'dist', 'build', 'coverage']);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function sortText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function key(file: Pick<FileFingerprint, 'tier' | 'path'>): string {
  return `${file.tier}\0${file.path}`;
}

export function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

/**
 * The exclusion predicate shared by fingerprint capture and symbol extraction: built-in ignored
 * directories at any depth, plus the ADR-0007 security defaults, plus caller globs.
 */
export function createPathFilter(globs: readonly string[]): (path: string) => boolean {
  const policy = createPathExclusionPolicy({ globs: [...globs] });
  return (path: string): boolean => {
    const parts = path.split('/');
    return parts.some((part, index) =>
      IGNORED_DIRECTORIES.has(part) || isPathExcluded(parts.slice(0, index + 1).join('/'), policy));
  };
}

/** Canonicalize an extraction root: an accessible, real directory (symlinks resolved). */
export async function resolveRepositoryRoot(root: string): Promise<string> {
  try {
    const canonicalRoot = await realpath(resolve(root));
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error('not a directory');
    return canonicalRoot;
  } catch {
    throw new FingerprintError('invalid_root', 'the repository root must be an accessible directory');
  }
}

/**
 * One shared worktree inspection (the safety conventions of fingerprint capture, reused by
 * symbol extraction): Git probe with the pinned failure rules, the index, conflicts, untracked
 * candidates, the object format/HEAD, and the filesystem walk when no Git worktree exists.
 * `candidates` still contains paths later stages report as unavailable (conflicts, symlinks,
 * submodules) — each caller applies its own honest reporting on top.
 */
export interface WorktreeScan {
  mode: 'git' | 'content';
  algorithm: RepositorySnapshot['hash_algorithm'];
  head: string | null;
  /** The full `ls-files --stage` record set, every stage included. */
  index: IndexEntry[];
  /** Paths with conflict stages (any stage ≠ 0); never fingerprinted, never extracted. */
  conflicted: string[];
  /** Every path the worktree currently offers (all index stages + untracked), exclusions applied. */
  candidates: string[];
  trustFileMode: boolean;
  warnings: string[];
}

export async function scanWorktree(
  canonicalRoot: string,
  options: { readonly exclusion_globs: readonly string[]; readonly max_files: number },
): Promise<WorktreeScan> {
  const excluded = createPathFilter(options.exclusion_globs);
  const probe = await runGit(canonicalRoot, ['rev-parse', '--is-inside-work-tree']);
  const warnings: string[] = [];

  if (probe.code === 0) {
    if (probe.stdout.trim() !== 'true') {
      throw new FingerprintError('invalid_root', 'bare Git repositories are not a source worktree');
    }
    const top = (await requireGit(canonicalRoot, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
    if (await realpath(top) !== canonicalRoot) {
      throw new FingerprintError('invalid_root', 'use the Git worktree root, not a directory inside it');
    }
    const format = (await requireGit(canonicalRoot, ['rev-parse', '--show-object-format'])).trim();
    if (format !== 'sha1' && format !== 'sha256') {
      throw new FingerprintError('invalid_git_output', 'unsupported Git object format');
    }
    const algorithm: RepositorySnapshot['hash_algorithm'] = format === 'sha1' ? 'git-sha1' : 'git-sha256';
    let head: string | null = null;
    const headResult = await runGit(canonicalRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (headResult.code === 0) head = ObjectIdSchema.parse(headResult.stdout.trim());
    else warnings.push('HEAD unavailable (unborn or missing): index/worktree fingerprints remain available');
    const index = parseIndex(await requireGit(canonicalRoot, ['ls-files', '--stage', '--full-name', '-z']));
    const untracked = parsePaths(await requireGit(canonicalRoot, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']));
    const candidates = [...new Set([...index.map((entry) => entry.path), ...untracked])]
      .filter((path) => !excluded(path));
    const fileMode = await runGit(canonicalRoot, ['config', '--bool', 'core.filemode']);
    return {
      mode: 'git',
      algorithm,
      head,
      index,
      conflicted: [...new Set(index.filter((entry) => entry.stage !== 0).map((entry) => entry.path))],
      candidates,
      trustFileMode: fileMode.code !== 0 || fileMode.stdout.trim() !== 'false',
      warnings,
    };
  }

  if (probe.code !== 128 && probe.code !== 'ENOENT') {
    throw new FingerprintError('git_failed', `local Git inspection failed (${String(probe.code)})`);
  }
  let gitMarker = false;
  try {
    await lstat(join(canonicalRoot, '.git'));
    gitMarker = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FingerprintError('git_failed', 'cannot inspect the local Git marker');
    }
  }
  if (gitMarker) {
    throw new FingerprintError('git_failed', probe.code === 'ENOENT'
      ? 'this root has Git metadata but system Git is unavailable; install Git and retry'
      : 'this root has Git metadata but Git could not inspect it; check repository permissions and configuration');
  }
  warnings.push(probe.code === 'ENOENT'
    ? 'system Git unavailable: using filesystem content hashes'
    : 'no Git worktree: using filesystem content hashes');
  return {
    mode: 'content',
    algorithm: 'sha256',
    head: null,
    index: [],
    conflicted: [],
    candidates: await filesystemPaths(canonicalRoot, excluded, options.max_files),
    trustFileMode: true,
    warnings,
  };
}

/** Only fingerprints/metadata are returned: source bytes, remote URLs, and Git stderr never are. */
export async function captureSnapshot(root: string, options: FingerprintOptions = {}): Promise<RepositorySnapshot> {
  const parsed = FingerprintOptionsSchema.parse(options);
  const canonicalRoot = await resolveRepositoryRoot(root);
  const scan = await scanWorktree(canonicalRoot, parsed);
  const excluded = createPathFilter(parsed.exclusion_globs);
  const files: FileFingerprint[] = [];
  const skipped: SkippedPath[] = [];
  const conflicted = new Set(scan.conflicted);

  if (scan.mode === 'git') {
    for (const path of scan.conflicted) {
      if (excluded(path)) continue;
      skipped.push({ path, tier: 'committed', reason: 'conflict' }, { path, tier: 'worktree', reason: 'conflict' });
    }
    for (const entry of scan.index) {
      if (entry.stage !== 0 || conflicted.has(entry.path) || excluded(entry.path)) continue;
      if (entry.mode === '100644' || entry.mode === '100755') {
        files.push({
          path: entry.path, tier: 'committed', blob_sha: entry.blob_sha,
          hash_algorithm: scan.algorithm, mode: entry.mode,
        });
      } else {
        const reason = entry.mode === '120000' ? 'symlink' : entry.mode === '160000' ? 'submodule' : 'unsupported';
        skipped.push({ path: entry.path, tier: 'committed', reason });
        skipped.push({ path: entry.path, tier: 'worktree', reason });
      }
    }
  }
  const unavailable = new Set(skipped.filter((entry) => entry.tier === 'worktree').map((entry) => entry.path));
  const candidates = scan.candidates.filter((path) => !unavailable.has(path));
  if (candidates.length > parsed.max_files || files.length > parsed.max_files) {
    throw new FingerprintError('scan_limit', 'repository exceeds the configured file budget');
  }

  const indexed = new Map(scan.index.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry.mode]));
  for (const path of candidates.sort(sortText)) {
    const modeOverride = !scan.trustFileMode ? indexed.get(path) : undefined;
    const outcome = await hashWorktreeFile(canonicalRoot, path, scan.algorithm, parsed.max_file_bytes, modeOverride);
    if (outcome === null) continue; // tracked file deleted from the working tree
    if ('reason' in outcome) skipped.push(outcome);
    else files.push(outcome);
  }
  const warnings = [...scan.warnings];
  if (skipped.length > 0) warnings.push(`${skipped.length} tier/path entries were unavailable; inspect skipped for reasons`);

  return RepositorySnapshotSchema.parse({
    version: 1, root_path: canonicalRoot, mode: scan.mode, head_commit: scan.head, hash_algorithm: scan.algorithm,
    exclusion_globs: parsed.exclusion_globs, captured_at: new Date().toISOString(),
    files: files.sort((a, b) => sortText(key(a), key(b))),
    skipped: skipped.sort((a, b) => sortText(key(a), key(b))), warnings,
  });
}

async function filesystemPaths(
  root: string, excluded: (path: string) => boolean, maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  const directories = [''];
  let visited = 0;
  while (directories.length > 0) {
    const directory = directories.pop()!;
    if (++visited > maxFiles) throw new FingerprintError('scan_limit', 'directory traversal exceeds the file budget');
    const absoluteDirectory = join(root, directory);
    if (await realpath(absoluteDirectory) !== absoluteDirectory) {
      throw new FingerprintError('unsupported_path', 'a directory changed into a symlink during capture');
    }
    const entries = await readdir(absoluteDirectory, { encoding: 'buffer' });
    for (const entry of entries) {
      let name: string;
      try {
        name = utf8.decode(entry);
      } catch {
        throw new FingerprintError('unsupported_path', 'a non-UTF-8 path cannot be fingerprinted losslessly');
      }
      const path = directory === '' ? name : `${directory}/${name}`;
      if (excluded(path)) continue;
      if ((await lstat(join(root, path))).isDirectory()) directories.push(path);
      else files.push(path);
      if (files.length > maxFiles) throw new FingerprintError('scan_limit', 'repository exceeds the configured file budget');
    }
  }
  return files;
}

async function hashWorktreeFile(
  root: string, path: string, algorithm: RepositorySnapshot['hash_algorithm'],
  maxBytes: number, modeOverride?: string,
): Promise<FileFingerprint | SkippedPath | null> {
  const unavailable = (reason: SkippedPath['reason']): SkippedPath => ({ path, tier: 'worktree', reason });
  try {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return unavailable('symlink');
    if (!info.isFile()) return unavailable('unsupported');
    if (info.size > maxBytes) return unavailable('too_large');
    const parent = await realpath(dirname(absolute));
    if (!inside(root, parent) || parent !== dirname(absolute)) return unavailable('symlink');
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const start = await handle.stat();
      if (!start.isFile()) return unavailable('unsupported');
      if (start.size > maxBytes) return unavailable('too_large');
      const hash = createHash(algorithm === 'git-sha1' ? 'sha1' : 'sha256');
      if (algorithm !== 'sha256') hash.update(`blob ${start.size}\0`);
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return unavailable('too_large');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const end = await handle.stat();
      if (start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || start.size !== total || end.size !== total) {
        return unavailable('unreadable'); // changed while reading: never claim a coherent fingerprint
      }
      const mode = modeOverride === '100755' || (modeOverride === undefined && (start.mode & 0o111) !== 0)
        ? '100755' : '100644';
      return { path, tier: 'worktree', blob_sha: hash.digest('hex'), hash_algorithm: algorithm, mode };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return unavailable(code === 'ELOOP' ? 'symlink' : 'unreadable');
  }
}

function compare(
  before: RepositorySnapshot, after: RepositorySnapshot, renames: readonly GitRename[],
): FileChange[] {
  if (before.root_path !== after.root_path || before.hash_algorithm !== after.hash_algorithm ||
    JSON.stringify([...before.exclusion_globs].sort()) !== JSON.stringify([...after.exclusion_globs].sort())) {
    throw new FingerprintError('snapshot_mismatch', 'snapshots must have the same root, hash algorithm, and exclusion policy');
  }
  const changes: FileChange[] = [];
  const oldFiles = new Map(before.files.map((file) => [key(file), file]));
  const newFiles = new Map(after.files.map((file) => [key(file), file]));
  const unavailable = new Set(after.skipped.map(key));
  for (const skipped of after.skipped) {
    if (!oldFiles.has(key(skipped))) {
      changes.push({
        kind: 'unavailable', tier: skipped.tier, path: skipped.path,
        before: null, after: null, content_changed: true, mode_changed: false,
      });
    }
  }
  const renameHints = [...renames];

  // Exact one-to-one content matches survive rebases/missing checkpoints. Ambiguous equal blobs
  // remain add/delete rather than guessing which source a memory should follow.
  for (const tier of ['committed', 'worktree'] as const) {
    const removed = before.files.filter((file) => file.tier === tier && !newFiles.has(key(file)) && !unavailable.has(key(file)));
    const added = after.files.filter((file) => file.tier === tier && !oldFiles.has(key(file)));
    const groupByIdentity = (files: FileFingerprint[]): Map<string, FileFingerprint[]> => {
      const groups = new Map<string, FileFingerprint[]>();
      for (const file of files) {
        const identity = `${file.blob_sha}:${file.mode}`;
        const group = groups.get(identity);
        if (group) group.push(file);
        else groups.set(identity, [file]);
      }
      return groups;
    };
    const oldGroups = groupByIdentity(removed);
    const newGroups = groupByIdentity(added);
    for (const [identity, oldMatches] of oldGroups) {
      const newMatches = newGroups.get(identity);
      if (oldMatches.length === 1 && newMatches?.length === 1) {
        renameHints.push({ previous_path: oldMatches[0]!.path, path: newMatches[0]!.path });
      }
    }
    for (const hint of renameHints) {
      const oldKey = `${tier}\0${hint.previous_path}`;
      const newKey = `${tier}\0${hint.path}`;
      const oldFile = oldFiles.get(oldKey);
      const newFile = newFiles.get(newKey);
      if (!oldFile || !newFile || newFiles.has(oldKey) || oldFiles.has(newKey)) continue;
      changes.push({
        kind: 'renamed', tier, path: newFile.path, previous_path: oldFile.path,
        before: oldFile, after: newFile,
        content_changed: oldFile.blob_sha !== newFile.blob_sha, mode_changed: oldFile.mode !== newFile.mode,
      });
      oldFiles.delete(oldKey);
      newFiles.delete(newKey);
    }
  }
  for (const [fileKey, oldFile] of oldFiles) {
    const newFile = newFiles.get(fileKey);
    if (!newFile) {
      changes.push({
        kind: unavailable.has(fileKey) ? 'unavailable' : 'deleted',
        tier: oldFile.tier, path: oldFile.path, before: oldFile, after: null,
        content_changed: true, mode_changed: false,
      });
    } else if (oldFile.blob_sha !== newFile.blob_sha || oldFile.mode !== newFile.mode) {
      changes.push({
        kind: 'modified', tier: oldFile.tier, path: oldFile.path, before: oldFile, after: newFile,
        content_changed: oldFile.blob_sha !== newFile.blob_sha, mode_changed: oldFile.mode !== newFile.mode,
      });
    }
    newFiles.delete(fileKey);
  }
  for (const file of newFiles.values()) {
    changes.push({
      kind: 'added', tier: file.tier, path: file.path, before: null, after: file,
      content_changed: true, mode_changed: false,
    });
  }
  return changes.sort((a, b) => sortText(key(a), key(b)));
}

/** Pure, schema-validated comparison; exact unambiguous renames need no Git history. */
export function compareSnapshots(before: RepositorySnapshot, after: RepositorySnapshot): FileChange[] {
  return compare(RepositorySnapshotSchema.parse(before), RepositorySnapshotSchema.parse(after), []);
}

/** Re-scan locally, use Git rename evidence when available, then compare content fingerprints. */
export async function detectChanges(
  baseline: RepositorySnapshot, options: Pick<FingerprintOptions, 'max_files' | 'max_file_bytes'> = {},
): Promise<FingerprintChangeReport> {
  const before = RepositorySnapshotSchema.parse(baseline);
  const snapshot = await captureSnapshot(before.root_path, {
    ...options, exclusion_globs: before.exclusion_globs,
  });
  const warnings = [...snapshot.warnings];
  let renames: GitRename[] = [];
  if (before.mode === 'git' && before.head_commit !== null && snapshot.head_commit !== null &&
    before.head_commit !== snapshot.head_commit) {
    // Preflight the stored baseline: shallow cuts and rewritten history can leave it pointing at
    // a missing object, which the primary-source verification forbids feeding to the diff. Per-file
    // hashes stay authoritative either way.
    const baseline = await runGit(before.root_path,
      ['rev-parse', '--verify', '--quiet', `${before.head_commit}^{commit}`]);
    if (baseline.code !== 0) {
      warnings.push('baseline checkpoint object is missing (shallow or rewritten history): per-file hashes are authoritative; modified renames may appear as add/delete');
    } else {
      const diff = await runGit(before.root_path, [
        'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames=50%',
        '--ignore-submodules=dirty', before.head_commit, snapshot.head_commit, '--',
      ]);
      if (diff.code === 0) renames = parseRenames(diff.stdout);
      else warnings.push('Git checkpoint/rename diff unavailable: per-file hashes are authoritative; modified renames may appear as add/delete');
    }
  }
  return { snapshot, changes: compare(before, snapshot, renames), warnings };
}
