#!/usr/bin/env bun
/**
 * Build the publishable artifacts (M16, ADR-0014).
 *
 * For every publishable workspace package:
 *
 * 1. `bun build <derived entries> --target node --format esm --packages=external --outdir dist`
 *    — one bundle per public entry, every bare specifier left external (so the manifest's
 *    dependency graph stays the truth and no library code is duplicated). Bundling is what makes
 *    the repo's extensionless relative imports a non-issue on Node's ESM loader.
 * 2. `tsc -p tsconfig.build.json` — declarations (`emitDeclarationOnly`) mirroring the src layout.
 * 3. Bins get `#!/usr/bin/env node` (source shebangs say `bun`; one source has none at all) and
 *    mode 0755, because npm links them from `node_modules/.bin`.
 *
 * Usage: `bun run build [package-dir ...]` — no args builds every publishable package.
 * Everything is offline and deterministic; `dist/` is gitignored and never committed.
 */

import { $ } from 'bun';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveTargets, distEntryOf, publishableDirs, readManifest } from './lib/manifest';

const repoRoot = join(import.meta.dir, '..');
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');
const NODE_SHEBANG = '#!/usr/bin/env node';
const BIN_MODE = 0o755;

interface BuiltPackage {
  dir: string;
  entries: string[];
  bins: string[];
}

/** Force the dist bin's shebang to Node (rewriting `bun`, or adding one that was missing). */
function nodeShebangBin(path: string): void {
  const source = readFileSync(path, 'utf8');
  const lines = source.split('\n');
  const body = lines[0]?.startsWith('#!') === true ? lines.slice(1).join('\n') : source;
  writeFileSync(path, `${NODE_SHEBANG}\n${body}`);
  chmodSync(path, BIN_MODE);
}

/**
 * Test scaffolding must never reach a published tarball. The declaration pass (`tsc`) emits a
 * `.d.ts` for every file in the program, and test helpers imported by other test files (`testing`,
 * `test-world`, `fixtures`, `test-support`) can slip in even when `exports` excludes them — that is
 * exactly what shipped four stray `*.d.ts` files until this check existed. Bundles are covered too:
 * a test helper reaching a bundle would ship its code, not just its types.
 */
const TEST_ARTIFACT_PATTERN = /(^|\/)(testing|test-support|test-world|fixtures)(\/|\.)/;

function assertNoTestArtifacts(dir: string, distDir: string): void {
  const strays: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const relativePath = path.slice(distDir.length + 1);
      if (TEST_ARTIFACT_PATTERN.test(relativePath)) strays.push(relativePath);
    }
  };
  walk(distDir);
  if (strays.length > 0) {
    throw new Error(
      `build: ${dir} emitted test scaffolding into dist (${strays.join(', ')}) — tighten tsconfig.build.json's exclude list or rename the file`,
    );
  }
}

async function buildPackage(dir: string): Promise<BuiltPackage> {
  const manifest = readManifest(repoRoot, dir);
  const { entries, bins } = deriveTargets(manifest);
  const distDir = join(repoRoot, dir, 'dist');

  rmSync(distDir, { recursive: true, force: true });
  await $`bun build ${entries.map((entry) => join(repoRoot, dir, entry))} --target=node --format=esm --packages=external --outdir ${distDir} --root ${join(repoRoot, dir, 'src')}`
    .cwd(repoRoot)
    .quiet();

  const tsconfig = join(repoRoot, dir, 'tsconfig.build.json');
  if (!existsSync(tsconfig)) {
    throw new Error(`build: ${dir} has no tsconfig.build.json — declarations would be missing`);
  }
  await $`${TSC} -p ${tsconfig}`.cwd(repoRoot).quiet();

  for (const entry of entries) {
    const bundle = join(repoRoot, dir, distEntryOf(entry));
    if (!existsSync(bundle)) throw new Error(`build: ${dir} produced no ${distEntryOf(entry)}`);
    const declarations = bundle.replace(/\.js$/, '.d.ts');
    if (!existsSync(declarations)) throw new Error(`build: ${dir} produced no ${declarations.replace(repoRoot + '/', '')}`);
  }
  assertNoTestArtifacts(dir, distDir);

  const binPaths: string[] = [];
  for (const bin of bins) {
    const path = join(repoRoot, dir, distEntryOf(bin.target));
    nodeShebangBin(path);
    binPaths.push(`${bin.name} → ${distEntryOf(bin.target)}`);
  }
  return { dir, entries, bins: binPaths };
}

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const all = publishableDirs(repoRoot);
const targets = filters.length === 0 ? all : all.filter((dir) => filters.includes(dir));
if (targets.length === 0) {
  throw new Error(`build: no publishable package matches ${filters.join(', ')} (available: ${all.join(', ')})`);
}

const results = await Promise.all(targets.map((dir) => buildPackage(dir)));
for (const result of results.sort((a, b) => a.dir.localeCompare(b.dir))) {
  const bundleSummary = result.entries.map((entry) => distEntryOf(entry)).join(', ');
  console.log(`${result.dir}: ${bundleSummary}`);
  for (const bin of result.bins) console.log(`${result.dir}: bin ${bin}`);
}
console.log(`build: ${results.length} package(s) → dist/ (${results.reduce((n, r) => n + r.entries.length, 0)} entries)`);
