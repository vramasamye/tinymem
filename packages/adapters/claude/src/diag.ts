/**
 * Machine-readable stderr diagnostics for hook scripts.
 *
 * Claude Code's contract (hooks reference, "Exit code output"): stderr from a hook that exits 0
 * goes to the debug log only — never the transcript, never Claude. So stderr is exactly where
 * bounded, machine-readable failure diagnostics belong. The one-liner carries REASONS AND COUNTS
 * ONLY — never payload contents (command text, transcripts, error strings), which stay inside the
 * events delivered to the daemon.
 */

export interface DiagRecord {
  /** Hook event name (when the payload parsed). */
  event?: string;
  /** What the hook did: delivered | skipped | failed | no_events. */
  outcome: 'delivered' | 'skipped' | 'failed' | 'no_events';
  /** Stable reason code for skipped/failed. */
  reason?: string;
  [key: string]: unknown;
}

export interface DiagSink {
  write(text: string): void;
}

const stderrSink: DiagSink = { write: (text) => process.stderr.write(text) };

/** Emit ONE JSON line. Never throws (a diagnostics failure must never kill the hook). */
export function emitDiag(record: DiagRecord, sink: DiagSink = stderrSink): void {
  const line = JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    component: 'onemem-claude-hook',
    ...record,
  });
  try {
    sink.write(`${line}\n`);
  } catch {
    // Swallow: diagnostics are best-effort by definition.
  }
}
