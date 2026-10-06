/**
 * The timeline route (`/memories/:memoryId/timeline`): the memory's status history
 * from the audit trail (`memory_events` via the inspect endpoint), plus the
 * supersession chain.
 */

import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { AsyncGate, EmptyState, StatusBadge, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadTimeline, type TimelineViewModel } from './controller';

/** Pure presentation. */
export function TimelineView({
  vm,
  projectId,
}: {
  vm: TimelineViewModel;
  projectId: string;
}): ReactNode {
  return (
    <section className="page page-timeline">
      <h1>Timeline — {vm.label}</h1>
      <p className="meta">
        <StatusBadge status={vm.currentStatus} /> current status ·{' '}
        <Link to={`/memories/${vm.memoryId}`}>provenance</Link>
      </p>
      <Warnings warnings={vm.warnings} />
      <h2>Status history (memory_events audit trail)</h2>
      {vm.audit.length === 0 ? (
        <EmptyState message="the API returned an empty audit trail for this memory" />
      ) : (
        <ol className="timeline">
          {vm.audit.map((event) => (
            <li key={event.id} className="timeline-event">
              <p className="when">{event.at}</p>
              <p className="what">
                <code>{event.action}</code>
                {event.from_status === null ? null : (
                  <>
                    {' '}
                    <StatusBadge status={event.from_status} /> →{' '}
                  </>
                )}
                {event.to_status === null ? null : <StatusBadge status={event.to_status} />}
                <span> · actor {event.actor}</span>
              </p>
              <p className="detail">{JSON.stringify(event.details)}</p>
            </li>
          ))}
        </ol>
      )}
      <h2>Supersession chain</h2>
      {vm.history.length === 0 ? (
        <EmptyState message="the API returned an empty supersession chain" />
      ) : (
        <ol className="supersession">
          {vm.history.map((record) => (
            <li key={`${record.id}-${record.valid_from}`}>
              <Link to={`/memories/${record.id}/timeline`}>{record.id}</Link>{' '}
              <StatusBadge status={record.status} /> valid from {record.valid_from}
              {record.valid_until === undefined ? null : ` until ${record.valid_until}`}
            </li>
          ))}
        </ol>
      )}
      <h2>Entities</h2>
      {vm.entities.length === 0 ? (
        <EmptyState message="the API returned no entities for this memory" />
      ) : (
        <ul className="entity-list">
          {vm.entities.map((entity) => (
            <li key={entity.id}>
              {entity.name} ({entity.kind}) · confidence {entity.confidence}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function TimelinePage(): ReactNode {
  const { api, activeProject } = useProject();
  const params = useParams();
  const memoryId = params.memoryId ?? '';
  const state = useAsync(
    () =>
      activeProject === null || memoryId === ''
        ? Promise.reject(new Error('no active project or memory id in the route'))
        : loadTimeline(api, activeProject.id, memoryId),
    [api, activeProject?.id, memoryId],
  );
  return (
    <AsyncGate state={state}>
      {(vm) => activeProject !== null && <TimelineView vm={vm} projectId={activeProject.id} />}
    </AsyncGate>
  );
}
