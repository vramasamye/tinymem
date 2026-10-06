/**
 * The failures route (`/failures`): the project's captured failures, kind-filtered
 * and token-budgeted by the API. Each row links to the drill-down, where the
 * failure payload (problem, root cause, solution, verification) renders.
 */

import type { ReactNode } from 'react';

import { AsyncGate, EmptyState, MemoryRow, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadFailures, type FailuresViewModel } from './controller';

/** Pure presentation. */
export function FailuresView({
  vm,
  projectId,
  projectWarnings,
}: {
  vm: FailuresViewModel;
  projectId: string;
  projectWarnings: readonly string[];
}): ReactNode {
  return (
    <section className="page page-failures">
      <h1>Failures</h1>
      <p className="meta">kind-filtered, token-budgeted (the API's failures endpoint)</p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={[...projectWarnings, ...vm.warnings]} />
      {vm.memories.length === 0 ? (
        <EmptyState message="the API returned no failures" />
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
export function FailuresPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadFailures(api, activeProject.id),
    [api, activeProject?.id],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Failures</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <FailuresView
          vm={vm}
          projectId={activeProject.id}
          projectWarnings={projects?.warnings ?? []}
        />
      )}
    </AsyncGate>
  );
}
