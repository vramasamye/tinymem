/**
 * Session context injection (retrieval.md §2; spec §22) — the `memory_project_context`
 * building block for M5 (MCP) and M13 (CLI/API). The compact context, NOT the database:
 *
 *   project digest  ~200 tokens   projects.digest (consolidation-built rollup) + name/description
 *   decisions       ~250 tokens   latest N accepted decisions, title + one-line rationale
 *   known failures  ~150 tokens   open + high-recurrence failures, problem → solution one-liners
 *   procedures      ~100 tokens   current procedural memories, importance-ordered
 *   preferences      ~50 tokens   current project preferences, importance-ordered
 *
 * `used ≤ budget` is enforced at the LINE level (whole lines are dropped, lowest priority
 * first — never a mid-sentence truncation), and unused share rolls forward to later sections.
 */

import { searchRepo } from '@onememory-ai/storage';
import type { Database } from '@onememory-ai/storage';
import type { Store } from '@onememory-ai/core';

import { mergeConfig } from './config';
import { estimateTokens, truncateAtWordBoundary } from './tokens';

/** What session-context assembly needs: the Store port + the SQL client (payload-table reads). */
export interface SessionContextDeps {
  store: Store;
  client: Database;
}

export interface SessionContextOptions {
  budget?: number;
  now?: () => Date;
}

export type SessionContextKind = 'digest' | 'decisions' | 'failures' | 'procedures' | 'preferences';

export interface SessionContextSection {
  kind: SessionContextKind;
  tokens: number;
  text: string;
}

export interface SessionContext {
  project_id: string;
  budget: number;
  used: number;
  /** The assembled, budget-bounded context block. */
  text: string;
  sections: SessionContextSection[];
  warnings: string[];
}

interface SectionSpec {
  kind: SessionContextKind;
  share: number;
}

/**
 * Build the compact project context. Deterministic given the database state and clock.
 * `deps` is satisfied structurally by `OnememoryStorage`.
 */
export async function buildSessionContext(
  deps: SessionContextDeps,
  projectId: string,
  options: SessionContextOptions = {},
): Promise<SessionContext> {
  const config = mergeConfig().sessionContext;
  const budget = options.budget ?? config.budget;
  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const warnings: string[] = [];

  const filter: searchRepo.CandidateFilter = {
    statuses: ['active', 'stale'],
    window: { kind: 'point', at: nowIso },
    projectId,
  };

  const specs: SectionSpec[] = [
    { kind: 'digest', share: config.digestTokens },
    { kind: 'decisions', share: config.decisionTokens },
    { kind: 'failures', share: config.failureTokens },
    { kind: 'procedures', share: config.procedureTokens },
    { kind: 'preferences', share: config.preferenceTokens },
  ];

  // Warn honestly when the digest rollup is missing (consolidation builds it, a later mission).
  try {
    const project = await deps.store.getProject(projectId);
    if (project === null) {
      warnings.push(`project ${projectId} not found`);
    } else if (Object.keys(project.digest).length === 0) {
      warnings.push('project digest not yet built (consolidation pending)');
    }
  } catch (error) {
    warnings.push(`project digest lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sections: SessionContextSection[] = [];
  let used = 0;
  let carried = 0;

  for (const spec of specs) {
    const allowance = Math.min(budget - used, spec.share + carried);
    const lines = await sectionLines(deps, spec.kind, projectId, config, filter);
    const packed: string[] = [];
    let sectionUsed = 0;
    for (const line of lines) {
      const tokens = estimateTokens(line);
      if (tokens <= 0) continue;
      if (sectionUsed + tokens > allowance) continue; // drop the line whole — no mid-sentence cuts
      packed.push(line);
      sectionUsed += tokens;
    }
    carried = Math.max(0, allowance - sectionUsed);
    if (packed.length > 0) {
      sections.push({ kind: spec.kind, tokens: sectionUsed, text: packed.join('\n') });
      used += sectionUsed;
    }
  }

  return {
    project_id: projectId,
    budget,
    used,
    text: sections.map((section) => section.text).join('\n\n'),
    sections,
    warnings,
  };
}

async function sectionLines(
  deps: SessionContextDeps,
  kind: SessionContextKind,
  projectId: string,
  config: ReturnType<typeof mergeConfig>['sessionContext'],
  filter: searchRepo.CandidateFilter,
): Promise<string[]> {
  switch (kind) {
    case 'digest': {
      const project = await deps.store.getProject(projectId);
      if (project === null) return [];
      const lines: string[] = [`project: ${project.name}`];
      if (project.description !== null && project.description !== '') {
        lines.push(`description: ${truncateAtWordBoundary(project.description, 200)}`);
      }
      const digest = project.digest;
      for (const [key, value] of Object.entries(digest)) {
        const label = key.replace(/_/g, ' ');
        if (typeof value === 'string' && value !== '') {
          lines.push(`${label}: ${truncateAtWordBoundary(value, 240)}`);
        } else if (Array.isArray(value) && value.length > 0) {
          lines.push(`${label}: ${value.map((entry) => String(entry)).join(', ')}`);
        }
      }
      return lines;
    }
    case 'decisions': {
      const decisions = await searchRepo.latestAcceptedDecisions(
        deps.client,
        { limit: config.decisions },
        filter,
      );
      return decisions.map((decision) => {
        const oneLine =
          decision.memory.content_summary ?? decision.memory.title ?? decision.memory.content;
        const rationale = decision.rationale !== null ? ` — ${decision.rationale}` : '';
        return `- ${oneLine}${truncateAtWordBoundary(rationale, 160)}`;
      });
    }
    case 'failures': {
      const failures = await searchRepo.knownFailures(
        deps.client,
        { limit: config.failures, openStatuses: ['open', 'mitigated'], minOccurrences: 2 },
        filter,
      );
      return failures.map((failure) => {
        const resolution = failure.solution !== null ? ` → ${failure.solution}` : ` (${failure.failure_status})`;
        return `- ${truncateAtWordBoundary(failure.problem, 120)}${truncateAtWordBoundary(resolution, 120)}`;
      });
    }
    case 'procedures': {
      const procedures = await searchRepo.listCurrentMemories(
        deps.client,
        { types: ['procedural'], limit: config.procedures, order: 'importance' },
        filter,
      );
      return procedures.map((procedure) =>
        `- ${procedure.title ?? procedure.content_summary ?? truncateAtWordBoundary(procedure.content, 120)}`,
      );
    }
    case 'preferences': {
      const preferences = await searchRepo.listCurrentMemories(
        deps.client,
        { types: ['preference'], limit: config.preferences, order: 'importance' },
        filter,
      );
      return preferences.map((preference) =>
        `- ${preference.title ?? preference.content_summary ?? truncateAtWordBoundary(preference.content, 120)}`,
      );
    }
  }
}
