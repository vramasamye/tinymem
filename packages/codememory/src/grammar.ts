/**
 * The tree-sitter runtime (dependency-verification §9 verdict: ADOPT `web-tree-sitter` — WASM,
 * no OS native addon, no build step at install). Grammar modules are npm packages that ship
 * their prebuilt `.wasm` files, pinned exact in `package.json`; they are read from disk at
 * runtime (`fs` under Bun/Node), never fetched. Bun blocks the grammar packages' native
 * `install` scripts, so an install performs no compilation at all — the WASM artifacts are the
 * only thing consumed. Offline invariant: the core runtime WASM is resolved through
 * `web-tree-sitter`'s exported `web-tree-sitter.wasm` subpath and `Language.load` reads grammar
 * bytes from the installed packages — never fetched; symbol tests pin this with the
 * `@onememory/security` network guard.
 */

import { createRequire } from 'node:module';
import { extname } from 'node:path';

import { Language, Parser } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';

import { FingerprintError } from './schema';
import type { SymbolLanguage } from './schema';

const nodeRequire = createRequire(import.meta.url);

/**
 * The shipped `.wasm` file of one grammar package. Every call site is a literal
 * `require.resolve` so bundlers see a static asset reference (the grammar packages have no
 * `exports` map, so their wasm files are resolvable subpaths).
 */
function grammarWasmPath(language: SymbolLanguage): string {
  switch (language) {
    case 'typescript':
      return nodeRequire.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
    case 'tsx':
      return nodeRequire.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');
    case 'javascript':
      return nodeRequire.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm');
    case 'python':
      return nodeRequire.resolve('tree-sitter-python/tree-sitter-python.wasm');
    case 'go':
      return nodeRequire.resolve('tree-sitter-go/tree-sitter-go.wasm');
    case 'rust':
      return nodeRequire.resolve('tree-sitter-rust/tree-sitter-rust.wasm');
  }
}

/** The source extensions in the symbol domain, mapped to their grammar. */
export const SOURCE_EXTENSIONS: Readonly<Record<string, SymbolLanguage>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** The grammar a path belongs to, or null when the extension is outside the symbol domain. */
export function languageForPath(path: string): SymbolLanguage | null {
  return SOURCE_EXTENSIONS[extname(path)] ?? null;
}

// One runtime init and one parser per grammar per process; failures are retryable (a transient
// init error should not poison later extractions) but shared while pending (one load, one result).
let runtime: Promise<void> | null = null;
const parsers = new Map<SymbolLanguage, Promise<Parser>>();

function ensureRuntime(): Promise<void> {
  if (runtime === null) {
    // Emscripten's default resolution is relative to the loader script's directory, which a
    // bundler moves. Resolve the core WASM explicitly — `web-tree-sitter` exports the subpath,
    // and a literal require.resolve gives bundlers a static asset reference to emit.
    const coreWasm = nodeRequire.resolve('web-tree-sitter/web-tree-sitter.wasm');
    runtime = Parser.init({ locateFile: () => coreWasm }).catch((error: unknown) => {
      runtime = null;
      throw new FingerprintError(
        'runtime_unavailable',
        `the tree-sitter WASM runtime could not initialize (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    });
  }
  return runtime;
}

function acquireParser(language: SymbolLanguage): Promise<Parser> {
  let parser = parsers.get(language);
  if (parser === undefined) {
    parser = (async (): Promise<Parser> => {
      await ensureRuntime();
      const instance = new Parser();
      instance.setLanguage(await Language.load(grammarWasmPath(language)));
      return instance;
    })();
    parser.catch(() => parsers.delete(language)); // a failed grammar load is retryable
    parsers.set(language, parser);
  }
  return parser;
}

/**
 * Parse one source string with its grammar. Rejects (never a fake empty tree) when the runtime
 * or the grammar cannot be loaded — callers report those files as `grammar_unavailable`.
 * The returned Tree is caller-owned: `delete()` it after extraction.
 */
export async function parseSource(language: SymbolLanguage, source: string): Promise<Tree> {
  const parser = await acquireParser(language);
  const tree = parser.parse(source);
  if (tree === null) {
    throw new FingerprintError('runtime_unavailable', `the ${language} parser produced no tree`);
  }
  return tree;
}
