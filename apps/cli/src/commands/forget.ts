/**
 * `onemem forget <id>` / `onemem restore <id>` — the audited status transition, never a deletion
 * (memory-model.md §4: forget ≠ delete). The CLI prints the undo path for every forget, so a
 * wrong forget is always reversible from the same surface.
 */

import { describeResolution, resolveBackend, type ResolveOptions } from '../resolve';
import type { Io } from '../io';
import type { ForgetOutcome } from '@onememory/api/runtime';

export interface ForgetOptions extends ResolveOptions {
  memoryId: string;
  reason?: string;
}

export async function runForget(options: ForgetOptions, io: Io): Promise<number> {
  const resolved = await resolveBackend(options);
  try {
    const outcome = await resolved.backend.forget({
      project_id: resolved.projectId,
      memory_id: options.memoryId,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit(outcome);
    printTransition(io, 'forgot', outcome);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export async function runRestore(options: ForgetOptions, io: Io): Promise<number> {
  const resolved = await resolveBackend(options);
  try {
    const outcome = await resolved.backend.restore({
      project_id: resolved.projectId,
      memory_id: options.memoryId,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (resolved.mode === 'local') io.err(`note: ${describeResolution(resolved)}`);
    io.emit(outcome);
    printTransition(io, 'restored', outcome);
    return 0;
  } finally {
    await resolved.backend.close();
  }
}

export function printTransition(io: Io, verb: 'forgot' | 'restored', outcome: ForgetOutcome): void {
  io.out(`${verb} ${outcome.memory_id} (${outcome.from_status} → ${outcome.to_status})`);
  io.out(`  ${outcome.note}`);
  if (outcome.restore_hint !== '') io.out(`  undo: ${outcome.restore_hint}`);
  io.out(`  ${outcome.purge_hint}`);
}
