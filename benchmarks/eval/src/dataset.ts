/**
 * Golden-dataset schema + loader (backlog M11.1).
 *
 * A dataset is committed JSON: projects, session events (the real `OnememoryEvent` envelope is
 * built from these), the explicit supersessions the engine supports today (M14 automates
 * detection), and the query expectations each metric is computed from.
 *
 * Expected memories are referenced indirectly by a stable `fact` key with a matcher, never by
 * generated uuid — memory ids are uuidv7 and differ on every run. The harness resolves keys to
 * ids after extraction and fails loudly when a key resolves to zero or more than one memory, so a
 * silently-broken fixture cannot quietly shrink the benchmark.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MEMORY_TYPES } from '@onememory/core';
import { z } from 'zod';

/** Reserved project key: events scoped to it are user-global (`project_id IS NULL`). */
export const GLOBAL_PROJECT_KEY = 'global';

/** The committed golden datasets, resolved from this package (`benchmarks/datasets/golden`). */
export const GOLDEN_DATASETS_DIR = resolve(import.meta.dir, '..', '..', 'datasets', 'golden');

const ProjectFixtureSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9-]+$/, 'project keys are kebab-case'),
  name: z.string().min(1),
  description: z.string().optional(),
});

const EventFixtureSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('conversation.message'),
    project: z.string(),
    session: z.string().default('sess-main'),
    offset_seconds: z.number().int().min(0),
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('terminal.output'),
    project: z.string(),
    session: z.string().default('sess-main'),
    offset_seconds: z.number().int().min(0),
    command: z.string().min(1),
    exit_code: z.number().int().nullable(),
    output_digest: z.string().default(''),
  }),
  z.strictObject({
    kind: z.literal('error.raised'),
    project: z.string(),
    session: z.string().default('sess-main'),
    offset_seconds: z.number().int().min(0),
    origin: z.enum(['build', 'runtime', 'test', 'tool']),
    message: z.string().min(1),
    context: z.string().default(''),
  }),
]);

/** How one expected memory is found in the corpus after extraction. */
const MemoryMatcherSchema = z
  .strictObject({
    type: z.enum(MEMORY_TYPES).optional(),
    subtype: z.string().min(1).optional(),
    project: z.string().optional(),
    content_equals: z.string().min(1).optional(),
    content_contains: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      value.content_equals !== undefined ||
      value.content_contains !== undefined ||
      value.subtype !== undefined,
    { message: 'a matcher needs content_equals, content_contains or subtype' },
  );

const FactSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9-]+$/, 'fact keys are kebab-case'),
  /** One-line human description for the report. */
  description: z.string().min(1),
  match: MemoryMatcherSchema,
  /** M11.1 scenario bucket, surfaced in the report. */
  scenario: z.enum([
    'repeated',
    'contradictory',
    'outdated',
    'project-scoped',
    'cross-project',
    'procedural',
    'failure-solution',
    'other',
  ]),
});

const SupersessionFixtureSchema = z.strictObject({
  /** Content matcher of the memory that is replaced (must resolve to exactly one memory). */
  loser: MemoryMatcherSchema,
  /** Content matcher of the memory that replaces it (must resolve to exactly one memory). */
  winner: MemoryMatcherSchema,
  reason: z.string().min(1),
});

const QueryFixtureSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Omitted = unscoped (all projects); {@link GLOBAL_PROJECT_KEY} is not valid here. */
  project: z.string().optional(),
  query: z.string().min(1),
  max_tokens: z.number().int().min(1).default(800),
  max_memories: z.number().int().min(1).optional(),
  as_of: z.iso.datetime().optional(),
  temporal_mode: z.enum(['current', 'historical']).optional(),
  /** Fact keys that MUST appear in the results. */
  expected: z.array(z.string()).default([]),
  /** Fact keys that must NOT appear in the results (pollution / outdated-truth probes). */
  forbidden: z.array(z.string()).default([]),
  /** Which metric bucket this query feeds. */
  kind: z.enum(['retrieval', 'temporal', 'pollution']).default('retrieval'),
});

const ContradictionGroupSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  query: z.string().min(1),
  project: z.string(),
  /** The fact that should win under memory-model.md §9 authority rules. */
  authority: z.string(),
  /** The fact(s) it contradicts. */
  contradicted: z.array(z.string()).min(1),
  note: z.string().optional(),
});

const ConsolidationGroupSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** How many observations of the same concept the fixture contains. */
  observations: z.number().int().min(2),
  /** Fact keys describing the same concept (each resolves to exactly one memory). */
  facts: z.array(z.string()).min(2),
  note: z.string().optional(),
});

