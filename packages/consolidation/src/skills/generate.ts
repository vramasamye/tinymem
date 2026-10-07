/**
 * Verified-solution pattern extraction (M15 issue 1) + the candidate builder (issue 2): the
 * pure functions that turn a QUALIFIED signature group into a skill candidate — the name, the
 * one-line description, the evidence-bounded `source`/`verification` records the `skills` table
 * stores, and the canonical SKILL.md bytes.
 *
 * Everything here is deterministic text assembly over durable rows (the same discipline as the
 * M14.5 digest rollup — zero model calls, zero network, AGENTS.md rules 4 and 7). The LLM tier
 * (a router `consolidate`-style operation that rewrites the sections) stays a documented
 * follow-up: the templated form is the floor, never a placeholder — it is complete, reviewable,
 * and idempotent today.
 */

import {
  MAX_SKILL_DESCRIPTION_CHARS,
  type EvidenceSpan,
  type MemoryRecord,
} from '@onememory-ai/core';

import { MAX_DERIVATION_EVIDENCE } from '../derive';
import { clampAtWordBoundary } from '../digest/rollup';
import { scopeKeyOf } from '../cluster';
import { observationOf, type FailureObservation, type SignatureGroup } from './match';
import { renderSkillMarkdown, type SkillDocument } from './render';

/** The candidate everything below assembles — the `skills` row input plus its rendered artifact. */
export interface SkillCandidateDraft {
  name: string;
  description: string;
  version: string;
  source: { failure_ids: string[]; procedure_id?: string };
  verification: { evidence: EvidenceSpan[]; verified_at: string };
  /** `skills/<slug>/SKILL.md` — project-relative, per the documented layout. */
  path: string;
  /** The canonical SKILL.md bytes — what `review` prints and `promote` writes. */
  markdown: string;
}

// ---------------------------------------------------------------------------
// Deterministic section extraction
// ---------------------------------------------------------------------------

/** Split text into sentence-ish steps: newlines first, then sentence boundaries. */
function stepsOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9`])/u)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

/** Distinct non-empty lines across sources, first occurrence wins, capped. */
function distinctLines(sources: readonly (string | null)[], cap: number): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of sources) {
    if (source === null || source === '') continue;
    for (const step of stepsOf(source)) {
      const key = step.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(step);
      if (lines.length >= cap) return lines;
    }
  }
  return lines;
}

/** Tool prefixes a line may start with to count as a shell command (deterministic, documented). */
const COMMAND_PREFIXES = new Set([
  'apt', 'aws', 'brew', 'bun', 'bunx', 'cargo', 'curl', 'docker', 'gcloud', 'git', 'go', 'helm',
  'jq', 'kubectl', 'make', 'node', 'npm', 'npx', 'onemem', 'pg_dump', 'pnpm', 'psql', 'pip',
  'python', 'ssh', 'tar', 'terraform', 'tsc', 'uv', 'yarn',
]);

function stripCommandDecoration(text: string): string {
  return text.trim().replace(/^\$\s+/, '').replace(/^`+|`+$/g, '').trim();
}

/**
 * The command PORTION of a shell-looking LINE: everything up to the first sentence terminator
 * — the rest of the line is prose explaining the command, never part of it. Backtick SPANS are
 * explicit command text and are kept verbatim (their authors quoted exactly what to run).
 */
function commandPortion(text: string): string {
  const cut = text.search(/[.;!?]/);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

function isCommandLine(text: string): boolean {
  const stripped = stripCommandDecoration(text);
  if (stripped.length === 0) return false;
  const firstWord = /^[a-z][\w.-]*/.exec(stripped)?.[0];
  return firstWord !== undefined && COMMAND_PREFIXES.has(firstWord);
}

/**
 * Commands across the solutions: shell-looking lines plus backtick-quoted spans (the classic
 * prose form "rerun `bun test` after …"), first occurrence wins, capped.
 */
function commandsOf(solutions: readonly (string | null)[], cap = 6): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];
  const add = (command: string): void => {
    const key = command.toLowerCase();
    if (command.length === 0 || seen.has(key)) return;
    seen.add(key);
    commands.push(command);
  };
  for (const solution of solutions) {
    if (solution === null || solution === '') continue;
    for (const rawLine of solution.split(/\n+/)) {
      if (isCommandLine(rawLine)) add(commandPortion(stripCommandDecoration(rawLine)));
    }
    for (const match of solution.matchAll(/`([^`\n]+)`/g)) add(match[1]!.trim());
    if (commands.length >= cap) break;
  }
  return commands.slice(0, cap);
}

