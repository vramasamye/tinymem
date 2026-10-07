/**
 * Extraction → STORE mapping. Both extractor paths use this same event-backed mapping.
 * Never reconstruct metadata from candidate content, subtype or evidence excerpts.
 */
import {
  DecisionStorePayloadSchema,
  FailureStorePayloadSchema,
  type ExtractedMemory,
  type NewMemoryPayload,
} from '@onememory-ai/core';

import type { NormalizedEvent } from '../events';
import { createFailureSignature, failureIncidentOf } from './failure';

/** Require a factual association, not merely "some later event succeeded". */
function recoveryFor(failure: NormalizedEvent, success: NormalizedEvent): boolean {
  if (Date.parse(success.occurred_at) <= Date.parse(failure.occurred_at)) return false;
  if (failure.session_id !== success.session_id) return false;
  if (success.command?.exit_code === 0) {
    if (failure.command) return failure.command.text.trim() === success.command.text.trim();
    // Error contexts may append a location ("<command> in <path>"), but a mere prefix
    // match would incorrectly accept a different command with extra arguments.
    const command = success.command.text.trim();
    const context = (failure.error?.context ?? '').trim().replace(/^codex:\s*/i, '');
    const contextCommand = context
      .replace(/\s+in\s+(?=[./~]|[\w.-]+\/)[\w.@~/-]+$/, '')
      .trim();
    return command.length > 0 && contextCommand === command;
  }
  if (success.tests && success.tests.failed === 0 && success.tests.passed > 0) {
    return failure.tests?.framework !== undefined &&
      failure.tests.framework === success.tests.framework;
  }
  return failure.tool_result?.tool !== undefined &&
    failure.tool_result.ok === false && success.tool_result?.ok === true &&
    failure.tool_result.tool === success.tool_result.tool;
}

export function storePayloadFor(
  candidate: ExtractedMemory,
  events: readonly NormalizedEvent[],
  observedAt: string,
): NewMemoryPayload | undefined {
  if (candidate.type === 'decision' && candidate.decision_payload) {
    const p = candidate.decision_payload;
    return DecisionStorePayloadSchema.parse({
      title: candidate.title?.trim() || p.decision,
      decision: p.decision,
      alternatives: p.alternatives,
      ...(p.rationale === undefined ? {} : { rationale: p.rationale }),
      participants: [], // No participant identity is extracted by either path.
      decided_at: observedAt,
      status: 'proposed', // Not memories.status; promotion is consolidation work.
    });
  }
  if (candidate.type !== 'failure' || !candidate.failure_signature) return undefined;
  const cited = events.filter((event) => candidate.evidence.some((span) =>
    span.source_id === event.source_id && span.locator === `event:${event.event_id}`,
  )).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const signature = candidate.failure_signature;
  const failure = cited.find((event) => {
    const incident = failureIncidentOf(event);
    return incident !== undefined && createFailureSignature(incident).hash === signature.hash;
  });
  if (!failure) return undefined;
  const incident = failureIncidentOf(failure)!;
  const success = cited.find((event) => recoveryFor(failure, event));
  let solution: string | undefined;
  let verification: string | undefined;
  if (success?.command) {
    solution = `Successful retry: ${success.command.text}`;
    verification = `Command ${success.command.text} exited 0` +
      (success.command.output_digest?.trim() ? `: ${success.command.output_digest}` : '');
  } else if (success?.tests) {
    solution = `Successful ${success.tests.framework} test rerun`;
    verification = `${success.tests.framework}: ${success.tests.passed} passed, 0 failed`;
  } else if (success?.tool_result) {
    solution = `Observed successful ${success.tool_result.tool} call`;
    verification = `Tool ${success.tool_result.tool} reported ok: true` +
      (success.tool_result.output_digest.trim() ? `: ${success.tool_result.output_digest}` : '');
  }
  return FailureStorePayloadSchema.parse({
    problem: incident.label,
    // The existing text column holds canonical structured context, including the fingerprint
    // inputs. Only observed fields are present; no made-up environment, versions or root cause.
    context: JSON.stringify({
      type: signature.type,
      normalized_message: signature.normalized_message,
      origin: signature.origin,
      ...(signature.error_origin === undefined ? {} : { error_origin: signature.error_origin }),
      ...(signature.tool === undefined ? {} : { tool: signature.tool }),
      ...(signature.command === undefined ? {} : { command: signature.command }),
      ...(failure.error?.context === undefined ? {} : { detail: failure.error.context }),
    }),
    ...(solution === undefined ? {} : { solution }),
    ...(verification === undefined ? {} : { verification }),
    // Same tool name alone does not prove the original operation was repaired. Record its
    // observed success as mitigation, not a verified fix (call/argument correlation is deferred).
    status: success === undefined ? 'open' : success.tool_result ? 'mitigated' : 'verified',
    signature_hash: signature.hash,
    first_seen_at: failure.occurred_at,
    last_seen_at: failure.occurred_at,
    occurrence_count: 1,
  });
}
