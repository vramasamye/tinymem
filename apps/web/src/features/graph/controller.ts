/**
 * The graph surface: the entity/memory graph around a query.
 *
 * The API exposes graph structure per memory (`inspect` → `entities` + `edges`);
 * there is no whole-graph endpoint yet. So the controller composes the API's own
 * data: one search seeds the memories, then one bounded inspect per result joins in
 * that memory's entities and its edges to the other seeded memories. Edges that
 * point outside the result set are counted, not drawn — the UI never invents the
 * missing node.
 */

import type { ApiClient } from '../../api/client';
import type { MemorySearchResponse } from '../../api/schemas';

/** How many search results get inspected (bounded N+1 — a local-first viewer). */
export const GRAPH_INSPECT_CAP = 12;

export interface GraphNode {
  readonly id: string;
  readonly kind: 'memory' | 'entity';
  /** Memory title/summary or entity name — straight from the API. */
  readonly label: string;
  readonly subtitle: string | null;
  readonly status: string | null;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** The API relation (edge relation vocabulary, or 'mentions' for memory→entity). */
  readonly relation: string;
}

export interface GraphViewModel {
  readonly querySent: string;
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  /** Edges from the API that pointed outside the inspected set (counted only). */
  readonly externalEdgeCount: number;
  /** Memory ids whose inspect failed individually (e.g. purged mid-view). */
  readonly inspectFailures: readonly string[];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

const nodeKey = {
  memory: (id: string) => `memory:${id}`,
  entity: (id: string) => `entity:${id}`,
};

export async function loadGraph(
  api: ApiClient,
  projectId: string,
  query: string,
  fallbackQuery: string,
  cap: number = GRAPH_INSPECT_CAP,
): Promise<GraphViewModel> {
  const querySent = query.trim() || fallbackQuery;
  const search = await api.search(projectId, { query: querySent, explain: true });

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const inspectFailures: string[] = [];
  const seeded = new Set<string>();
  const externalTargets = new Set<string>();

  const seededMemories = search.memories.slice(0, cap);
  for (const memory of seededMemories) {
    seeded.add(memory.id);
    nodes.set(nodeKey.memory(memory.id), {
      id: nodeKey.memory(memory.id),
      kind: 'memory',
      label: memory.title ?? memory.summary,
      subtitle: memory.type,
      status: memory.temporal.status,
    });
  }

  const inspections = await Promise.all(
    seededMemories.map(async (memory) => {
      try {
        return { ok: true as const, memory, inspect: await api.inspect(projectId, memory.id) };
      } catch {
        inspectFailures.push(memory.id);
        return { ok: false as const, memory };
      }
    }),
  );

  for (const result of inspections) {
    if (!result.ok) continue;
    // Memory → entity links ('mentions' is this view's label for the join the API
    // reports — the entity rows themselves come from the inspect response).
    for (const entity of result.inspect.entities) {
      const key = nodeKey.entity(entity.id);
      if (!nodes.has(key)) {
        nodes.set(key, {
          id: key,
          kind: 'entity',
          label: entity.name,
          subtitle: entity.kind,
          status: null,
        });
      }
      edges.push({
        from: nodeKey.memory(result.memory.id),
        to: key,
        relation: 'mentions',
      });
    }
    // Memory → memory edges: only the ones the API reports between seeded memories.
    for (const edge of result.inspect.edges) {
      if (seeded.has(edge.to_memory_id)) {
        edges.push({
          from: nodeKey.memory(edge.from_memory_id),
          to: nodeKey.memory(edge.to_memory_id),
          relation: edge.relation,
        });
      } else {
        externalTargets.add(edge.to_memory_id);
      }
    }
  }

  return {
    querySent,
    nodes: [...nodes.values()],
    edges,
    externalEdgeCount: externalTargets.size,
    inspectFailures,
    tokens: search.tokens,
    warnings: search.warnings,
  };
}
