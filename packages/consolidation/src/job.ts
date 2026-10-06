/**
 * The `consolidate` / `decay` job payloads (memory-model.md §8 stages 12–14) — the daemon's
 * scheduled form of the CONSOLIDATE and DECAY lifecycle stages.
 *
 * `JOB_KINDS` declares both kinds, but until now nothing enqueued or handled them: an enqueued
 * job would dead-letter with `JobKindNotImplemented`. The composition root registers a handler
 * for each kind; both take this payload, and both drive the same idempotent
 * {@link runConsolidation} entry — `consolidate` runs all four passes, `decay` restricts the run
 * to the terminal decay/archive stage.
 *
 * The payload is validated at the worker boundary (Zod) like every external input: a malformed
 * payload fails the job loudly rather than running a pass over the wrong scope.
 */

import { jobPayloadFields } from '@onememory/core';
import { z } from 'zod';

/** The `consolidate` / `decay` job payload (strict — the worker boundary validates external input). */
export const ConsolidationJobPayloadSchema = z.strictObject({
  /** The project whose pool the pass runs over. Always explicit: a scheduled pass is never unscoped. */
  project_id: z.uuid(),
  /** Audit actor override (the REST route records the calling surface); default `job:consolidate`. */
  actor: z.string().min(1).max(120).optional(),
});
export type ConsolidationJobPayload = z.infer<typeof ConsolidationJobPayloadSchema>;

/** Parse a `consolidate` / `decay` job payload (throws on malformed input, like every job boundary). */
export function parseConsolidationJobPayload(payload: Record<string, unknown>): ConsolidationJobPayload {
  // `jobPayloadFields` drops the queue's own `key` (stored inside the payload JSON by `enqueue`).
  return ConsolidationJobPayloadSchema.parse(jobPayloadFields(payload));
}
