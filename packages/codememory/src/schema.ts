import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Portable repository-relative paths; never a shell expression or a filesystem escape. */
export const RepositoryPathSchema = z.string().min(1).refine((path) =>
  !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
  !/^[A-Za-z]:/.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
{ message: 'expected a safe, POSIX repository-relative path' });

export const ObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const HashAlgorithmSchema = z.enum(['git-sha1', 'git-sha256', 'sha256']);
export const FingerprintTierSchema = z.enum(['committed', 'worktree']);
export const FileFingerprintSchema = z.strictObject({
  path: RepositoryPathSchema,
  tier: FingerprintTierSchema,
  blob_sha: ObjectIdSchema,
  hash_algorithm: HashAlgorithmSchema,
  mode: z.enum(['100644', '100755']),
}).refine((file) => file.blob_sha.length === (file.hash_algorithm === 'git-sha1' ? 40 : 64),
  { message: 'hash length does not match hash_algorithm' });
export type FileFingerprint = z.infer<typeof FileFingerprintSchema>;

export const SkippedPathSchema = z.strictObject({
  path: RepositoryPathSchema,
  tier: FingerprintTierSchema,
  reason: z.enum(['symlink', 'submodule', 'conflict', 'too_large', 'unreadable', 'unsupported']),
});
export type SkippedPath = z.infer<typeof SkippedPathSchema>;

export const FingerprintOptionsSchema = z.strictObject({
  exclusion_globs: z.array(z.string().min(1).max(512)).max(1000).default([]),
  max_files: z.number().int().min(1).max(1_000_000).default(100_000),
  max_file_bytes: z.number().int().min(1).max(100_000_000).default(10_000_000),
});
export type FingerprintOptions = z.input<typeof FingerprintOptionsSchema>;

export const RepositorySnapshotSchema = z.strictObject({
  version: z.literal(1),
  root_path: z.string().refine(isAbsolute, { message: 'root_path must be absolute' }),
  mode: z.enum(['git', 'content']),
  head_commit: ObjectIdSchema.nullable(),
  hash_algorithm: HashAlgorithmSchema,
  exclusion_globs: z.array(z.string()),
  captured_at: z.iso.datetime(),
  files: z.array(FileFingerprintSchema),
  skipped: z.array(SkippedPathSchema),
  warnings: z.array(z.string()),
}).superRefine((snapshot, ctx) => {
  if (snapshot.mode === 'content' && (snapshot.hash_algorithm !== 'sha256' || snapshot.head_commit !== null)) {
    ctx.addIssue({ code: 'custom', message: 'content snapshots have plain SHA-256 hashes and no Git HEAD' });
  }
  if (snapshot.mode === 'git' && snapshot.hash_algorithm === 'sha256') {
    ctx.addIssue({ code: 'custom', message: 'Git snapshots require the Git blob hash algorithm' });
  }
  const seen = new Set<string>();
  for (const file of snapshot.files) {
    const key = `${file.tier}\0${file.path}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate tier/path fingerprint' });
    seen.add(key);
    if (file.hash_algorithm !== snapshot.hash_algorithm) {
      ctx.addIssue({ code: 'custom', message: 'file hash algorithm differs from snapshot' });
    }
    if (snapshot.mode === 'content' && file.tier !== 'worktree') {
      ctx.addIssue({ code: 'custom', message: 'content snapshots have no committed tier' });
    }
  }
  for (const skipped of snapshot.skipped) {
    const key = `${skipped.tier}\0${skipped.path}`;
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: 'duplicate or conflicting skipped tier/path' });
    seen.add(key);
  }
});
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

export interface FileChange {
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'unavailable';
  tier: FileFingerprint['tier'];
  path: string;
  previous_path?: string;
  before: FileFingerprint | null;
  after: FileFingerprint | null;
  content_changed: boolean;
  mode_changed: boolean;
}

export interface FingerprintChangeReport {
  snapshot: RepositorySnapshot;
  changes: FileChange[];
  warnings: string[];
}

/** `DriftWatcher.detectDrift` input (the core port this package implements). */
export const DetectDriftInputSchema = z.strictObject({ project_id: z.uuid() });
export type DetectDriftInput = z.infer<typeof DetectDriftInputSchema>;

export class FingerprintError extends Error {
  constructor(
    public readonly code: 'invalid_root' | 'unsupported_path' | 'git_failed' | 'invalid_git_output' | 'scan_limit' | 'snapshot_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'FingerprintError';
  }
}
