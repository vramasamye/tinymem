/**
 * Symbol-table extraction (ADR-0008 `code_symbols.span_hash` — intra-file granularity): parse
 * the repository's source files with tree-sitter and produce, per file, the ordered symbol
 * table plus a `symbols_hash` over it (the `file_fingerprints.symbols_hash` the persistence
 * slice now writes). This is the extraction half of "Symbol tables re-extract only changed
 * files": `options.files` re-extracts exactly the paths a `detectChanges`/`DriftWatcher`
 * report flags — the primitive the future re-index job drives.
 *
 * Safety conventions are fingerprint capture's, shared by construction through
 * `scanWorktree`/`createPathFilter`/`resolveRepositoryRoot`: the same Git probe rules (bare
 * repositories, subdirectory roots, broken metadata = errors, never a misleading fallback),
 * the same exclusion policy (ignored directories, ADR-0007 security defaults, caller globs),
 * the same file-budget behavior, and the same read discipline (no symlink following, size
 * caps, race detection — a file that changes mid-read is unreadable, never a stale parse).
 * Source bytes are read in-process because extraction parses content — but only symbol
 * metadata leaves this module; raw source never enters a result.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';

import { extractFileSymbols } from './declarations';
import { languageForPath, parseSource } from './grammar';
import { createPathFilter, inside, resolveRepositoryRoot, scanWorktree } from './fingerprints';
import {
  FingerprintError,
  SymbolOptionsSchema,
  SymbolTableSchema,
} from './schema';
import type {
  SkippedSymbolFile,
  SymbolFile,
  SymbolLanguage,
  SymbolOptions,
  SymbolRecord,
  SymbolTable,
} from './schema';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const SYMBOLS_HASH_DOMAIN = 'onememory.symbols.v1';

/**
 * SHA-256 over a file's ordered symbol table (kind, name, signature, line range, span hash per
 * symbol, in document order). Positions are part of the hash on purpose: the persisted table
 * rows include them, so a table whose rows moved is a changed table.
 */
export function computeSymbolsHash(symbols: readonly SymbolRecord[]): string {
  const hash = createHash('sha256').update(SYMBOLS_HASH_DOMAIN).update('\n');
  for (const symbol of symbols) {
    hash.update(`${symbol.kind}\0${symbol.name}\0${symbol.signature}\0`);
    hash.update(`${symbol.line_start}\0${symbol.line_end}\0${symbol.span_hash}\n`);
  }
  return hash.digest('hex');
}

/**
 * Extract the repository's symbol table. Full scan by default; with `options.files` set,
 * exactly those paths (the only-changed re-extraction primitive). Every covered path resolves
 * to one entry: a `files` row (a known-language file may legitimately declare nothing) or an
 * honest `skipped` row — never a fabricated "no symbols" for bytes that could not be read.
 * Only fingerprints/metadata are returned: parsed source never is.
 */
