/**
 * Path exclusion policy (ADR-0007 §1: `.env*`, key/credential files, and configurable path
 * globs are excluded from ingestion ENTIRELY — before redaction, before any stage).
 *
 * Adapters/ingest call `isPathExcluded(path)` (or `isEventPathExcluded(event)`) on
 * `document.added` / `file.changed` paths FIRST; an excluded path means the caller drops the
 * whole event. The defaults are ADR invariants and are not removable — config only ADDS globs.
 */

import { z } from 'zod';
import { DocumentAddedPayloadSchema, FileChangedPayloadSchema } from '@onememory-ai/core';
import type { OnememoryEvent } from '@onememory-ai/core';

/**
 * Default exclusion globs. `*` matches any characters INCLUDING `/`, so `*credentials*`
 * hits `deploy/aws_credentials.json` anywhere in the tree. Both the full (normalized) path
 * and its basename are tested.
 */
export const DEFAULT_EXCLUDED_GLOBS: readonly string[] = [
  '.env*', // .env, .env.local, .env.production, .envrc — direnv included (safe direction)
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx', // KeePass databases
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '*_rsa',
  '*_dsa',
  '*_ed25519',
  '*credentials*',
  '*secrets*',
  '*.tfvars',
  '*.tfvars.*',
  '*.tfstate',
  '*.tfstate.*',
  '.npmrc', // registry tokens
  '.netrc', // credentials for curl/ftp
  '.git-credentials',
  '.htpasswd',
  'authorized_keys*',
  '*service_account*.json', // GCP service-account key files
];

export interface PathExclusionPolicy {
  /** Defaults + config-supplied globs, in effect. */
  readonly globs: readonly string[];
  /** Precompiled matchers, one per glob (derived; exposed so `isPathExcluded` stays allocation-free). */
  readonly matchers: readonly RegExp[];
}

export class PathExclusionConfigError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super(message);
    this.name = 'PathExclusionConfigError';
    this.issues = issues;
  }
}

const PathExclusionConfigSchema = z.strictObject({
  /** Additional globs on top of the (non-removable) defaults. */
  globs: z.array(z.string().min(1).max(512)).max(1000).optional(),
});
export type PathExclusionPolicyConfig = z.input<typeof PathExclusionConfigSchema>;

/** Glob -> anchored RegExp. `*` = any run of characters (incl. `/`), `?` = any single character. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (const char of glob) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/').trim();
  if (normalized.startsWith('file://')) {
    const after = normalized.slice('file://'.length);
    // file:///home/u/.env -> /home/u/.env ; file://relative/.env -> relative/.env
    normalized = after.startsWith('/') ? after : `/${after}`;
  }
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Build a policy from defaults + config globs. Config adds to the defaults; the defaults are
 * an ADR-0007 invariant and cannot be switched off.
 */
export function createPathExclusionPolicy(config?: PathExclusionPolicyConfig): PathExclusionPolicy {
  const parsed = PathExclusionConfigSchema.safeParse(config ?? {});
  if (!parsed.success) {
    throw new PathExclusionConfigError(
      'invalid path exclusion configuration',
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  const custom = parsed.data.globs ?? [];
  const globs = [...DEFAULT_EXCLUDED_GLOBS, ...custom];
  return { globs, matchers: globs.map(globToRegExp) };
}

/** The default policy (defaults only). Compiled once. */
export const DEFAULT_PATH_EXCLUSION_POLICY: PathExclusionPolicy = createPathExclusionPolicy();

/** `true` when `path` (full path or basename) matches any exclusion glob. */
export function isPathExcluded(
  path: string,
  policy: PathExclusionPolicy = DEFAULT_PATH_EXCLUSION_POLICY,
): boolean {
  const normalized = normalizePath(path);
  if (normalized.length === 0) return false;
  const basename = basenameOf(normalized);
  return policy.matchers.some((matcher) => matcher.test(normalized) || matcher.test(basename));
}

/** Path part of a URI: `file:///home/u/.env` -> `/home/u/.env`; `https://h/x/.env` -> `/x/.env`. */
function uriPaths(uri: string): string[] {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/.exec(uri);
  if (!match) return [uri]; // not a URI scheme: treat as a bare path
  const pathname = match[2] ?? '';
  if (/^file:/i.test(uri)) {
    return pathname.length > 0 ? [pathname] : [];
  }
  return pathname.length > 0 ? [pathname] : [];
}

/**
 * Whole-event exclusion check for the two path-bearing kinds: `document.added` (path/uri) and
 * `file.changed` (path/old_path). `true` means drop the event BEFORE redaction — an excluded
 * path is never ingested, never stored, never hashed. Malformed payloads return `false`
 * (never drop for the wrong reason; the ingest validator dead-letters them separately).
 */
export function isEventPathExcluded(
  event: OnememoryEvent,
  policy: PathExclusionPolicy = DEFAULT_PATH_EXCLUSION_POLICY,
): boolean {
  if (event.kind === 'document.added') {
    const parsed = DocumentAddedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return false;
    const paths: string[] = [];
    if (typeof parsed.data.path === 'string') paths.push(parsed.data.path);
    if (typeof parsed.data.uri === 'string') paths.push(...uriPaths(parsed.data.uri));
    return paths.some((path) => isPathExcluded(path, policy));
  }
  if (event.kind === 'file.changed') {
    const parsed = FileChangedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return false;
    const paths: string[] = [];
    if (typeof parsed.data.path === 'string') paths.push(parsed.data.path);
    if (typeof parsed.data.old_path === 'string') paths.push(parsed.data.old_path);
    return paths.some((path) => isPathExcluded(path, policy));
  }
  return false;
}
