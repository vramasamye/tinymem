/**
 * Output plumbing for the CLI.
 *
 * Every command prints human text by default; with `--json` it prints exactly one JSON document
 * on stdout instead (stderr stays free for warnings and prompts), so scripts and agents can
 * consume the output deterministically. No ANSI colours: the output is read by agents and diffed
 * by tests.
 *
 * Commands call BOTH `io.out(...)` (human lines) and `io.emit(value)` (the machine document);
 * exactly one of them writes, chosen by the mode — no `if (json)` branching inside commands.
 */

export interface Io {
  /** Emit a human line (no-op in `--json` mode). */
  out(text: string): void;
  /** Emit a blank human line (no-op in `--json` mode). */
  blank(): void;
  /** Emit a warning to stderr (always written). */
  err(text: string): void;
  /** Emit the machine document (no-op unless `--json`). */
  emit(value: unknown): void;
  /** `--json` was requested. */
  readonly json: boolean;
  /** stdin is interactive (init prompts only when this is true). */
  readonly interactive: boolean;
}

export interface IoOptions {
  /** Injected stdout writer (tests capture it). */
  write?: (text: string) => void;
  /** Injected stderr writer (tests capture it). */
  writeErr?: (text: string) => void;
  json?: boolean;
  interactive?: boolean;
}

export function createIo(options: IoOptions = {}): Io {
  const json = options.json === true;
  const write = options.write ?? ((text: string): void => {
    process.stdout.write(text);
  });
  const writeErr = options.writeErr ?? ((text: string): void => {
    process.stderr.write(text);
  });
  return {
    out: json ? () => {} : (text: string): void => write(`${text}\n`),
    blank: json ? () => {} : (): void => write('\n'),
    err: (text: string): void => writeErr(`${text}\n`),
    emit: json ? (value: unknown): void => write(`${JSON.stringify(value, null, 2)}\n`) : () => {},
    json,
    interactive: options.interactive ?? process.stdin.isTTY === true,
  };
}

/** Format a timestamp compactly (`2026-10-01 12:00`) without pulling in a date library. */
export function shortDate(iso: string | undefined | null): string {
  if (iso === undefined || iso === null || iso === '') return '-';
  return iso.slice(0, 19).replace('T', ' ');
}
