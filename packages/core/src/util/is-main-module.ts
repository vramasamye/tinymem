/**
 * Portable main-module detection (M16, ADR-0014).
 *
 * Bun's `import.meta.main` is a Bun/Deno-only property: Node LTS leaves it `undefined`, so a bin
 * guarded by it exits silently when installed from npm. This check works on both runtimes by
 * comparing the module's own real path against the process entry (`process.argv[1]`) — through
 * `realpath`, so an npm bin symlink in `node_modules/.bin` still matches the file it points at.
 *
 * Callers MUST pass their own `import.meta.url`: inside a helper, `import.meta.url` names the
 * helper's own file, not the entry point being checked.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve a path to its real path; may throw (the caller treats a throw as "not the entry"). */
export type PathResolver = (path: string) => string;

/**
 * Is `moduleUrl` the process entry point `argvPath`? Pure and injectable so it is unit-testable
 * without spawning processes. A missing entry, a non-`file:` URL, or an unresolvable path is
 * `false` — never a throw: module loading must not be affected by a filesystem quirk.
 */
export function isMainModulePath(
  moduleUrl: string,
  argvPath: string | undefined,
  resolve: PathResolver = realpathSync,
): boolean {
  if (argvPath === undefined || argvPath === '' || !moduleUrl.startsWith('file:')) return false;
  let selfPath: string;
  try {
    selfPath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const realOf = (path: string): string | null => {
    try {
      return resolve(path);
    } catch {
      return null;
    }
  };
  const self = realOf(selfPath);
  const entry = realOf(argvPath);
  return self !== null && entry !== null && self === entry;
}

/** `isMainModulePath` for the calling module: pass `import.meta.url` from the entry file. */
export function isMainModule(moduleUrl: string): boolean {
  return isMainModulePath(moduleUrl, process.argv[1]);
}
