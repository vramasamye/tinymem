/**
 * The browse route: the project's memories, newest observation first, paged by the
 * API's keyset cursor. Every row value is the API's own memory record.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { BrowseIncludeStatus } from '../../api/client';
import { DURABLE_MEMORY_TYPES_UI, INCLUDE_STATUSES_UI, type DurableMemoryType } from '../../api/schemas';
import { AsyncGate, EmptyState, StatusBadge, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import {
  BROWSE_PAGE_SIZES,
  loadBrowsePage,
  serializeBrowseFilters,
  useBrowseFilters,
  type BrowseFilters,
  type BrowseViewModel,
} from './controller';

const toggle = <T,>(selected: readonly T[], value: T): T[] =>
  selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value];

/** Pure presentation — takes the view-model the controller produced. */
export function BrowseView(props: {
  vm: BrowseViewModel;
  filters: BrowseFilters;
  onFiltersChange(next: Omit<BrowseFilters, 'cursor'>): void;
  onNext(cursor: string): void;
  onFirst(): void;
}): ReactNode {
  const { vm, filters, onFiltersChange, onNext, onFirst } = props;
  const base = { types: filters.types, include: filters.include, pageSize: filters.pageSize };
  return (
    <section className="page page-browse">
      <h1>Browse</h1>
      <p className="meta">every memory, newest observation first — paged by the API cursor (no ranking, no token budget)</p>
      <form className="filters" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="filter-group">
          <legend>types</legend>
          {DURABLE_MEMORY_TYPES_UI.map((type: DurableMemoryType) => (
            <label key={type}>
              <input
                type="checkbox"
                checked={filters.types.includes(type)}
                onChange={() => onFiltersChange({ ...base, types: toggle(filters.types, type) })}
              />
              {type}
            </label>
          ))}
        </fieldset>
        <fieldset className="filter-group">
          <legend>include</legend>
          {INCLUDE_STATUSES_UI.map((status: BrowseIncludeStatus) => (
            <label key={status}>
              <input
                type="checkbox"
                checked={filters.include.includes(status)}
                onChange={() => onFiltersChange({ ...base, include: toggle(filters.include, status) })}
              />
              {status}
            </label>
          ))}
        </fieldset>
        <label>
          page size
          <select
            value={filters.pageSize}
            onChange={(event) => onFiltersChange({ ...base, pageSize: Number(event.target.value) })}
          >
            {BROWSE_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </form>
      {vm.memories.length === 0 ? (
        <EmptyState message={vm.isFirstPage ? 'the API returned no memories' : 'no further memories'} />
      ) : (
        <ol className="memory-list">
          {vm.memories.map((memory) => (
            <li key={memory.id}>
              <article className="memory-row">
                <h3>
                  <Link to={`/memories/${memory.id}`}>{memory.title ?? memory.content_summary ?? memory.content}</Link>
                </h3>
                <p className="meta">
                  <span className="badge badge-type">{memory.type}</span> <StatusBadge status={memory.status} />{' '}
                  observed {memory.observed_at}
                </p>
              </article>
            </li>
          ))}
        </ol>
      )}
      <nav className="pager" aria-label="pages">
        {vm.isFirstPage ? null : (
          <button type="button" onClick={onFirst}>
            first page
          </button>
        )}
        {vm.nextCursor === null ? (
          <span className="meta">end of list</span>
        ) : (
          <button type="button" onClick={() => onNext(vm.nextCursor!)}>
            next page
          </button>
        )}
      </nav>
    </section>
  );
}

/** The route element: URL filters → controller → view. */
export function BrowsePage(): ReactNode {
  const { api, projects, activeProject } = useProject();
  const { filters, setFilters, goToCursor } = useBrowseFilters();
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadBrowsePage(api, activeProject.id, filters),
    [api, activeProject?.id, serializeBrowseFilters(filters)],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Browse</h1>
        <EmptyState message="waiting for the projects API…" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => (
        <BrowseView
          vm={vm}
          filters={filters}
          onFiltersChange={setFilters}
          onNext={goToCursor}
          onFirst={() => goToCursor('')}
        />
      )}
    </AsyncGate>
  );
}
