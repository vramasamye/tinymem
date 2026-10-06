/**
 * The quality route (`/quality`): duplicates, stale, conflicts, unused,
 * low-confidence — whatever the API can back today, honestly labeled where a list
 * is query-scoped or a category is a view policy over API fields.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { AsyncGate, EmptyState, MemoryRow, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import {
  LOW_CONFIDENCE_THRESHOLD,
  loadQuality,
  type QualitySample,
  type QualityViewModel,
} from './controller';

function SampleList({
  title,
  sample,
  projectId,
}: {
  title: string;
  sample: QualitySample;
  projectId: string;
}): ReactNode {
  return (
    <section className="quality-category">
      <h2>{title}</h2>
      <p className="meta">
        sample matching <code>{sample.querySent}</code> ({sample.memories.length} returned)
      </p>
      {sample.memories.length === 0 ? (
        <EmptyState message="the API returned no memories in this category" />
      ) : (
        <ol className="memory-list">
          {sample.memories.map((memory) => (
            <li key={memory.id}>
              <MemoryRow memory={memory} projectId={projectId} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Pure presentation. */
export function QualityView({
  vm,
  projectId,
}: {
  vm: QualityViewModel;
  projectId: string;
}): ReactNode {
  const lowConfidence = vm.insights.filter((row) => row.lowConfidence);
  const unused = vm.insights.filter((row) => row.unused);
  return (
    <section className="page page-quality">
      <h1>Quality</h1>

      <h2>Counts (from /v1/stats)</h2>
      <p>
        {vm.stats.memories.total} memories total
        {vm.stats.memories.truncated ? ' (truncated at the read cap — a lower bound)' : ''}
      </p>
      <table className="stat-table">
        <caption>by status</caption>
        <tbody>
          {Object.entries(vm.stats.memories.by_status).map(([status, count]) => (
            <tr key={status}>
              <th>{status}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="stat-table">
        <caption>by type</caption>
        <tbody>
          {Object.entries(vm.stats.memories.by_type).map(([type, count]) => (
            <tr key={type}>
              <th>{type}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Warnings warnings={vm.warnings} />

      <section className="quality-category quality-duplicates">
        <h2>Duplicates</h2>
        <p className="state state-empty">
          the REST API does not expose duplicate groups yet (near-dup merge is
          consolidation, M14/M15 scope) — no number is shown because none can be
          queried; a <code>/v1/quality</code> endpoint is the recorded follow-up
        </p>
      </section>

      <SampleList title="Stale" sample={vm.staleSample} projectId={projectId} />
      <SampleList title="Conflicts (disputed)" sample={vm.disputedSample} projectId={projectId} />
      <SampleList title="Superseded" sample={vm.supersededSample} projectId={projectId} />

      <section className="quality-category quality-insights">
        <h2>Low-confidence &amp; unused</h2>
        <p className="meta">
          from inspect enrichment over the first sampled rows — the thresholds are this
          view's policy over API values: confidence below {LOW_CONFIDENCE_THRESHOLD} ·
          access_count = 0
        </p>
        {vm.insights.length === 0 ? (
          <EmptyState message="no sampled memories were available for enrichment" />
        ) : (
          <>
            <h3>
              low-confidence ({lowConfidence.length} of {vm.insights.length} inspected)
            </h3>
            {lowConfidence.length === 0 ? (
              <EmptyState message="no inspected memory falls below the threshold" />
            ) : (
              <ul>
                {lowConfidence.map((row) => (
                  <li key={row.memoryId}>
                    <Link to={`/memories/${row.memoryId}`}>{row.label}</Link> — confidence{' '}
                    {row.confidence}
                  </li>
                ))}
              </ul>
            )}
            <h3>unused ({unused.length} of {vm.insights.length} inspected)</h3>
            {unused.length === 0 ? (
              <EmptyState message="no inspected memory has access_count 0" />
            ) : (
              <ul>
                {unused.map((row) => (
                  <li key={row.memoryId}>
                    <Link to={`/memories/${row.memoryId}`}>{row.label}</Link> — access_count{' '}
                    {row.accessCount}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {vm.inspectFailures.length === 0 ? null : (
          <p className="state state-partial">
            {vm.inspectFailures.length} sampled memor
            {vm.inspectFailures.length === 1 ? 'y' : 'ies'} could not be inspected (reported
            individually by the API)
          </p>
        )}
      </section>
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function QualityPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadQuality(api, activeProject.id, activeProject.name),
    [api, activeProject?.id, activeProject?.name],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Quality</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => <QualityView vm={vm} projectId={activeProject.id} />}
    </AsyncGate>
  );
}
