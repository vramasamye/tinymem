/**
 * The M15 CI gate: run the skills evaluator over the committed golden dataset and require every
 * metric at 1.0. The engine is deterministic (zero models, zero network), so unlike the
 * retrieval gates there is no headroom — a single broken probe is a real regression and fails
 * this suite loudly, with the failing probe named in the metrics' `failures` list.
 */

import { describe, expect, test } from 'bun:test';

import { SKILLS_GOLDEN_DATASET, SKILL_MD_CHAR_BOUND } from './fixtures';
import { evaluateSkillGates, evaluateSkills, renderSkillsReport } from './evaluate';

describe('the M15 skills gate (golden failure→fix dataset, real engine)', () => {
  const metrics = evaluateSkills();
  const gates = evaluateSkillGates(metrics);

  test('the dataset is committed and self-describing', () => {
    expect(SKILLS_GOLDEN_DATASET.cases.length).toBeGreaterThanOrEqual(6);
    expect(SKILLS_GOLDEN_DATASET.failures.length).toBeGreaterThanOrEqual(10);
    // Every case declares exactly one outcome, and every failure belongs to a case.
    for (const datasetCase of SKILLS_GOLDEN_DATASET.cases) {
      expect(
        (datasetCase.candidate === undefined) !== (datasetCase.blocked === undefined),
        `${datasetCase.key} must declare exactly one of candidate|blocked`,
      ).toBeTrue();
      expect(
        SKILLS_GOLDEN_DATASET.failures.some((failure) => failure.key.startsWith(`${datasetCase.key}-`)),
        `${datasetCase.key} has no fixture failures`,
      ).toBeTrue();
    }
  });

  test('every generated artifact carries the six canonical sections, in order', () => {
    expect(metrics.section_completeness).toBe(1);
  });

  test('every expected skill is generated with its exact deterministic name', () => {
    expect(metrics.generation_accuracy).toBe(1);
  });

  test('every blocked group carries its expected typed reason — never a silent drop', () => {
    expect(metrics.gate_accuracy).toBe(1);
  });

  test('every content probe is found in its named section', () => {
    expect(metrics.content_grounding).toBe(1);
  });

  test('rebuilding a candidate is byte-identical — the canonical form is stable', () => {
    expect(metrics.canonical_stability).toBe(1);
  });

  test(`every artifact stays within the ${SKILL_MD_CHAR_BOUND}-char bound`, () => {
    expect(metrics.compactness).toBe(1);
  });

  test('the gates pass as a whole, or name every failing probe', () => {
    expect(gates.passed, metrics.failures.join('\n')).toBeTrue();
  });

  test('the report renders (the baseline / mission-report shape)', () => {
    const report = renderSkillsReport(metrics, gates);
    expect(report).toContain('## Skill generation (M15 golden dataset)');
    expect(report).toContain('gates: PASS');
  });
});
