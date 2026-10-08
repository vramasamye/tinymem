#!/usr/bin/env bun
/**
 * Release tooling (M16, ADR-0014): stage → pack → (publish).
 *
 * The repo manifests point at `./src/*.ts` and are `private: true`, so nothing can be published
 * from a package directory. This script writes a **staged** manifest (deps rewritten off the
 * workspace protocol, paths pointed at `dist/`, dev-only fields stripped) into `.release/stage/`,
 * packs each staged package with `npm pack`, and — only with `--yes` — publishes the tarballs in
 * dependency order. `bun run scripts/smoke-packed.ts` then proves the tarballs install and run
 * under Node before anything reaches a registry.
 *
 * Usage:
 *   bun run scripts/release.ts order                 # the publish plan (no writes)
 *   bun run scripts/release.ts stage                 # requires a completed `bun run build`
 *   bun run scripts/release.ts pack                  # staged dirs → .release/tarballs/*.tgz
 *   bun run scripts/release.ts publish --dry-run     # npm's dry run, per tarball
 *   bun run scripts/release.ts publish --yes         # the real thing
 *   bun run scripts/release.ts clean
 */

import { $ } from 'bun';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { undeclaredDependencies } from './lib/deps';
import { deriveTargets, distEntryOf, publishableDirs, readManifest } from './lib/manifest';
import { publishOrder, stagedManifest, extraPublishedFiles, selectPlanned, resumeFrom, repoMetadataOf, type PublishablePackage } from './lib/publish';

const repoRoot = join(import.meta.dir, '..');
const releaseDir = join(repoRoot, '.release');
const stageDir = join(releaseDir, 'stage');
const tarballDir = join(releaseDir, 'tarballs');
const planPath = join(releaseDir, 'release-plan.json');

interface ReleasePlan {
  version: string;
  packages: Array<{ name: string; dir: string; tarball: string | null }>;
}

function workspace(): PublishablePackage[] {
  return publishableDirs(repoRoot).map((dir) => ({ dir, manifest: readManifest(repoRoot, dir) }));
}

function versionOf(packages: readonly PublishablePackage[]): string {
  const versions = new Set(packages.map((pkg) => pkg.manifest.version));
  if (versions.size !== 1) {
    throw new Error(`release: the workspace must be single-version (found ${[...versions].join(', ')})`);
  }
  return [...versions][0]!;
}

function readPlan(): ReleasePlan {
  if (!existsSync(planPath)) throw new Error('release: no plan — run `stage` and `pack` first');
  return JSON.parse(readFileSync(planPath, 'utf8')) as ReleasePlan;
}

/** Build artifacts must exist before staging: a tarball without `dist/` is a broken install. */
function assertBuilt(pkg: PublishablePackage): void {
  const { entries, bins } = deriveTargets(pkg.manifest);
  for (const entry of [...entries, ...bins.map((bin) => bin.target)]) {
    const bundle = join(repoRoot, pkg.dir, distEntryOf(entry));
    if (!existsSync(bundle)) {
      throw new Error(`release: ${pkg.dir} has no ${distEntryOf(entry)} — run \`bun run build\` first`);
    }
  }
}

/**
 * No bundle may import a package its manifest does not declare: the monorepo hoists everything
 * into one root `node_modules`, so a phantom dependency passes every test in the repo and then
 * breaks every install (ADR-0014 — the packed smoke caught exactly this in `@onememory-ai/mcp`).
 */
function assertNoPhantomDependencies(pkg: PublishablePackage): void {
  const distDir = join(repoRoot, pkg.dir, 'dist');
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) sources.push(readFileSync(path, 'utf8'));
    }
  };
  walk(distDir);

  const manifest = pkg.manifest;
  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  const missing = undeclaredDependencies(sources, declared);
  if (missing.length > 0) {
    throw new Error(
      `release: ${pkg.manifest.name} imports undeclared package(s): ${missing.join(', ')} — add them to dependencies (a devDependency is not enough)`,
    );
  }
}

function stage(packages: readonly PublishablePackage[], version: string): void {
  // The root manifest is the source of truth for the repository URL — the git remote may carry an
  // SSH host alias (`git@github.com-personal:…`) that no tool can resolve. Every staged manifest
  // points at the repo with its own `directory` (M22: trusted publishing validates `repository.url`
  // and the npm package page renders all three fields).
  const root = readManifest(repoRoot, '.');
  rmSync(stageDir, { recursive: true, force: true });
  for (const pkg of packages) {
    assertBuilt(pkg);
    assertNoPhantomDependencies(pkg);
    const target = join(stageDir, pkg.dir);
    mkdirSync(target, { recursive: true });
    cpSync(join(repoRoot, pkg.dir, 'dist'), join(target, 'dist'), { recursive: true });
    // Runtime assets the package declares beyond dist/ (storage ships its SQL migrations).
    for (const asset of extraPublishedFiles(pkg.manifest)) {
      const source = join(repoRoot, pkg.dir, asset);
      if (!existsSync(source)) throw new Error(`release: ${pkg.dir} declares files: '${asset}' but it does not exist`);
      cpSync(source, join(target, asset), { recursive: true });
    }
    // The tarball should carry the license text (npm picks up LICENSE automatically).
    cpSync(join(repoRoot, 'LICENSE'), join(target, 'LICENSE'));
    writeFileSync(
      join(target, 'package.json'),
      `${JSON.stringify(stagedManifest(pkg.manifest, version, repoMetadataOf(root, pkg.dir)), null, 2)}\n`,
    );
  }
  console.log(`release: staged ${packages.length} package(s) at ${stageDir}`);
}