/** Distinct text with a small normalization key — the section dedupe base. */
function distinctProse(texts: readonly (string | null)[], cap: number): string[] {
  return distinctLines(texts, cap);
}

// ---------------------------------------------------------------------------
// The slug + the description
// ---------------------------------------------------------------------------

/** Kebab-case the first ≤ 6 significant words of the problem — the deterministic slug base. */
export function skillSlugBase(problem: string): string {
  const words = problem
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1);
  const slug = words.slice(0, 6).join('-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'recurring-failure';
}

/**
 * The candidate name: the slug base, discriminated by the signature's first 8 significant
 * characters when a DIFFERENT problem already claimed the base (deterministic, collision-free,
 * re-runs stable). Signature hashes are prefixed (`sha256:…`, `sig-…`) — the discriminator
 * strips a `prefix:` so it never reads the scheme out of the hash.
 */
export function skillNameOf(problem: string, signatureHash: string, taken: ReadonlySet<string>): string {
  const base = skillSlugBase(problem);
  if (!taken.has(base)) return base;
  const hash = signatureHash.includes(':') ? signatureHash.slice(signatureHash.indexOf(':') + 1) : signatureHash;
  const tag = hash.slice(0, 8).replace(/[^a-z0-9]+$/, '');
  return tag.length > 0 ? `${base}-${tag}` : `${base}-skill`;
}

/** `Fix: <problem>` clamped to the description budget at a word boundary. */
export function skillDescriptionOf(problem: string): string {
  const firstSentence = stepsOf(problem)[0] ?? problem;
  return clampAtWordBoundary(`Fix: ${firstSentence}`, MAX_SKILL_DESCRIPTION_CHARS);
}

// ---------------------------------------------------------------------------
// The evidence union (provenance — the candidate must point at its failures)
// ---------------------------------------------------------------------------

