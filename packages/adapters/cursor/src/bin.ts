#!/usr/bin/env bun
/**
 * `onemem-cursor-hook` — the Cursor hook binary.
 *
 * Cursor invokes it per subscribed hook event (`.cursor/hooks.json`), delivering the event JSON on
 * stdin; the event name arrives IN the payload (`hook_event_name`), so one bin serves every
 * subscribed event. `sessionStart` additionally writes the documented context-injection object on
 * stdout (`{"additional_context": "…"}`); every other event writes nothing to stdout.
 *
 * The process ALWAYS exits 0 — a hook must never block or fail the agent, and exit code 2 is
 * Cursor's BLOCKING signal (hooks reference, "Exit code behavior"), which onememory never emits.
 * Diagnostics are one machine-readable stderr line.
 */

import { isMainModule } from '@onememory/core';

import { runHook } from './hook-bin';

async function readAllStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let joined = '';
  for await (const chunk of process.stdin) {
    joined += decoder.decode(chunk as Uint8Array, { stream: true });
  }
  return joined + decoder.decode();
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    const text = await readAllStdin();
    input = text.trim().length === 0 ? null : JSON.parse(text);
  } catch {
    input = null; // unparseable stdin → the skipped diagnostic inside runHook, never a crash
  }
  await runHook(input, {});
}

if (isMainModule(import.meta.url)) {
  main()
    .catch(() => {
      // Last-resort guard: a hook NEVER fails the agent.
      process.exit(0);
    })
    .then(() => process.exit(0));
}