async function pack(packages: readonly PublishablePackage[], version: string): Promise<ReleasePlan> {
  if (!existsSync(stageDir)) throw new Error('release: nothing staged — run `stage` first');
  rmSync(tarballDir, { recursive: true, force: true });
  mkdirSync(tarballDir, { recursive: true });

  const order = publishOrder(packages);
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const entries: ReleasePlan['packages'] = [];
  for (const name of order) {
    const pkg = byName.get(name)!;
    const stagedDir = join(stageDir, pkg.dir);
    await $`npm pack --pack-destination ${tarballDir} --silent`.cwd(stagedDir).quiet();
    const tarball = join(tarballDir, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    if (!existsSync(tarball)) throw new Error(`release: npm pack produced no ${tarball}`);
    entries.push({ name, dir: pkg.dir, tarball });
  }
  const plan: ReleasePlan = { version, packages: entries };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`release: packed ${entries.length} tarball(s) at ${tarballDir}`);
  return plan;
}

interface PublishFlags {
  dryRun: boolean;
  yes: boolean;
  /** One-time code for accounts with 2FA required for publishing (npm's `--otp`). */
  otp?: string;
  from?: string;
  only?: string;
}

/**
 * Publish the selected packages in order, reporting partial progress.
 *
 * A registry write is irreversible, so a mid-sequence failure must leave an operator with an exact
 * account of what landed and an obvious way to continue. On failure the error names every package
 * that DID publish and prints the `--from` command that resumes after it.
 */
async function publish(plan: ReleasePlan, flags: PublishFlags): Promise<void> {
  if (!flags.dryRun && !flags.yes) {
    throw new Error('release: refusing to publish without --yes (use --dry-run to inspect first)');
  }
  const selected = selectPlanned(plan.packages, {
    ...(flags.from === undefined ? {} : { from: flags.from }),
    ...(flags.only === undefined ? {} : { only: flags.only }),
  });

  const published: string[] = [];
  for (const pkg of selected) {
    if (pkg.tarball === null) throw new Error(`release: ${pkg.name} has no tarball — re-run pack`);
    const args = ['publish', pkg.tarball, '--tag', 'latest'];
    if (pkg.name.startsWith('@')) args.push('--access', 'public');
    if (flags.dryRun) args.push('--dry-run');
    if (flags.otp !== undefined) args.push('--otp', flags.otp);
    try {
      // npm only runs its browser 2FA flow when stdin and stdout are a TTY;
      // piped output makes it fail fast with EOTP and a redacted auth URL.
      const child = Bun.spawn(['npm', ...args], { cwd: repoRoot, stdio: ['inherit', 'inherit', 'inherit'] });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new Error(`release: npm publish ${pkg.name} exited with code ${exitCode}`);
    } catch (error) {
      if (published.length > 0) {
        const next = resumeFrom(selected, published.length);
        console.error(`release: ${published.length} package(s) DID publish: ${published.join(', ')}`);
        if (next !== null) {
          console.error(`release: resume with \`bun run scripts/release.ts publish --yes --from ${next.name}\``);
        }
      } else {
        console.error('release: nothing was published');
      }
      throw error;
    }
    published.push(pkg.name);
  }
  console.log(`release: ${flags.dryRun ? 'dry-ran' : 'published'} ${published.length} package(s)`);
}

/** `--from <name>`, `--only <name>`, `--otp <code>` parsed from the command line. */
function publishFlags(args: readonly string[]): PublishFlags {
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const otp = valueOf('--otp');
  const from = valueOf('--from');
  const only = valueOf('--only');
  return {
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes'),
    ...(otp === undefined ? {} : { otp }),
    ...(from === undefined ? {} : { from }),
    ...(only === undefined ? {} : { only }),
  };
}

const [command, ...rest] = process.argv.slice(2);
const packages = workspace();
const version = versionOf(packages);

switch (command) {
  case 'order': {
    const order = publishOrder(packages);
    console.log(`release plan (version ${version}, ${order.length} packages, in publish order):`);
    for (const [index, name] of order.entries()) {
      const pkg = packages.find((candidate) => candidate.manifest.name === name)!;
      console.log(`  ${String(index + 1).padStart(2)}. ${name}  (${pkg.dir})`);
    }
    break;
  }
  case 'stage':
    stage(packages, version);
    break;
  case 'pack': {
    const plan = await pack(packages, version);
    for (const pkg of plan.packages) console.log(`  ${pkg.name} → ${pkg.tarball}`);
    break;
  }
  case 'publish':
    await publish(readPlan(), publishFlags(rest));
    break;
  case 'clean':
    rmSync(releaseDir, { recursive: true, force: true });
    console.log('release: removed .release/');
    break;
  default:
    throw new Error(
      'release: usage: release.ts <order|stage|pack|publish|clean> [--dry-run|--yes|--from <name>|--only <name>|--otp <code>]',
    );
}
