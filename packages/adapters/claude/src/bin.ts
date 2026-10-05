#!/usr/bin/env bun
/**
 * `onemem-claude-hook` — the Claude Code hook binary.
 *
 * Invoked directly (the settings.json scaffold points hooks at this bin through the published
 * install's `node_modules/.bin/` link), so the shebang is load-bearing: without it the bin link
 * is not executable and every scaffolded hook fails. The file mode must stay 0755 for the same
 * reason (npm preserves it in the published tarball).
 *
 * Claude Code invokes it per hook event (`.claude/settings.json`), delivering the event JSON on
 * stdin; the event name arrives IN the payload (`hook_event_name`), so one bin serves every
 * subscribed event (SessionStart additionally emits the context-injection JSON on stdout). The
 * process ALWAYS exits 0 — a hook must never block or fail the agent (mission-6 fail-soft
 * contract); diagnostics are one machine-readable stderr line, never stdout (except the documented
 * SessionStart `additionalContext` object).
 */

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

if (import.meta.main) {
  main().catch(() => {
    // Last-resort guard: a hook NEVER fails the agent.
    process.exit(0);
  }).then(() => process.exit(0));
}
