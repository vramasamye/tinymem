/**
 * Failure-signature enrichment (M3b): a **stable fingerprint** for a coding failure, computed from
 * error / terminal / test events — the input ADR-0009 rule 1 needs ("failures are fingerprinted
 * (`signature_hash` + embedding of the problem statement)").
 *
 * The signature is deterministic, local, and dependency-free: a normalized error class plus a
 * sha256 digest over the noise-normalized message. Two runs of the same failure that differ only
 * in paths, ports, timings, counts, ANSI colour codes or memory addresses MUST produce the same
 * digest — that stability is the whole point. The normalization rules are documented on
 * `normalizeFailureMessage()` and pinned by tests.
 *
 * What is deliberately *not* in the digest: the failing command/tool. They are recorded next to
 * the digest (`command`, `tool`) but excluded from it, so one root cause reached through different
 * tools collapses into one signature (recurrence, not tool bookkeeping).
 */

import { createHash } from 'node:crypto';

import { FailureSignatureSchema, type FailureSignature } from '@onememory/core';

import type { NormalizedEvent } from '../events';
import { executableOf } from '../heuristic/patterns';

/** Digest salt: bump when normalization changes, so old and new signatures never collide. */
export const FAILURE_SIGNATURE_VERSION = 'failure-v1';

/** `FailureSignature.normalized_message` cap; the digest is computed over the capped form. */
export const MAX_NORMALIZED_MESSAGE = 300;

/** Digest length in hex characters. */
const DIGEST_LENGTH = 16;

/**
 * Ordered error-class rules: **first match wins**, and the order encodes specificity (a
 * `etimedout` is a network failure before it is a timeout). The class names mirror the platform
 * error codes they recognize where one exists (`MODULE_NOT_FOUND`, `EACCES` → `PERMISSION_DENIED`).
 */
const ERROR_CLASS_RULES: ReadonlyArray<{ type: string; pattern: RegExp }> = [
  {
    type: 'NETWORK_ERROR',
    pattern:
      /\b(?:econnrefused|econnreset|econnaborted|etimedout|ehostunreach|enetunreach|eai_again|enotfound|socket\s+hang\s+up|connection\s+refused)\b/,
  },
  {
    type: 'PERMISSION_DENIED',
    pattern: /\b(?:eacces|eperm|permission\s+denied|access\s+denied|operation\s+not\s+permitted)\b/,
  },
  { type: 'FILE_NOT_FOUND', pattern: /\b(?:enoent|no\s+such\s+file\s+or\s+directory)\b/ },
  {
    type: 'MODULE_NOT_FOUND',
    pattern:
      /\b(?:module_not_found|cannot\s+find\s+module|cannot\s+find\s+package|cannot\s+resolve|failed\s+to\s+resolve\s+import|is\s+not\s+exported\s+by|does\s+not\s+provide\s+an\s+export)\b/,
  },
  { type: 'TYPECHECK_ERROR', pattern: /\berror\s+ts\d{3,5}\b/ },
  {
    type: 'SYNTAX_ERROR',
    pattern: /\b(?:syntaxerror|unexpected\s+token|unexpected\s+end\s+of\s+input|unterminated|parse\s+error)\b/,
  },
  { type: 'TYPE_ERROR', pattern: /\btypeerror\b/ },
  { type: 'REFERENCE_ERROR', pattern: /\breferenceerror\b/ },
  { type: 'RANGE_ERROR', pattern: /\brangeerror\b/ },
  {
    type: 'ASSERTION_FAILURE',
    pattern: /\b(?:assertionerror|assertion\s+failed|expected\s+.{0,80}\s+to\s+(?:be|equal|match|contain|throw|have))\b/,
  },
  { type: 'OUT_OF_MEMORY', pattern: /\b(?:out\s+of\s+memory|heap\s+out\s+of\s+memory|javascript\s+heap|\boom\b)\b/ },
  {
    type: 'CONSTRAINT_VIOLATION',
    pattern:
      /\b(?:duplicate\s+key\s+value\s+violates\s+unique\s+constraint|unique\s+constraint|foreign\s+key\s+constraint|null\s+value\s+in\s+column)\b/,
  },
  { type: 'DEADLOCK', pattern: /\bdeadlock\b/ },
  { type: 'TIMEOUT', pattern: /\b(?:timeout|timed\s+out|exceeded\s+.{0,20}time)\b/ },
];

