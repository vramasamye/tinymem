/**
 * The `Redactor` port implementation (core's `packages/core/src/ports/redactor.ts`, M12).
 *
 * Walks nested objects/arrays/strings, detects secrets via the pattern catalog, replaces each
 * matched span with `[REDACTED:<kind>]`, and returns `Redaction[]` records carrying
 * kind + JSON-path location + length ONLY (the §7 redaction invariant: the secret value never
 * reaches a record, a log, or an error).
 *
 * Overlap rule (documented in mission-12.md): candidates are resolved earliest-start-first; at
 * an equal start the longer match wins, then the more specific group (group order = priority);
 * any candidate overlapping an accepted span is dropped — so every location is counted once.
 */

import { isRedactionMarker, redactionMarker } from './marker';
import {
  compileDetector,
  type Detector,
  type KindSource,
  type PatternGroup,
  type SecretPattern,
  type ExtraPattern,
  type RedactorConfig,
} from './patterns';

import type { Redaction, RedactionKind, Redactor, RedactionResult } from '@onememory/core';

// ---------------------------------------------------------------------------
// Scanner (one string -> marked string + records)
// ---------------------------------------------------------------------------

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly kind: RedactionKind;
  readonly priority: number;
}

/** Exec-array with `d`-flag indices (structural: avoids lib-dependent typing of `indices`). */
type IndexedMatch = RegExpExecArray & { indices?: Array<[number, number] | undefined> };

function resolveKind(source: KindSource, name: string): RedactionKind {
  return typeof source === 'function' ? source(name) : source;
}

function nameAllows(name: string, pattern: SecretPattern): boolean {
  if (!pattern.keywords) return true;
  const lower = name.toLowerCase();
  return pattern.keywords.some((keyword) => lower.includes(keyword));
}

function spanOf(match: IndexedMatch, pattern: SecretPattern): [number, number] | null {
  if (pattern.valueGroup === undefined) {
    return [match.index, match.index + match[0].length];
  }
  const indices = match.indices;
  if (!indices) return null;
  const span = indices[pattern.valueGroup];
  return span ? [span[0], span[1]] : null;
}

/** One pattern's matches as candidates (value-group spans, keyword-gated, marker-skipped). */
function candidatesOf(text: string, pattern: SecretPattern, group: PatternGroup, groupPriority: number): Candidate[] {
  const out: Candidate[] = [];
  pattern.regex.lastIndex = 0;
  for (const rawMatch of text.matchAll(pattern.regex)) {
    const match = rawMatch as IndexedMatch;
    if (match[0].length === 0) continue; // zero-length match: nothing to redact
    const span = spanOf(match, pattern);
    if (!span) continue;
    const [start, end] = span;
    if (end - start === 0) continue;
    if (isRedactionMarker(text.slice(start, end))) continue; // already redacted (idempotency)
    const name = pattern.nameGroup !== undefined ? String(match[pattern.nameGroup] ?? '') : '';
    if (!nameAllows(name, pattern)) continue;
    out.push({ start, end, kind: resolveKind(group.kind, name), priority: groupPriority });
  }
  return out;
}

function scanExtra(text: string, extra: ExtraPattern, priority: number): Candidate[] {
  const out: Candidate[] = [];
  extra.regex.lastIndex = 0;
  for (const rawMatch of text.matchAll(extra.regex)) {
    const match = rawMatch as IndexedMatch;
    if (match[0].length === 0) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (isRedactionMarker(text.slice(start, end))) continue;
    out.push({ start, end, kind: extra.kind, priority });
  }
  return out;
}

export interface ScanResult {
  readonly text: string;
  readonly records: readonly Redaction[];
}

/** Scan one string: detect, resolve overlaps, splice markers, emit records. */
export function scanString(text: string, location: string, detector: Detector): ScanResult {
  const candidates: Candidate[] = [];
  detector.groups.forEach((group, groupPriority) => {
    for (const pattern of group.patterns) {
      candidates.push(...candidatesOf(text, pattern, group, groupPriority));
    }
  });
  detector.extraPatterns.forEach((extra, index) => {
    candidates.push(...scanExtra(text, extra, detector.groups.length + index));
  });

  if (candidates.length === 0) return { text, records: [] };

  // Earliest start wins; at equal start: longest, then most specific (stable sort keeps order).
  candidates.sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.priority - b.priority,
  );

  const chosen: Candidate[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue; // overlaps an accepted span: dropped
    chosen.push(candidate);
    lastEnd = candidate.end;
  }

  let marked = '';
  let cursor = 0;
  const records: Redaction[] = [];
  for (const candidate of chosen) {
    marked += text.slice(cursor, candidate.start) + redactionMarker(candidate.kind);
    cursor = candidate.end;
    records.push({ kind: candidate.kind, location, length: candidate.end - candidate.start });
  }
  marked += text.slice(cursor);
  return { text: marked, records };
}

// ---------------------------------------------------------------------------
// Walker (deep copy + redact, JSON-path locations)
// ---------------------------------------------------------------------------

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Walk `value` depth-first, redacting every string. Returns a redacted deep copy. */
export function walkValue(value: unknown, path: string, detector: Detector, records: Redaction[]): unknown {
  if (typeof value === 'string') {
    const scanned = scanString(value, path, detector);
    records.push(...scanned.records);
    return scanned.text;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => walkValue(item, `${path}[${index}]`, detector, records));
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = walkValue(value[key], childPath(path, key), detector, records);
    }
    return copy;
  }
  // Primitives and exotic objects (Date, Map, class instances) pass through untouched: the
  // event boundary is Zod-validated JSON, and exotic leaves carry no scannable text we own.
  return value;
}

// ---------------------------------------------------------------------------
// Port implementation
// ---------------------------------------------------------------------------

let defaultDetector: Detector | null = null;

/** The detector for `config` (compiled once for the default config; per-call for custom ones). */
export function detectorFor(config?: RedactorConfig): Detector {
  if (config === undefined) {
    if (!defaultDetector) defaultDetector = compileDetector();
    return defaultDetector;
  }
  return compileDetector(config);
}

/**
 * Synchronous redaction of an arbitrary value: `{value: redactedDeepCopy, redactions}`.
 * Locations are JSON paths rooted at `$` (e.g. `$.payload.content`).
 */
export function redactValue(value: unknown, config?: RedactorConfig): RedactionResult {
  const detector = detectorFor(config);
  const records: Redaction[] = [];
  const out = walkValue(value, '$', detector, records);
  return { value: out, redactions: records };
}

/**
 * The core `Redactor` port (INGEST stage 2). Async by contract so pipeline stages can await
 * it uniformly; the implementation is synchronous under the await.
 */
export function createRedactor(config?: RedactorConfig): Redactor & { redactSync(value: unknown): RedactionResult } {
  const detector = detectorFor(config);
  return {
    async redact(value: unknown): Promise<RedactionResult> {
      return this.redactSync(value);
    },
    redactSync(value: unknown): RedactionResult {
      const records: Redaction[] = [];
      const out = walkValue(value, '$', detector, records);
      return { value: out, redactions: records };
    },
  };
}
