/**
 * The memory drill-down route (`/memories/:memoryId`): every claim the engine makes
 * about one memory — source, evidence quotes, extraction, status, redactions,
 * typed payload, entities, edges, supersession — from the inspect endpoint.
 */

import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { AsyncGate, EmptyState, StatusBadge, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadMemoryDetail, type MemoryDetailViewModel } from './controller';

function PayloadDisplay({ vm }: { vm: MemoryDetailViewModel }): ReactNode {
  const display = vm.payloadDisplay;
  if (display === null) {
    return <EmptyState message="the API returned no typed payload for this memory" />;
  }
  if (display.kind === 'decision') {
    const payload = display.payload;
    return (
      <section className="payload payload-decision">
        <h3>Decision payload</h3>
        <p>
          <strong>{payload.title}</strong> — <span>{payload.decision}</span> ({payload.status})
        </p>
        {payload.rationale === undefined ? null : <p>rationale: {payload.rationale}</p>}
        <h4>Alternatives</h4>
        {payload.alternatives.length === 0 ? (
          <EmptyState message="the API returned no alternatives" />
        ) : (
          <ul>
            {payload.alternatives.map((alternative) => (
              <li key={alternative.option}>
                {alternative.option}
                {alternative.why_rejected === undefined ? null : ` — ${alternative.why_rejected}`}
              </li>
            ))}
          </ul>
        )}
        <p>participants: {payload.participants.join(', ')}</p>
        <p>decided at {payload.decided_at}</p>
      </section>
    );
  }
  if (display.kind === 'failure') {
    const payload = display.payload;
    return (
      <section className="payload payload-failure">
        <h3>Failure payload</h3>
        <p>
          <strong>{payload.problem}</strong> ({payload.status}) · {payload.occurrence_count}{' '}
          occurrence{payload.occurrence_count === 1 ? '' : 's'}
        </p>
        <p>context: {payload.context}</p>
        {payload.root_cause === undefined ? null : <p>root cause: {payload.root_cause}</p>}
        {payload.solution === undefined ? null : <p>solution: {payload.solution}</p>}
        {payload.verification === undefined ? null : <p>verification: {payload.verification}</p>}
        <p>
          first seen {payload.first_seen_at} · last seen {payload.last_seen_at}
        </p>
      </section>
    );
  }
  const payload = display.payload;
  return (
    <section className="payload payload-skill">
      <h3>Skill payload</h3>
      <p>
        <strong>{payload.name}</strong> v{payload.version} ({payload.status})
      </p>
      <p>{payload.description}</p>
      <p>
        path <code>{payload.path}</code> · usage {payload.usage_count}
        {payload.success_rate === undefined ? null : ` · success rate ${payload.success_rate}`}
      </p>
      <p>
        from {payload.source.failure_ids.length} failure
        {payload.source.failure_ids.length === 1 ? '' : 's'} · verified at{' '}
        {payload.verification.verified_at}
      </p>
    </section>
  );
}

