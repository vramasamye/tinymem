/**
 * The smoke render test: every surface's View rendered with a view-model produced
 * by its controller over the stubbed API (client → controller → view, the exact
 * production path), then rendered to string via react-dom/server.
 *
 * What this pins (M10 acceptance 3): the HTML a user would see contains the
 * API's own values — titles, summaries, statuses, score components, evidence
 * quotes, source titles, warnings — and with an EMPTY API response the rendered
 * HTML contains the empty state and none of the data markers.
 */

import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import { createApiClient } from './api/client';
import { ProjectListResponseSchema } from './api/schemas';
import { AppShell } from './App';
import { loadDecisions } from './features/decisions/controller';
import { DecisionsView } from './features/decisions/DecisionsPage';
import { loadFailures } from './features/failures/controller';
import { FailuresView } from './features/failures/FailuresPage';
import { loadGraph } from './features/graph/controller';
import { GraphView } from './features/graph/GraphPage';
import { DEFAULT_MEMORIES_FILTERS, loadMemories } from './features/memories/controller';
import { MemoriesView } from './features/memories/MemoriesPage';
import { loadProjectOverview } from './features/projects/controller';
import { ProjectsView } from './features/projects/ProjectsPage';
import { loadQuality } from './features/quality/controller';
import { QualityView } from './features/quality/QualityPage';
import { loadMemoryDetail, loadSources } from './features/src-provenance/controller';
import { MemoryDetailView } from './features/src-provenance/MemoryDetailPage';
import { SourcesView } from './features/src-provenance/SourcesPage';
import { loadSkills } from './features/skills/controller';
import { SkillsView } from './features/skills/SkillsPage';
import { loadTimeline } from './features/timeline/controller';
import { TimelineView } from './features/timeline/TimelinePage';
import { ProjectProvider } from './state/project';
import {
  MEMORY_ID_ALPHA,
  PROJECT_ID,
  defaultStubRoutes,
  fixtureEmptySearchResponse,
  fixtureProceduralSearchResponse,
  fixtureProjectList,
  stubApi,
} from './test/fixtures';

const noop = (): void => {};

const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
const projects = ProjectListResponseSchema.parse(fixtureProjectList());

/** Render inside a router so <Link> resolves; react-dom/server needs no DOM.
 * React SSR separates adjacent text nodes with `<!-- -->` comments — strip them so
 * assertions read the human-visible text. */
function render(node: ReactNode): string {
  return renderToString(<MemoryRouter>{node}</MemoryRouter>).replaceAll('<!-- -->', '');
}

describe('the app shell', () => {
  test('renders the nav for every surface with the API project list', () => {
    const html = render(
      <ProjectProvider api={api} initialProjects={projects}>
        <AppShell />
      </ProjectProvider>,
    );
    expect(html).toContain('onememory explorer');
    expect(html).toContain('memories');
    expect(html).toContain('graph');
    expect(html).toContain('projects');
    expect(html).toContain('decisions');
    expect(html).toContain('failures');
    expect(html).toContain('skills');
    expect(html).toContain('sources');
    expect(html).toContain('quality');
    expect(html).toContain('checking the API'); // health pill is async in the browser
  });
});

