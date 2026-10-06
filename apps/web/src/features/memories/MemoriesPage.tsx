/**
 * The memories list/filter route: the structured search form + the result rows.
 * Every row value (title, status, relevance, score components, source, code refs)
 * is the API's own search response — the form only chooses the REQUEST.
 */

import type { ReactNode } from 'react';

import { DURABLE_MEMORY_TYPES_UI, INCLUDE_STATUSES_UI } from '../../api/schemas';
import { AsyncGate, EmptyState, MemoryRow, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import {
  loadMemories,
  serializeFilters,
  useMemoriesFilters,
  type MemoriesFilters,
  type MemoriesViewModel,
} from './controller';

const checkboxGroup = <T extends string,>(
  name: string,
  options: readonly T[],
  selected: readonly T[],
  onToggle: (option: T) => void,
): ReactNode => (
  <fieldset className="filter-group">
    <legend>{name}</legend>
    {options.map((option) => (
      <label key={option}>
        <input
          type="checkbox"
          name={name}
          value={option}
          checked={selected.includes(option)}
          onChange={() => onToggle(option)}
        />
        {option}
      </label>
    ))}
  </fieldset>
);

/** Pure presentation — takes the view-model the controller produced. */
export function MemoriesView(props: {
  vm: MemoriesViewModel;
  filters: MemoriesFilters;
  projectId: string;
  projectWarnings: readonly string[];
  onFiltersChange(next: MemoriesFilters): void;
}): ReactNode {
  const { vm, filters, projectId, projectWarnings, onFiltersChange } = props;
  const toggleType = (type: (typeof DURABLE_MEMORY_TYPES_UI)[number]) =>
    onFiltersChange({
      ...filters,
      types: filters.types.includes(type)
        ? filters.types.filter((candidate) => candidate !== type)
        : [...filters.types, type],
    });
  const toggleInclude = (status: (typeof INCLUDE_STATUSES_UI)[number]) =>
    onFiltersChange({
      ...filters,
      include: filters.include.includes(status)
        ? filters.include.filter((candidate) => candidate !== status)
        : [...filters.include, status],
    });

  return (
    <section className="page page-memories">
      <h1>Memories</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="filter-query">
          full-text query
          <input
            type="search"
            value={filters.query}
            placeholder="search memories"
            onChange={(event) => onFiltersChange({ ...filters, query: event.target.value })}
          />
        </label>
        {checkboxGroup('types', DURABLE_MEMORY_TYPES_UI, filters.types, toggleType)}
        {checkboxGroup('include', INCLUDE_STATUSES_UI, filters.include, toggleInclude)}
        <label>
          entities (comma-separated)
          <input
            type="text"
            value={filters.entities.join(',')}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                entities: event.target.value
                  .split(',')
                  .map((entity) => entity.trim())
                  .filter((entity) => entity !== ''),
              })
            }
          />
        </label>
        <label>
          temporal mode
          <select
            value={filters.temporalMode}
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                temporalMode: event.target.value === 'historical' ? 'historical' : 'current',
              })
            }
          >
            <option value="current">current</option>
            <option value="historical">historical</option>
          </select>
        </label>
        <label>
          as of (ISO date)
          <input
            type="text"
            value={filters.asOf}
            placeholder="2026-10-01T00:00:00.000Z"
            onChange={(event) => onFiltersChange({ ...filters, asOf: event.target.value })}
          />
        </label>
        <label>
          token budget
          <input
            type="number"
            min={1}
            value={filters.maxTokens}
            onChange={(event) =>
              onFiltersChange({ ...filters, maxTokens: Number(event.target.value) || 1 })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.explain}
            onChange={(event) => onFiltersChange({ ...filters, explain: event.target.checked })}
          />
          score components (explain)
        </label>
      </form>

      <p className="query-sent">
        query sent: <code>{vm.querySent}</code>
      </p>
      <p className="understanding">
        intent <code>{vm.understanding.intent}</code> · keywords{' '}
        <code>{vm.understanding.keywords.join(', ')}</code>
        {vm.understanding.entities.length === 0
          ? null
          : ` · entities ${vm.understanding.entities.map((entity) => entity.name).join(', ')}`}
      </p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={[...projectWarnings, ...vm.warnings]} />
      {vm.memories.length === 0 ? (
        <EmptyState message="the API returned no memories for this query" />
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

/** The route element: URL filters → controller → view. */
export function MemoriesPage(): ReactNode {
  const { api, projects, activeProject } = useProject();
  const { filters, setFilters } = useMemoriesFilters();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadMemories(api, activeProject.id, filters, activeProject.name),
    [api, activeProject?.id, activeProject?.name, serializeFilters(filters)],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Memories</h1>
        <EmptyState
          message={
            projects !== null && projects.projects.length === 0
              ? 'no project is registered — run `onemem init` (the API lists zero projects)'
              : 'waiting for the projects API…'
          }
        />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <MemoriesView
          vm={vm}
          filters={filters}
          projectId={activeProject.id}
          projectWarnings={projects?.warnings ?? []}
          onFiltersChange={setFilters}
        />
      )}
    </AsyncGate>
  );
}
