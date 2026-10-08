/**
 * Staged publish manifests and publish order (M16, ADR-0014).
 *
 * The repo manifests stay dev-oriented (`exports` → `./src/*.ts`) and carry `private: true`, so
 * nothing can be published straight from a package directory. The publishable manifest is derived
 * here — pure, unit-tested, and the single place the rules live:
 *
 * - `workspace:*` → `^<version>` (npm has no idea what a workspace protocol is),
 * - `exports`/`main`/`types`/`bin` → `dist/` (the built artifact),
 * - test-support subpaths (`./testing`) dropped — they import `bun:test` and are repo-internal,
 * - `files: ["dist"]`, `engines.node`, `publishConfig.access` for scoped names,
 * - `scripts`/`devDependencies`/`private` stripped.
 */

import { deriveTargets, distEntryOf, distTypesOf, isTestSupportKey, normalizeTarget, type SourceManifest } from './manifest';

/** A publishable manifest, ready to be written into a staging directory. */
export interface StagedManifest extends Record<string, unknown> {
  name: string;
  version: string;
  exports: Record<string, { types: string; import: string }>;
  main: string;
  types: string;
  files: string[];
  engines: { node: string };
  repository?: { type: string; url: string; directory: string };
  homepage?: string;
  bugs?: { url: string };
}

// ---------------------------------------------------------------------------
// Repository metadata
// ---------------------------------------------------------------------------

/**
 * The per-package GitHub metadata a staged manifest carries (M22, ADR-0014). npm renders
 * `repository`/`homepage`/`bugs` on the package page, and trusted publishing (OIDC) validates the
 * `repository.url` against the workflow's repository — a monorepo package points at the repo with
 * `directory` naming the package's own subdirectory.
 */
export interface RepoMetadata {
  repository: { type: 'git'; url: string; directory: string };
  homepage: string;
  bugs: { url: string };
}

/** Normalize any usual GitHub remote/URL form to `https://github.com/<owner>/<repo>`; refuse the rest. */
export function githubRepoOf(url: string): string {
  const forms = [
    /^git\+https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/,
    /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/,
    /^git\+ssh:\/\/git@github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/,
  ];
  for (const form of forms) {
    const match = url.match(form);
    if (match !== null) return `https://github.com/${match[1]}/${match[2]}`;
  }
  // A non-GitHub host, or an SSH host *alias* (`git@github.com-personal:…`) that cannot be
  // resolved to a URL: both are refused rather than published as something they are not.
  throw new Error(
    `release: repository is not a resolvable github.com URL (${url || '(empty)'}) — trusted publishing requires it; set the canonical URL in the root package.json`,
  );
}

/**
 * Derive one package's repository metadata from the root manifest's `repository` and the package's
 * workspace directory. The root manifest is the source of truth (the git remote may carry an SSH
 * alias that no tool can resolve), and a missing repository is an error: a published package
 * without provenance or a repo link is a broken package page, not a convenience.
 */
export function repoMetadataOf(root: SourceManifest, dir: string): RepoMetadata {
  const repository = root.repository;
  const url =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && typeof (repository as { url?: unknown }).url === 'string'
        ? ((repository as { url: string }).url)
        : undefined;
  if (url === undefined) {
    throw new Error('release: root package.json declares no repository.url — staged manifests must not ship bare');
  }
  const repo = githubRepoOf(url);
  return {
    repository: { type: 'git', url: `git+${repo}.git`, directory: dir },
    homepage: `${repo}#readme`,
    bugs: { url: `${repo}/issues` },
  };
}

/** `workspace:*` / `workspace:^` → `^<version>`; every other spec passes through. */
export function publishableDependencySpec(spec: string, version: string): string {
  if (!spec.startsWith('workspace:')) return spec;
  const range = spec.slice('workspace:'.length);
  // `workspace:*` and `workspace:^` mean "the workspace version"; `workspace:^1.2.3` keeps its range.
  if (range === '*' || range === '^' || range === '') return `^${version}`;
  return range.replace(/^[~^]/, '^');
}

/** The `exports` map with every non-test-support target repointed at the built artifact. */
function stagedExports(manifest: SourceManifest): Record<string, { types: string; import: string }> {
  const source = manifest.exports;
  const entries: Array<[string, string]> = [];
  if (typeof source === 'string') {
    entries.push(['.', normalizeTarget(source)]);
  } else if (source !== undefined) {
    for (const [key, value] of Object.entries(source)) {
      if (isTestSupportKey(key)) continue;
      // Our manifests use plain string targets; a condition object would need a nested rewrite,
      // so fail loudly rather than publish something subtly wrong.
      if (typeof value !== 'string') throw new Error(`release: ${manifest.name} exports['${key}'] must be a string target`);
      entries.push([key, normalizeTarget(value)]);
    }
  }
  const staged: Record<string, { types: string; import: string }> = {};
  for (const [key, target] of entries) {
    staged[key] = { types: `./${distTypesOf(target)}`, import: `./${distEntryOf(target)}` };
  }
  return staged;
}

