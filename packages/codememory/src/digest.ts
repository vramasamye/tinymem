/**
 * Architecture digest (ADR-0008 point 5, M4.6): a project-level rollup answering "what is this
 * project" — modules → responsibilities → entry points — assembled from data that already exists
 * (`code_symbols`, `file_fingerprints`), never from a model call. The default budget is 300 tokens
 * (phased-plan Phase 2 DoD: "the project digest answers 'what is this project' in < 300 tokens").
 *
 * Pure and deterministic: the same repositories/symbols always render the same text, so a digest
 * refresh can compare content hashes and skip the write when nothing moved. Line-level budget
 * enforcement mirrors the retrieval layer's discipline — whole module lines are dropped from the
 * lowest-signal end, never truncated mid-line.
 */

import { estimateTokens } from '@onememory/core';
import type { CodeMemoryStore, CodeRepositoryRecord, StoredSymbol } from '@onememory/core';

import { compareText } from './internal';

/** The provenance version recorded on a digest memory's extraction meta. */
export const DIGEST_PROMPT_VERSION = 'code-digest-v1';

/** Default answer budget: "< 300 tokens" from the Phase 2 definition of done. */
export const DEFAULT_DIGEST_BUDGET_TOKENS = 300;

/** Symbol kinds that read as a module's public surface ("entry points"), most entry-like first. */
const ENTRY_KIND_ORDER = ['function', 'class', 'struct', 'interface', 'trait', 'enum', 'type', 'module'] as const;
const ENTRY_KINDS: ReadonlySet<string> = new Set(ENTRY_KIND_ORDER);

function entryKindRank(kind: string): number {
  const index = (ENTRY_KIND_ORDER as readonly string[]).indexOf(kind);
  return index < 0 ? ENTRY_KIND_ORDER.length : index;
}

/** How many entry points one module line names (the rest is a count). */
const MAX_ENTRY_POINTS = 3;

export interface DigestRepositoryInput {
  repository_id: string;
  root_path: string;
  head_commit: string | null;
  /** Worktree-tier paths the repository currently holds. */
  paths: readonly string[];
  /** Persisted symbol rows for those paths (may be empty). */
  symbols: readonly StoredSymbol[];
}

export interface DigestModule {
  module: string;
  files: number;
  symbols: number;
  entry_points: string[];
}

export interface ArchitectureDigest {
  text: string;
  tokens: number;
  budget: number;
  truncated: boolean;
  file_count: number;
  symbol_count: number;
  modules: DigestModule[];
}

/** Compatibility name for the shared token estimator. */
export const estimateDigestTokens = estimateTokens;

/**
 * The module a path belongs to: its containing directory (POSIX), or `(root)` for top-level files.
 * Grouping by directory rather than by the first segment keeps monorepo layout legible
 * (`packages/codememory/src` is one module, not all of `packages`).
 */
export function moduleOfPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator <= 0 ? '(root)' : path.slice(0, separator);
}

function languageOfPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot === path.length - 1) return 'other';
  const extension = path.slice(dot + 1).toLowerCase();
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'ts';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'js';
    case 'py':
      return 'py';
    case 'go':
      return 'go';
    case 'rs':
      return 'rs';
    default:
      return extension;
  }
}

/**
 * The ONE assembly of digest inputs from persisted state — the re-index pass and the doctor's
 * digest probe share it, so the probe's expected text is byte-identical to the text the pass
 * persists (and the probe stays a pure read: no capture, no model, no filesystem).
 *
 * `repositories` may be passed when the caller already listed them (the re-index pass has);
 * otherwise it is listed here.
 */
export async function loadDigestInputs(
  codeMemory: Pick<CodeMemoryStore, 'listRepositories' | 'loadFingerprints' | 'loadSymbols'>,
  projectId: string,
  repositories?: readonly CodeRepositoryRecord[],
): Promise<DigestRepositoryInput[]> {
  const listed = repositories ?? (await codeMemory.listRepositories(projectId));
  const inputs: DigestRepositoryInput[] = [];
  for (const repository of listed) {
    const fingerprints = await codeMemory.loadFingerprints(repository.id, { tier: 'worktree' });
    const symbols = await codeMemory.loadSymbols(repository.id);
    inputs.push({
      repository_id: repository.id,
      root_path: repository.root_path,
      head_commit: repository.head_commit,
      paths: fingerprints.map((fingerprint) => fingerprint.path),
      symbols,
    });
  }
  return inputs;
}

/** Structural shape of a memory row the digest locator predicate reads (no store import). */
export interface DigestLikeMemory {
  subtype?: string | null;
  tags: readonly string[];
  status: string;
  valid_until?: string | null;
}

/**
 * The deterministic digest locator predicate: this row IS the current architecture digest (the
 * stable `project_digest` subtype + `architecture_digest` tag, still current — `queryCurrent`
 * semantics: status active/stale and no `valid_until`).
 *
 * The Store port offers no tag/subtype-filtered query, so everything that must find the digest
 * locates it by predicate over rows the port CAN return: the exact-dedupe probe
 * (`findDuplicate`) for the unchanged case (windowless, any age), and a windowed scan only to
 * find a *changed* digest's predecessor for supersession.
 */
