/**
 * Manifest derivation for the release tooling (M16, ADR-0014).
 *
 * Both scripts/build.ts and scripts/release.ts must agree on what a package publishes, so the
 * rules live here, pure and unit-tested:
 *
 * - **entries**: every `exports` target that is not test-support, plus every `bin` target. The
 *   build bundles exactly these, and the staged manifest points exactly these at `dist/`.
 * - **test-support**: the `./testing` subpath family (`@onememory/*\/testing` is imported by
 *   other packages' tests only — it imports `bun:test` and is never published).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A manifest as read from disk — only the fields the tooling reads. */
export interface SourceManifest {
  name: string;
  version: string;
  exports?: Record<string, unknown> | string;
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  private?: boolean;
  description?: string;
  license?: string;
  type?: string;
  files?: string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

/** One `bin` name and the source file it points at (both repo-relative, `src/...`). */
export interface BinTarget {
  name: string;
  target: string;
}

export interface DerivedTargets {
  /** Unique, sorted `src/...` entry files to bundle. */
  entries: string[];
  bins: BinTarget[];
}

/** Normalize `./src/index.ts` (or `src/index.ts`) to `src/index.ts`. */
export function normalizeTarget(target: string): string {
  return target.replace(/^\.\//, '');
}

/** Is this exports subpath the test-support family? (`./testing`, `./testing/...`) */
export function isTestSupportKey(key: string): boolean {
  return key === './testing' || key.startsWith('./testing/');
}

/** Flatten an `exports` value (string, or nested condition object) into its target strings. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap((nested) => exportTargets(nested));
}

/** Every `bin` target, normalized: `bin: "./src/bin.ts"` becomes the package's own name. */
export function binTargets(manifest: SourceManifest): BinTarget[] {
  const { bin, name } = manifest;
  if (bin === undefined) return [];
  if (typeof bin === 'string') return [{ name, target: normalizeTarget(bin) }];
  return Object.entries(bin)
    .map(([binName, target]) => ({ name: binName, target: normalizeTarget(target) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The `src/...` files this package publishes: non-test-support exports plus bins. */
export function deriveTargets(manifest: SourceManifest): DerivedTargets {
  const entries = new Set<string>();
  const exportsValue = manifest.exports;
  if (typeof exportsValue === 'string') {
    entries.add(normalizeTarget(exportsValue));
  } else if (exportsValue !== undefined) {
    for (const [key, value] of Object.entries(exportsValue)) {
      if (isTestSupportKey(key)) continue;
      for (const target of exportTargets(value)) entries.add(normalizeTarget(target));
    }
  }
  const bins = binTargets(manifest);
  for (const bin of bins) entries.add(bin.target);
  return { entries: [...entries].sort(), bins };
}

/** `src/index.ts` → `dist/index.js` (the bundle path the staged manifest points at). */
export function distEntryOf(entry: string): string {
  if (!entry.startsWith('src/')) {
    throw new Error(`release: entry ${entry} is outside src/ — the build assumes src/ as its root`);
  }
  return `dist/${entry.slice('src/'.length).replace(/\.ts$/, '.js')}`;
}

/** `src/index.ts` → `dist/index.d.ts` (the declaration tsc emits alongside the bundle). */
export function distTypesOf(entry: string): string {
  return distEntryOf(entry).replace(/\.js$/, '.d.ts');
}

// ---------------------------------------------------------------------------
// Workspace membership
// ---------------------------------------------------------------------------

/**
 * Workspace members that are NOT npm packages: the web UI ships as a hosted surface (ADR-0011),
 * and the benchmark harness is dev-only tooling. Everything else in the workspace publishes.
 */
export const NON_PUBLISHABLE_DIRS: readonly string[] = ['apps/web', 'benchmarks/eval'];

/** Expand the root `workspaces` globs (`dir/*` form) into member directories that have a manifest. */
export function workspaceDirs(repoRoot: string): string[] {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { workspaces?: string[] };
  const dirs = new Set<string>();
  for (const pattern of root.workspaces ?? []) {
    if (!pattern.endsWith('/*')) throw new Error(`release: unsupported workspace pattern '${pattern}'`);
    const group = pattern.slice(0, -2);
    for (const entry of readdirSync(join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      if (existsSync(join(repoRoot, dir, 'package.json'))) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/**
 * The publishable packages, in a stable order. Membership comes from the workspace globs minus
 * {@link NON_PUBLISHABLE_DIRS} — deliberately NOT from the `private` field: every publishable
 * manifest sets `private: true` as the staging guard (ADR-0014), so `private` cannot also mean
 * "not a package".
 */
export function publishableDirs(repoRoot: string): string[] {
  return workspaceDirs(repoRoot).filter((dir) => !NON_PUBLISHABLE_DIRS.includes(dir));
}

/** Read one member's manifest. */
export function readManifest(repoRoot: string, dir: string): SourceManifest {
  return JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as SourceManifest;
}
