import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { uuidv7 } from '@onememory/core';
import { installNetworkGuard } from '@onememory/security';
import { createEmbeddedDb, ValidationError } from '@onememory/storage';

import { captureSnapshot, detectChanges, extractSymbolTable } from './index';
import type { SymbolTable } from './index';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(git = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'onemem code symbols '));
  roots.push(root);
  if (git) await command(root, 'init', '-q');
  return root;
}

async function command(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 });
  return result.stdout.trim();
}

async function commit(root: string): Promise<void> {
  await command(root, 'add', '--all');
  await command(root, 'commit', '-qm', 'test: record symbol fixture');
}

function fileOf(table: SymbolTable, path: string) {
  const file = table.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`fixture missing symbol file ${path}`);
  return file;
}

function rowsOf(table: SymbolTable, path: string) {
  return fileOf(table, path).symbols.map(
    (symbol) => `${symbol.kind} ${symbol.name} L${symbol.line_start}-${symbol.line_end} ${symbol.signature}`,
  );
}

const TS_SOURCE = [
  "import { z } from 'zod';",
  '',
  '// a function-like binding: the declarator is the named symbol',
  'export const handler = async (req: Request): Promise<Response> => {',
  "  return new Response('ok');",
  '};',
  '',
  'export function greet(name: string): string {',
  '  const double = (n: number) => n * 2; // nested: covered by greet\'s span, not its own row',
  '  return double(1) + name;',
  '}',
  '',
  'export default class Foo<T> extends Bar implements Baz {',
  '  private count = 0;',
  '  constructor(private readonly id: string) { super(); }',
  '  async *stream(): AsyncGenerator<number> { yield 1; }',
  '}',
  '',
  'export interface Config {',
  '  port: number;',
  '  listen(host: string): void;',
  '}',
  '',
  "export type Id = string & { brand: 'id' };",
  'export enum Color { Red, Green }',
  'namespace NS { export const inner = 1; }',
  "declare module 'ambient' { export const skipped: number; }",
  '',
].join('\n');