export function isCurrentArchitectureDigest(memory: DigestLikeMemory | null): boolean {
  return (
    memory !== null &&
    memory.subtype === 'project_digest' &&
    memory.tags.includes('architecture_digest') &&
    (memory.status === 'active' || memory.status === 'stale') &&
    (memory.valid_until === null || memory.valid_until === undefined)
  );
}

/** Group the input into modules, ordered by substance (symbols desc, then path asc). */
function assembleModules(repositories: readonly DigestRepositoryInput[]): DigestModule[] {
  const byModule = new Map<string, { files: Set<string>; symbols: StoredSymbol[] }>();
  for (const repository of repositories) {
    for (const path of repository.paths) {
      const module = moduleOfPath(path);
      const group = byModule.get(module) ?? { files: new Set<string>(), symbols: [] };
      group.files.add(path);
      byModule.set(module, group);
    }
  }
  for (const repository of repositories) {
    for (const symbol of repository.symbols) {
      const module = moduleOfPath(symbol.path);
      const group = byModule.get(module) ?? { files: new Set<string>(), symbols: [] };
      group.files.add(symbol.path);
      group.symbols.push(symbol);
      byModule.set(module, group);
    }
  }

  const modules: DigestModule[] = [];
  for (const [module, group] of byModule) {
    const entryPoints = group.symbols
      .filter((symbol) => ENTRY_KINDS.has(symbol.kind))
      .sort(
        (a, b) => entryKindRank(a.kind) - entryKindRank(b.kind) || compareText(a.name, b.name),
      )
      .map((symbol) => symbol.name);
    modules.push({
      module,
      files: group.files.size,
      symbols: group.symbols.length,
      entry_points: [...new Set(entryPoints)].slice(0, MAX_ENTRY_POINTS),
    });
  }
  modules.sort(
    (a, b) => b.symbols - a.symbols || b.files - a.files || compareText(a.module, b.module),
  );
  return modules;
}

/** The declaration mix of one module, most frequent first — its "responsibility" in one phrase. */
function responsibilities(kinds: ReadonlyMap<string, number>): string {
  const parts = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, 4)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length === 0 ? 'no symbols' : parts.join(', ');
}

/**
 * Build the digest. `budgetTokens` bounds the rendered text: header lines are always kept (they
 * carry the project identity and totals), module lines are dropped from the least-substantial end
 * until the estimate fits. `truncated` reports whether anything was dropped — honesty over a
 * silently partial answer.
 */
export function buildArchitectureDigest(input: {
  repositories: readonly DigestRepositoryInput[];
  projectName?: string;
  budgetTokens?: number;
}): ArchitectureDigest {
  const budget = Math.max(1, Math.floor(input.budgetTokens ?? DEFAULT_DIGEST_BUDGET_TOKENS));
  const modules = assembleModules(input.repositories);
  const fileCount = new Set(input.repositories.flatMap((repository) => repository.paths)).size;
  const symbolCount = input.repositories.reduce(
    (total, repository) => total + repository.symbols.length,
    0,
  );

  const languages = new Map<string, number>();
  for (const repository of input.repositories) {
    for (const path of repository.paths) {
      const language = languageOfPath(path);
      languages.set(language, (languages.get(language) ?? 0) + 1);
    }
  }
  const languageLine = [...languages.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, 5)
    .map(([language, count]) => `${language} ${count}`)
    .join(', ');

  const header: string[] = [];
  if (input.projectName !== undefined && input.projectName !== '') {
    header.push(`project: ${input.projectName}`);
  }
  header.push(
    `code: ${input.repositories.length} repo(s), ${modules.length} module(s), ${fileCount} file(s), ${symbolCount} symbol(s)`,
  );
  if (languageLine !== '') header.push(`languages: ${languageLine}`);

  const kindsByModule = new Map<string, Map<string, number>>();
  for (const repository of input.repositories) {
    for (const symbol of repository.symbols) {
      const module = moduleOfPath(symbol.path);
      const kinds = kindsByModule.get(module) ?? new Map<string, number>();
      kinds.set(symbol.kind, (kinds.get(symbol.kind) ?? 0) + 1);
      kindsByModule.set(module, kinds);
    }
  }

  const moduleLines = modules.map((module) => {
    const entry = module.entry_points.length > 0 ? `; entry: ${module.entry_points.join(', ')}` : '';
    return `- ${module.module}: ${module.files} file(s), ${responsibilities(kindsByModule.get(module.module) ?? new Map())}${entry}`;
  });

  const kept: string[] = [];
  let truncated = false;
  for (let index = 0; index < moduleLines.length; index += 1) {
    const candidate = [...header, ...kept, moduleLines[index]!];
    // Strictly-less-than budget (the Phase 2 DoD says "< 300 tokens"): a line that would land
    // the estimate exactly ON the budget is dropped, so a rendered digest always fits below it
    // (the header alone may exceed a tiny budget — `truncated` reports that honestly).
    if (estimateDigestTokens(candidate.join('\n')) >= budget) {
      truncated = true;
      break;
    }
    kept.push(moduleLines[index]!);
  }
  if (!truncated && kept.length < moduleLines.length) truncated = true;

  const text = [...header, ...kept].join('\n');
  return {
    text,
    tokens: estimateDigestTokens(text),
    budget,
    truncated,
    file_count: fileCount,
    symbol_count: symbolCount,
    modules,
  };
}