describe('each surface renders its API data', () => {
  test('memories: title, relevance, score components, source, code refs, warnings', async () => {
    const vm = await loadMemories(api, PROJECT_ID, DEFAULT_MEMORIES_FILTERS, 'fixture-project');
    const html = render(
      <MemoriesView
        vm={vm}
        filters={DEFAULT_MEMORIES_FILTERS}
        projectId={PROJECT_ID}
        projectWarnings={[]}
        onFiltersChange={noop}
      />,
    );
    expect(html).toContain('Use PGlite for embedded mode');
    expect(html).toContain('fixture decision: embedded mode stores memories in PGlite');
    expect(html).toContain('relevance 0.83');
    expect(html).toContain('matched terms: pglite, embedded'); // explain detail
    expect(html).toContain('conversation (session://fixture-session/183)'); // provenance
    expect(html).toContain('packages/storage/src/embedded.ts'); // code ref
    expect(html).toContain('embedding index degraded: lexical only (fixture)'); // API warning
    expect(html).toContain('query sent: <code>fixture-project</code>');
  });

  test('memory detail: source title, evidence quotes, payload, redactions', async () => {
    const vm = await loadMemoryDetail(api, PROJECT_ID, MEMORY_ID_ALPHA);
    const html = render(<MemoryDetailView vm={vm} projectId={PROJECT_ID} />);
    expect(html).toContain('fixture session 2026-10-01'); // source title from inspect
    expect(html).toContain('we will store memories in PGlite for the embedded profile'); // quote
    expect(html).toContain('session.jsonl:183'); // locator
    expect(html).toContain('embedded mode stores memories in PGlite under .onememory/'); // payload
    expect(html).toContain('Docker Postgres + pgvector'); // alternative
    expect(html).toContain('fixture rationale: keeps the default install fully offline');
    expect(html).toContain('api-key'); // redaction kind
    expect(html).toContain('supersedes'); // edge relation
  });

  test('timeline: the audit events and supersession chain render', async () => {
    const vm = await loadTimeline(api, PROJECT_ID, MEMORY_ID_ALPHA);
    const html = render(<TimelineView vm={vm} projectId={PROJECT_ID} />);
    expect(html).toContain('status_changed');
    expect(html).toContain('actor drift-scan');
    expect(html).toContain('fixture drift: cited file changed');
    expect(html).toContain('Use PGlite for embedded mode');
  });

  test('projects: stats tables and the session context sections', async () => {
    const vm = await loadProjectOverview(api, PROJECT_ID);
    const html = render(<ProjectsView vm={vm} projectWarnings={[]} />);
    expect(html).toContain('12 total');
    expect(html).toContain('fixture digest: local-first memory engine');
    expect(html).toContain('fixture decisions: PGlite embedded mode');
    expect(html).toContain('budget 750 · used 210');
  });

  test('decisions + failures: rows pass through to the row component', async () => {
    const decisionsVm = await loadDecisions(api, PROJECT_ID);
    const decisionsHtml = render(
      <DecisionsView vm={decisionsVm} projectId={PROJECT_ID} projectWarnings={[]} />,
    );
    expect(decisionsHtml).toContain('Use PGlite for embedded mode');
    expect(decisionsHtml).toContain('relevance 0.83');

    const failuresVm = await loadFailures(api, PROJECT_ID);
    const failuresHtml = render(
      <FailuresView vm={failuresVm} projectId={PROJECT_ID} projectWarnings={[]} />,
    );
    expect(failuresHtml).toContain('pgvector extension missing');
  });

  test('graph: nodes, labels and the external-edge count render', async () => {
    const vm = await loadGraph(api, PROJECT_ID, '', 'fixture-project');
    const html = render(
      <GraphView vm={vm} projectId={PROJECT_ID} query="" onQueryChange={noop} />,
    );
    expect(html).toContain('Use PGlite for embedded mode');
    expect(html).toContain('pgvector extension missing');
    expect(html).toContain('PGlite'); // entity node
    expect(html).toContain('1 inspected memor'); // BETA inspect failure notice
  });

  test('skills: the skill card fields from the skill payload', async () => {
    const routes = defaultStubRoutes();
    routes[`POST /v1/projects/${PROJECT_ID}/search`] = fixtureProceduralSearchResponse();
    const skillsApi = createApiClient({ fetchImpl: stubApi(routes) });
    const vm = await loadSkills(skillsApi, PROJECT_ID);
    const html = render(
      <SkillsView vm={vm} projectId={PROJECT_ID} projectWarnings={[]} />,
    );
    expect(html).toContain('restore-pgvector-extension');
    expect(html).toContain('fixture skill: how to restore the pgvector extension in server mode');
    expect(html).toContain('skills/restore-pgvector-extension/SKILL.md');
    expect(html).toContain('verified');
  });

  test('sources: grouped by kind + uri with the inspected source title', async () => {
    const vm = await loadSources(api, PROJECT_ID, '', 'fixture-project');
    const html = render(
      <SourcesView vm={vm} projectId={PROJECT_ID} query="" onQueryChange={noop} />,
    );
    expect(html).toContain('conversation');
    expect(html).toContain('session://fixture-session/183');
    expect(html).toContain('fixture session 2026-10-01');
    expect(html).toContain('Use PGlite for embedded mode');
  });

  test('quality: counts, category samples, and the honest duplicates gap', async () => {
    const vm = await loadQuality(api, PROJECT_ID, 'fixture-project');
    const html = render(<QualityView vm={vm} projectId={PROJECT_ID} />);
    expect(html).toContain('12 memories total');
    expect(html).toContain('the REST API does not expose duplicate groups yet');
    expect(html).toContain('confidence below 0.5'); // the stated view policy
  });
});

describe('an empty API response renders empty, never invented', () => {
  test('memories view with zero rows shows the empty state and no data markers', async () => {
    const emptyApi = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadMemories(emptyApi, PROJECT_ID, DEFAULT_MEMORIES_FILTERS, 'fallback');
    const html = render(
      <MemoriesView
        vm={vm}
        filters={DEFAULT_MEMORIES_FILTERS}
        projectId={PROJECT_ID}
        projectWarnings={[]}
        onFiltersChange={noop}
      />,
    );
    expect(html).toContain('the API returned no memories for this query');
    expect(html).toContain('no memories matched (fixture)');
    // None of the populated-response markers may leak in.
    expect(html).not.toContain('Use PGlite for embedded mode');
    expect(html).not.toContain('matched terms');
  });

  test('decisions view with zero rows shows the empty state', async () => {
    const emptyApi = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/decisions`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadDecisions(emptyApi, PROJECT_ID);
    const html = render(
      <DecisionsView vm={vm} projectId={PROJECT_ID} projectWarnings={[]} />,
    );
    expect(html).toContain('the API returned no decisions');
    expect(html).not.toContain('Use PGlite');
  });

  test('failures view with zero rows shows the empty state', async () => {
    const emptyApi = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/failures`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadFailures(emptyApi, PROJECT_ID);
    const html = render(
      <FailuresView vm={vm} projectId={PROJECT_ID} projectWarnings={[]} />,
    );
    expect(html).toContain('the API returned no failures');
    expect(html).not.toContain('pgvector extension missing');
  });
});