export async function extractSymbolTable(
  root: string,
  options: SymbolOptions = {},
): Promise<SymbolTable> {
  const parsed = SymbolOptionsSchema.parse(options);
  const canonicalRoot = await resolveRepositoryRoot(root);
  const scan = await scanWorktree(canonicalRoot, parsed);
  const fullScan = parsed.files.length === 0;
  const excluded = createPathFilter(parsed.exclusion_globs);
  const conflicted = new Set(scan.conflicted);
  // Index modes give symbol extraction capture's committed-tier knowledge: tracked symlinks and
  // submodules are reported by their honest reason instead of a filesystem-generic one.
  const indexMode = new Map<string, string>();
  for (const entry of scan.index) indexMode.set(entry.path, entry.mode);
  if (fullScan && scan.candidates.length > parsed.max_files) {
    throw new FingerprintError('scan_limit', 'repository exceeds the configured file budget');
  }
  const targets = fullScan
    ? [...scan.candidates].sort(compareText)
    : [...parsed.files].sort(compareText);

  const files: SymbolFile[] = [];
  const skipped: SkippedSymbolFile[] = [];
  const warnings = [...scan.warnings];
  const failedGrammars = new Set<SymbolLanguage>();

  for (const path of targets) {
    if (excluded(path)) {
      skipped.push({ path, reason: 'excluded' });
      continue;
    }
    if (conflicted.has(path)) {
      skipped.push({ path, reason: 'conflict' });
      continue;
    }
    const mode = indexMode.get(path);
    if (mode === '120000') {
      skipped.push({ path, reason: 'symlink' });
      continue;
    }
    if (mode === '160000') {
      skipped.push({ path, reason: 'submodule' });
      continue;
    }
    const language = languageForPath(path);
    if (language === null) {
      // Outside the symbol domain by design: a full scan stays silent (the file-level
      // fingerprint tier still covers the path); an explicit request is reported honestly.
      if (!fullScan) skipped.push({ path, reason: 'unsupported_language' });
      continue;
    }
    const read = await readSourceFile(canonicalRoot, path, parsed.max_file_bytes);
    if ('reason' in read) {
      skipped.push(read);
      continue;
    }

    let symbols: SymbolRecord[];
    let parseErrors: number;
    try {
      const tree = await parseSource(language, read.source);
      try {
        const extracted = extractFileSymbols(language, tree);
        symbols = extracted.symbols;
        parseErrors = extracted.parse_errors;
      } finally {
        tree.delete();
      }
    } catch (error) {
      // The WASM runtime failing to initialize is global: extraction cannot run at all.
      if (error instanceof FingerprintError && error.code === 'runtime_unavailable') throw error;
      // A grammar that cannot load (missing/corrupt artifact) is per-language: every affected
      // file is reported unavailable, with one warning per grammar — never a fake empty table.
      skipped.push({ path, reason: 'grammar_unavailable' });
      if (!failedGrammars.has(language)) {
        failedGrammars.add(language);
        warnings.push(`the ${language} grammar could not be loaded; its files are reported as unavailable`);
      }
      continue;
    }
    files.push({
      path,
      language,
      symbols,
      symbols_hash: computeSymbolsHash(symbols),
      parse_errors: parseErrors,
    });
  }
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} covered paths were unavailable; inspect skipped for reasons`);
  }
  return SymbolTableSchema.parse({
    version: 1,
    root_path: canonicalRoot,
    extracted_at: new Date().toISOString(),
    files,
    skipped: skipped.sort((a, b) => compareText(a.path, b.path)),
    warnings,
  });
}

/**
 * Read one file's bytes with fingerprint capture's discipline: no symlink following (link,
 * symlinked parent, or O_NOFOLLOW race), size caps, and the read-race check — bytes that
 * changed mid-read are unreadable, never a coherent parse of stale content. Binary detection
 * is honest about its heuristic: a NUL byte or invalid UTF-8 means the bytes are not source.
 *
 * Exported (M4f): the re-index reads the SAME bytes through this one discipline before handing
 * them to the extraction pipeline — the bounded read is shared, never re-implemented.
 */
export async function readSourceFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ source: string } | SkippedSymbolFile> {
  const unavailable = (reason: SkippedSymbolFile['reason']): SkippedSymbolFile => ({ path, reason });
  try {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return unavailable('symlink');
    if (!info.isFile()) return unavailable('unsupported');
    if (info.size > maxBytes) return unavailable('too_large');
    const parent = await realpath(dirname(absolute));
    if (!inside(root, parent) || parent !== dirname(absolute)) return unavailable('symlink');
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const start = await handle.stat();
      if (!start.isFile()) return unavailable('unsupported');
      if (start.size > maxBytes) return unavailable('too_large');
      const buffer = Buffer.alloc(64 * 1024);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return unavailable('too_large');
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const end = await handle.stat();
      if (start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || start.size !== total || end.size !== total) {
        return unavailable('unreadable'); // changed while reading: never claim a coherent parse
      }
      const bytes = Buffer.concat(chunks);
      if (bytes.subarray(0, 8192).includes(0)) return unavailable('binary');
      try {
        const source = utf8.decode(bytes);
        return { source: source.startsWith('\uFEFF') ? source.slice(1) : source };
      } catch {
        return unavailable('binary'); // bytes that are not decodable text are not source
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return unavailable('missing');
    return unavailable(code === 'ELOOP' ? 'symlink' : 'unreadable');
  }
}
