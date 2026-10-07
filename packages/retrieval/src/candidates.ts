/**
 * The unified retrieval candidate — one shape for durable memories and session working memory,
 * so the temporal filter, dedupe, fusion, and packer stages are pure functions over this type
 * (golden-testable without a database).
 *
 * Channel ranks are 1-based raw positions within each candidate channel (retrieval.md stage 2);
 * RRF turns them into fused scores in fusion.ts. `graphBoost` is the 0..1 graph signal
 * (entity-bound = 1.0, decayed by hops); `graphSource` is the explain provenance of the best boost.
 */

import { memoryContentHash } from '@onememory-ai/core';
import type {
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  WorkingMemoryRecord,
} from '@onememory-ai/core';

export interface ChannelRanks {
  /** Rank in the vector KNN channel, best first. */
  vector?: number;
  /** Rank in the lexical FTS channel, best first. */
  lexical?: number;
  /** Rank in the merged graph channel (entity-bound → expansion → shortcuts). */
  graph?: number;
}

export interface RetrievalCandidate {
  id: string;
  kind: 'durable' | 'working';
  type: MemoryType;
  title?: string;
  content: string;
  contentSummary?: string;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  accessCount: number;
  observedAt: string;
  validFrom: string;
  /** NULL/absent = open-ended validity. */
  validUntil?: string;
  projectId?: string;
  /** Exact-dedupe key (normalized content hash; derived for working entries). */
  contentHash: string;
  sourceKind: string;
  sourceUri?: string;
  verifiedAt?: string;
  entityIds: string[];
  entityNames: string[];
  channels: ChannelRanks;
  graphBoost: number;
  graphSource?: string;
  /** Working-memory entries only. */
  workingKind?: string;
  sessionId?: string;
}

/** Convert a wire MemoryRecord (durable channel result) into the unified candidate shape. */
export function candidateFromMemory(
  record: MemoryRecord,
  seed: { channels?: ChannelRanks; graphBoost?: number; graphSource?: string } = {},
): RetrievalCandidate {
  const candidate: RetrievalCandidate = {
    id: record.id,
    kind: 'durable',
    type: record.type,
    content: record.content,
    status: record.status,
    importance: record.importance,
    confidence: record.confidence,
    accessCount: record.access_count,
    observedAt: record.observed_at,
    validFrom: record.valid_from,
    validUntil: record.valid_until,
    contentHash: memoryContentHash(record.content),
    sourceKind: record.provenance.source.kind,
    entityIds: record.entities.map((entity) => entity.id),
    entityNames: record.entities.map((entity) => entity.name),
    channels: seed.channels ?? {},
    graphBoost: seed.graphBoost ?? 0,
  };
  if (record.title !== undefined) candidate.title = record.title;
  if (record.content_summary !== undefined) candidate.contentSummary = record.content_summary;
  if (record.project_id !== undefined) candidate.projectId = record.project_id;
  const uri = record.provenance.source.uri;
  if (uri !== undefined) candidate.sourceUri = uri;
  const verifiedAt = record.provenance.verified_at;
  if (verifiedAt !== undefined) candidate.verifiedAt = verifiedAt;
  if (seed.graphSource !== undefined) candidate.graphSource = seed.graphSource;
  return candidate;
}

/**
 * Convert a working-memory row into a candidate. Working memory is session-scoped scratchpad
 * (memory-model.md §10): its validity window is [created_at, expires_at), its status is modeled
 * `active` while unexpired, and it carries no source (provenance.source_kind = 'working' —
 * honest, not faked).
 */
export function candidateFromWorking(entry: WorkingMemoryRecord): RetrievalCandidate {
  const candidate: RetrievalCandidate = {
    id: entry.id,
    kind: 'working',
    type: 'working',
    content: entry.content,
    contentSummary: entry.content.length > 160 ? undefined : entry.content,
    status: 'active',
    importance: entry.importance,
    confidence: entry.confidence,
    accessCount: 0,
    observedAt: entry.created_at,
    validFrom: entry.created_at,
    validUntil: entry.expires_at,
    contentHash: memoryContentHash(entry.content),
    sourceKind: 'working',
    entityIds: [],
    entityNames: [],
    channels: {},
    graphBoost: 0,
    workingKind: entry.kind,
    sessionId: entry.session_id,
  };
  return candidate;
}

/**
 * Merge channel results by memory id: a candidate seen by several channels keeps the BEST (lowest)
 * rank per channel, the MAX graph boost (with its explain source), and all observed channels.
 */
export function mergeCandidates(lists: readonly RetrievalCandidate[][]): Map<string, RetrievalCandidate> {
  const merged = new Map<string, RetrievalCandidate>();
  for (const list of lists) {
    for (const candidate of list) {
      const existing = merged.get(candidate.id);
      if (!existing) {
        merged.set(candidate.id, { ...candidate, channels: { ...candidate.channels } });
        continue;
      }
      for (const [channel, rank] of Object.entries(candidate.channels)) {
        const key = channel as keyof ChannelRanks;
        const currentRank = existing.channels[key];
        if (currentRank === undefined || rank < currentRank) existing.channels[key] = rank;
      }
      if (candidate.graphBoost > existing.graphBoost) {
        existing.graphBoost = candidate.graphBoost;
        existing.graphSource = candidate.graphSource;
      }
    }
  }
  return merged;
}
