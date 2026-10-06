/**
 * The skills route (`/skills`): skill payloads found among the project's procedural
 * memories (the skillify stage, M15, is not landed — the honest state is whatever
 * the API returns, including zero skills).
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { AsyncGate, EmptyState, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadSkills, type SkillsViewModel } from './controller';

/** Pure presentation. */
export function SkillsView({
  vm,
  projectId,
  projectWarnings,
}: {
  vm: SkillsViewModel;
  projectId: string;
  projectWarnings: readonly string[];
}): ReactNode {
  return (
    <section className="page page-skills">
      <h1>Skills</h1>
      <p className="meta">
        skill payloads carried by procedural memories (query <code>{vm.querySent}</code> —
        the API's typed-list synthesis)
      </p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={[...projectWarnings, ...vm.warnings]} />

      <h2>Skill payloads</h2>
      {vm.skills.length === 0 ? (
        <EmptyState message="no procedural memory carries a skill payload yet (the skillify stage generates them)" />
      ) : (
        <ol className="skill-cards">
          {vm.skills.map((card) => (
            <li key={card.memoryId} className="skill-card">
              <h3>
                <Link to={`/memories/${card.memoryId}`}>{card.skill.name}</Link> v
                {card.skill.version}
              </h3>
              <p className="meta">
                status {card.skill.status} · memory status {card.memoryStatus} · usage{' '}
                {card.skill.usage_count}
                {card.skill.success_rate === undefined
                  ? null
                  : ` · success rate ${card.skill.success_rate}`}
                {' · '}
                {card.evidenceCount} evidence span{card.evidenceCount === 1 ? '' : 's'}
              </p>
              <p>{card.skill.description}</p>
              <p>
                path <code>{card.skill.path}</code>
              </p>
              <p>verified at {card.skill.verification.verified_at}</p>
            </li>
          ))}
        </ol>
      )}

      <h2>Procedural memories in scope</h2>
      {vm.procedural.length === 0 ? (
        <EmptyState message="the API returned no procedural memories" />
      ) : (
        <ul className="procedural-list">
          {vm.procedural.map((memory) => (
            <li key={memory.id}>
              <Link to={`/memories/${memory.id}`}>{memory.title ?? memory.summary}</Link> (
              {memory.temporal.status})
            </li>
          ))}
        </ul>
      )}
      {vm.inspectFailures.length === 0 ? null : (
        <p className="state state-partial">
          {vm.inspectFailures.length} procedural memor
          {vm.inspectFailures.length === 1 ? 'y' : 'ies'} could not be inspected (reported
          individually by the API)
        </p>
      )}
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function SkillsPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadSkills(api, activeProject.id),
    [api, activeProject?.id],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Skills</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <SkillsView
          vm={vm}
          projectId={activeProject.id}
          projectWarnings={projects?.warnings ?? []}
        />
      )}
    </AsyncGate>
  );
}
