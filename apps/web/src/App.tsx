/**
 * The app shell: navigation for every M10 surface, the active-project indicator,
 * and a health pill fed by GET /v1/health. Chrome strings are static; the health
 * values (status, version) and project values come from the API.
 */

import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';

import { useAsync } from './lib/async';
import { useProject } from './state/project';

function HealthPill(): ReactNode {
  const { api } = useProject();
  const state = useAsync(() => api.health(), [api]);
  if (state.status === 'loading') {
    return <span className="health health-loading">checking the API…</span>;
  }
  if (state.status === 'error') {
    return (
      <span className="health health-error" title={state.error.message}>
        API unreachable
      </span>
    );
  }
  return (
    <span className={`health health-${state.data.status}`} title={state.data.warnings.join('; ')}>
      API {state.data.status} · v{state.data.version} · storage {state.data.storage.profile}
    </span>
  );
}

export function AppShell(): ReactNode {
  const { activeProject } = useProject();
  return (
    <div className="shell">
      <header className="topbar">
        <h1 className="brand">
          <Link to="/memories">onememory explorer</Link>
        </h1>
        <nav aria-label="surfaces">
          <ul>
            <li>
              <NavLink to="/memories">memories</NavLink>
            </li>
            <li>
              <NavLink to="/graph">graph</NavLink>
            </li>
            <li>
              <NavLink to="/projects">projects</NavLink>
            </li>
            <li>
              <NavLink to="/decisions">decisions</NavLink>
            </li>
            <li>
              <NavLink to="/failures">failures</NavLink>
            </li>
            <li>
              <NavLink to="/skills">skills</NavLink>
            </li>
            <li>
              <NavLink to="/sources">sources</NavLink>
            </li>
            <li>
              <NavLink to="/quality">quality</NavLink>
            </li>
          </ul>
        </nav>
        <div className="topbar-status">
          <HealthPill />
          {activeProject === null ? null : (
            <span className="active-project">project: {activeProject.name}</span>
          )}
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="footer">every value on these pages comes from the REST API</footer>
    </div>
  );
}
