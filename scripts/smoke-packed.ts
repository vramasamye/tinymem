#!/usr/bin/env bun
/**
 * Packed-artifact smoke (M16, ADR-0014) — the Node-compatibility gate for the release.
 *
 * The unit suites run under Bun and import `bun:test`, so they cannot prove the thing that
 * actually matters to a user: that the tarballs npm serves install and run under **Node**. This
 * script packs nothing itself; it takes the tarballs `scripts/release.ts pack` produced, installs
 * them into a scratch project OUTSIDE the repo with npm (Bun is stripped from PATH for every
 * child process), then drives the real CLI:
 *
 *   1. `onememory init` scaffolds a scratch project (no repo checkout, local preset, offline),
 *   2. `onemem doctor --json` reports a clean bill of health (exit 0),
 *   3. `onemem remember` + `onemem search` round-trip a memory through embedded PGlite,
 *   4. hygiene: bins carry a `node` shebang, no `workspace:` specifier or `bun` shebang survived.
 *
 * Usage: `bun run scripts/smoke-packed.ts [--tarballs <dir>] [--keep]`
 */

import { $ } from 'bun';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const tarballsFlag = args.indexOf('--tarballs');
const tarballDir = tarballsFlag === -1 ? join(repoRoot, '.release', 'tarballs') : args[tarballsFlag + 1]!;

if (!existsSync(tarballDir)) {
  throw new Error(`smoke: no tarballs at ${tarballDir} — run \`bun run scripts/release.ts stage && ... pack\` first`);
}
const tarballs = readdirSync(tarballDir)
  .filter((file) => file.endsWith('.tgz'))
  .sort()
  .map((file) => join(tarballDir, file));
if (tarballs.length === 0) throw new Error(`smoke: ${tarballDir} holds no tarballs`);

// Bun is removed from PATH so nothing in this smoke can silently fall back to it: the children are
// npm and node, exactly what a user has.
const nodeBinDir = dirname(process.execPath.includes('bun') ? (Bun.which('node') ?? 'node') : process.execPath);
const cleanEnv = {
  ...process.env,
  PATH: [nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  // Hermetic: npx/npm must not touch the developer's cache, and no telemetry or hosted model call.
  npm_config_cache: join(mkdtempSync(join(tmpdir(), 'onememory-smoke-npm-')), 'cache'),
  NO_COLOR: '1',
  ONEMEMORY_NO_UPDATE_CHECK: '1',
};

const scratch = mkdtempSync(join(tmpdir(), 'onememory-smoke-'));
const projectDir = join(scratch, 'project');
const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

/** Per-child timeout: a hang must fail the smoke, not wedge CI. */
const COMMAND_TIMEOUT_MS = 300_000;

async function run(cmd: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // stdin is ignored (not a pipe): a child that waits for stdin EOF must not hang the smoke.
  const proc = Bun.spawn({ cmd, cwd, env: cleanEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => {
    proc.kill();
  }, COMMAND_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The installed copies of OUR packages (third-party packages are none of our business). */
function installedOnememoryPackages(nodeModules: string): string[] {
  const dirs = [join(nodeModules, 'onememory')];
  const scope = join(nodeModules, '@onememory-ai');
  if (existsSync(scope)) {
    for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(scope, entry.name));
    }
  }
  return dirs.filter((dir) => existsSync(dir));
}

/** Files in the installed packages that still carry a dev-only artifact. */
function hygieneOffenders(nodeModules: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(path));
      else files.push(path);
    }
    return files;
  };
  for (const pkgDir of installedOnememoryPackages(nodeModules)) {
    for (const file of walk(pkgDir)) {
      if (file.endsWith('package.json')) {
        if (readFileSync(file, 'utf8').includes('"workspace:')) offenders.push(`${file}: workspace: specifier`);
      } else if (file.endsWith('.js')) {
        if (readFileSync(file, 'utf8').startsWith('#!/usr/bin/env bun')) offenders.push(`${file}: bun shebang`);
      }
    }
  }
  return offenders;
}

