/**
 * Drift detection over PERSISTED fingerprints — ADR-0008's zero-token freshness oracle: a ref
 * drifted when the current persisted worktree-tier blob differs from the blob the memory was
 * extracted against. Pure read over the `CodeMemoryStore` port (this package contains no SQL);
 * the pipeline persists the latest capture with `saveSnapshot` BEFORE calling `detectDrift`.
 *
 * Suspicion rule (never silently fresh): a ref whose path has no current worktree-tier
 * fingerprint, or whose fingerprint the latest capture could not read (retained-unavailable,
 * exposed honestly as the snapshot metadata's `skipped` set), is reported as suspect even when
 * a retained last-known blob happens to match the ref.
 *
 * Rename mapping: when a ref's path disappeared but its EXACT blob is found at exactly one
 * other current path, that successor is reported alongside the stale path — the same
 * conservative one-to-one evidence `compareSnapshots` uses for exact moves. Ambiguous matches,
 * modified renames (the blob changed during the move), and unreadable captures never resolve:
 * the stale path alone is reported rather than a guess.
 */

import type {
  CodeMemoryStore,
  DriftedMemory,
  DriftedRef,
  DriftReason,
  DriftReport,
  DriftWatcher,
  MemoryCodeRef,
} from '@onememory-ai/core';

import { DetectDriftInputSchema } from './schema';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Group a per-repository ref list by memory (listCodeRefs orders by memory_id, path). */
function groupRefsByMemory(refs: readonly MemoryCodeRef[]): Map<string, MemoryCodeRef[]> {
  const byMemory = new Map<string, MemoryCodeRef[]>();
  for (const ref of refs) {
    const group = byMemory.get(ref.memory_id);
    if (group) group.push(ref);
    else byMemory.set(ref.memory_id, [ref]);
  }
  return byMemory;
}

/**
 * Attach successor paths to this memory's path_missing refs. Pairing mirrors `compareSnapshots`
 * exactly: a blob group pairs only when one drifted ref and one candidate path hold it
 * (ambiguous equal blobs are never guessed), and the memory's own other ref paths are excluded —
 * a surviving sibling ref is not a rename successor.
 */
function resolveSuccessors(
  missing: readonly MemoryCodeRef[],
  drifted: ReadonlyMap<string, DriftedRef>,
  candidatesByBlob: ReadonlyMap<string, readonly string[]>,
  ownPaths: ReadonlySet<string>,
): void {
  if (missing.length === 0) return;
  const needingByBlob = new Map<string, MemoryCodeRef[]>();
  for (const ref of missing) {
    const group = needingByBlob.get(ref.blob_sha);
    if (group) group.push(ref);
    else needingByBlob.set(ref.blob_sha, [ref]);
  }
  for (const [blob, needing] of needingByBlob) {
    if (needing.length !== 1) continue; // two vanished refs with identical bytes: never guess
    const candidates = (candidatesByBlob.get(blob) ?? []).filter((path) => !ownPaths.has(path));
    if (candidates.length !== 1) continue; // zero or ambiguous destinations: never guess
    const entry = drifted.get(needing[0]!.path);
    if (entry) entry.successor_path = candidates[0];
  }
}

/** Build the core `DriftWatcher` port over a `CodeMemoryStore` (constructor-injected, no SQL). */
export function createDriftWatcher(store: CodeMemoryStore): DriftWatcher {
  return {
    detectDrift: async (rawInput) => {
      const input = DetectDriftInputSchema.parse(rawInput);
      const driftedByMemory = new Map<string, DriftedRef[]>();

      for (const repository of await store.listRepositories(input.project_id)) {
        const refs = await store.listCodeRefs(repository.id);
        if (refs.length === 0) continue; // nothing rests on this repository

        const metadata = await store.loadSnapshotMetadata(repository.id);
        // Paths the LATEST capture could not read: their fingerprints (if any) are retained
        // last-known values that can never certify freshness. Pre-skipped metadata rows simply
        // carry no such knowledge until the repository's next saveSnapshot.
        const unavailable = new Set(
          (metadata?.skipped ?? [])
            .filter((entry) => entry.tier === 'worktree')
            .map((entry) => entry.path),
        );

        const fingerprints = await store.loadFingerprints(repository.id, { tier: 'worktree' });
        const currentByPath = new Map(fingerprints.map((row) => [row.path, row.blob_sha]));
        // Rename candidates group by exact blob; retained-unavailable rows are excluded — a
        // last-known value cannot prove where content moved.
        const candidatesByBlob = new Map<string, string[]>();
        for (const fingerprint of fingerprints) {
          if (unavailable.has(fingerprint.path)) continue;
          const group = candidatesByBlob.get(fingerprint.blob_sha);
          if (group) group.push(fingerprint.path);
          else candidatesByBlob.set(fingerprint.blob_sha, [fingerprint.path]);
        }

        for (const [memoryId, memoryRefs] of groupRefsByMemory(refs)) {
          const ownPaths = new Set(memoryRefs.map((ref) => ref.path));
          const driftedRefs = new Map<string, DriftedRef>();
          const missing: MemoryCodeRef[] = [];
          for (const ref of memoryRefs) {
            const current = currentByPath.get(ref.path);
            let reason: DriftReason | null = null;
            if (unavailable.has(ref.path)) reason = 'capture_unavailable';
            else if (current === undefined) reason = 'path_missing';
            else if (current !== ref.blob_sha) reason = 'content_changed';
            if (reason === null) continue; // fresh: the current worktree blob matches the ref
            driftedRefs.set(ref.path, { repository_id: repository.id, path: ref.path, reason });
            // Only a path that is definitively ABSENT from the capture may resolve a successor;
            // an unreadable path may simply be unreadable, and must not claim a move.
            if (reason === 'path_missing') missing.push(ref);
          }
          resolveSuccessors(missing, driftedRefs, candidatesByBlob, ownPaths);
          if (driftedRefs.size > 0) {
            const accumulated = driftedByMemory.get(memoryId) ?? [];
            accumulated.push(...driftedRefs.values());
            driftedByMemory.set(memoryId, accumulated);
          }
        }
      }

      const drifted: DriftedMemory[] = [...driftedByMemory.entries()]
        .map(([memoryId, refs]) => ({
          memory_id: memoryId,
          changed_paths: [
            ...new Set(refs.flatMap((ref) => (ref.successor_path === undefined ? [ref.path] : [ref.path, ref.successor_path]))),
          ].sort(compareText),
          refs: [...refs].sort(
            (a, b) =>
              compareText(a.repository_id, b.repository_id) || compareText(a.path, b.path),
          ),
        }))
        .sort((a, b) => compareText(a.memory_id, b.memory_id));
      return { drifted };
    },
  };
}
