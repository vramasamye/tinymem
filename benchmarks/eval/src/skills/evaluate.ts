/**
 * The M15 skills evaluator (backlog M15: golden failure→fix dataset + grading) — runs the REAL
 * generation engine over the committed fixtures and grades the artifacts against the canonical
 * contract. Every metric is a correctness invariant of a deterministic engine, so every gate is
 * 1.0 with no headroom: a regression in the matcher, the gate, the extraction, or the renderer
 * fails the gate loudly, and the failure lines name the exact probe that broke.
 *
 * What is graded, per generated candidate:
 *   - the exact deterministic skill name;
 *   - the six canonical sections, present, in the documented order;
 *   - content grounding: the fixture's probes appear in their named sections;
 *   - canonical stability: building the candidate again yields byte-identical SKILL.md (the
 *     form `review` prints, `promote` writes, and re-generation never rewrites);
 *   - compactness: the artifact stays under the documented char bound (token-efficiency rule
 *     7 — a skill is a retrieval artifact, never a transcript).
 * Per blocked group: the exact typed refusal reason, never a silent drop.
 */

import {
  buildSkillCandidate,
  groupFailuresBySignature,
  renderSkillMarkdown,
  type SignatureGroup,
} from '@onememory/consolidation';
import { MAX_SKILL_EVIDENCE_FAILURES, SKILL_MD_SECTIONS } from '@onememory/core';

import {
  SKILLS_GOLDEN_DATASET,
  SKILL_MD_CHAR_BOUND,
  type SkillsFixtureCase,
} from './fixtures';

// ---------------------------------------------------------------------------
// The metrics + the gates
// ---------------------------------------------------------------------------

export interface SkillsMetrics {
  /** Signature groups the pool formed. */
  groups: number;
  /** Cases the dataset declares (candidates + blocked). */
  cases: number;
  /** Blocked groups carrying their expected typed reason / blocked groups. */
  gate_accuracy: number;
  /** Expected candidates produced with their exact deterministic name / expected candidates. */
  generation_accuracy: number;
  /** Artifacts whose six sections are all present, in order / artifacts. */
  section_completeness: number;
  /** Content probes satisfied / probes. */
  content_grounding: number;
  /** Artifacts whose second build is byte-identical / artifacts. */
  canonical_stability: number;
  /** Artifacts within the char bound / artifacts. */
  compactness: number;
  /** Named failures — every metric miss, loud and specific. */
  failures: string[];
}

/** Every skills gate is a deterministic correctness invariant: 1.0, no headroom. */
export interface SkillsGateEvaluation {
  passed: boolean;
  checks: Array<{ metric: keyof Omit<SkillsMetrics, 'failures' | 'groups' | 'cases'>; value: number; threshold: number; passed: boolean }>;
}

