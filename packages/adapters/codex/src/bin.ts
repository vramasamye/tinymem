#!/usr/bin/env bun
/**
 * `onemem-codex-capture` — the process Codex hooks invoke (and the manual ingest path).
 *
 * Modes:
 *   (stdin)                  a Codex command-hook payload; dispatches on `hook_event_name`.
 *                            SessionStart additionally fetches the packed session context from
 *                            the daemon and prints the `additionalContext` JSON Codex expects
 *                            on stdout (the ONLY thing this bin ever writes to stdout).
 *   --rollout <file>         ingest a Codex rollout/session JSONL (backfill: sessions run before
 *                            the hooks existed, wrapper-driven flows, CI). The rollout format is
 *                            deliberately manual-only: Codex documents that the transcript
 *                            format is not a stable interface, so it is never parsed live.
 *
 * Fail-soft is the contract: no daemon, timeout, bad payload → a one-line stderr diagnostic and
 * EXIT 0. Capture must never block or fail the agent (ADR-0010 §6). Exit 2 is reserved for
 * operator errors (unknown flags, unreadable rollout file) — those are not capture failures.
 *
 * Configuration: `ONEMEMORY_DAEMON_URL` + `ONEMEMORY_PROJECT_ID` env overrides, else discovered
 * from the nearest `.onememory/` walking up (project.json for the id, daemon.json for the URL).
 * Flags: --project <id>, --cwd <dir>, --context-budget <n>, --timeout <ms>.
 */

import { readFileSync } from 'node:fs';

import { isMainModule } from '@onememory/core';

import type { CaptureOutcome } from './capture';

import {
  buildSessionStartOutput,
  captureHook,
  captureRollout,
  deliveryDiagnostic,
  deliverySummary,
} from './capture';

export interface BinArgs {
  rollout?: string;
  project?: string;
  cwd?: string;
  contextBudget?: number;
  timeoutMs?: number;
  help?: boolean;
}

export function parseBinArgs(argv: readonly string[]): BinArgs | { error: string } {
  const args: BinArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    if (arg === '--rollout') {
      if (next === undefined) return { error: '--rollout requires a file path' };
      args.rollout = next;
      index += 1;
    } else if (arg === '--project') {
      if (next === undefined) return { error: '--project requires a project id' };
      args.project = next;
      index += 1;
    } else if (arg === '--cwd') {
      if (next === undefined) return { error: '--cwd requires a directory' };
      args.cwd = next;
      index += 1;
    } else if (arg === '--context-budget') {
      if (next === undefined || !/^\d+$/.test(next)) return { error: '--context-budget requires a positive integer' };
      args.contextBudget = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--timeout') {
      if (next === undefined || !/^\d+$/.test(next)) return { error: '--timeout requires a positive integer (ms)' };
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return args;
}

const USAGE = `onemem-codex-capture — onememory capture hook for OpenAI Codex

Usage:
  onemem-codex-capture                       read a Codex hook payload from stdin
  onemem-codex-capture --rollout <file>      ingest a rollout/session JSONL file
  onemem-codex-capture --project <id>        override the project id
  onemem-codex-capture --cwd <dir>           directory to discover .onememory/ from
  onemem-codex-capture --context-budget <n>  SessionStart context token budget (default 750)
  onemem-codex-capture --timeout <ms>        delivery timeout (default 2500)

Environment: ONEMEMORY_DAEMON_URL + ONEMEMORY_PROJECT_ID override discovery.

Exit codes: 0 for every capture outcome (fail-soft by contract); 2 for usage errors.`;

export async function main(
  argv: readonly string[],
  io: {
    stdin?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    env?: Record<string, string | undefined>;
    /** Working directory for `.onememory` discovery when --cwd is absent (tests inject a sandbox). */
    cwd?: string;
  },
  readStdin: () => Promise<string>,
): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  const env = io.env ?? process.env;

  const parsed = parseBinArgs(argv);
  if ('error' in parsed) {
    err(`onemem-codex-capture: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help === true) {
    err(`${USAGE}\n`);
    return 0;
  }

  const options = {
    cwd: parsed.cwd ?? io.cwd,
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    env: {
      ...env,
      ...(parsed.project === undefined ? {} : { ONEMEMORY_PROJECT_ID: parsed.project }),
    },
  };

  if (parsed.rollout !== undefined) {
    let text: string;
    try {
      text = readFileSync(parsed.rollout, 'utf8');
    } catch (error) {
      err(`onemem-codex-capture: cannot read rollout file: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    const outcome = await captureRollout(text, options);
    report(outcome, err);
    return 0;
  }

  const stdinText = io.stdin !== undefined ? io.stdin : await readStdin();
  if (stdinText.trim().length === 0) {
    err('[onememory] capture skipped (empty-input): the hook payload was empty\n');
    return 0;
  }

  let input: unknown;
  try {
    input = JSON.parse(stdinText);
  } catch {
    err('[onememory] capture skipped (bad-json): the hook payload was not valid JSON\n');
    return 0;
  }

  const eventName = (input as { hook_event_name?: unknown } | null)?.hook_event_name;
  if (eventName === 'SessionStart') {
    const result = await buildSessionStartOutput(input, options, {
      ...(parsed.contextBudget === undefined ? {} : { budget: parsed.contextBudget }),
    });
    report(result.capture, err);
    if (result.output !== null) {
      out(`${JSON.stringify(result.output)}\n`);
    } else if (result.contextText === null) {
      // No daemon or fetch failure — already reported by report(); nothing to inject.
    } else {
      err('[onememory] session context was empty; nothing injected\n');
    }
    return 0;
  }

  const outcome = await captureHook(input, options);
  report(outcome, err);
  return 0;
}

function report(outcome: CaptureOutcome, err: (text: string) => void): void {
  if (outcome.delivery.ok) {
    if (outcome.stored > 0) err(`${deliverySummary(outcome.delivery)}\n`);
  } else {
    err(`${deliveryDiagnostic(outcome.delivery)}\n`);
  }
}

if (isMainModule(import.meta.url)) {
  const readStdin = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    if (process.stdin.isTTY === true) return '';
    for (;;) {
      const { value, done } = await process.stdin[Symbol.asyncIterator]().next().catch(() => ({
        value: undefined as unknown as Buffer,
        done: true,
      }));
      if (done) break;
      if (value !== undefined) chunks.push(value as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  main(process.argv.slice(2), {}, readStdin).then(
    (code) => process.exit(code),
    (error) => {
      // Unreachable in theory (every path is fail-soft); belt-and-suspenders so a bug in this
      // process can never fail the agent: diagnose and exit 0.
      process.stderr.write(
        `[onememory] capture skipped (internal): ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(0);
    },
  );
}