describe('tree-sitter symbol extraction', () => {
  test('extraction and grammar loading run with zero network calls (offline invariant)', async () => {
    const root = await fixture();
    await writeFile(join(root, 'offline.ts'), 'export function offline(): void {}\n');
    const guard = installNetworkGuard();
    try {
      const table = await extractSymbolTable(root); // first parse: runtime + grammar WASM load
      expect(fileOf(table, 'offline.ts').symbols.map((symbol) => symbol.name)).toEqual(['offline']);
      guard.assertZeroCalls();
    } finally {
      guard.restore();
    }
  });

  test('extracts the TypeScript declaration surface with exact spans, signatures, and kinds', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.ts'), TS_SOURCE);
    const table = await extractSymbolTable(root);
    expect(fileOf(table, 'src/app.ts').language).toBe('typescript');
    expect(fileOf(table, 'src/app.ts').parse_errors).toBe(0);
    expect(rowsOf(table, 'src/app.ts')).toEqual([
      'function handler L4-6 handler = async ( req : Request ) : Promise < Response >',
      'function greet L8-11 function greet ( name : string ) : string',
      'class Foo L13-17 class Foo < T >',
      'method constructor L15-15 constructor ( private readonly id : string )',
      'method stream L16-16 async * stream ( ) : AsyncGenerator < number >',
      'interface Config L19-22 interface Config',
      'method listen L21-21 listen ( host : string ) : void',
      'type Id L24-24 type Id',
      'enum Color L25-25 enum Color',
      'module NS L26-26 namespace NS',
    ]);
    // The nested arrow binding inside greet is NOT a separate row (function bodies are
    // terminal), and ambient declarations produce no symbols.
    const names = fileOf(table, 'src/app.ts').symbols.map((symbol) => symbol.name);
    expect(names).not.toContain('double');
    expect(names).not.toContain('skipped');
  });

  test('span hashes survive cosmetic changes and move on real symbol edits', async () => {
    const root = await fixture();
    const original = [
      'export function first(n: number): number {',
      '  // TODO: cleanup',
      '  return n + 1;',
      '}',
      '',
      '// a comment between the two symbols',
      'export function second(n: number): number {',
      '  return n * 2;',
      '}',
      '',
    ].join('\n');
    await writeFile(join(root, 'math.ts'), original);
    const before = await extractSymbolTable(root);
    const beforeFile = fileOf(before, 'math.ts');

    // Cosmetic: comment rewrites, reindentation, CRLF endings. Token content is unchanged, so
    // every span hash and the table hash stay exactly the same.
    const cosmetic = original
      .replace('// TODO: cleanup', '// TODO: actually rewrite this comment')
      .replace('// a comment between the two symbols', '// a DIFFERENT comment, still cosmetic')
      .replace(/^  return n \+ 1;$/m, '      return n + 1;');
    await writeFile(join(root, 'math.ts'), cosmetic.replaceAll('\n', '\r\n'));
    const afterCosmetic = await extractSymbolTable(root);
    expect(fileOf(afterCosmetic, 'math.ts').symbols.map((symbol) => symbol.span_hash)).toEqual(
      beforeFile.symbols.map((symbol) => symbol.span_hash),
    );
    expect(fileOf(afterCosmetic, 'math.ts').symbols_hash).toBe(beforeFile.symbols_hash);

    // Real: a token change inside the second function moves only its span hash.
    await writeFile(join(root, 'math.ts'), original.replace('n * 2', 'n * 3'));
    const afterReal = await extractSymbolTable(root);
    const realFile = fileOf(afterReal, 'math.ts');
    const beforeSecond = beforeFile.symbols[1]?.span_hash ?? null;
    expect(realFile.symbols[0]?.span_hash).toBe(beforeFile.symbols[0]?.span_hash);
    expect((realFile.symbols[1]?.span_hash ?? null) !== beforeSecond).toBe(true);
    expect(realFile.symbols_hash).not.toBe(beforeFile.symbols_hash);
  });

  test('symbols_hash includes positions, so line shifts change the table hash', async () => {
    const root = await fixture();
    const original = 'export function only(n: number): number {\n  return n;\n}\n';
    await writeFile(join(root, 'one.ts'), original);
    const before = await extractSymbolTable(root);
    // Insert a comment line above: no symbol content changed, but every row moved down one line.
    await writeFile(join(root, 'one.ts'), `// new leading comment\n${original}`);
    const after = await extractSymbolTable(root);
    const beforeSymbol = fileOf(before, 'one.ts').symbols[0]!;
    const afterSymbol = fileOf(after, 'one.ts').symbols[0]!;
    expect(afterSymbol.span_hash).toBe(beforeSymbol.span_hash); // content unchanged
    expect(afterSymbol.line_start).toBe(beforeSymbol.line_start + 1);
    expect(fileOf(after, 'one.ts').symbols_hash).not.toBe(fileOf(before, 'one.ts').symbols_hash);
  });

  test('JavaScript, Python, Go, and Rust extract with their kind vocabularies', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'util.js'),
      [
        'export function helper(a) { return a; }',
        'function* gen() { yield 1; }',
        'const config = { async load(x) { return x; }, get done() { return true; } };',
        'const anonymous = function () { return 1; };',
        'class Widget extends Base { static make() { return new Widget(); } }',
        'const data = 42; // plain data bindings are outside the symbol domain',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'service.py'),
      [
        'import os',
        '',
        '@decorator',
        'async def top(a: int, b: str = "x") -> bool:',
        '    def inner():',
        '        pass',
        '    return True',
        '',
        'class C(Base):',
        '    attr: int = 1',
        '    def __init__(self):',
        '        self.x = 1',
        '    @property',
        '    def value(self):',
        '        return 1',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'main.go'),
      [
        'package main',
        '',
        'type Point struct { X, Y int }',
        'type Shape interface { Area() float64 }',
        'type Alias = int',
        'var data = 1',
        '',
        'func (p *Point) Move(dx int) {}',
        'func Top(a int, b string) (int, error) { return 0, nil }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'lib.rs'),
      [
        'pub struct Point { pub x: u32 }',
        'pub enum Kind { A, B }',
        'pub trait Shape { fn area(&self) -> u32; fn describe(&self) {} }',
        'impl Display for Point { fn fmt(&self) -> R { ok() } }',
        'impl Point { fn new() -> Self { unimplemented!() } }',
        'pub type Meters = u32;',
        'mod inner { pub fn deep() {} }',
        'fn main() { println!("hi"); }',
        '',
      ].join('\n'),
    );
    const table = await extractSymbolTable(root);
    expect(fileOf(table, 'util.js').language).toBe('javascript');
    expect(rowsOf(table, 'util.js')).toEqual([
      'function helper L1-1 function helper ( a )',
      'function gen L2-2 function * gen ( )',
      'method load L3-3 async load ( x )',
      'method done L3-3 get done ( )',
      'function anonymous L4-4 anonymous = function ( )',
      'class Widget L5-5 class Widget',
      'method make L5-5 static make ( )',
    ]);
    expect(rowsOf(table, 'service.py')).toEqual([
      'function top L3-7 @ decorator async def top ( a : int , b : str = " x " ) -> bool',
      'class C L9-15 class C ( Base )',
      'method __init__ L11-12 def __init__ ( self )',
      'method value L13-15 @ property def value ( self )',
    ]);
    expect(rowsOf(table, 'main.go')).toEqual([
      'struct Point L3-3 Point struct',
      'interface Shape L4-4 Shape interface',
      'method Area L4-4 Area ( ) float64',
      'type Alias L5-5 Alias = int',
      'method Move L8-8 func ( p * Point ) Move ( dx int )',
      'function Top L9-9 func Top ( a int , b string ) ( int , error )',
    ]);
    expect(rowsOf(table, 'lib.rs')).toEqual([
      'struct Point L1-1 pub struct Point',
      'enum Kind L2-2 pub enum Kind',
      'trait Shape L3-3 pub trait Shape',
      'method area L3-3 fn area ( & self ) -> u32',
      'method describe L3-3 fn describe ( & self )',
      'impl impl Display for Point L4-4 impl Display for Point',
      'method fmt L4-4 fn fmt ( & self ) -> R',
      'impl impl Point L5-5 impl Point',
      'method new L5-5 fn new ( ) -> Self',
      'type Meters L6-6 pub type Meters = u32',
      'module inner L7-7 mod inner',
      'function deep L7-7 pub fn deep ( )',
      'function main L8-8 fn main ( )',
    ]);
  });

  test('TSX files parse with the tsx grammar and stay in the symbol domain', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'widget.tsx'),
      'export function Card({ title }: { title: string }) {\n  return <div>{title}</div>;\n}\nexport const App = () => <Card title="hi" />;\n',
    );
    const table = await extractSymbolTable(root);
    expect(fileOf(table, 'widget.tsx').language).toBe('tsx');
    expect(fileOf(table, 'widget.tsx').symbols.map((symbol) => symbol.name)).toEqual(['Card', 'App']);
  });

  test('parse errors are counted; valid declarations still extract', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'broken.ts'),
      'export function good(): void {}\nexport function broken( { return 1;\n',
    );
    const table = await extractSymbolTable(root);
    const file = fileOf(table, 'broken.ts');
    expect(file.parse_errors).toBeGreaterThan(0);
    expect(file.symbols.map((symbol) => symbol.name)).toContain('good');
  });

  test('capture exclusion conventions apply: ignored directories and policy globs never extract', async () => {
    const root = await fixture();
    await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'vendor'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'dep', 'index.ts'), 'export function dep(): void {}\n');
    await writeFile(join(root, 'dist', 'bundle.ts'), 'export function built(): void {}\n');
    await writeFile(join(root, '.env'), 'SECRET=1\n');
    await writeFile(join(root, 'aws_credentials.json'), '{"secret": 1}\n');
    await writeFile(join(root, 'vendor', 'generated.ts'), 'export function vendored(): void {}\n');
    const table = await extractSymbolTable(root);
    expect(table.files.map((file) => file.path)).toEqual(['vendor/generated.ts']);
    expect(table.skipped).toEqual([]); // excluded paths are not candidates, not unavailable
    // An explicitly requested excluded path is reported honestly, not silently dropped.
    const targeted = await extractSymbolTable(root, {
      files: ['dist/bundle.ts', 'aws_credentials.json'],
    });
    expect(targeted.skipped).toEqual([
      { path: 'aws_credentials.json', reason: 'excluded' },
      { path: 'dist/bundle.ts', reason: 'excluded' },
    ]);
    // Caller globs ADD to the built-in policy, exactly like capture.
    const custom = await extractSymbolTable(root, {
      exclusion_globs: ['*generated*'],
      files: ['vendor/generated.ts'],
    });
    expect(custom.skipped).toEqual([{ path: 'vendor/generated.ts', reason: 'excluded' }]);
  });

  test('unavailable sources are reported honestly, never as empty symbol tables', async () => {
    const root = await fixture();
    await writeFile(join(root, 'binary.ts'), Buffer.from('export function f(): void {}\n\0not text at all\0'));
    await writeFile(join(root, 'huge.ts'), 'export function big(): void {}\n'.repeat(200));
    await writeFile(join(root, 'fine.ts'), 'export function fine(): void {}\n');
    await writeFile(join(root, 'linked.ts'), 'export function linked(): void {}\n');
    await rename(join(root, 'linked.ts'), join(root, 'moved.ts'));
    await symlink(join(root, 'moved.ts'), join(root, 'linked.ts'));
    const table = await extractSymbolTable(root, { max_file_bytes: 200 });
    expect(table.files.map((file) => file.path)).toEqual(['fine.ts', 'moved.ts']);
    expect(table.skipped).toEqual([
      { path: 'binary.ts', reason: 'binary' },
      { path: 'huge.ts', reason: 'too_large' },
      { path: 'linked.ts', reason: 'symlink' },
    ]);
    expect(table.warnings.some((warning) => warning.includes('unavailable'))).toBe(true);
    // Explicit requests carry the same honesty: unknown extensions and missing paths say so.
    const targeted = await extractSymbolTable(root, { files: ['README.md', 'gone.ts', 'fine.ts'] });
    expect(targeted.skipped).toEqual([
      { path: 'README.md', reason: 'unsupported_language' },
      { path: 'gone.ts', reason: 'missing' },
    ]);
    expect(targeted.files.map((file) => file.path)).toEqual(['fine.ts']);
  });

  test('root validation and broken-Git failures match fingerprint capture (shared scan)', async () => {
    await expect(extractSymbolTable('/nonexistent-root-for-symbols')).rejects.toThrow(
      /repository root must be an accessible directory/,
    );
    const notDirectory = join(tmpdir(), `onemem not a dir ${uuidv7()}`);
    await writeFile(notDirectory, 'export function x(): void {}\n');
    roots.push(notDirectory);
    await expect(extractSymbolTable(notDirectory)).rejects.toThrow(
      /repository root must be an accessible directory/,
    );

    const root = await fixture();
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'a.ts'), 'export const a = 1;\n');
    await expect(extractSymbolTable(join(root, 'nested'))).rejects.toThrow(/use the Git worktree root/);

    const broken = await fixture(false);
    await writeFile(join(broken, '.git'), 'not a valid Git directory marker');
    await expect(extractSymbolTable(broken)).rejects.toThrow(/Git could not inspect/);
  });

  test('conflicted paths are unavailable to symbol extraction', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a.ts'), 'export function base(): void {}\n');
    await commit(root);
    const main = await command(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    await command(root, 'checkout', '-qb', 'onemem-fixture-side');
    await writeFile(join(root, 'a.ts'), 'export function side(): void {}\n');
    await commit(root);
    await command(root, 'checkout', '-q', main);
    await writeFile(join(root, 'a.ts'), 'export function main(): void {}\n');
    await commit(root);
    await expect(command(root, 'merge', '--no-edit', 'onemem-fixture-side')).rejects.toThrow();
    const table = await extractSymbolTable(root);
    expect(table.files).toEqual([]);
    expect(table.skipped).toEqual([{ path: 'a.ts', reason: 'conflict' }]);
  });

  test('only-changed re-extraction persists end to end over real embedded storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-symbols-e2e-'));
    roots.push(dataDir);
    const storage = await createEmbeddedDb(dataDir);
    const guard = installNetworkGuard();
    try {
      const root = await fixture();
      await writeFile(
        join(root, 'a.ts'),
        'export function alpha(n: number): number {\n  return n + 1;\n}\n',
      );
      await writeFile(
        join(root, 'b.ts'),
        '// leading comment\nexport function beta(n: number): number {\n  return n * 2;\n}\n',
      );
      await writeFile(join(root, 'c.py'), 'def helper():\n    return 1\n');
      await commit(root);

      // The pipeline shape: capture → saveSnapshot → extract → saveSymbolTable.
      const project = await storage.store.createProject({
        name: `symbols-e2e-${uuidv7().slice(0, 8)}`,
        root_path: root,
      });
      const baseline = await captureSnapshot(root);
      const repository = await storage.codeMemory.ensureRepository({
        project_id: project.id,
        root_path: baseline.root_path,
      });
      await storage.codeMemory.saveSnapshot(repository.id, baseline);
      const firstTable = await extractSymbolTable(root);
      const firstSave = await storage.codeMemory.saveSymbolTable(repository.id, {
        files: firstTable.files,
      });
      expect(firstSave.rewritten).toBe(3);
      expect(firstSave.unchanged).toBe(0);
      expect(firstSave.repository.last_ingested_commit).toBeNull();
      const storedFirst = await storage.codeMemory.loadSymbols(repository.id);
      expect(storedFirst.map((symbol) => `${symbol.path}:${symbol.name}`)).toEqual([
        'a.ts:alpha',
        'b.ts:beta',
        'c.py:helper',
      ]);
      const betaRow = storedFirst.find((symbol) => symbol.path === 'b.ts')!;
      const fingerprintsFirst = await storage.codeMemory.loadFingerprints(repository.id, {
        tier: 'worktree',
      });
      expect(fingerprintsFirst.every((row) => row.symbols_hash !== null)).toBe(true);

      // A real edit in a.ts; a COSMETIC comment edit in b.ts (same line count); c.py deleted.
      await writeFile(
        join(root, 'a.ts'),
        'export function alpha(n: number): number {\n  return n + 42;\n}\n',
      );
      await writeFile(
        join(root, 'b.ts'),
        '// leading comment, now different\nexport function beta(n: number): number {\n  return n * 2;\n}\n',
      );
      await rm(join(root, 'c.py'));

      // Drift flags both edits at FILE level; only the flagged paths re-extract.
      const report = await detectChanges(baseline);
      const changedPaths = report.changes
        .filter(
          (change) => change.tier === 'worktree' && (change.kind === 'modified' || change.kind === 'added'),
        )
        .map((change) => change.path)
        .sort();
      expect(changedPaths).toEqual(['a.ts', 'b.ts']);
      const latestCapture = await captureSnapshot(root);
      await storage.codeMemory.saveSnapshot(repository.id, latestCapture); // c.py anchor dies here
      const reExtracted = await extractSymbolTable(root, { files: changedPaths });
      expect(reExtracted.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
      expect(reExtracted.skipped).toEqual([]);
      // The cosmetic-only file's symbol table is IDENTICAL: same spans, same table hash.
      expect(fileOf(reExtracted, 'b.ts').symbols_hash).toBe(fileOf(firstTable, 'b.ts').symbols_hash);
      expect(fileOf(reExtracted, 'a.ts').symbols_hash).not.toBe(fileOf(firstTable, 'a.ts').symbols_hash);

      const secondSave = await storage.codeMemory.saveSymbolTable(repository.id, {
        files: reExtracted.files,
      });
      expect(secondSave.rewritten).toBe(1); // a.ts only: b.ts matched the stored symbols_hash
      expect(secondSave.unchanged).toBe(1);
      expect(secondSave.repository.last_ingested_commit).toBeNull();

      // The guard left b.ts's rows untouched; a.ts's rows carry the new span hash, and c.py's
      // symbol rows died with its fingerprint anchor in the saveSnapshot above.
      const storedSecond = await storage.codeMemory.loadSymbols(repository.id);
      expect(storedSecond.map((symbol) => `${symbol.path}:${symbol.name}`)).toEqual([
        'a.ts:alpha',
        'b.ts:beta',
      ]);
      expect(storedSecond.find((symbol) => symbol.path === 'b.ts')?.updated_at).toBe(betaRow.updated_at);
      const storedAlpha = storedSecond.find((symbol) => symbol.path === 'a.ts')!;
      const reExtractedAlphaHash = fileOf(reExtracted, 'a.ts').symbols[0]?.span_hash ?? null;
      expect(storedAlpha.span_hash).toBe(reExtractedAlphaHash);
      const firstAlphaHash = storedFirst.find((symbol) => symbol.path === 'a.ts')?.span_hash ?? null;
      expect(storedAlpha.span_hash !== firstAlphaHash).toBe(true);

      // The per-file hashes landed on the worktree-tier fingerprint rows, moved only for a.ts.
      const fingerprintsSecond = await storage.codeMemory.loadFingerprints(repository.id, {
        tier: 'worktree',
      });
      const byPath = new Map(fingerprintsSecond.map((row) => [row.path, row]));
      expect(byPath.get('a.ts')?.symbols_hash).toBe(fileOf(reExtracted, 'a.ts').symbols_hash);
      expect(byPath.get('b.ts')?.symbols_hash).toBe(fileOf(firstTable, 'b.ts').symbols_hash);
      const firstBetaHash = fingerprintsFirst.find((row) => row.path === 'b.ts')?.symbols_hash ?? null;
      expect((byPath.get('b.ts')?.symbols_hash ?? null) === firstBetaHash).toBe(true);
      expect(byPath.get('c.py')).toBeUndefined(); // the fingerprint died in saveSnapshot
      guard.assertZeroCalls();
    } finally {
      guard.restore();
      await storage.close();
    }
  });

  test('saveSymbolTable boundaries reject pipeline errors and malformed input', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-symbols-boundary-'));
    roots.push(dataDir);
    const storage = await createEmbeddedDb(dataDir);
    try {
      const root = await fixture();
      await writeFile(join(root, 'a.ts'), 'export function alpha(): void {}\n');
      const project = await storage.store.createProject({
        name: `symbols-boundary-${uuidv7().slice(0, 8)}`,
        root_path: root,
      });
      const snapshot = await captureSnapshot(root);
      const repository = await storage.codeMemory.ensureRepository({
        project_id: project.id,
        root_path: snapshot.root_path,
      });
      await storage.codeMemory.saveSnapshot(repository.id, snapshot);
      const table = await extractSymbolTable(root);
      const [file] = table.files;

      await expect(storage.codeMemory.saveSymbolTable(uuidv7(), { files: [file!] })).rejects.toThrow(
        /not found/,
      );
      // A covered path without a live worktree fingerprint anchor is a pipeline error: the
      // symbol hash lives on the fingerprint row by schema design (saveSnapshot comes first).
      await expect(
        storage.codeMemory.saveSymbolTable(repository.id, {
          files: [
            {
              path: 'not-captured.ts',
              language: 'typescript',
              symbols: [],
              symbols_hash: 'a'.repeat(64),
              parse_errors: 0,
            },
          ],
        }),
      ).rejects.toThrow(/not found/);
      // The extraction is validated at the storage boundary too.
      await expect(
        storage.codeMemory.saveSymbolTable(repository.id, {
          files: [{ ...file!, symbols_hash: 'not-hex' }],
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        storage.codeMemory.saveSymbolTable(repository.id, {
          files: [{ ...file!, symbols: [{ ...file!.symbols[0]!, kind: 'widget' as never }] }],
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        storage.codeMemory.saveSymbolTable(repository.id, { files: [file!, file!] }),
      ).rejects.toThrow(ValidationError);
      await expect(
        storage.codeMemory.saveSymbolTable(repository.id, { files: [] }),
      ).rejects.toThrow(ValidationError);
    } finally {
      await storage.close();
    }
  });
});
