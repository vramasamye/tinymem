/**
 * Phantom-dependency detection for published bundles (M16, ADR-0014).
 *
 * The monorepo hoists dependencies into one root `node_modules`, so a package can import a module
 * it never declared and still pass every test in the repo — and then fail for every user with
 * `ERR_MODULE_NOT_FOUND` (this is exactly how `@modelcontextprotocol/client` hid in
 * `@onememory-ai/mcp` until the packed smoke caught it). The check reads the BUILT bundles, which is
 * what npm actually ships, and compares bare specifiers against the manifest's declared names.
 */

import { builtinModules } from 'node:module';

/**
 * Matches real import/require statements in ESM bundle output — not strings that look like them.
 *
 * Two deliberate restrictions keep template-embedded code (adapter scaffolds ship TypeScript
 * inside template literals) from producing false positives: every pattern is anchored at column 0
 * of a line, and the CJS `require` form is not matched at all (the build emits static `import`
 * statements for external packages, so `require` only appears inside embedded snippets).
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /^import\s+["']([^"']+)["']/gm, // side-effect import
  /^import\s+[^;]*?from\s+["']([^"']+)["']/gms, // import … from "x" (may wrap lines)
  /^export\s+[^;]*?from\s+["']([^"']+)["']/gms, // export … from "x" (re-exports)
  /^import\s*\(\s*["']([^"']+)["']\s*\)/gm, // dynamic import at column 0
];

/** A plausible package name (a template placeholder like `${PKG}` is not one). */
function isPackageSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('bun:')) return false;
  if (builtinModules.includes(specifier)) return false;
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/i.test(specifier);
}

/** Every bare (non-relative, non-builtin) specifier a source file imports. */
export function bareSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]!;
      if (isPackageSpecifier(specifier)) found.add(specifier);
    }
  }
  return [...found].sort();
}

/** `@scope/pkg/sub/path` → `@scope/pkg`; `pkg/sub/path` → `pkg`. */
export function packageNameOf(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]!;
  return specifier.split('/').slice(0, 2).join('/');
}

/**
 * Dependencies a bundle imports but the manifest never declares. `declared` should carry every
 * dependency family (dependencies, peerDependencies, optionalDependencies) — a devDependency is
 * NOT enough, since npm installs those for the repo, not for a consumer.
 */
export function undeclaredDependencies(bundleSources: readonly string[], declared: readonly string[]): string[] {
  const known = new Set(declared);
  const missing = new Set<string>();
  for (const source of bundleSources) {
    for (const specifier of bareSpecifiers(source)) {
      const name = packageNameOf(specifier);
      if (!known.has(name)) missing.add(name);
    }
  }
  return [...missing].sort();
}
