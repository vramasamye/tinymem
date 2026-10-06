/**
 * The projects route (`/projects`): registered projects (from the API list, with
 * the API's own warnings), the active project's storage/memory stats, and the
 * session context block with its token accounting.
 */

import type { ReactNode } from 'react';

import { AsyncGate, EmptyState, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadProjectOverview, type ProjectOverviewViewModel } from './controller';

/** Pure presentation. */
export function ProjectsView({
  vm,
  projectWarnings,
}: {
  vm: ProjectOverviewViewModel;
  projectWarnings: readonly string[];
}): ReactNode {
  const stats = vm.stats;
  return (
    <section className="page page-projects">
      <h1>Projects</h1>
      <Warnings warnings={projectWarnings} />

      <h2>Storage</h2>
      <p className="meta">
        profile <code>{stats.storage.profile}</code> · vector{' '}
        <code>
          {stats.storage.vector_backend}/{stats.storage.vector_model}
        </code>{' '}
        dim {stats.storage.vector_dim}
        {stats.storage.data_dir === null ? null : ` · data dir ${stats.storage.data_dir}`}
      </p>

      <h2>Memories</h2>
      <p>
        {stats.memories.total} total
        {stats.memories.truncated ? ' (counts truncated at the read cap — a lower bound)' : ''}
      </p>
      <table className="stat-table">
        <caption>by status (from /v1/stats)</caption>
        <tbody>
          {Object.entries(stats.memories.by_status).map(([status, count]) => (
            <tr key={status}>
              <th>{status}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="stat-table">
        <caption>by type (from /v1/stats)</caption>
        <tbody>
          {Object.entries(stats.memories.by_type).map(([type, count]) => (
            <tr key={type}>
              <th>{type}</th>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Runtime</h2>
      <p>
        working memory{' '}
        {stats.working_memory === null
          ? 'none (the API reports no active session)'
          : `session ${stats.working_memory.session_id}, depth ${stats.working_memory.depth}`}{' '}
        · jobs{' '}
        {stats.jobs === null
          ? 'unreported (no job-count API yet)'
          : `${stats.jobs.pending} pending, ${stats.jobs.running} running, ${stats.jobs.dead} dead`}{' '}
        · cache {stats.cache.embeddings} embeddings, {stats.cache.results} results,{' '}
        {stats.cache.entityScopes} entity scopes
      </p>
      <Warnings warnings={stats.warnings} />

      <h2>Session context</h2>
      <p>
        budget {vm.context.budget} · used {vm.context.used} (
        {Math.round((vm.context.used / vm.context.budget) * 100)}%)
      </p>
      {vm.context.sections.length === 0 ? (
        <EmptyState message="the API returned no context sections" />
      ) : (
        <ol className="context-sections">
          {vm.context.sections.map((section) => (
            <li key={section.kind}>
              <code>{section.kind}</code> ({section.tokens} tokens) — {section.text}
            </li>
          ))}
        </ol>
      )}
      <Warnings warnings={vm.context.warnings} />
    </section>
  );
}

/** The route element. */
export function ProjectsPage(): ReactNode {
  const { api, projects, projectsError, activeProject, selectProject } = useProject();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadProjectOverview(api, activeProject.id),
    [api, activeProject?.id],
  );

  return (
    <section className="page page-projects">
      <h1>Projects</h1>
      {projectsError !== null && (
        <p className="state state-error">
          the projects API failed: {projectsError.message} (code {projectsError.code})
        </p>
      )}
      {projects === null ? (
        <EmptyState message="loading the projects API…" />
      ) : (
        <>
          {projects.projects.length === 0 ? (
            <EmptyState message="the API lists zero projects — run `onemem init`" />
          ) : (
            <ul className="project-list">
              {projects.projects.map((project) => (
                <li key={project.id}>
                  <label>
                    <input
                      type="radio"
                      name="active-project"
                      checked={activeProject?.id === project.id}
                      onChange={() => selectProject(project.id)}
                    />{' '}
                    <strong>{project.name}</strong> ({project.id})
                  </label>
                  {project.root_path === undefined || project.root_path === null ? null : (
                    <p className="meta">root {project.root_path}</p>
                  )}
                  {project.git_remote === undefined || project.git_remote === null ? null : (
                    <p className="meta">remote {project.git_remote}</p>
                  )}
                  {project.description === undefined || project.description === null ? null : (
                    <p className="meta">{project.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Warnings warnings={projects.warnings} />
        </>
      )}
      {activeProject !== null && (
        <AsyncGate state={state}>
          {(vm) => <ProjectsView vm={vm} projectWarnings={projects?.warnings ?? []} />}
        </AsyncGate>
      )}
    </section>
  );
}
