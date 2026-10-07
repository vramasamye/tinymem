/**
 * The route map — one route per M10 surface, all data-bearing.
 *
 * The table is data first (`APP_ROUTES`) so the route-map test can assert surface
 * coverage without mounting anything; `createAppRouter` wires the same table into
 * the browser router under the shared AppShell.
 */

import type { ReactNode } from 'react';
import { Navigate, Outlet, createBrowserRouter } from 'react-router';

import { AppShell } from './App';
import { BrowsePage } from './features/browse/BrowsePage';
import { DecisionsPage } from './features/decisions/DecisionsPage';
import { FailuresPage } from './features/failures/FailuresPage';
import { GraphPage } from './features/graph/GraphPage';
import { MemoriesPage } from './features/memories/MemoriesPage';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { QualityPage } from './features/quality/QualityPage';
import { MemoryDetailPage, SourcesPage } from './features/src-provenance';
import { SkillReviewPage } from './features/skills/review/SkillReviewPage';
import { SkillsPage } from './features/skills/SkillsPage';
import { TimelinePage } from './features/timeline/TimelinePage';

export interface AppRoute {
  readonly path: string;
  /** The M10 backlog surface this route delivers. */
  readonly surface: string;
  readonly element: ReactNode;
}

export const APP_ROUTES: readonly AppRoute[] = [
  {
    path: '/',
    surface: 'root redirect → memories',
    element: <Navigate replace to="/memories" />,
  },
  {
    path: '/memories',
    surface: 'memories list/filter + full-text + structured search',
    element: <MemoriesPage />,
  },
  {
    path: '/browse',
    surface: 'memories browse (keyset-paginated: cursor + page size from the API)',
    element: <BrowsePage />,
  },
  {
    path: '/memories/:memoryId',
    surface: 'sources/provenance drill-down (one memory)',
    element: <MemoryDetailPage />,
  },
  {
    path: '/memories/:memoryId/timeline',
    surface: 'timeline (status history via memory_events audit)',
    element: <TimelinePage />,
  },
  {
    path: '/projects',
    surface: 'projects (+ stats + session context)',
    element: <ProjectsPage />,
  },
  {
    path: '/decisions',
    surface: 'decisions',
    element: <DecisionsPage />,
  },
  {
    path: '/failures',
    surface: 'failures',
    element: <FailuresPage />,
  },
  {
    path: '/skills',
    surface: 'skills (skill payloads on procedural memories)',
    element: <SkillsPage />,
  },
  {
    path: '/skills/:skillId/review',
    surface: 'skill review (SKILL.md body + audited approve / reject)',
    element: <SkillReviewPage />,
  },
  {
    path: '/graph',
    surface: 'graph view (entity/memory graph from retrieval + inspect)',
    element: <GraphPage />,
  },
  {
    path: '/sources',
    surface: 'sources/provenance index (cross-memory)',
    element: <SourcesPage />,
  },
  {
    path: '/quality',
    surface: 'quality dashboard (duplicates, stale, conflicts, unused, low-confidence)',
    element: <QualityPage />,
  },
];

export const ROUTE_COUNT = APP_ROUTES.length;

export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      children: [...APP_ROUTES],
    },
  ]);
}
