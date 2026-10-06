/**
 * The app-level state: one ApiClient, the registered projects (from the API), and
 * which project the explorer is pointed at. The selection is UI state persisted in
 * localStorage — but the project itself is always the API's record, never a
 * client-side description.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiError, createApiClient, type ApiClient } from '../api/client';
import type { Project, ProjectListResponse } from '../api/schemas';

const STORAGE_KEY = 'onememory.web.activeProject';

export interface ProjectContextValue {
  readonly api: ApiClient;
  /** null until the projects call lands. */
  readonly projects: ProjectListResponse | null;
  readonly projectsError: ApiError | null;
  readonly activeProject: Project | null;
  selectProject(projectId: string): void;
  reload(): void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export interface ProjectProviderProps {
  children: ReactNode;
  /** Injectable for tests and remote deployments; defaults to the env-resolving client. */
  api?: ApiClient;
  /**
   * Test seam: start from a known projects response (still API-shaped data) so
   * renderToString-based smoke tests can exercise the shell synchronously.
   */
  initialProjects?: ProjectListResponse;
}

function readStoredProjectId(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function storeProjectId(projectId: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, projectId);
  } catch {
    // Storage unavailable (private mode) — the selection stays session-only.
  }
}

export function ProjectProvider(props: ProjectProviderProps): ReactNode {
  const api = props.api ?? defaultApiClient;
  const [projects, setProjects] = useState<ProjectListResponse | null>(
    props.initialProjects ?? null,
  );
  const [projectsError, setProjectsError] = useState<ApiError | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => readStoredProjectId());
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    if (props.initialProjects !== undefined) return;
    let cancelled = false;
    api
      .listProjects()
      .then((response) => {
        if (!cancelled) {
          setProjects(response);
          setProjectsError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProjectsError(error instanceof ApiError ? error : null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, reloadCount, props.initialProjects]);

  const activeProject = useMemo(() => {
    if (projects === null) return null;
    const stored = projects.projects.find((project) => project.id === activeId);
    return stored ?? projects.projects[0] ?? null;
  }, [projects, activeId]);

  const selectProject = useCallback(
    (projectId: string) => {
      setActiveId(projectId);
      storeProjectId(projectId);
    },
    [],
  );

  const reload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      api,
      projects,
      projectsError,
      activeProject,
      selectProject,
      reload,
    }),
    [api, projects, projectsError, activeProject, selectProject, reload],
  );

  return <ProjectContext.Provider value={value}>{props.children}</ProjectContext.Provider>;
}

/** The single instance pages share (same-origin by default — see `api/client.ts`). */
export const defaultApiClient = createApiClient();

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (value === null) {
    throw new Error('useProject must be used inside <ProjectProvider>');
  }
  return value;
}