try {
  console.log(`smoke: scratch install at ${scratch}`);
  console.log(`smoke: node ${(await run(['node', '--version'], scratch)).stdout.trim()} · npm ${(await run(['npm', '--version'], scratch)).stdout.trim()}`);
  console.log(`smoke: ${tarballs.length} tarball(s) from ${tarballDir}`);

  await Bun.write(join(scratch, 'package.json'), JSON.stringify({ name: 'onememory-smoke', private: true }, null, 2));
  mkdirSync(projectDir, { recursive: true });

  console.log('\ninstall (npm, node only)');
  const install = await run(['npm', 'install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], scratch);
  check(install.exitCode === 0, `npm install exits 0${install.exitCode === 0 ? '' : ` (${install.stderr.trim().slice(0, 400)})`}`);

  console.log('\nartifact hygiene');
  const installed = join(scratch, 'node_modules', 'onememory');
  check(existsSync(join(installed, 'dist', 'bin.js')), 'the CLI ships dist/bin.js');
  if (existsSync(join(installed, 'dist', 'bin.js'))) {
    const shebang = readFileSync(join(installed, 'dist', 'bin.js'), 'utf8').split('\n')[0]!;
    check(shebang.includes('node'), `the CLI bin shebang is node (${shebang})`);
  }
  check(existsSync(join(installed, 'dist', 'index.d.ts')), 'declarations ship (dist/index.d.ts)');
  const binLink = join(scratch, 'node_modules', '.bin', 'onemem');
  check(existsSync(binLink), 'npm linked the onemem bin');
  if (existsSync(binLink)) {
    check((statSync(binLink).mode & 0o111) !== 0, 'the onemem bin link is executable');
  }
  const offenders = hygieneOffenders(join(scratch, 'node_modules'));
  check(
    offenders.length === 0,
    `no workspace: specifiers or bun shebangs survived (${offenders.slice(0, 3).join(', ') || 'clean'})`,
  );

  console.log('\ninit (a scratch project, no repo checkout)');
  const init = await run(['node', join(installed, 'dist', 'bin.js'), 'init', '--cwd', projectDir, '--name', 'smoke', '--preset', 'local'], scratch);
  check(init.exitCode === 0, `onememory init exits 0${init.exitCode === 0 ? '' : ` (${init.stderr.trim().slice(0, 400)})`}`);
  check(existsSync(join(projectDir, '.onememory', 'project.json')), 'init registered the project');

  console.log('\ndoctor');
  const doctor = await run(['node', join(installed, 'dist', 'bin.js'), 'doctor', '--cwd', projectDir, '--json', '--no-probe'], scratch);
  check(doctor.exitCode === 0, `onemem doctor exits 0${doctor.exitCode === 0 ? '' : ` (${doctor.stderr.trim().slice(0, 400)})`}`);
  if (doctor.stdout.trim() !== '') {
    try {
      const report = JSON.parse(doctor.stdout) as { checks?: Array<{ status?: string; name?: string }> };
      const failed = (report.checks ?? []).filter((entry) => entry.status === 'fail' || entry.status === 'error');
      check(failed.length === 0, `doctor reports no failing checks (${failed.map((entry) => entry.name).join(', ') || 'none'})`);
    } catch {
      check(false, 'doctor --json printed parseable JSON');
    }
  }

  console.log('\nremember → search (embedded PGlite under Node)');
  const remember = await run(
    ['node', join(installed, 'dist', 'bin.js'), 'remember', 'the packed CLI stores memories under node', '--cwd', projectDir, '--json'],
    scratch,
  );
  check(remember.exitCode === 0, `onemem remember exits 0${remember.exitCode === 0 ? '' : ` (${remember.stderr.trim().slice(0, 400)})`}`);
  const search = await run(['node', join(installed, 'dist', 'bin.js'), 'search', 'packed CLI memories node', '--cwd', projectDir, '--json'], scratch);
  check(search.exitCode === 0, `onemem search exits 0${search.exitCode === 0 ? '' : ` (${search.stderr.trim().slice(0, 400)})`}`);
  check(search.stdout.includes('stores memories under node'), 'the remembered text comes back from search');

  console.log('\nnpx onememory (the documented install path, Wave B DoD)');
  const npxProject = join(scratch, 'npx-project');
  mkdirSync(npxProject, { recursive: true });
  const npxInit = await run(['npx', '--no-install', 'onememory', 'init', '--cwd', npxProject, '--name', 'npx-smoke', '--preset', 'local'], scratch);
  check(npxInit.exitCode === 0, `npx onememory init exits 0${npxInit.exitCode === 0 ? '' : ` (${npxInit.stderr.trim().slice(0, 400)})`}`);
  const npxDoctor = await run(['npx', '--no-install', 'onememory', 'doctor', '--cwd', npxProject, '--json', '--no-probe'], scratch);
  check(npxDoctor.exitCode === 0, `npx onememory doctor exits 0${npxDoctor.exitCode === 0 ? '' : ` (${npxDoctor.stderr.trim().slice(0, 400)})`}`);
} finally {
  if (failures.length > 0) {
    console.log(`\nsmoke: ${failures.length} check(s) FAILED — scratch kept at ${scratch}`);
    process.exitCode = 1;
  } else if (keep) {
    console.log(`\nsmoke: all checks passed — scratch kept at ${scratch}`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
    console.log('\nsmoke: all checks passed');
  }
}
