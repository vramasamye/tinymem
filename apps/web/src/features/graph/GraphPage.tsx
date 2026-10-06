/**
 * The graph route (`/graph`): the entity/memory graph around a query, drawn as SVG.
 * The layout is presentation (deterministic rings); the nodes, labels, statuses and
 * edges are the controller's view-model — API data only.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';

import { AsyncGate, EmptyState, TokensMeter, Warnings } from '../../components/kit';
import { useAsync } from '../../lib/async';
import { useProject } from '../../state/project';
import { loadGraph, type GraphNode, type GraphViewModel } from './controller';

const WIDTH = 900;
const HEIGHT = 620;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;

interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

/** Deterministic ring layout: memories outer, entities inner — stable per node set. */
export function layoutNodes(nodes: readonly GraphNode[]): PositionedNode[] {
  const memories = nodes.filter((node) => node.kind === 'memory');
  const entities = nodes.filter((node) => node.kind === 'entity');
  const ring = (group: GraphNode[], radius: number, phase: number): PositionedNode[] =>
    group.map((node, index) => {
      const angle = phase + (2 * Math.PI * index) / Math.max(group.length, 1);
      return { ...node, x: CENTER_X + radius * Math.cos(angle), y: CENTER_Y + radius * Math.sin(angle) };
    });
  return [...ring(memories, 250, -Math.PI / 2), ...ring(entities, 120, Math.PI / 6)];
}

/** Pure presentation — an SVG the view-model fully determines. */
export function GraphView({
  vm,
  projectId,
  query,
  onQueryChange,
}: {
  vm: GraphViewModel;
  projectId: string;
  query: string;
  onQueryChange(next: string): void;
}): ReactNode {
  const positioned = layoutNodes(vm.nodes);
  const byId = new Map(positioned.map((node) => [node.id, node]));
  return (
    <section className="page page-graph">
      <h1>Graph</h1>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="filter-query">
          seed query
          <input
            type="search"
            value={query}
            placeholder="the memories the graph grows from"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      </form>
      <p className="query-sent">
        query sent: <code>{vm.querySent}</code>
      </p>
      <TokensMeter tokens={vm.tokens} />
      <Warnings warnings={vm.warnings} />
      <p className="meta">
        {vm.nodes.filter((node) => node.kind === 'memory').length} memory nodes ·{' '}
        {vm.nodes.filter((node) => node.kind === 'entity').length} entity nodes ·{' '}
        {vm.edges.length} edges
        {vm.externalEdgeCount === 0
          ? null
          : ` · ${vm.externalEdgeCount} edge${vm.externalEdgeCount === 1 ? '' : 's'} to memories outside the result set (not drawn)`}
      </p>
      {vm.nodes.length === 0 ? (
        <EmptyState message="the API returned no memories to graph for this query" />
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="entity and memory graph"
          className="graph-svg"
        >
          {vm.edges.map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (from === undefined || to === undefined) return null;
            return (
              <g key={`${edge.from}-${edge.to}-${edge.relation}`} className="graph-edge">
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
              </g>
            );
          })}
          {positioned.map((node) => (
            <g key={node.id} className={`graph-node graph-node-${node.kind}`}>
              <circle cx={node.x} cy={node.y} r={node.kind === 'memory' ? 26 : 14} />
              <text x={node.x} y={node.y + (node.kind === 'memory' ? 48 : 30)} textAnchor="middle">
                {node.label}
              </text>
              {node.subtitle === null ? null : (
                <text x={node.x} y={node.y + 4} textAnchor="middle" className="graph-node-type">
                  {node.subtitle}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      {vm.inspectFailures.length === 0 ? null : (
        <p className="state state-partial">
          {vm.inspectFailures.length} inspected memor
          {vm.inspectFailures.length === 1 ? 'y' : 'ies'} could not be joined (the inspect
          endpoint reported them individually, e.g. purged mid-view)
        </p>
      )}
      <span className="sr-only" data-project-id={projectId} />
    </section>
  );
}

/** The route element. */
export function GraphPage(): ReactNode {
  const { api, activeProject, projects } = useProject();
  const [query, setQuery] = useState('');
  const state = useAsync(
    () =>
      activeProject === null
        ? Promise.reject(new Error('no active project'))
        : loadGraph(api, activeProject.id, query, activeProject.name),
    [api, activeProject?.id, activeProject?.name, query],
  );

  if (activeProject === null) {
    return (
      <section className="page">
        <h1>Graph</h1>
        <EmptyState message="no project is registered — run `onemem init` (the API lists zero projects)" />
        <Warnings warnings={projects?.warnings ?? []} />
      </section>
    );
  }

  return (
    <AsyncGate state={state}>
      {(vm) => <GraphView vm={vm} projectId={activeProject.id} query={query} onQueryChange={setQuery} />}
    </AsyncGate>
  );
}