/** Class used when no message rule matched, derived from the event that carried the failure. */
const FALLBACK_CLASS_BY_ORIGIN: Record<string, string> = {
  build: 'BUILD_ERROR',
  test: 'TEST_FAILURE',
  tool: 'TOOL_ERROR',
  terminal: 'COMMAND_FAILURE',
  runtime: 'RUNTIME_ERROR',
};

/** One recognized failure event, in the form the signature is computed from. */
export interface FailureIncident {
  /** Which event kind supplied the signature. */
  origin: 'error' | 'command' | 'test';
  /** Raw text the signature normalizes (error message, command line, or failing test names). */
  message: string;
  /** Human-readable label for the durable `content`. */
  label: string;
  /** `error.raised.origin`, when the incident is an error event. */
  error_origin?: string;
  /** Failing executable, tool name, or test framework. */
  tool?: string;
  /** Normalized failing command (command incidents only). */
  command?: string;
}

/** Tools named in an `error.raised` context (`origin: 'tool'`); keeps only a plausible name. */
function toolFromContext(context: string | undefined): string | undefined {
  const first = context?.trim().split(/[\s:]+/)[0];
  return first !== undefined && /^[A-Za-z][\w.-]{1,63}$/.test(first) ? first : undefined;
}

function testFailureNames(event: NormalizedEvent): string[] {
  return (event.tests?.failure_names ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Recognize a failure incident in a normalized event, or `undefined` when the event is not a
 * failure. This is the single definition of "a failure happened" for the extract stage: an
 * `error.raised`, a command that exited non-zero, or a test run with failing tests.
 */
export function failureIncidentOf(event: NormalizedEvent): FailureIncident | undefined {
  if (event.error) {
    return {
      origin: 'error',
      error_origin: event.error.origin,
      message: event.error.context
        ? `${event.error.message} ${event.error.context}`
        : event.error.message,
      label: event.error.message,
      ...(event.error.origin === 'tool'
        ? { tool: toolFromContext(event.error.context) ?? undefined }
        : {}),
    };
  }
  if (event.command && event.command.exit_code !== null && event.command.exit_code !== 0) {
    return {
      origin: 'command',
      command: event.command.normalized,
      tool: executableOf(event.command.normalized),
      // `event.text` carries the command, its exit code, and the output digest (events.ts).
      message: event.text,
      label: `\`${event.command.text}\` failed`,
    };
  }
  if (event.tests && event.tests.failed > 0) {
    const names = testFailureNames(event);
    const framework = event.tests.framework;
    return {
      origin: 'test',
      ...(framework === undefined || framework.length === 0 ? {} : { tool: framework }),
      message:
        names.length > 0
          ? `${framework ?? 'tests'}: ${names.join(' | ')}`
          : `${framework ?? 'tests'}: ${event.tests.failed} failed`,
      label: names.length > 0 ? `${names.length} failed: ${names.join(', ')}` : 'tests failed',
    };
  }
  return undefined;
}

/**
 * Normalize an error message so that *trivial* variation disappears (ordered, deterministic):
 *
 * 1. strip ANSI escape sequences (colour/progress output);
 * 2. collapse whitespace runs and trim;
 * 3. lowercase (error classes are matched case-insensitively; the digest is case-agnostic);
 * 4. UUIDs → `<uuid>`;
 * 5. hex addresses and long hex runs (`0x7ffee1…`, content hashes) → `<hex>`;
 * 6. IPv4 addresses → `<host>`;
 * 7. file paths → `<path>`: anchored paths (`/abs/x.ts`, `./x`, `../a/b`) first, then relative
 *    multi-segment paths (`packages/storage/src/store.ts`) — a bare filename is *not* a path;
 * 8. `line:col` positions (`src/a.ts:12:5`) → `:<line>:<col>`;
 * 9. `:<port>` → `:<port>` (network endpoints);
 * 10. durations (`1.2s`, `5000ms`, `3 min`) → `<duration>`;
 * 11. remaining numbers and decimals (`87`, `exit 1`, counts) → `<n>`;
 * 12. collapse again, then cap at `MAX_NORMALIZED_MESSAGE` (the digest is computed over the
 *     capped form, so the stored `normalized_message` always reproduces the stored `hash`).
 *
 * Deliberately preserved (they are identity, not noise): bare quoted module names (`"react"`),
 * identifiers, error codes (`ts2345`), test names, and the words an error class is recognized by.
 * A *path-like* quoted literal (`"./schema"`) is normalized like any other path — the signature
 * groups "a relative module is missing", while the candidate content still names which one.
 */
export function normalizeFailureMessage(message: string): string {
  const normalized = message
    // CSI sequences (colour, cursor moves, progress bars) are pure presentation noise.
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{16,}\b/g, '<hex>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<host>')
    .replace(/(?<![\w.-])(?:\.{1,2}\/|\/)[\w.@~-]+(?:\/[\w.@~-]+)*(?:\.[a-z0-9]{1,8})?/g, '<path>')
    .replace(/(?<![\w./-])(?:[\w.@~-]+\/)+[\w.@-]+(?:\.[a-z0-9]{1,8})?/g, '<path>')
    .replace(/:(\d+):(\d+)\b/g, ':<line>:<col>')
    .replace(/:\d{2,5}\b/g, ':<port>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|min|h)\b/g, '<duration>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > MAX_NORMALIZED_MESSAGE
    ? normalized.slice(0, MAX_NORMALIZED_MESSAGE - 1)
    : normalized;
}

/**
 * The normalized error class for an incident. Classification runs on the **normalized** message
 * (the same form the digest covers), so a colour-wrapped message classifies like its plain twin
 * and `type`/`hash` can never disagree about what the failure was.
 */
export function classifyFailure(incident: FailureIncident): string {
  const haystack = normalizeFailureMessage(incident.message);
  for (const rule of ERROR_CLASS_RULES) {
    if (rule.pattern.test(haystack)) return rule.type;
  }
  if (incident.origin === 'test') return 'TEST_FAILURE';
  if (incident.origin === 'command') return 'NONZERO_EXIT';
  return FALLBACK_CLASS_BY_ORIGIN[incident.error_origin ?? 'runtime'] ?? 'ERROR';
}

/**
 * The signature digest: `sha256("failure-v1" ␀ type ␀ normalized_message)`, first 16 hex chars.
 * `normalized_message` is expected to be the output of `normalizeFailureMessage()` — pass the whole
 * incident to `createFailureSignature()` instead of calling this directly.
 */
export function failureSignatureHash(type: string, normalizedMessage: string): string {
  return createHash('sha256')
    .update(`${FAILURE_SIGNATURE_VERSION}\u0000${type}\u0000${normalizedMessage}`)
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
}

/** The signature for one recognized failure incident (schema-validated at construction). */
export function createFailureSignature(incident: FailureIncident): FailureSignature {
  const type = classifyFailure(incident);
  const normalized_message = normalizeFailureMessage(incident.message);
  return FailureSignatureSchema.parse({
    type,
    hash: failureSignatureHash(type, normalized_message),
    normalized_message,
    origin: incident.origin,
    ...(incident.error_origin === undefined ? {} : { error_origin: incident.error_origin }),
    ...(incident.tool === undefined || incident.tool.length === 0 ? {} : { tool: incident.tool }),
    ...(incident.command === undefined || incident.command.length === 0
      ? {}
      : { command: incident.command }),
  });
}

/** Signature for a normalized event, when that event is a failure (`undefined` otherwise). */
export function failureSignatureOf(event: NormalizedEvent): FailureSignature | undefined {
  const incident = failureIncidentOf(event);
  return incident === undefined ? undefined : createFailureSignature(incident);
}

/**
 * Signature for the first failure event among a candidate's cited events. The LLM path never asks
 * the model for a fingerprint: the model names the events, the engine fingerprints them — so the
 * heuristic and LLM paths emit byte-identical signatures for the same failure.
 */
export function failureSignatureForEvents(
  events: readonly NormalizedEvent[],
): FailureSignature | undefined {
  for (const event of events) {
    const signature = failureSignatureOf(event);
    if (signature !== undefined) return signature;
  }
  return undefined;
}

/** The durable candidate's human-readable failure statement (bounded; `content` is clamped). */
export function failureStatement(
  signature: FailureSignature,
  label: string,
  resolution: string,
): string {
  return `Failure: ${signature.type} — ${label} — resolved by: ${resolution}`;
}
