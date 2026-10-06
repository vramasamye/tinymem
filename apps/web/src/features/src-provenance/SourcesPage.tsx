/**
 * The sources index route (`/sources`): search results grouped by the provenance the
 * API reports per row — source kind + uri — with the source title from a bounded
 * per-group inspect (the only endpoint that returns `provenance.source.title`).
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router';

import { AsyncGate, EmptyState, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadSources, type SourcesViewModel } from './controller';

/** Pure presentation. */
export function SourcesView({
  vm,
  projectId,
  query,
  onQueryChange,
}: {
  vm: SourcesViewModel;
  projectId: string;
  query: string;
  onQueryChange(next: string): void;
}): ReactNode {
  return (
    <section className="page page-sources">
      <h1>Sources &amp; provenance</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="filter-query">
          scope query
          <input
            type="search"
            value={query}
            placeholder="which memories to index sources over"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      </form>
      <p className="query-sent">
        query sent: <code>{vm.querySent}</code>
      </p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={vm.warnings} />
      {vm.inspectFailures.length > 0 && (
        <p className="state state-partial">
          {vm.inspectFailures.length} source title
          {vm.inspectFailures.length === 1 ? '' : 's'} unavailable — the inspect endpoint
          reported them individually (e.g. purged mid-view)
        </p>
      )}
      {vm.groups.length === 0 ? (
        <EmptyState message="the API returned no memories to group by source" />
      ) : (
        <ol className="source-groups">
          {vm.groups.map((group) => (
            <li key={`${group.kind}-${group.uri}`} className="source-group">
              <h2>
                <code>{group.kind}</code>
                {group.uri === null ? null : <> — {group.uri}</>}
              </h2>
              {group.title === null ? (
                <p className="meta">source title not returned by the API for this group</p>
              ) : (
                <p className="meta">“{group.title}”</p>
              )}
              <ul className="source-memories">
                {group.memories.map((memory) => (
                  <li key={memory.id}>
                    <Link to={`/memories/${memory.id}`}>
                      {memory.title ?? memory.summary}
                    </Link>{' '}
                    ({memory.temporal.status})
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function SourcesPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const [query, setQuery] = useState('');
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadSources(api, activeProject.id, query, activeProject.name),
    [api, activeProject?.id, activeProject?.name, query],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Sources &amp; provenance</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <SourcesView
          vm={vm}
          projectId={activeProject.id}
          query={query}
          onQueryChange={setQuery}
        />
      )}
    </AsyncGate>
  );
}
