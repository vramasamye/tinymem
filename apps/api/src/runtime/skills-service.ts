/**
 * The skills service layer: the review queue, the review bundle, and the two audited actions
 * (promote, deprecate) — the semantics the CLI and the REST API share (M15 follow-up 4: the web
 * review surface needs the same operations the CLI already has, so it is not CLI-only).
 *
 * Same rules as every write path (ADR-0007/ADR-0009):
 * - **the artifact is written BEFORE the status flips** — an orphan file is harmless, a serving
 *   row without its artifact is not;
 * - **every flip is audited** through the `memory_events` path (`updateSkillStatus`), carrying the
 *   written path and how the skills root was chosen;
 * - **promotion requires verification evidence** (ADR-0009 rule 2) — defense in depth behind the
 *   generation gate;
 * - **deprecation requires a reason** — `deprecated` is terminal and the reason is audited; the
 *   on-disk SKILL.md is never deleted.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canTransitionSkill, resolveSkillsTarget, type SkillRecord } from '@onememory-ai/core';
import { loadSkillForReview } from '@onememory-ai/consolidation';

import type { OnememoryRuntime } from './composition';
import { localUser, requireProject } from './memory-service';
import {
  BackendError,
  type DeprecateSkillInput,
  type DeprecateSkillResult,
  type PromoteSkillInput,
  type PromoteSkillResult,
  type SkillListResult,
  type SkillReviewResult,
  type SkillSummary,
} from './types';

/** Project the row down to the list/detail shape (no payload internals). */
export function summarizeSkill(record: SkillRecord): SkillSummary {
  return {
    id: record.id,
    project_id: record.project_id ?? null,
    name: record.name,
    description: record.description,
    version: record.version,
    status: record.status,
    path: record.path,
    usage_count: record.usage_count,
    success_rate: record.success_rate ?? null,
    evidence_count: record.verification.evidence.length,
    verified_at: record.verification.verified_at,
    source_failure_ids: [...record.source.failure_ids],
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** A skill belongs to the route's project only when the ids match (no cross-project reach). */
function skillInProject(skill: SkillRecord, projectId: string): boolean {
  return skill.project_id === projectId;
}

/** List a project's skills, newest-updated first. */
export async function listProjectSkills(
  runtime: OnememoryRuntime,
  projectId: string,
): Promise<SkillListResult> {
  await requireProject(runtime, projectId);
  const records = await runtime.storage.skills.listSkills({ scope: { project_id: projectId } });
  return { project_id: projectId, skills: records.map(summarizeSkill), warnings: [] };
}

/**
 * The review bundle for one skill: the row, the SKILL.md bytes exactly as promotion would write
 * them, the audit trail, and any cited failure that could no longer be re-read.
 */
export async function reviewSkill(
  runtime: OnememoryRuntime,
  projectId: string,
  skillId: string,
): Promise<SkillReviewResult> {
  await requireProject(runtime, projectId);
  const bundle = await loadSkillForReview({
    skills: runtime.storage.skills,
    store: runtime.storage.store,
    skillId,
  });
  if (bundle === null || !skillInProject(bundle.skill, projectId)) {
    throw new BackendError(
      `skill ${skillId} is not in project ${projectId} — list the project's skills to find its id`,
      'not_found',
    );
  }
  return {
    project_id: projectId,
    skill: summarizeSkill(bundle.skill),
    markdown: bundle.markdown,
    audit: bundle.audit,
    unresolved_failure_ids: bundle.unresolved_failure_ids,
  };
}

/**
 * Write the SKILL.md (file first) and flip `candidate → verified`, audited. Refuses a skill that
 * is not a candidate or that carries no verification evidence, and a `dir`/`runtime` pair.
 */
export async function promoteSkill(
  runtime: OnememoryRuntime,
  input: PromoteSkillInput,
): Promise<PromoteSkillResult> {
  if (input.dir !== undefined && input.runtime !== undefined) {
    throw new BackendError(
      'pass either dir or runtime, not both — dir is the explicit override',
      'invalid_request',
    );
  }
  const project = await requireProject(runtime, input.project_id);
  const bundle = await loadSkillForReview({
    skills: runtime.storage.skills,
    store: runtime.storage.store,
    skillId: input.skill_id,
  });
  if (bundle === null || !skillInProject(bundle.skill, input.project_id)) {
    throw new BackendError(`skill ${input.skill_id} is not in project ${input.project_id}`, 'not_found');
  }
  const { skill } = bundle;
  if (skill.status !== 'candidate') {
    throw new BackendError(
      `skill ${skill.id} is ${skill.status}, not candidate — promotion flips candidate → verified ` +
        '(verified → promoted is the usage-proven stage)',
      'invalid_request',
    );
  }
  if (skill.verification.evidence.length === 0) {
    throw new BackendError(
      `skill ${skill.id} carries no verification evidence — promotion requires proof the fix worked`,
      'invalid_request',
    );
  }

  const home = input.home ?? process.env['HOME'] ?? null;
  const resolved = resolveSkillsTarget({
    dirFlag: input.dir,
    runtime: input.runtime,
    configDir: runtime.config.skills.dir,
    projectRoot: project.root_path,
    home,
  });
  if (!resolved.ok) throw new BackendError(resolved.message, 'invalid_request');
  const target = resolved.target;

  // 1. The artifact FIRST.
  const targetDir = join(target.dir, skill.name);
  const targetPath = join(targetDir, 'SKILL.md');
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, bundle.markdown, 'utf-8');

  // 2. The audited flip.
  const user = await localUser(runtime);
  const promoted = await runtime.storage.skills.updateSkillStatus(skill.id, 'verified', {
    actor: `user:${user.id}`,
    ...(input.note === undefined ? {} : { note: input.note }),
    details: {
      written_path: targetPath,
      markdown_bytes: bundle.markdown.length,
      skills_root: target.dir,
      skills_root_source: target.source,
      surface: 'api',
    },
  });

  return {
    project_id: input.project_id,
    skill: summarizeSkill(promoted),
    written_path: targetPath,
    skills_root: target.dir,
    skills_root_source: target.source,
    markdown_bytes: bundle.markdown.length,
  };
}

/**
 * Reject a candidate or retire a served skill (`→ deprecated`), audited; any written artifact is
 * kept on disk.
 */
export async function deprecateSkill(
  runtime: OnememoryRuntime,
  input: DeprecateSkillInput,
): Promise<DeprecateSkillResult> {
  await requireProject(runtime, input.project_id);
  const note = input.note.trim();
  if (note === '') {
    throw new BackendError(
      'deprecation requires a note — deprecated is terminal and the reason is audited',
      'invalid_request',
    );
  }
  const skill = await runtime.storage.skills.getSkill(input.skill_id);
  if (skill === null || !skillInProject(skill, input.project_id)) {
    throw new BackendError(`skill ${input.skill_id} is not in project ${input.project_id}`, 'not_found');
  }
  if (!canTransitionSkill(skill.status, 'deprecated')) {
    throw new BackendError(`skill ${skill.id} is already ${skill.status} — deprecated is terminal`, 'conflict');
  }
  const user = await localUser(runtime);
  const deprecated = await runtime.storage.skills.updateSkillStatus(skill.id, 'deprecated', {
    actor: `user:${user.id}`,
    note,
    details: { surface: 'api' },
  });
  return { project_id: input.project_id, skill: summarizeSkill(deprecated) };
}