/**
 * Build the manifest that goes into a staging directory: the repo manifest with dev-only fields
 * stripped and every path/dependency rewritten to the published form.
 *
 * `files` comes from the repo manifest when it declares one (`packages/storage` ships its SQL
 * `migrations/` alongside `dist/` — the CLI cannot migrate its own database without them) and
 * defaults to `dist` alone.
 */
export function stagedManifest(
  manifest: SourceManifest,
  version: string = manifest.version,
  repo?: RepoMetadata,
): StagedManifest {
  const { entries, bins } = deriveTargets(manifest);
  if (entries.length === 0) throw new Error(`release: ${manifest.name} has no publishable entry`);

  const publishedFiles = manifest.files ?? ['dist'];
  if (!publishedFiles.includes('dist')) {
    throw new Error(`release: ${manifest.name} files must include 'dist' (found ${publishedFiles.join(', ')})`);
  }

  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {})
      .map(([name, spec]) => [name, publishableDependencySpec(spec, version)] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  const staged: Record<string, unknown> = {
    name: manifest.name,
    version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    license: manifest.license ?? 'Apache-2.0',
    type: manifest.type ?? 'module',
    // Repository metadata (trusted publishing validates `repository.url`; the package page
    // renders all three). Omitted only when the caller gave no repo context (unit calls).
    ...(repo === undefined
      ? {}
      : { repository: repo.repository, homepage: repo.homepage, bugs: repo.bugs }),
    main: `./${distEntryOf(entries.includes('src/index.ts') ? 'src/index.ts' : entries[0]!)}`,
    types: `./${distTypesOf(entries.includes('src/index.ts') ? 'src/index.ts' : entries[0]!)}`,
    exports: stagedExports(manifest),
    ...(bins.length === 0
      ? {}
      : {
          bin: Object.fromEntries(bins.map((bin) => [bin.name, `./${distEntryOf(bin.target)}`])),
        }),
    files: publishedFiles,
    engines: { node: '>=22' },
    ...(manifest.name.startsWith('@') ? { publishConfig: { access: 'public' } } : {}),
    ...(Object.keys(dependencies).length === 0 ? {} : { dependencies }),
  };
  return staged as StagedManifest;
}

/** Every path a package publishes beyond the built `dist/` (runtime assets like SQL migrations). */
export function extraPublishedFiles(manifest: SourceManifest): string[] {
  return (manifest.files ?? []).filter((entry) => entry !== 'dist');
}

/** One package in a release plan: its name, workspace dir, and the tarball to publish. */
export interface PlannedPackage {
  name: string;
  dir: string;
  tarball: string | null;
}

export interface ReleasePlanShape {
  version: string;
  packages: PlannedPackage[];
}

/**
 * The packages a `publish` run should touch. A registry write is irreversible and a mid-sequence
 * failure (expired OTP, network) leaves a partial release, so the run must be resumable:
 * `--only <name>` re-runs a single package, `--from <name>` resumes at a package and continues in
 * order. Both are looked up by name because that is what the operator sees in the plan; an unknown
 * name is an error, never a silently empty run.
 */
export function selectPlanned(
  packages: readonly PlannedPackage[],
  options: { from?: string; only?: string } = {},
): PlannedPackage[] {
  if (options.from !== undefined && options.only !== undefined) {
    throw new Error('release: --from and --only are mutually exclusive');
  }
  if (options.only !== undefined) {
    const match = packages.find((pkg) => pkg.name === options.only);
    if (match === undefined) throw new Error(`release: --only ${options.only} is not in the plan`);
    return [match];
  }
  if (options.from !== undefined) {
    const index = packages.findIndex((pkg) => pkg.name === options.from);
    if (index === -1) throw new Error(`release: --from ${options.from} is not in the plan`);
    return packages.slice(index);
  }
  return [...packages];
}

/** The next package to publish after `published` succeeded — the resume point, or null when done. */
export function resumeFrom(packages: readonly PlannedPackage[], published: number): PlannedPackage | null {
  return packages[published] ?? null;
}

// ---------------------------------------------------------------------------
// Publish order
// ---------------------------------------------------------------------------


export interface PublishablePackage {
  dir: string;
  manifest: SourceManifest;
}

/**
 * Topological order over the workspace-internal dependency edges (`@onememory-ai/*`), alphabetical
 * within a level so the order is deterministic: a consumer never resolves a dependency that has
 * not been published yet.
 */
export function publishOrder(packages: readonly PublishablePackage[]): string[] {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const remaining = new Map(
    packages.map((pkg) => [
      pkg.manifest.name,
      new Set(
        Object.keys(pkg.manifest.dependencies ?? {}).filter((name) => byName.has(name)),
      ),
    ]),
  );

  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((dep) => ordered.includes(dep)))
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      throw new Error(`release: dependency cycle among ${[...remaining.keys()].join(', ')}`);
    }
    for (const name of ready) {
      ordered.push(name);
      remaining.delete(name);
    }
  }
  return ordered;
}