export const GoldenDatasetSchema = z.strictObject({
  schema_version: z.literal('1'),
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Wall-clock anchor every event's `offset_seconds` is measured from. */
  base_time: z.iso.datetime(),
  /** Deterministic engine clock (recency scoring + temporal `now`). Must be after `base_time`. */
  now: z.iso.datetime(),
  projects: z.array(ProjectFixtureSchema).min(1),
  events: z.array(EventFixtureSchema).min(1),
  supersessions: z.array(SupersessionFixtureSchema).default([]),
  facts: z.array(FactSchema).min(1),
  queries: z.array(QueryFixtureSchema).min(1),
  contradictions: z.array(ContradictionGroupSchema).default([]),
  consolidation: z.array(ConsolidationGroupSchema).default([]),
});

export type GoldenDataset = z.infer<typeof GoldenDatasetSchema>;
export type DatasetFact = z.infer<typeof FactSchema>;
export type DatasetQuery = z.infer<typeof QueryFixtureSchema>;
export type DatasetEvent = z.infer<typeof EventFixtureSchema>;
export type MemoryMatcher = z.infer<typeof MemoryMatcherSchema>;
export type SupersessionFixture = z.infer<typeof SupersessionFixtureSchema>;
export type ContradictionGroup = z.infer<typeof ContradictionGroupSchema>;
export type ConsolidationGroup = z.infer<typeof ConsolidationGroupSchema>;

/** Parse and validate one dataset document, reporting the JSON path of every issue. */
export function parseDataset(raw: unknown, source = '<inline>'): GoldenDataset {
  const result = GoldenDatasetSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`dataset ${source} failed validation: ${issues}`);
  }
  return validateReferences(result.data, source);
}

/** Cross-field checks Zod cannot express: keys must exist and queries must be answerable. */
function validateReferences(dataset: GoldenDataset, source: string): GoldenDataset {
  const projectKeys = new Set(dataset.projects.map((project) => project.key));
  projectKeys.add(GLOBAL_PROJECT_KEY);
  const factKeys = new Set(dataset.facts.map((fact) => fact.key));

  const requireProject = (key: string, where: string): void => {
    if (!projectKeys.has(key)) throw new Error(`dataset ${source}: ${where} references unknown project '${key}'`);
  };
  const requireFacts = (keys: readonly string[], where: string): void => {
    for (const key of keys) {
      if (!factKeys.has(key)) throw new Error(`dataset ${source}: ${where} references unknown fact '${key}'`);
    }
  };

  for (const event of dataset.events) requireProject(event.project, `event (${event.kind})`);
  for (const query of dataset.queries) {
    if (query.project !== undefined) requireProject(query.project, `query '${query.id}'`);
    requireFacts(query.expected, `query '${query.id}'.expected`);
    requireFacts(query.forbidden, `query '${query.id}'.forbidden`);
  }
  for (const group of dataset.contradictions) {
    requireProject(group.project, `contradiction '${group.id}'`);
    requireFacts([group.authority, ...group.contradicted], `contradiction '${group.id}'`);
  }
  for (const group of dataset.consolidation) requireFacts(group.facts, `consolidation '${group.id}'`);
  for (const supersession of dataset.supersessions) {
    // matchers are validated structurally; resolution happens against the live corpus
    void supersession;
  }

  const baseMs = Date.parse(dataset.base_time);
  const nowMs = Date.parse(dataset.now);
  if (!(nowMs > baseMs)) {
    throw new Error(`dataset ${source}: now (${dataset.now}) must be after base_time (${dataset.base_time})`);
  }
  for (const event of dataset.events) {
    const at = baseMs + event.offset_seconds * 1000;
    if (at >= nowMs) {
      throw new Error(
        `dataset ${source}: event at offset ${event.offset_seconds}s (${new Date(at).toISOString()}) is not before now (${dataset.now})`,
      );
    }
  }

  const factIds = new Set<string>();
  for (const fact of dataset.facts) {
    if (factIds.has(fact.key)) throw new Error(`dataset ${source}: duplicate fact key '${fact.key}'`);
    factIds.add(fact.key);
  }
  const queryIds = new Set<string>();
  for (const query of dataset.queries) {
    if (queryIds.has(query.id)) throw new Error(`dataset ${source}: duplicate query id '${query.id}'`);
    queryIds.add(query.id);
  }
  return dataset;
}

/** Load every `*.json` in a directory, sorted by id, each validated. */
export async function loadDatasets(directory: string): Promise<GoldenDataset[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const datasets: GoldenDataset[] = [];
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(`dataset ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    datasets.push(parseDataset(raw, file));
  }
  return datasets.sort((a, b) => a.id.localeCompare(b.id));
}
