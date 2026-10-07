/**
 * The Markdown export surface (ADR-0013) — the pure renderer from store records to the file set
 * `onemem export` writes.
 *
 * The canonical-store rule: the database is the single source of truth; this projection is
 * one-way and no engine path ever reads it back. Determinism is the contract — stable sort, no
 * wall-clock, no run metadata — so a re-render over unchanged data is byte-identical and the
 * export service can own (and prune) exactly the files it writes: every file carries the
 * ownership marker.
 *
 * Layout (ADR-0013 §2): `MEMORY.md` (the capped session index: digest sections + an index of
 * links), one per-type index file (`episodic.md` … `failures.md`), and one
 * `memories/<type>/<id>.md` per durable memory with frontmatter provenance, payload sections,
 * and evidence excerpts. `working` rows never export (they are not durable); every durable
 * status does, so history stays diffable.
 *
 * The index cap (ADR-0013 §4) follows the Claude Code auto-memory discipline: at most
 * {@link EXPORT_MEMORY_INDEX_LINE_CAP} lines and {@link EXPORT_MEMORY_INDEX_BYTE_CAP} bytes. The
 * renderer keeps it under the caps by construction — sections trim procedures first, then
 * failures, then decisions, each replaced by one visible overflow line — and fails closed
 * ({@link ExportCapExceededError}) when even the trimmed skeleton cannot fit.
 */

import { PROJECT_DIGEST_ENTRY_KEY } from './digest';
import type { MemoryRecord } from '../schema/memory';

/** The ownership marker every exported file carries (the service prunes only marked files). */
export const EXPORT_OWNERSHIP_MARKER = 'onememory-export: true';

/** The Claude Code auto-memory load limit the MEMORY.md index respects (ADR-0013 §4). */
export const EXPORT_MEMORY_INDEX_LINE_CAP = 200;

/** 25KB — the byte half of the same load limit. */
export const EXPORT_MEMORY_INDEX_BYTE_CAP = 25_600;

const INDEX_EXPLAINER =
  'Read-only projection of the onememory store — the store is canonical and `onemem export` regenerates this tree.';

/** Fail-closed: the index cannot be emitted under its cap even after trimming every section. */
export class ExportCapExceededError extends Error {
  constructor(detail: string) {
    super(`the MEMORY.md index cannot fit the export cap even after trimming: ${detail}`);
    this.name = 'ExportCapExceededError';
  }
}

/** One file of the export tree, path relative to the export root. */
export interface ExportFile {
  readonly path: string;
  readonly content: string;
}

/** Everything the renderer needs: the project's digest rollup and its hydrated durable rows. */
export interface ProjectExportInput {
  /** The project's name (the index header anchors the export in its project). */
  project_name: string | null;
  /** The stored `projects.digest` rollup (loose JSONB: `summary`, `stack`, `decision_NN`, …). */
  digest: Readonly<Record<string, unknown>> | null;
  /** Every durable memory of the project, hydrated (provenance + payload), in any order. */
  memories: readonly MemoryRecord[];
}

/** The durable content types, in index order (working memory is not durable and never exports). */
const DURABLE_TYPE_ORDER = ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference'] as const;
type DurableType = (typeof DURABLE_TYPE_ORDER)[number];

/** The per-type index file base names (ADR-0013 §2). */
const TYPE_FILE_BASE: Record<DurableType, string> = {
  episodic: 'episodic',
  semantic: 'semantic',
  procedural: 'procedural',
  decision: 'decisions',
  failure: 'failures',
  preference: 'preferences',
};

/** Status sections render in lifecycle order (memory-model.md §4). */
const STATUS_ORDER = ['active', 'stale', 'superseded', 'disputed', 'archived'] as const;

const encoder = new TextEncoder();

type DurableMemory = MemoryRecord & { type: DurableType };

function isDurableType(type: MemoryRecord['type']): type is DurableType {
  return (DURABLE_TYPE_ORDER as readonly string[]).includes(type);
}

