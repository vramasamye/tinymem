/**
 * The shared CLI test harness: run `main()` non-interactively with the process seam captured
 * (stdout, stderr, exit code — never `process.exit`), plus the JSON-document helper every
 * `--json` assertion needs. Previously each test file carried its own copy; new test files
 * import this one (per-file copies retire as their owning missions touch them).
 */

import { main } from './bin';

/** Captured process seam: everything `main()` printed, split by stream, plus the exit code. */
export interface Captured {
  out: string;
  err: string;
  exitCode: number;
}

/** Run `main(argv)` non-interactively with both write streams captured. */
export async function runMain(argv: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  const exitCode = await main(argv, {
    interactive: false,
    env: {},
    write: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err, exitCode };
}

/** Parse the single JSON document a `--json` command printed. */
export function jsonOf(captured: Captured): any {
  return JSON.parse(captured.out);
}
