/**
 * The skill review route (`/skills/:skillId/review`): the SKILL.md exactly as
 * promotion would write it, the audit trail, and the approve / reject actions.
 */

import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { ApiError } from '../../../api/client';
import type { MemoryEventRecord } from '../../../api/schemas';
import { AsyncGate, EmptyState, StatusBadge, Warnings } from '../../../components/kit';
import { useAsync } from '../../../lib/async';
import { useProject } from '../../../state/project';
import {
  SKILL_RUNTIME_OPTIONS,
  approveSkill,
  loadSkillReview,
  rejectSkill,
  type SkillReviewViewModel,
} from './controller';

/** What the last action produced: the API's confirmation or its refusal, verbatim. */
export type ActionOutcome =
  | { kind: 'idle' }
  | { kind: 'pending'; action: 'approve' | 'reject' }
  | { kind: 'approved'; writtenPath: string; rootSource: string }
  | { kind: 'rejected' }
  | { kind: 'error'; code: string; message: string };

export interface ReviewFormState {
  runtime: string;
  note: string;
}

function AuditTrail({ audit }: { audit: readonly MemoryEventRecord[] }): ReactNode {
  if (audit.length === 0) return <EmptyState message="the API returned no audit events" />;
  return (
    <ol className="audit">
      {audit.map((event) => (
        <li key={event.id}>
          {event.at} · <code>{event.action}</code>
          {event.from_status === null && event.to_status === null
            ? null
            : ` ${event.from_status ?? '∅'} → ${event.to_status ?? '∅'}`}{' '}
          · {event.actor}
          {typeof event.details['note'] === 'string' ? ` · “${event.details['note']}”` : null}
        </li>
      ))}
    </ol>
  );
}

function OutcomeNotice({ outcome }: { outcome: ActionOutcome }): ReactNode {
  switch (outcome.kind) {
    case 'idle':
      return null;
    case 'pending':
      return <p className="state state-loading">{outcome.action === 'approve' ? 'Approving…' : 'Rejecting…'}</p>;
    case 'approved':
      return (
        <p className="state state-ok" aria-live="polite">
          approved: wrote <code>{outcome.writtenPath}</code> (root chosen by {outcome.rootSource})
        </p>
      );
    case 'rejected':
      return (
        <p className="state state-ok" aria-live="polite">
          rejected: the skill is deprecated (any written SKILL.md stays on disk)
        </p>
      );
    case 'error':
      return (
        <section className="state state-error" aria-live="polite">
          <h3>
            API error <code>{outcome.code}</code>
          </h3>
          <p>{outcome.message}</p>
        </section>
      );
  }
}

/** Pure presentation. */
export function SkillReviewView({
  vm,
  form,
  outcome,
  onFormChange,
  onApprove,
  onReject,
}: {
  vm: SkillReviewViewModel;
  form: ReviewFormState;
  outcome: ActionOutcome;
  onFormChange: (next: ReviewFormState) => void;
  onApprove: () => void;
  onReject: () => void;
}): ReactNode {
  const { skill } = vm;
  const busy = outcome.kind === 'pending';
  return (
    <section className="page page-skill-review">
      <p className="meta">
        <Link to="/skills">← skills</Link>
      </p>
      <h1>
        {skill.name} v{skill.version} <StatusBadge status={skill.status} />
      </h1>
      <p>{skill.description}</p>
      <p className="meta">
        {skill.evidence_count} evidence span{skill.evidence_count === 1 ? '' : 's'} · verified at{' '}
        {skill.verified_at} · usage {skill.usage_count}
        {skill.success_rate === null ? null : ` · success rate ${skill.success_rate}`} · path{' '}
        <code>{skill.path}</code>
      </p>
      {skill.source_failure_ids.length === 0 ? null : (
        <p className="meta">
          from failures:{' '}
          {skill.source_failure_ids.map((id, index) => (
            <span key={id}>
              {index === 0 ? null : ', '}
              <Link to={`/memories/${id}`}>{id}</Link>
            </span>
          ))}
        </p>
      )}
      <Warnings
        warnings={vm.unresolvedFailureIds.map((id) => `cited failure ${id} could no longer be read`)}
      />

      <h2>SKILL.md</h2>
      <pre className="skill-markdown">{vm.markdown}</pre>

      <h2>Review</h2>
      <form
        className="skill-review-actions"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label>
          write to{' '}
          <select
            value={form.runtime}
            disabled={busy || !vm.canApprove}
            onChange={(event) => onFormChange({ ...form, runtime: event.target.value })}
          >
            <option value="">configured default (skills.dir or project skills/)</option>
            {SKILL_RUNTIME_OPTIONS.map((runtime) => (
              <option key={runtime} value={runtime}>
                {runtime} skills root
              </option>
            ))}
          </select>
        </label>
        <label>
          note (required to reject)
          <textarea
            value={form.note}
            maxLength={500}
            disabled={busy || (!vm.canApprove && !vm.canReject)}
            onChange={(event) => onFormChange({ ...form, note: event.target.value })}
          />
        </label>
        <p>
          <button type="button" disabled={busy || !vm.canApprove} onClick={onApprove}>
            Approve
          </button>{' '}
          <button type="button" disabled={busy || !vm.canReject || form.note.trim() === ''} onClick={onReject}>
            Reject
          </button>
        </p>
        {vm.approveBlockedReason === null ? null : <p className="meta">{vm.approveBlockedReason}</p>}
      </form>
      <OutcomeNotice outcome={outcome} />

      <h2>Audit trail</h2>
      <AuditTrail audit={vm.audit} />
    </section>
  );
}

function toOutcomeError(error: unknown): ActionOutcome {
  return error instanceof ApiError
    ? { kind: 'error', code: error.code, message: error.message }
    : { kind: 'error', code: 'internal', message: `UI controller failed: ${String(error)}` };
}

/** The route element. */
export function SkillReviewPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const { skillId = '' } = useParams();
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<ReviewFormState>({ runtime: '', note: '' });
  const [outcome, setOutcome] = useState<ActionOutcome>({ kind: 'idle' });
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadSkillReview(api, activeProject.id, skillId),
    [api, activeProject?.id, skillId, revision],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Skill review</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }
  const projectId = activeProject.id;

  const onApprove = (): void => {
    setOutcome({ kind: 'pending', action: 'approve' });
    approveSkill(api, projectId, skillId, form).then(
      (result) => {
        setOutcome({ kind: 'approved', writtenPath: result.written_path, rootSource: result.skills_root_source });
        setRevision((value) => value + 1);
      },
      (error: unknown) => setOutcome(toOutcomeError(error)),
    );
  };
  const onReject = (): void => {
    setOutcome({ kind: 'pending', action: 'reject' });
    rejectSkill(api, projectId, skillId, form.note).then(
      () => {
        setOutcome({ kind: 'rejected' });
        setRevision((value) => value + 1);
      },
      (error: unknown) => setOutcome(toOutcomeError(error)),
    );
  };

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <SkillReviewView
          vm={vm}
          form={form}
          outcome={outcome}
          onFormChange={setForm}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}
    </AsyncGate>
  );
}