/** Union of evidence spans, first occurrence wins, capped (the digest/derive dedupe key). */
export function unionEvidenceSpans(
  sources: readonly { evidence: readonly EvidenceSpan[] }[],
  cap: number,
): EvidenceSpan[] {
  const seen = new Set<string>();
  const union: EvidenceSpan[] = [];
  for (const source of sources) {
    for (const span of source.evidence) {
      const key = `${span.source_id}|${span.kind}|${span.locator}|${span.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(span);
      if (union.length >= cap) return union;
    }
  }
  return union;
}

// ---------------------------------------------------------------------------
// The document + the candidate
// ---------------------------------------------------------------------------

/**
 * Build the structured SKILL.md document from the candidate's solved failures. Deterministic:
 * members ordered (the caller sorts), the representative is the most recent solved failure,
 * every section derived from durable fields only.
 */
export function buildSkillDocument(input: {
  name: string;
  description: string;
  version: string;
  failures: readonly FailureObservation[];
}): SkillDocument {
  const failures = [...input.failures].sort(
    (a, b) =>
      (a.last_seen_at === b.last_seen_at
        ? a.memory_id < b.memory_id
          ? -1
          : 1
        : a.last_seen_at < b.last_seen_at
          ? -1
          : 1),
  );
  const representative = failures[failures.length - 1];
  const problems = failures.map((failure) => failure.problem);
  const contexts = failures.map((failure) => failure.context);
  const solutions = failures.map((failure) => failure.solution);
  const verifications = failures.map((failure) => failure.verification);
  const rootCauses = failures.map((failure) => failure.root_cause);

  const whenToUse: string[] = [];
  if (representative !== undefined) {
    whenToUse.push(`The same failure recurs: ${distinctProse(problems, 1)[0] ?? representative.problem}`);
    // The recurrence window spans the WHOLE group: earliest first_seen to latest last_seen
    // (the representative's own first_seen is just its row's, not the recurrence's).
    const firstSeen = failures.reduce(
      (earliest, failure) => (failure.first_seen_at < earliest ? failure.first_seen_at : earliest),
      failures[0]!.first_seen_at,
    );
    whenToUse.push(
      `Seen ${failures.length} times — first ${firstSeen.slice(0, 10)}, ` +
        `last ${representative.last_seen_at.slice(0, 10)} (signature ${representative.signature_hash})`,
    );
  }

  return {
    name: input.name,
    description: input.description,
    version: input.version,
    when_to_use: whenToUse,
    prerequisites: distinctProse(contexts, 3),
    // The procedure is the representative solution — the pairwise gate (match.ts) already
    // certified every solved member's solution equivalent to it.
    procedure: representative?.solution === null || representative?.solution === undefined
      ? []
      : stepsOf(representative.solution),
    commands: commandsOf(solutions),
    validation: distinctProse(verifications, 3),
    known_failure_modes: distinctProse(rootCauses, 3),
  };
}

/** Assemble the full candidate from a qualified group (name, evidence, path, markdown). */
export function buildSkillCandidate(input: {
  group: SignatureGroup;
  takenNames: ReadonlySet<string>;
  /** Cap on `source.failure_ids` (newest kept). */
  maxEvidenceFailures: number;
  /**
   * Explicit name for an existing skill being re-processed (the identity-matched recurrence —
   * the run finds a skill by its source failures before deriving any name); default: derive
   * deterministically from the problem, discriminated by signature on collision.
   */
  name?: string;
}): SkillCandidateDraft {
  const { group } = input;
  const representative = group.solved[group.solved.length - 1]!;
  const name = input.name ?? skillNameOf(representative.problem, group.signature_hash, input.takenNames);
  const description = skillDescriptionOf(representative.problem);
  const evidenceFailures = [...group.solved]
    .sort(
      (a, b) =>
        (a.last_seen_at === b.last_seen_at ? (a.memory_id < b.memory_id ? -1 : 1) : a.last_seen_at < b.last_seen_at ? -1 : 1),
    )
    .slice(-input.maxEvidenceFailures);
  const document = buildSkillDocument({ name, description, version: '1.0.0', failures: evidenceFailures });
  return {
    name,
    description,
    version: '1.0.0',
    source: { failure_ids: evidenceFailures.map((failure) => failure.memory_id) },
    verification: {
      // The failures' own evidence spans — the candidate's provenance (AGENTS.md rule 8).
      evidence: unionEvidenceSpans(evidenceFailures, MAX_DERIVATION_EVIDENCE),
      verified_at: evidenceFailures[evidenceFailures.length - 1]!.last_seen_at,
    },
    path: `skills/${name}/SKILL.md`,
    markdown: renderSkillMarkdown(document),
  };
}

/**
 * Convenience: build the observation from a hydrated failure `MemoryRecord` (the review/promote
 * re-render path — `getMemory` hydrates the payload) plus its entity names. Returns null when
 * the row is not a failure with a hydrated payload.
 */
export function observationFromMemory(record: MemoryRecord): FailureObservation | null {
  const payload = record.payload;
  if (payload === undefined || payload === null || typeof payload !== 'object') return null;
  if (!('problem' in payload && 'signature_hash' in payload && 'context' in payload)) return null;
  const failure = payload as {
    problem: string;
    context: string;
    root_cause?: string;
    solution?: string;
    verification?: string;
    status: string;
    signature_hash?: string;
    first_seen_at: string;
    last_seen_at: string;
  };
  if (failure.signature_hash === undefined) return null;
  return {
    memory_id: record.id,
    scope_key: scopeKeyOf(record),
    project_id: record.project_id ?? null,
    observed_at: record.observed_at,
    problem: failure.problem,
    context: failure.context,
    root_cause: failure.root_cause ?? null,
    solution: failure.solution ?? null,
    verification: failure.verification ?? null,
    signature_hash: failure.signature_hash,
    first_seen_at: failure.first_seen_at,
    last_seen_at: failure.last_seen_at,
    entities: record.entities.map((entity) => entity.name),
    evidence: record.provenance.evidence,
  };
}
