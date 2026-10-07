/**
 * Code-ref wire shaping (M4g2 — closing M4g's finding F5): the pure half of code-ref
 * hydration. Storage's `listCodeRefsForMemories` returns the hydrated rows; this module turns
 * ONE memory's rows into the `codeRefs` entries of its search-response item — deterministic,
 * capped, and honest:
 *
 * - **Symbol attribution** — the symbol within the cited file that the memory's own content
 *   names, matched on word boundaries (a substring inside another identifier never matches:
 *   content naming `verifyCredentials` must not claim the `Credentials` interface), first in
 *   document order (the storage aggregation orders by line_start, then name). Case-sensitive —
 *   code identifiers are; a prose "Session" is not the `session` symbol. No name in the content
 *   → no symbol, never a guess.
 * - **Refs budget** — `maxPerMemory` real entries (rows arrive ordered repository, then path);
 *   a memory with more refs than the cap gets exactly ONE placeholder entry appended —
 *   `<N more refs>` in `path`, the first omitted ref's repoId, the honest empty commitSha —
 *   instead of a silent mid-list truncation. Consumers must treat a path matching
 *   /^<\d+ more refs>$/ as the summary marker, not a file.
 */

import type { CodeRefEntry } from '@onememory-ai/core';

import type { HydratedCodeRef } from '@onememory-ai/storage';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The first symbol name (document order) that appears in `content` as a whole word; undefined
 * when the content names none. Word boundaries use identifier semantics (letters, digits,
 * underscore), so `Credentials` does not match inside `verifyCredentials`.
 */
export function matchingSymbol(content: string, symbolNames: readonly string[]): string | undefined {
  for (const name of symbolNames) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`,
      'u',
    );
    if (pattern.test(content)) return name;
  }
  return undefined;
}

/** The `<N more refs>` summary marker — the deterministic over-budget placeholder's path. */
export function moreRefsPlaceholder(omitted: number): string {
  return `<${omitted} more refs>`;
}

/**
 * Shape one memory's hydrated rows into its wire `codeRefs` entries. `rows` must be this
 * memory's rows only, in the storage order (repository_id, then path); `maxPerMemory` is the
 * refs budget (`config.codeRefs.maxPerMemory`, clamped to ≥ 1).
 */
export function toCodeRefEntries(
  rows: readonly HydratedCodeRef[],
  content: string,
  maxPerMemory: number,
): CodeRefEntry[] {
  const cap = Math.max(1, maxPerMemory);
  const entries: CodeRefEntry[] = rows.map((row) => {
    const symbol = matchingSymbol(content, row.symbols);
    return {
      repoId: row.repository_id,
      commitSha: row.commit_sha,
      path: row.path,
      ...(symbol === undefined ? {} : { symbol }),
      evidence: row.blob_sha,
    };
  });
  if (entries.length <= cap) return entries;
  const omitted = entries.length - cap;
  const firstOmitted = entries[cap]!;
  return [
    ...entries.slice(0, cap),
    {
      repoId: firstOmitted.repoId,
      commitSha: '',
      path: moreRefsPlaceholder(omitted),
    },
  ];
}