/** Pure presentation. */
export function MemoryDetailView({
  vm,
  projectId,
}: {
  vm: MemoryDetailViewModel;
  projectId: string;
}): ReactNode {
  const memory = vm.memory;
  const label = memory.title ?? memory.content_summary ?? memory.content;
  return (
    <section className="page page-memory-detail">
      <h1>{label}</h1>
      <p className="meta">
        <span className="badge badge-type">{memory.type}</span>
        <StatusBadge status={memory.status} /> · confidence {memory.confidence} · importance{' '}
        {memory.importance} · {memory.access_count} access
        {memory.access_count === 1 ? '' : 'es'}
      </p>
      <p className="meta">
        valid from {memory.valid_from}
        {memory.valid_until === undefined ? null : ` until ${memory.valid_until}`} · observed{' '}
        {memory.observed_at} · created {memory.created_at} · updated {memory.updated_at}
      </p>
      <p className="row-links">
        <Link to={`/memories/${memory.id}/timeline`}>timeline</Link>
        {memory.superseded_by === undefined ? null : (
          <>
            {' · superseded by '}
            <Link to={`/memories/${memory.superseded_by}`}>{memory.superseded_by}</Link>
          </>
        )}
      </p>
      <Warnings warnings={vm.warnings} />

      <h2>Source</h2>
      <section className="source-card">
        <p>
          kind <code>{memory.provenance.source.kind}</code>
          {memory.provenance.source.uri === undefined ? null : (
            <>
              {' · uri '}
              <code>{memory.provenance.source.uri}</code>
            </>
          )}
        </p>
        {memory.provenance.source.title === undefined ? null : (
          <p>title: {memory.provenance.source.title}</p>
        )}
        <p>
          extraction <code>{memory.provenance.extraction.method}</code>
          {memory.provenance.extraction.model === undefined
            ? null
            : ` · model ${memory.provenance.extraction.model}`}{' '}
          · prompt {memory.provenance.extraction.prompt_version}
        </p>
        {memory.provenance.verified_at === undefined ? null : (
          <p>verified at {memory.provenance.verified_at}</p>
        )}
        <p>
          source id <code>{memory.provenance.source.id}</code>
        </p>
      </section>

      <h2>Evidence quotes</h2>
      {memory.provenance.evidence.length === 0 ? (
        <EmptyState message="the API returned no evidence spans for this memory" />
      ) : (
        <blockquote className="evidence">
          {memory.provenance.evidence.map((span) => (
            <p key={`${span.source_id}-${span.locator}`}>
              “{span.excerpt}” <cite>{span.locator} ({span.kind})</cite>
            </p>
          ))}
        </blockquote>
      )}

      <h2>Typed payload</h2>
      <PayloadDisplay vm={vm} />

      <h2>Redactions</h2>
      {vm.redactions.length === 0 ? (
        <EmptyState message="the API returned no redactions for this memory" />
      ) : (
        <ul>
          {vm.redactions.map((redaction) => (
            <li key={`${redaction.kind}-${redaction.location}`}>
              <code>{redaction.kind}</code> at {redaction.location} ({redaction.length} chars
              removed — the value is never stored)
            </li>
          ))}
        </ul>
      )}

      <h2>Entities</h2>
      {memory.entities.length === 0 ? (
        <EmptyState message="the API returned no entities for this memory" />
      ) : (
        <ul className="entity-list">
          {memory.entities.map((entity) => (
            <li key={entity.id}>
              {entity.name} ({entity.kind})
            </li>
          ))}
        </ul>
      )}

      <h2>Edges</h2>
      {vm.edges.length === 0 ? (
        <EmptyState message="the API returned no edges for this memory" />
      ) : (
        <ul className="edge-list">
          {vm.edges.map((edge) => (
            <li key={edge.id}>
              <code>{edge.relation}</code> →{' '}
              <Link to={`/memories/${edge.to_memory_id}`}>{edge.to_memory_id}</Link> (confidence{' '}
              {edge.confidence})
            </li>
          ))}
        </ul>
      )}

      <h2>Audit trail</h2>
      <p>
        {vm.audit.length} event{vm.audit.length === 1 ? '' : 's'} —{' '}
        <Link to={`/memories/${memory.id}/timeline`}>full status history</Link>
      </p>

      <h2>Supersession chain</h2>
      {vm.history.length === 0 ? (
        <EmptyState message="the API returned an empty supersession chain" />
      ) : (
        <ol className="supersession">
          {vm.history.map((record) => (
            <li key={`${record.id}-${record.valid_from}`}>
              <Link to={`/memories/${record.id}`}>{record.id}</Link>{' '}
              <StatusBadge status={record.status} /> valid from {record.valid_from}
            </li>
          ))}
        </ol>
      )}
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function MemoryDetailPage(): ReactNode {
  const { api, activeProject } = useProject();
  const params = useParams();
  const memoryId = params.memoryId ?? '';
  const state = useAsync(
    () =>
      activeProject === null || memoryId === ''
        ? Promise.reject(new Error('no active project or memory id in the route'))
        : loadMemoryDetail(api, activeProject.id, memoryId),
    [api, activeProject?.id, memoryId],
  );
  return (
    <AsyncGate state={state}>
      {(vm) => activeProject !== null && <MemoryDetailView vm={vm} projectId={activeProject.id} />}
    </AsyncGate>
  );
}
