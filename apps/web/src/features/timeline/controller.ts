/**
 * The timeline surface: one memory's status history. The API exposes status history
 * per memory (`GET /v1/projects/:id/memories/:memoryId` → `audit`, the `memory_events`
 * rows, plus `history`, the supersession chain) — there is no project-wide event
 * stream yet; that gap is a coordinator follow-up, not a client-side invention.
 */

import type { ApiClient } from '../../api/client';
import type { InspectResponse } from '../../api/schemas';

export interface TimelineViewModel {
  readonly memoryId: string;
  /** Title from the memory record (or its content summary — both API fields). */
  readonly label: string;
  readonly currentStatus: string;
  /** The append-only audit trail, oldest first — exactly the API's order. */
  readonly audit: InspectResponse['audit'];
  /** The supersession chain, oldest first (includes the memory itself). */
  readonly history: InspectResponse['history'];
  readonly entities: InspectResponse['entities'];
  readonly warnings: InspectResponse['warnings'];
}

export async function loadTimeline(
  api: ApiClient,
  projectId: string,
  memoryId: string,
): Promise<TimelineViewModel> {
  const inspect = await api.inspect(projectId, memoryId);
  return {
    memoryId: inspect.memory.id,
    label: inspect.memory.title ?? inspect.memory.content_summary ?? inspect.memory.content,
    currentStatus: inspect.memory.status,
    audit: inspect.audit,
    history: inspect.history,
    entities: inspect.entities,
    warnings: inspect.warnings,
  };
}
