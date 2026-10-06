/**
 * The decisions route (`/decisions`): the project's decisions, kind-filtered and
 * token-budgeted by the API. Each row links to the full provenance drill-down,
 * where the decision payload (alternatives, rationale, participants) renders.
 */

import type { ReactNode } from 'react';

import { AsyncGate, EmptyState, MemoryRow, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadDecisions, type DecisionsViewModel } from './controller';

/** Pure presentation. */
export function DecisionsView({
  vm,
  projectId,
  projectWarnings,
}: {
  vm: DecisionsViewModel;
  projectId: string;
  projectWarnings: readonly string[];
}): ReactNode {
  return (
    <section className="page page-decisions">
      <h1>Decisions</h1>
      <p className="meta">kind-filtered, token-budgeted (the API's decisions endpoint)</p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={[...projectWarnings, ...vm.warnings]} />
      {vm.memories.length === 0 ? (
        <EmptyState message="the API returned no decisions" />
      ) : (
        <ol className="memory-list">
          {vm.memories.map((memory) => (
            <li key={memory.id}>
              <MemoryRow memory={memory} projectId={projectId} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The route element. */
export function DecisionsPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadDecisions(api, activeProject.id),
    [api, activeProject?.id],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Decisions</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <DecisionsView
          vm={vm}
          projectId={activeProject.id}
          projectWarnings={projects?.warnings ?? []}
        />
      )}
    </AsyncGate>
  );
}
