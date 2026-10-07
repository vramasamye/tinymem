/**
 * The skill review surface (`/skills/:skillId/review`): the review bundle the API
 * returns (the SKILL.md bytes exactly as promotion would write them) and the two
 * audited actions. The action gates mirror the lifecycle the API enforces
 * (`candidate → verified` needs evidence; `deprecated` is terminal) so the page never
 * offers a button the API would refuse; the API still decides, and its refusal
 * message is what the page shows.
 */

import type { ApiClient } from '../../../api/client';
import type {
  AgentRuntimeIdUi,
  DeprecateSkillResponse,
  MemoryEventRecord,
  PromoteSkillResponse,
  SkillSummary,
} from '../../../api/schemas';

/** The runtimes whose canonical skills root promotion can target (mirror of core). */
export const SKILL_RUNTIME_OPTIONS = [
  'claude-code',
  'codex',
  'cursor',
  'pi',
  'opencode',
] as const satisfies readonly AgentRuntimeIdUi[];

export interface SkillReviewViewModel {
  readonly skill: SkillSummary;
  readonly markdown: string;
  readonly audit: readonly MemoryEventRecord[];
  readonly unresolvedFailureIds: readonly string[];
  readonly canApprove: boolean;
  /** Why approve is unavailable (shown beside the disabled button), or null. */
  readonly approveBlockedReason: string | null;
  readonly canReject: boolean;
}

export async function loadSkillReview(
  api: ApiClient,
  projectId: string,
  skillId: string,
): Promise<SkillReviewViewModel> {
  const bundle = await api.reviewSkill(projectId, skillId);
  const { skill } = bundle;
  const approveBlockedReason =
    skill.status !== 'candidate'
      ? `the skill is ${skill.status}; only a candidate can be approved`
      : skill.evidence_count === 0
        ? 'the skill carries no verification evidence; approval requires proof the fix worked'
        : null;
  return {
    skill,
    markdown: bundle.markdown,
    audit: bundle.audit,
    unresolvedFailureIds: bundle.unresolved_failure_ids,
    canApprove: approveBlockedReason === null,
    approveBlockedReason,
    canReject: skill.status !== 'deprecated',
  };
}

export interface ApproveInput {
  /** A runtime id, or `''` for the configured default root. */
  runtime?: string;
  note?: string;
}

export function approveSkill(
  api: ApiClient,
  projectId: string,
  skillId: string,
  input: ApproveInput = {},
): Promise<PromoteSkillResponse> {
  const runtime = input.runtime ?? '';
  const note = (input.note ?? '').trim();
  return api.promoteSkill(projectId, skillId, {
    ...(runtime === '' ? {} : { runtime }),
    ...(note === '' ? {} : { note }),
  });
}

/** The reason is sent as typed: the API owns the "a reason is required" rule. */
export function rejectSkill(
  api: ApiClient,
  projectId: string,
  skillId: string,
  note: string,
): Promise<DeprecateSkillResponse> {
  return api.deprecateSkill(projectId, skillId, note.trim());
}
