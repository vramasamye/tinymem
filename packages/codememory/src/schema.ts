import { isAbsolute } from 'node:path';
import { z } from 'zod';

import { SYMBOL_KINDS, SYMBOL_LANGUAGES } from '@onememory-ai/core';

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

// ---------------------------------------------------------------------------
// Drift apply (M4e — the write side over Store + CodeMemoryStore)
// ---------------------------------------------------------------------------

/** `system|user:<id>|agent:<id>|job:<kind>` — recorded on every audited stale transition. */
const DriftActorSchema = z.string().min(1).max(256).default('job:drift_scan');

export const DriftedRefSchema = z.strictObject({
  repository_id: z.uuid(),
  path: RepositoryPathSchema,
  reason: z.enum(['content_changed', 'path_missing', 'capture_unavailable']),
  successor_path: RepositoryPathSchema.optional(),
});

export const DriftReportSchema = z.strictObject({
  drifted: z.array(
    z.strictObject({
      memory_id: z.uuid(),
      changed_paths: z.array(RepositoryPathSchema),
      refs: z.array(DriftedRefSchema).min(1),
    }),
  ),
});

/**
 * The checkpoint basis of one repository, read BEFORE drift detection: where the checkpoint
 * stood and which persisted head the processed report describes.
 */
export const CheckpointBasisSchema = z.strictObject({
  repository_id: z.uuid(),
  head_commit: ObjectIdSchema.nullable(),
  last_ingested_commit: ObjectIdSchema.nullable(),
});
export type CheckpointBasis = z.infer<typeof CheckpointBasisSchema>;

export const ApplyDriftReportInputSchema = z.strictObject({
  report: DriftReportSchema,
  checkpoints: z.array(CheckpointBasisSchema),
  actor: DriftActorSchema,
});
export type ApplyDriftReportInput = z.input<typeof ApplyDriftReportInputSchema>;

export const ApplyDriftInputSchema = z.strictObject({
  project_id: z.uuid(),
  actor: DriftActorSchema,
});
export type ApplyDriftInput = z.input<typeof ApplyDriftInputSchema>;

// ---------------------------------------------------------------------------
// Symbol extraction (tree-sitter — ADR-0008 "Symbol tables re-extract only changed files")
// ---------------------------------------------------------------------------

/** The shared cross-language kind vocabulary (single source: `@onememory-ai/core` persistence). */
export const SymbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

/** The grammars the extractor ships; other source extensions are outside the symbol domain. */
export const SymbolLanguageSchema = z.enum(SYMBOL_LANGUAGES);
export type SymbolLanguage = z.infer<typeof SymbolLanguageSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a 64-character lowercase hex SHA-256');

export const SymbolRecordSchema = z.strictObject({
  name: z.string().min(1).max(512),
  kind: SymbolKindSchema,
  /** Normalized single-line declaration header (comments stripped, whitespace collapsed, capped). */
  signature: z.string().max(256),
  /** 1-based inclusive line range of the symbol's span. */
  line_start: z.number().int().min(1),
  line_end: z.number().int().min(1),
  /** SHA-256 of the symbol's normalized span — intra-file granularity (ADR-0008). */
  span_hash: sha256Hex,
}).refine((symbol) => symbol.line_start <= symbol.line_end, {
  message: 'line_start must not exceed line_end',
});
export type SymbolRecord = z.infer<typeof SymbolRecordSchema>;

export const SymbolFileSchema = z.strictObject({
  path: RepositoryPathSchema,
  language: SymbolLanguageSchema,
  /** Document-order symbol table; a known-language file may legitimately declare nothing. */
  symbols: z.array(SymbolRecordSchema),
  /** SHA-256 over the ordered symbol table — the per-file rewrite guard. */
  symbols_hash: sha256Hex,
  /** How many ERROR nodes the parse recovered from (error-tolerant extraction stays honest). */
  parse_errors: z.number().int().min(0),
});
export type SymbolFile = z.infer<typeof SymbolFileSchema>;

/**
 * Why a file the extraction covered has no symbol entry. These are the honest reports — never
 * a fabricated "no symbols" for bytes the extractor could not read or parse.
 */
export const SkippedSymbolFileSchema = z.strictObject({
  path: RepositoryPathSchema,
  reason: z.enum([
    'binary',
    'conflict',
    'excluded',
    'grammar_unavailable',
    'missing',
    'submodule',
    'symlink',
    'too_large',
    'unreadable',
    'unsupported',
    'unsupported_language',
  ]),
});
export type SkippedSymbolFile = z.infer<typeof SkippedSymbolFileSchema>;

export const SymbolOptionsSchema = z.strictObject({
  exclusion_globs: z.array(z.string().min(1).max(512)).max(1000).default([]),
  max_files: z.number().int().min(1).max(1_000_000).default(100_000),
  max_file_bytes: z.number().int().min(1).max(100_000_000).default(10_000_000),
  /**
   * Only-changed re-extraction: extract exactly these paths (repository-relative). The future
   * re-index job passes the paths a `detectChanges`/`DriftWatcher` report flags. Empty = full
   * scan of every candidate the shared worktree enumeration offers.
   */
  files: z.array(RepositoryPathSchema).max(50_000).default([]),
}).refine((options) => options.files.length <= options.max_files, {
  message: 'requested files exceed the configured max_files budget',
}).refine((options) => new Set(options.files).size === options.files.length, {
  message: 'duplicate paths in the requested files list',
});
export type SymbolOptions = z.input<typeof SymbolOptionsSchema>;

export const SymbolTableSchema = z.strictObject({
  version: z.literal(1),
  root_path: z.string().refine(isAbsolute, { message: 'root_path must be absolute' }),
  extracted_at: z.iso.datetime(),
  files: z.array(SymbolFileSchema),
  skipped: z.array(SkippedSymbolFileSchema),
  warnings: z.array(z.string()),
}).superRefine((table, ctx) => {
  const seen = new Set<string>();
  for (const file of table.files) {
    if (seen.has(file.path)) ctx.addIssue({ code: 'custom', message: 'duplicate symbol file path' });
    seen.add(file.path);
  }
  for (const skipped of table.skipped) {
    if (seen.has(skipped.path)) {
      ctx.addIssue({ code: 'custom', message: 'duplicate or conflicting skipped symbol path' });
    }
    seen.add(skipped.path);
  }
});
export type SymbolTable = z.infer<typeof SymbolTableSchema>;

export class FingerprintError extends Error {
  constructor(
    public readonly code:
      | 'invalid_root'
      | 'unsupported_path'
      | 'git_failed'
      | 'invalid_git_output'
      | 'scan_limit'
      | 'snapshot_mismatch'
      | 'runtime_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FingerprintError';
  }
}
