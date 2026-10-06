/**
 * The shared presentational kit. Every component here renders values that arrive
 * through a controller view-model (API data) — chrome strings (labels, headings)
 * are static; data values are never invented here.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { MemorySearchResponse } from '../api/schemas';

export { AsyncGate } from '../lib/async';

/** The API's own warnings, verbatim. */
export function Warnings({ warnings }: { warnings: readonly string[] }): ReactNode {
  if (warnings.length === 0) return null;
  return (
    <ul className="warnings" aria-label="warnings from the API">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

/** Token budget vs used — the packing meter the retrieval API reports (a feature, not chrome). */
export function TokensMeter({
  tokens,
}: {
  tokens: MemorySearchResponse['tokens'];
}): ReactNode {
  const pct = tokens.budget === 0 ? 0 : Math.round((tokens.used / tokens.budget) * 100);
  return (
    <p className="tokens">
      {tokens.used} / {tokens.budget} tokens used ({pct}%) · packing {tokens.packing}
    </p>
  );
}

/** The per-query score components (`explain`): factor, weight, detail — all from the API. */
export function ExplainList({
  explain,
}: {
  explain: MemorySearchResponse['memories'][number]['explain'];
}): ReactNode {
  if (explain.length === 0) return null;
  return (
    <details className="explain">
      <summary>score components ({explain.length})</summary>
      <ul>
        {explain.map((factor) => (
          <li key={factor.factor}>
            <code>{factor.factor}</code> × {factor.weight} — {factor.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Code refs the memory rests on (M4g2: repo, commit, path, symbol). */
export function CodeRefs({
  codeRefs,
}: {
  codeRefs: MemorySearchResponse['memories'][number]['codeRefs'];
}): ReactNode {
  if (codeRefs.length === 0) return null;
  return (
    <ul className="code-refs">
      {codeRefs.map((ref) => (
        <li key={`${ref.repoId}:${ref.path}`}>
          <code>{ref.path}</code>
          {ref.symbol === undefined ? null : <span> · symbol <code>{ref.symbol}</code></span>}
          <span> · commit <code>{ref.commitSha === '' ? 'no anchor' : ref.commitSha}</code></span>
        </li>
      ))}
    </ul>
  );
}

/** One search result row — the title/summary, status, relevance, provenance, refs, links. */
export function MemoryRow({
  memory,
  projectId,
}: {
  memory: MemorySearchResponse['memories'][number];
  projectId: string;
}): ReactNode {
  const title = memory.title ?? memory.summary;
  return (
    <article className="memory-row">
      <header>
        <h3>
          <Link to={`/memories/${memory.id}`}>{title}</Link>
        </h3>
        <p className="meta">
          <span className="badge badge-type">{memory.type}</span>
          <StatusBadge status={memory.temporal.status} />
          <span>relevance {memory.relevance.toFixed(2)}</span>
          {memory.temporal.valid_until === undefined ? null : (
            <span>valid until {memory.temporal.valid_until}</span>
          )}
          <span>
            source {memory.provenance.source_kind}
            {memory.provenance.source_uri === undefined
              ? null
              : ` (${memory.provenance.source_uri})`}
          </span>
        </p>
      </header>
      <p className="summary">{memory.summary}</p>
      <CodeRefs codeRefs={memory.codeRefs} />
      {memory.conflicts === undefined || memory.conflicts.length === 0 ? null : (
        <p className="conflicts">
          conflicts: {memory.conflicts.length}
          <ul>
            {memory.conflicts.map((conflict) => (
              <li key={conflict.memory_id}>
                <Link to={`/memories/${conflict.memory_id}`}>{conflict.memory_id}</Link> —{' '}
                {conflict.note}
              </li>
            ))}
          </ul>
        </p>
      )}
      <ExplainList explain={memory.explain} />
      <p className="row-links">
        <Link to={`/memories/${memory.id}`}>provenance</Link> ·{' '}
        <Link to={`/memories/${memory.id}/timeline`}>timeline</Link>
      </p>
      <span className="sr-only" data-project-id={projectId} />
    </article>
  );
}

/** An empty state that says what the API returned (zero rows) — never a fake row. */
export function EmptyState({
  message,
}: {
  message: string;
}): ReactNode {
  return <p className="state state-empty">{message}</p>;
}