export function evaluateSkillGates(metrics: SkillsMetrics): SkillsGateEvaluation {
  const metricKeys: Array<keyof Omit<SkillsMetrics, 'failures' | 'groups' | 'cases'>> = [
    'gate_accuracy',
    'generation_accuracy',
    'section_completeness',
    'content_grounding',
    'canonical_stability',
    'compactness',
  ];
  const checks = metricKeys.map((metric) => ({
    metric,
    value: metrics[metric],
    threshold: 1,
    passed: metrics[metric] === 1,
  }));
  return { passed: checks.every((check) => check.passed), checks };
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

/** The body of one section: from its heading to the next heading (or the end). */
function sectionBody(markdown: string, section: string): string {
  const start = markdown.indexOf(`## ${section}\n`);
  if (start === -1) return '';
  const rest = markdown.slice(start + `## ${section}\n`.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/** The group key of a case: derived from its first fixture failure (never re-declared). */
function caseGroupKey(datasetCase: SkillsFixtureCase, groups: readonly SignatureGroup[]): string | null {
  const members = SKILLS_GOLDEN_DATASET.failures.filter((failure) =>
    failure.key.startsWith(`${datasetCase.key}-`),
  );
  const first = members[0];
  if (first === undefined) return null;
  const entity = first.observation.entities[0] ?? null;
  const wanted = `${first.observation.scope_key}|${entity ?? '∅'}|${first.observation.signature_hash}`;
  return groups.some((group) => group.key === wanted) ? wanted : null;
}

export function evaluateSkills(): SkillsMetrics {
  const failures = SKILLS_GOLDEN_DATASET.failures.map((failure) => failure.observation);
  const groups = groupFailuresBySignature(failures);

  // Per-project taken-name namespaces, exactly like the pass (`run.ts`): skill names are
  // project-scoped, so a collision in ANOTHER project never discriminates and never merges.
  const takenByProject = new Map<string, Set<string>>();

  let blockedTotal = 0;
  let blockedCorrect = 0;
  let candidateTotal = 0;
  let candidateCorrect = 0;
  let sectionsTotal = 0;
  let sectionsCorrect = 0;
  let probeTotal = 0;
  let probeCorrect = 0;
  let stabilityTotal = 0;
  let stabilityCorrect = 0;
  let compactTotal = 0;
  let compactCorrect = 0;
  const failures_: string[] = [];

  for (const datasetCase of SKILLS_GOLDEN_DATASET.cases) {
    const key = caseGroupKey(datasetCase, groups);
    if (key === null) {
      failures_.push(`${datasetCase.key}: no signature group formed for the case's failures`);
      continue;
    }
    const group = groups.find((entry) => entry.key === key)!;

    if (datasetCase.blocked !== undefined) {
      blockedTotal += 1;
      if (!group.qualified && group.reason === datasetCase.blocked.reason) blockedCorrect += 1;
      else if (group.qualified) {
        failures_.push(`${datasetCase.key}: expected blocked (${datasetCase.blocked.reason}) but the group QUALIFIED`);
      } else {
        failures_.push(`${datasetCase.key}: expected blocked (${datasetCase.blocked.reason}) but blocked with ${group.reason}`);
      }
      continue;
    }

    const expected = datasetCase.candidate!;
    if (!group.qualified) {
      candidateTotal += 1;
      failures_.push(`${datasetCase.key}: expected candidate '${expected.name}' but the group was blocked (${group.reason})`);
      continue;
    }
    candidateTotal += 1;

    const projectId = group.scope.project_id ?? '∅';
    const taken = takenByProject.get(projectId) ?? new Set<string>();
    const candidate = buildSkillCandidate({
      group,
      takenNames: taken,
      maxEvidenceFailures: MAX_SKILL_EVIDENCE_FAILURES,
    });
    taken.add(candidate.name);
    takenByProject.set(projectId, taken);

    if (candidate.name === expected.name) candidateCorrect += 1;
    else {
      failures_.push(`${datasetCase.key}: expected skill '${expected.name}' but the engine named it '${candidate.name}'`);
    }

    // Section completeness: every canonical section heading, in the documented order.
    sectionsTotal += 1;
    const headings = [...candidate.markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    if (headings.join('|') === SKILL_MD_SECTIONS.join('|')) sectionsCorrect += 1;
    else failures_.push(`${datasetCase.key}: the artifact's sections are [${headings.join(', ')}], not the six canonical ones in order`);

    // Content grounding: each probe appears within its named section.
    for (const probe of expected.probes) {
      probeTotal += 1;
      if (sectionBody(candidate.markdown, probe.section).includes(probe.contains)) probeCorrect += 1;
      else failures_.push(`${datasetCase.key}: '${probe.section}' does not contain the probe '${probe.contains}'`);
    }

    // Canonical stability: a second build over the same group is byte-identical.
    stabilityTotal += 1;
    const rebuilt = buildSkillCandidate({
      group,
      takenNames: taken,
      maxEvidenceFailures: MAX_SKILL_EVIDENCE_FAILURES,
      name: candidate.name,
    });
    if (rebuilt.markdown === candidate.markdown) stabilityCorrect += 1;
    else failures_.push(`${datasetCase.key}: the second build is not byte-identical to the first`);

    // Compactness: the artifact stays under the documented bound.
    compactTotal += 1;
    if (candidate.markdown.length <= SKILL_MD_CHAR_BOUND) compactCorrect += 1;
    else failures_.push(`${datasetCase.key}: the artifact is ${candidate.markdown.length} chars, over the ${SKILL_MD_CHAR_BOUND} bound`);
  }

  const rate = (correct: number, total: number): number => (total === 0 ? 1 : correct / total);
  return {
    groups: groups.length,
    cases: SKILLS_GOLDEN_DATASET.cases.length,
    gate_accuracy: rate(blockedCorrect, blockedTotal),
    generation_accuracy: rate(candidateCorrect, candidateTotal),
    section_completeness: rate(sectionsCorrect, sectionsTotal),
    content_grounding: rate(probeCorrect, probeTotal),
    canonical_stability: rate(stabilityCorrect, stabilityTotal),
    compactness: rate(compactCorrect, compactTotal),
    failures: failures_,
  };
}

/** Render the skills evaluation as a markdown section (the mission-report / baseline shape). */
export function renderSkillsReport(metrics: SkillsMetrics, gates: SkillsGateEvaluation): string {
  const lines = [
    '## Skill generation (M15 golden dataset)',
    '',
    `- groups formed: ${metrics.groups} across ${metrics.cases} declared cases`,
    `- gate accuracy: ${metrics.gate_accuracy} (blocked groups carry their typed reason)`,
    `- generation accuracy: ${metrics.generation_accuracy} (exact deterministic names)`,
    `- section completeness: ${metrics.section_completeness} (six canonical sections, in order)`,
    `- content grounding: ${metrics.content_grounding} (probes found in their sections)`,
    `- canonical stability: ${metrics.canonical_stability} (byte-identical rebuilds)`,
    `- compactness: ${metrics.compactness} (within the ${SKILL_MD_CHAR_BOUND}-char bound)`,
    `- gates: ${gates.passed ? 'PASS' : 'FAIL'} (every threshold 1.0 — deterministic engine, no headroom)`,
  ];
  if (metrics.failures.length > 0) {
    lines.push('', '### Failures', '', ...metrics.failures.map((failure) => `- ${failure}`));
  }
  return lines.join('\n');
}
