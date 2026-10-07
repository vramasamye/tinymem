/**
 * Shared fixtures for the skills module's tests — the digest fixtures precedent
 * (`src/digest/fixtures.ts`): storage-shaped `FailureRecurrence` rows built over
 * `memoryFixture`, the standard qualified two-occurrence recurrence, and an in-memory
 * `SkillStore` fake the pass tests drive (the real SQL implementation is exercised by the
 * CLI end-to-end suite; these fixtures pin the PASS logic, fast and deterministic).
 */

import type {
  EvidenceSpan,
  FailureRecurrence,
  NewSkill,
  SkillRecord,
  SkillStatus,
  SkillStore,
  SkillUsageEvent,
} from '@onememory-ai/core';
import { InvalidSkillTransitionError, assertSkillTransition } from '@onememory-ai/core';

import { memoryFixture } from '../testing';

export const FIXTURE_PROJECT = '00000000-0000-7000-8002-000000000021';
export const OTHER_FIXTURE_PROJECT = '00000000-0000-7000-8002-000000000022';
export const SIG_OOM = 'sha256:oom-kill-on-deploy';
export const SIG_CONN = 'sha256:conn-exhausted';

let counter = 0;
export function fixtureUuid(): string {
  counter += 1;
  return `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

/** One storage-shaped failure recurrence wrapping a fixture memory — the pool read model. */
export function failureRecurrence(input: {
  id?: string;
  problem: string;
  signature: string;
  solution?: string | null;
  verification?: string | null;
  entity?: string;
  project?: string | null;
  at?: string;
  firstSeen?: string;
  context?: string;
  rootCause?: string | null;
}): FailureRecurrence {
  const at = input.at ?? '2026-03-02T09:00:00.000Z';
  const id = input.id ?? fixtureUuid();
  const memory = memoryFixture({
    id,
    type: 'failure',
    content: input.problem,
    project_id: input.project ?? FIXTURE_PROJECT,
    observed_at: at,
    entities: input.entity === undefined ? [] : [{ id: `${id}-e`, name: input.entity, kind: 'tool' }],
  });
  return {
    memory,
    problem: input.problem,
    context: input.context ?? 'Cloud Run 2 GiB default memory limit.',
    root_cause: input.rootCause ?? null,
    solution: input.solution ?? null,
    verification: input.verification ?? null,
    failure_status: input.solution === undefined ? 'open' : 'solved',
    signature_hash: input.signature,
    first_seen_at: input.firstSeen ?? at,
    last_seen_at: at,
    occurrence_count: 1,
  };
}

/** The canonical qualified recurrence: two solved + verified occurrences, equivalent solutions. */
export function qualifiedPair(): FailureRecurrence[] {
  return [
    failureRecurrence({
      id: '00000000-0000-7000-8000-0000000000a1',
      problem: 'Cloud Run deploy failed with OOM during gcloud run deploy.',
      signature: SIG_OOM,
      solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
      verification: 'gcloud run deploy exited 0; the deploy completes under 4 GiB.',
      entity: 'cloud-run',
      at: '2026-03-01T09:00:00.000Z',
    }),
    failureRecurrence({
      id: '00000000-0000-7000-8000-0000000000a2',
      problem: 'Cloud Run deploy failed with OOM again during the release build.',
      signature: SIG_OOM,
      solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
      verification: 'the deploy passed with 4 GiB configured.',
      entity: 'cloud-run',
      at: '2026-03-05T09:00:00.000Z',
    }),
  ];
}

// ---------------------------------------------------------------------------
// The in-memory SkillStore fake
// ---------------------------------------------------------------------------

export interface FakeSkillCall {
  method: string;
  args: unknown[];
}

/** The mutation log the pass tests assert against (auditing is storage's real job). */
export class FakeSkillStore implements SkillStore {
  readonly rows: SkillRecord[] = [];
  readonly calls: FakeSkillCall[] = [];
  recurrences: FailureRecurrence[] = [];
  usageEvents: SkillUsageEvent[] = [];
  /** Set to make the next insertSkill throw — the error-isolation tests. */
  failNextInsert: Error | null = null;
  /** Set to make listFailureRecurrences throw — the scan-failure report test. */
  failScan: Error | null = null;
  private seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `00000000-0000-7000-9000-${String(this.seq).padStart(12, '0')}`;
  }

  private stamp(row: SkillRecord, at: string): SkillRecord {
    row.updated_at = at;
    return row;
  }

  async listFailureRecurrences(): Promise<FailureRecurrence[]> {
    if (this.failScan !== null) throw this.failScan;
    return this.recurrences;
  }

  async insertSkill(candidate: NewSkill, options: { actor: string; at?: string }): Promise<SkillRecord> {
    this.calls.push({ method: 'insertSkill', args: [candidate, options] });
    if (this.failNextInsert !== null) {
      const error = this.failNextInsert;
      this.failNextInsert = null;
      throw error;
    }
    const at = options.at ?? '2026-03-06T09:00:00.000Z';
    const row: SkillRecord = {
      id: this.nextId(),
      ...(candidate.project_id === undefined || candidate.project_id === null ? {} : { project_id: candidate.project_id }),
      name: candidate.name,
      description: candidate.description,
      version: candidate.version ?? '1.0.0',
      status: candidate.status ?? 'candidate',
      source: candidate.source,
      verification: candidate.verification,
      path: candidate.path,
      usage_count: candidate.usage_count ?? 0,
      ...(candidate.success_rate === undefined ? {} : { success_rate: candidate.success_rate }),
      created_at: at,
      updated_at: at,
    };
    this.rows.push(row);
    return row;
  }

  async getSkill(id: string): Promise<SkillRecord | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  async findSkillByName(name: string, scope: { project_id?: string | null }): Promise<SkillRecord | null> {
    return (
      this.rows.find(
        (row) => row.name === name && (row.project_id ?? null) === (scope.project_id ?? null),
      ) ?? null
    );
  }

  async listSkills(options: { statuses?: readonly SkillStatus[] }): Promise<SkillRecord[]> {
    const filtered =
      options.statuses === undefined
        ? [...this.rows]
        : this.rows.filter((row) => options.statuses!.includes(row.status));
    return filtered.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  async updateSkillStatus(
    id: string,
    to: SkillStatus,
    options: { actor: string; note?: string; details?: Record<string, unknown>; at?: string },
  ): Promise<SkillRecord> {
    this.calls.push({ method: 'updateSkillStatus', args: [id, to, options] });
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`skill ${id} not found`);
    assertSkillTransition(row.status, to);
    const from = row.status;
    row.status = to;
    return this.stamp(row, options.at ?? '2026-03-06T09:00:00.000Z');
  }

  async refreshSkillEvidence(
    id: string,
    next: { failure_ids: readonly string[]; description: string; verification: { evidence: EvidenceSpan[]; verified_at: string } },
    options: { actor: string; added_failure_ids: readonly string[]; at?: string },
  ): Promise<SkillRecord> {
    this.calls.push({ method: 'refreshSkillEvidence', args: [id, next, options] });
    const row = this.rows.find((entry) => entry.id === id);
    if (row === undefined) throw new Error(`skill ${id} not found`);
    if (row.status !== 'candidate') {
      throw new InvalidSkillTransitionError(row.status, row.status);
    }
    row.source = { ...row.source, failure_ids: [...next.failure_ids] };
    row.description = next.description;
    row.verification = next.verification;
    return this.stamp(row, options.at ?? '2026-03-06T09:00:00.000Z');
  }

  async listSessionEventsForUsage(): Promise<SkillUsageEvent[]> {
    return this.usageEvents;
  }
}