/** Stable sort: type order, then status order, then newest-observed first, then id. */
function compareMemories(a: DurableMemory, b: DurableMemory): number {
  const typeDelta = DURABLE_TYPE_ORDER.indexOf(a.type) - DURABLE_TYPE_ORDER.indexOf(b.type);
  if (typeDelta !== 0) return typeDelta;
  const statusDelta = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (statusDelta !== 0) return statusDelta;
  if (a.observed_at !== b.observed_at) return a.observed_at < b.observed_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function memoryFilePath(memory: DurableMemory): string {
  return `memories/${memory.type}/${memory.id}.md`;
}

/** The link/h1 label: title, else summary, else the first content line — bracket-safe, ≤80 chars. */
function labelOf(memory: MemoryRecord): string {
  const raw = (memory.title ?? memory.content_summary ?? memory.content.split('\n')[0] ?? '').slice(0, 80);
  return raw.replace(/\[/g, '(').replace(/\]/g, ')');
}

/** Quote a frontmatter scalar only when YAML needs it (deterministic, no run metadata). */
function yamlScalar(value: string): string {
  if (value !== '' && !value.includes(':') && /^[\w][\w ,./@+-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The stored digest rollup split into renderable lines: `summary`, `stack`, owned `*_NN` entries. */
function digestRenderOf(digest: Readonly<Record<string, unknown>> | null): {
  summary: string | null;
  stack: string | null;
  decisions: string[];
  failures: string[];
  procedures: string[];
} {
  const buckets: Record<'decision' | 'failure' | 'procedure', Array<[number, string]>> = {
    decision: [],
    failure: [],
    procedure: [],
  };
  let summary: string | null = null;
  let stack: string | null = null;
  for (const [key, value] of Object.entries(digest ?? {})) {
    const match = PROJECT_DIGEST_ENTRY_KEY.exec(key);
    if (match !== null && typeof value === 'string') {
      buckets[match[1] as 'decision' | 'failure' | 'procedure'].push([Number(match[2]), value]);
    } else if (key === 'summary' && typeof value === 'string') {
      summary = value;
    } else if (key === 'stack' && Array.isArray(value)) {
      stack = value.filter((entry): entry is string => typeof entry === 'string').join(', ');
    }
  }
  const lines = (bucket: Array<[number, string]>): string[] =>
    bucket.sort((a, b) => a[0] - b[0]).map(([, text]) => text);
  return {
    summary,
    stack,
    decisions: lines(buckets.decision),
    failures: lines(buckets.failure),
    procedures: lines(buckets.procedure),
  };
}

function renderMemoryIndex(
  projectName: string | null,
  digest: Readonly<Record<string, unknown>> | null,
  sorted: readonly DurableMemory[],
): string {
  const render = digestRenderOf(digest);
  const sections = [
    { heading: 'Settled decisions', entries: [...render.decisions], link: 'decisions', file: 'decisions.md', overflow: 0 },
    { heading: 'Known failures', entries: [...render.failures], link: 'failures', file: 'failures.md', overflow: 0 },
    { heading: 'Procedures', entries: [...render.procedures], link: 'procedures', file: 'procedural.md', overflow: 0 },
  ];

  const build = (): string => {
    const lines: string[] = [
      '---',
      EXPORT_OWNERSHIP_MARKER,
      'type: memory-index',
      '---',
      `# ${projectName ?? 'project'} memory`,
      '',
      INDEX_EXPLAINER,
      '',
    ];
    if (render.summary !== null || render.stack !== null) {
      lines.push('## Project');
      if (render.summary !== null) lines.push(`summary: ${render.summary}`);
      if (render.stack !== null) lines.push(`stack: ${render.stack}`);
      lines.push('');
    }
    for (const section of sections) {
      if (section.entries.length === 0 && section.overflow === 0) continue;
      lines.push(`## ${section.heading}`);
      for (const entry of section.entries) lines.push(`- ${entry}`);
      if (section.overflow > 0) lines.push(`(+${section.overflow} more, see [${section.link}](${section.file}))`);
      lines.push('');
    }
    if (sorted.length > 0) {
      lines.push('## Index');
      for (const type of DURABLE_TYPE_ORDER) {
        const count = sorted.filter((memory) => memory.type === type).length;
        if (count > 0) lines.push(`- [${TYPE_FILE_BASE[type]} (${count})](${TYPE_FILE_BASE[type]}.md)`);
      }
      lines.push('');
    }
    return `${lines.join('\n')}\n`;
  };

  for (;;) {
    const text = build();
    if (
      text.split('\n').length <= EXPORT_MEMORY_INDEX_LINE_CAP &&
      encoder.encode(text).length <= EXPORT_MEMORY_INDEX_BYTE_CAP
    ) {
      return text;
    }
    // Trim procedures first, then failures, then decisions (ADR-0013 §4); fail closed when
    // nothing is left to trim and the skeleton still cannot fit.
    const target = [2, 1, 0].find((index) => sections[index]!.entries.length > 0);
    if (target === undefined) {
      throw new ExportCapExceededError(`${text.split('\n').length} lines / ${encoder.encode(text).length} bytes`);
    }
    sections[target]!.entries.pop();
    sections[target]!.overflow += 1;
  }
}

function renderTypeIndex(type: DurableType, memories: readonly DurableMemory[]): string {
  const lines: string[] = [
    '---',
    EXPORT_OWNERSHIP_MARKER,
    'type: memory-type-index',
    `memory-type: ${type}`,
    '---',
    `# ${TYPE_FILE_BASE[type]}`,
    '',
  ];
  for (const status of STATUS_ORDER) {
    const ofStatus = memories.filter((memory) => memory.status === status);
    if (ofStatus.length === 0) continue;
    lines.push(`## ${status[0]!.toUpperCase()}${status.slice(1)}`);
    for (const memory of ofStatus) {
      lines.push(`- [${labelOf(memory)}](${memoryFilePath(memory)}) [status: ${memory.status}; observed: ${memory.observed_at.slice(0, 10)}]`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** Payload sections: decision / failure / skill payloads hydrate through the owning memory read. */
function appendPayloadSections(lines: string[], payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  const section = (heading: string, body: unknown): void => {
    if (typeof body !== 'string' || body === '') return;
    lines.push(`## ${heading}`, '', body, '');
  };
  const bullets = (heading: string, entries: unknown): void => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    lines.push(`## ${heading}`, '');
    for (const entry of entries) if (typeof entry === 'string') lines.push(`- ${entry}`);
    lines.push('');
  };

  if (typeof record.decision === 'string') {
    section('Decision', record.decision);
    bullets('Alternatives', record.alternatives);
    section('Rationale', record.rationale);
    bullets('Participants', record.participants);
    section('Status', record.status);
  } else if (typeof record.problem === 'string') {
    section('Problem', record.problem);
    section('Context', record.context);
    section('Root cause', record.root_cause);
    section('Solution', record.solution);
    section('Verification', record.verification);
    section('Status', record.status);
    if (typeof record.occurrence_count === 'number') {
      lines.push('## Occurrences', '', String(record.occurrence_count), '');
    }
  } else if (typeof record.name === 'string' && typeof record.path === 'string') {
    const version = typeof record.version === 'string' ? ` v${record.version}` : '';
    section('Skill', `${record.name}${version} — ${typeof record.description === 'string' ? record.description : ''}`);
    lines.push(`artifact: ${record.path}`, '');
  }
}

function renderMemoryFile(memory: DurableMemory): string {
  const fields: Array<[string, string]> = [
    ['id', memory.id],
    ['type', memory.type],
  ];
  if (memory.subtype !== undefined) fields.push(['subtype', yamlScalar(memory.subtype)]);
  fields.push(['status', memory.status]);
  if (memory.title !== undefined) fields.push(['title', yamlScalar(memory.title)]);
  fields.push(['importance', String(memory.importance)]);
  fields.push(['confidence', String(memory.confidence)]);
  fields.push(['observed', yamlScalar(memory.observed_at)]);
  fields.push(['valid_from', yamlScalar(memory.valid_from)]);
  if (memory.valid_until !== undefined) fields.push(['valid_until', yamlScalar(memory.valid_until)]);
  if (memory.superseded_by !== undefined) fields.push(['superseded_by', memory.superseded_by]);
  if (memory.agent_id !== undefined) fields.push(['agent', yamlScalar(memory.agent_id)]);
  if (memory.tags.length > 0) fields.push(['tags', yamlScalar(memory.tags.join(', '))]);
  fields.push([
    'source',
    yamlScalar(memory.provenance.source.uri ?? memory.provenance.source.title ?? memory.provenance.source.kind),
  ]);

  const lines: string[] = [
    '---',
    EXPORT_OWNERSHIP_MARKER,
    ...fields.map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
    `# ${labelOf(memory)}`,
    '',
    ...memory.content.split('\n'),
    '',
  ];
  appendPayloadSections(lines, memory.payload);
  if (memory.provenance.evidence.length > 0) {
    lines.push('## Evidence', '');
    for (const span of memory.provenance.evidence) {
      lines.push(`- "${span.excerpt}" (${span.kind}, ${span.locator})`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render the whole export tree: `MEMORY.md`, one index per non-empty type, one file per durable
 * memory — output sorted by path, byte-identical across renders over the same data.
 */
export function renderProjectExport(input: ProjectExportInput): ExportFile[] {
  const durable: DurableMemory[] = input.memories.filter((memory): memory is DurableMemory =>
    isDurableType(memory.type),
  );
  const sorted = [...durable].sort(compareMemories);

  const files: ExportFile[] = [
    { path: 'MEMORY.md', content: renderMemoryIndex(input.project_name, input.digest, sorted) },
  ];
  for (const type of DURABLE_TYPE_ORDER) {
    const ofType = sorted.filter((memory) => memory.type === type);
    if (ofType.length > 0) files.push({ path: `${TYPE_FILE_BASE[type]}.md`, content: renderTypeIndex(type, ofType) });
  }
  for (const memory of sorted) files.push({ path: memoryFilePath(memory), content: renderMemoryFile(memory) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}
