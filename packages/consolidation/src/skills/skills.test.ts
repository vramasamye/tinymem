/**
 * The M15 skill engine's pure layer: the signature recurrence matcher (grouping + the
 * three-reason gate, `pairKey`-certified), the candidate builder (slug / description / command
 * extraction / the evidence union), and the canonical SKILL.md renderer — the byte contract
 * `review` prints and `promote` writes. Everything here is deterministic text assembly: zero
 * model calls, zero network (AGENTS.md rules 4 and 7).
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SOLUTION_SIMILARITY,
  MAX_SKILL_DESCRIPTION_CHARS,
  SKILL_MD_SECTIONS,
  type EvidenceSpan,
  type MemoryRecord,
} from '@onememory-ai/core';

import { memoryFixture } from '../testing';
import {
  buildSkillCandidate,
  buildSkillDocument,
  observationFromMemory,
  skillDescriptionOf,
  skillNameOf,
  skillSlugBase,
  unionEvidenceSpans,
} from './generate';
import {
  groupFailuresBySignature,
  observationOf,
  primaryEntityOf,
  solutionSimilarityOf,
  type FailureObservation,
} from './match';
import { renderSkillMarkdown } from './render';

import {
  FIXTURE_PROJECT as PROJECT,
  OTHER_FIXTURE_PROJECT as OTHER_PROJECT,
  SIG_CONN,
  SIG_OOM,
  failureRecurrence,
  qualifiedPair as qualifiedPairRecurrences,
} from './fixtures';

/** The qualified two-solved-occurrence group every gate test starts from. */
function qualifiedPair(): FailureObservation[] {
  return qualifiedPairRecurrences().map(observationOf);
}

// ---------------------------------------------------------------------------
// solutionSimilarityOf — the Jaccard equivalence measure
// ---------------------------------------------------------------------------

describe('solutionSimilarityOf', () => {
  test('identical text short-circuits to 1; disjoint text scores 0', () => {
    expect(solutionSimilarityOf('same fix', 'same fix')).toBe(1);
    expect(solutionSimilarityOf('raise max_connections', 'close the leaked pools')).toBe(0);
  });

  test('token-set Jaccard over normalized alphanumeric runs', () => {
    // {raise, max, connections, to, 200} vs {raise, max, connections, to, 400}: 4 shared of 6.
    expect(solutionSimilarityOf('Raise max_connections to 200.', 'raise MAX connections to 400!')).toBeCloseTo(
      4 / 6,
      5,
    );
    // Empty inputs never divide by zero.
    expect(solutionSimilarityOf('', 'raise the limit')).toBe(0);
    expect(solutionSimilarityOf('   ', '!!!')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// groupFailuresBySignature — grouping + the three-reason gate
// ---------------------------------------------------------------------------

describe('groupFailuresBySignature', () => {
  test('groups by scope + primary entity + signature; members ordered by last_seen_at', () => {
    const groups = groupFailuresBySignature(qualifiedPair());
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    // scopeKeyOf is `project|user` — the user part is `∅` for project-scoped rows — plus
    // the primary entity and the extraction-stage signature: four parts, no more.
    expect(group.key).toBe(`${PROJECT}|∅|cloud-run|${SIG_OOM}`);
    expect(group.entity).toBe('cloud-run');
    expect(group.failures.map((member) => member.memory_id)).toEqual([
      '00000000-0000-7000-8000-0000000000a1',
      '00000000-0000-7000-8000-0000000000a2',
    ]);
    expect(group.solved).toHaveLength(2);
    expect(group.qualified).toBeTrue();
  });

  test('the same signature against a different entity is a SEPARATE group', () => {
    const groups = groupFailuresBySignature([
      ...qualifiedPair(),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000b1',
          problem: 'OOM on deploy for the worker build.',
          signature: SIG_OOM,
          solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
          verification: 'worker deploy passed.',
          entity: 'worker-service',
        }),
      ),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.entity))).toEqual(new Set(['cloud-run', 'worker-service']));
  });

  test('the same signature in a different project never crosses scopes', () => {
    const groups = groupFailuresBySignature([
      ...qualifiedPair(),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000b2',
          problem: 'Cloud Run deploy failed with OOM in the other project.',
          signature: SIG_OOM,
          solution: 'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
          verification: 'deploy passed.',
          entity: 'cloud-run',
          project: OTHER_PROJECT,
        }),
      ),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.scope.project_id).sort()).toEqual([OTHER_PROJECT, PROJECT].sort());
  });

  test('gates: two equivalent solved occurrences WITH verification evidence qualify', () => {
    const [group] = groupFailuresBySignature(qualifiedPair());
    expect(group!.qualified).toBeTrue();
    expect(group!.reason).toBeUndefined();
    expect(group!.detail).toContain('pairwise-equivalent solutions');
    // The certification is recorded per unordered pair key — order-independent.
    expect(group!.pairSimilarity.get('00000000-0000-7000-8000-0000000000a1|00000000-0000-7000-8000-0000000000a2')).toBe(1);
  });

  test('gates: fewer than 2 solved occurrences → insufficient_solved_failures', () => {
    const groups = groupFailuresBySignature([
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000c1',
          problem: 'Port 8080 already in use.',
          signature: SIG_CONN,
          solution: 'Kill the stale listener.',
          verification: 'lsof shows no listener.',
        }),
      ),
    ]);
    expect(groups[0]!.reason).toBe('insufficient_solved_failures');
    expect(groups[0]!.qualified).toBeFalse();
    // An unsolved second occurrence does not rescue the group — the gate counts SOLVED members,
    // and the unsolved recurrence still rides the same signature group.
    const withUnsolved = groupFailuresBySignature([
      ...groups[0]!.failures,
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000c2',
          problem: 'Port 8080 already in use again.',
          signature: SIG_CONN,
        }),
      ),
    ]);
    expect(withUnsolved).toHaveLength(1); // same scope, same (unbound) entity, same signature
    expect(withUnsolved[0]!.failures).toHaveLength(2);
    expect(withUnsolved[0]!.solved).toHaveLength(1);
    expect(withUnsolved[0]!.reason).toBe('insufficient_solved_failures');
    expect(withUnsolved[0]!.qualified).toBeFalse();
  });

  test('gates: solved different ways → divergent_solutions, naming the blocking pair', () => {
    const groups = groupFailuresBySignature([
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000d1',
          problem: 'Too many Postgres connections.',
          signature: SIG_CONN,
          solution: 'Raise max_connections in postgresql.conf to 200 and restart the container.',
          verification: 'count(*) stays under the limit.',
          entity: 'postgres',
        }),
      ),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000d2',
          problem: 'Too many Postgres connections again.',
          signature: SIG_CONN,
          solution: 'Close leaked pools in the test setup by calling pool.end() after the suite.',
          verification: 'suite passes with no connection errors.',
          entity: 'postgres',
        }),
      ),
    ]);
    const group = groups[0]!;
    expect(group.reason).toBe('divergent_solutions');
    expect(group.qualified).toBeFalse();
    expect(group.detail).toContain('0000000000d1|00000000-0000-7000-8000-0000000000d2');
    expect(group.detail).toContain(String(DEFAULT_SOLUTION_SIMILARITY));
  });

  test('gates: equivalent solutions but no proof → no_verification_evidence', () => {
    const groups = groupFailuresBySignature([
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000e1',
          problem: 'bun test flakes with EBUSY.',
          signature: 'sha256:flake-ebusy',
          solution: 'Add a retry loop around the setup directory removal.',
          entity: 'bun',
        }),
      ),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000e2',
          problem: 'bun test flakes with EBUSY again.',
          signature: 'sha256:flake-ebusy',
          solution: 'Add a retry loop around the setup directory removal.',
          entity: 'bun',
        }),
      ),
    ]);
    expect(groups[0]!.reason).toBe('no_verification_evidence');
    expect(groups[0]!.detail).toContain('verification evidence');
  });

  test('primaryEntityOf: the first binding, null when unbound', () => {
    const [bound, unbound] = qualifiedPair();
    expect(primaryEntityOf(bound!)).toBe('cloud-run');
    expect(primaryEntityOf(observationOf(failureRecurrence({ id: '00000000-0000-7000-8000-0000000000f1', problem: 'x', signature: SIG_CONN })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The slug, the name, the description
// ---------------------------------------------------------------------------

describe('skillSlugBase / skillNameOf / skillDescriptionOf', () => {
  test('kebab-cases the first six significant words of the problem', () => {
    expect(skillSlugBase('Cloud Run deploy failed with OOM (exit 137) during the build!')).toBe(
      'cloud-run-deploy-failed-with-oom',
    );
    expect(skillSlugBase('Port 8080 in use')).toBe('port-8080-in-use');
  });

  test('a slug-less problem degrades to a stable name, never an empty one', () => {
    expect(skillSlugBase('??? !!!')).toBe('recurring-failure');
  });

  test('the base is free → the base; taken → discriminated by the signature', () => {
    const taken = new Set(['cloud-run-deploy-failed-with-oom']);
    expect(skillNameOf('Cloud Run deploy failed with OOM.', SIG_OOM, new Set())).toBe(
      'cloud-run-deploy-failed-with-oom',
    );
    // The discriminator reads the hash's significant part, never a `sha256:` scheme prefix.
    expect(skillNameOf('Cloud Run deploy failed with OOM elsewhere.', 'sha256:deadbeef00ff', taken)).toBe(
      'cloud-run-deploy-failed-with-oom-deadbeef',
    );
    expect(skillNameOf('Cloud Run deploy failed with OOM elsewhere.', 'sig-oom-kill-1234', taken)).toBe(
      'cloud-run-deploy-failed-with-oom-sig-oom',
    );
  });

  test('the description is the first sentence, Fix-prefixed, clamped at the bound', () => {
    expect(skillDescriptionOf('Cloud Run deploy failed with OOM. Then more text.')).toBe(
      'Fix: Cloud Run deploy failed with OOM.',
    );
    const long = `${'word '.repeat(60)}.`;
    expect(skillDescriptionOf(long).length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
    expect(skillDescriptionOf(long).startsWith('Fix: word')).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// Command extraction + the evidence union
// ---------------------------------------------------------------------------

describe('commandsOf (through buildSkillCandidate)', () => {
  test('shell-prefixed lines and backtick spans, deduped, capped', () => {
    const [group] = groupFailuresBySignature([
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000g1',
          problem: 'Deploy failed; the service OOMed.',
          signature: SIG_OOM,
          solution:
            'Scale the service memory.\nRun `gcloud run services update api --memory 4Gi`.\n' +
            '$ gcloud run deploy --region europe-west1\nThen rerun `gcloud run services update api --memory 4Gi`.',
          verification: 'gcloud run deploy exited 0.',
          entity: 'cloud-run',
        }),
      ),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000g2',
          problem: 'Deploy failed again; the service OOMed.',
          signature: SIG_OOM,
          solution: 'kubectl rollout status deploy/api after the bump, then verify with make check.',
          verification: 'rollout complete.',
          entity: 'cloud-run',
        }),
      ),
    ]);
    const candidate = buildSkillCandidate({ group: group!, takenNames: new Set(), maxEvidenceFailures: 5 });
    // Within one solution the shell-prefixed LINES are scanned before the backtick SPANS; a
    // line's command is its head up to the first sentence terminator (the tail is prose), and a
    // backtick span is explicit command text, kept verbatim.
    expect(candidate.markdown).toContain(
      '```bash\ngcloud run deploy --region europe-west1\ngcloud run services update api --memory 4Gi\nkubectl rollout status deploy/api after the bump, then verify with make check\n```',
    );
    // Prose never leaks into the commands block, and a command's explaining tail is trimmed.
    expect(candidate.markdown).not.toContain('```bash\nScale');
    expect(candidate.markdown).toContain('kubectl rollout status deploy/api after the bump, then verify with make check\n');
  });
});

describe('unionEvidenceSpans', () => {
  test('unions by (source, kind, locator, excerpt), first wins, capped', () => {
    const span = (locator: string): { evidence: EvidenceSpan[] } => ({
      evidence: [
        { source_id: 's1', kind: 'message', locator, excerpt: 'same excerpt' },
      ],
    });
    const union = unionEvidenceSpans([span('l1'), span('l1'), span('l2'), span('l3')], 2);
    expect(union.map((entry) => entry.locator)).toEqual(['l1', 'l2']);
  });
});

// ---------------------------------------------------------------------------
// buildSkillDocument / buildSkillCandidate
// ---------------------------------------------------------------------------

describe('buildSkillDocument', () => {
  test('every canonical section is always present, in order, with deterministic content', () => {
    const document = buildSkillDocument({
      name: 'cloud-run-deploy-failed-with-oom',
      description: 'Fix: Cloud Run deploy failed with OOM.',
      version: '1.0.0',
      failures: qualifiedPair(),
    });
    expect(Object.keys(document)).toEqual([
      'name',
      'description',
      'version',
      'when_to_use',
      'prerequisites',
      'procedure',
      'commands',
      'validation',
      'known_failure_modes',
    ]);
    // "When to use" names the failure as FIRST reported (the canonical phrasing of the
    // recurrence); the procedure carries the most recent (representative) solution.
    expect(document.when_to_use[0]).toBe(
      'The same failure recurs: Cloud Run deploy failed with OOM during gcloud run deploy.',
    );
    expect(document.when_to_use[1]).toContain('Seen 2 times — first 2026-03-01, last 2026-03-05');
    expect(document.when_to_use[1]).toContain(`signature ${SIG_OOM}`);
    // The procedure is the REPRESENTATIVE (most recent) solution, split into steps; validation
    // carries every occurrence's proof (distinct, capped at 3, first occurrence wins).
    expect(document.procedure).toEqual([
      'Raise the Cloud Run memory limit to 4 GiB with gcloud run services update.',
    ]);
    expect(document.validation).toEqual([
      'gcloud run deploy exited 0; the deploy completes under 4 GiB.',
      'the deploy passed with 4 GiB configured.',
    ]);
    expect(document.prerequisites).toEqual(['Cloud Run 2 GiB default memory limit.']);
    expect(document.known_failure_modes).toEqual([]); // the seeded rows carry no root cause
  });

  test('order-independence: the same members in any order render the same document', () => {
    const forward = buildSkillDocument({
      name: 'x',
      description: 'd',
      version: '1.0.0',
      failures: qualifiedPair(),
    });
    const reversed = buildSkillDocument({
      name: 'x',
      description: 'd',
      version: '1.0.0',
      failures: [...qualifiedPair()].reverse(),
    });
    expect(reversed).toEqual(forward);
  });
});

describe('buildSkillCandidate', () => {
  test('assembles the full candidate: name, path, capped evidence, rendered markdown', () => {
    const [group] = groupFailuresBySignature(qualifiedPair());
    const candidate = buildSkillCandidate({ group: group!, takenNames: new Set(), maxEvidenceFailures: 5 });
    expect(candidate.name).toBe('cloud-run-deploy-failed-with-oom');
    expect(candidate.version).toBe('1.0.0');
    expect(candidate.path).toBe('skills/cloud-run-deploy-failed-with-oom/SKILL.md');
    expect(candidate.source.failure_ids).toEqual([
      '00000000-0000-7000-8000-0000000000a1',
      '00000000-0000-7000-8000-0000000000a2',
    ]);
    // verified_at is the most recent evidence failure's last_seen_at.
    expect(candidate.verification.verified_at).toBe('2026-03-05T09:00:00.000Z');
    expect(candidate.verification.evidence.length).toBe(2); // one span per fixture memory
    expect(candidate.markdown.startsWith('---\nname: cloud-run-deploy-failed-with-oom\n')).toBeTrue();
  });

  test('the evidence window is the newest maxEvidenceFailures, capped', () => {
    const members = [
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000h1',
          problem: 'OOM one.',
          signature: SIG_OOM,
          solution: 'Raise the memory limit to 4 GiB.',
          verification: 'passed.',
          entity: 'cloud-run',
          at: '2026-03-01T09:00:00.000Z',
        }),
      ),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000h2',
          problem: 'OOM two.',
          signature: SIG_OOM,
          solution: 'Raise the memory limit to 4 GiB.',
          verification: 'passed.',
          entity: 'cloud-run',
          at: '2026-03-02T09:00:00.000Z',
        }),
      ),
      observationOf(
        failureRecurrence({
          id: '00000000-0000-7000-8000-0000000000h3',
          problem: 'OOM three.',
          signature: SIG_OOM,
          solution: 'Raise the memory limit to 4 GiB.',
          verification: 'passed.',
          entity: 'cloud-run',
          at: '2026-03-03T09:00:00.000Z',
        }),
      ),
    ];
    const [group] = groupFailuresBySignature(members);
    const capped = buildSkillCandidate({ group: group!, takenNames: new Set(), maxEvidenceFailures: 2 });
    expect(capped.source.failure_ids).toEqual([
      '00000000-0000-7000-8000-0000000000h2',
      '00000000-0000-7000-8000-0000000000h3',
    ]);

    // An explicit name (the identity-matched re-run) overrides derivation and stays canonical.
    const renamed = buildSkillCandidate({
      group: group!,
      takenNames: new Set(['oom-three']),
      maxEvidenceFailures: 2,
      name: 'existing-name',
    });
    expect(renamed.name).toBe('existing-name');
    expect(renamed.path).toBe('skills/existing-name/SKILL.md');
    expect(renamed.markdown).toContain('name: existing-name');
  });
});

describe('observationFromMemory (the review rebuild path)', () => {
  test('rebuilds the observation from a hydrated failure memory; null for anything else', () => {
    const hydrated: MemoryRecord = {
      ...memoryFixture({
        id: '00000000-0000-7000-8000-0000000000i1',
        type: 'failure',
        project_id: PROJECT,
      }),
      payload: {
        problem: 'OOM on deploy.',
        context: 'Cloud Run 2 GiB limit.',
        solution: 'Raise the memory limit.',
        verification: 'deploy passed.',
        status: 'solved',
        signature_hash: SIG_OOM,
        first_seen_at: '2026-03-01T09:00:00.000Z',
        last_seen_at: '2026-03-04T09:00:00.000Z',
        occurrence_count: 1,
      },
    };
    const observation = observationFromMemory(hydrated);
    expect(observation).not.toBeNull();
    expect(observation!.problem).toBe('OOM on deploy.');
    expect(observation!.signature_hash).toBe(SIG_OOM);
    expect(observation!.solution).toBe('Raise the memory limit.');
    // The rebuilt scope key matches the live projection (`scopeKeyOf` — the same four parts).
    expect(observation!.scope_key).toBe(`${PROJECT}|∅`);

    const notAFailure = memoryFixture({ id: '00000000-0000-7000-8000-0000000000i2' });
    expect(observationFromMemory(notAFailure)).toBeNull();

    const signatureless: MemoryRecord = {
      ...memoryFixture({ id: '00000000-0000-7000-8000-0000000000i3', type: 'failure' }),
      payload: {
        problem: 'x',
        context: 'y',
        status: 'open',
        first_seen_at: '2026-03-01T09:00:00.000Z',
        last_seen_at: '2026-03-01T09:00:00.000Z',
        occurrence_count: 1,
      },
    };
    expect(observationFromMemory(signatureless)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderSkillMarkdown — the canonical byte contract
// ---------------------------------------------------------------------------

describe('renderSkillMarkdown', () => {
  const document = {
    name: 'cloud-run-deploy-failed-with-oom',
    description: 'Fix: Cloud Run deploy failed with OOM.',
    version: '1.0.0',
    when_to_use: ['The same failure recurs: deploy OOM.'],
    prerequisites: ['Cloud Run 2 GiB default memory limit.'],
    procedure: ['Raise the limit to 4 GiB.', 'Redeploy the service.'],
    commands: ['gcloud run deploy --region europe-west1'],
    validation: ['gcloud run deploy exited 0.'],
    known_failure_modes: ['The default limit is 2 GiB.'],
  };

  test('renders the exact canonical bytes: front matter, six sections in order, LF, one tail', () => {
    const markdown = renderSkillMarkdown(document);
    expect(markdown).toBe(
      [
        '---',
        'name: cloud-run-deploy-failed-with-oom',
        'description: Fix: Cloud Run deploy failed with OOM.',
        'version: 1.0.0',
        '---',
        '',
        '## When to use',
        '- The same failure recurs: deploy OOM.',
        '',
        '## Prerequisites',
        '- Cloud Run 2 GiB default memory limit.',
        '',
        '## Procedure',
        '1. Raise the limit to 4 GiB.',
        '2. Redeploy the service.',
        '',
        '## Commands',
        '```bash',
        'gcloud run deploy --region europe-west1',
        '```',
        '',
        '## Validation',
        '- gcloud run deploy exited 0.',
        '',
        '## Known failure modes',
        '- The default limit is 2 GiB.',
        '',
      ].join('\n'),
    );
    expect(markdown.includes('\r')).toBeFalse();
    expect(markdown.endsWith('\n')).toBeTrue();
    // Exactly the six documented sections, in the documented order.
    expect([...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[0])).toEqual(
      SKILL_MD_SECTIONS.map((section) => `## ${section}`),
    );
  });

  test('idempotent: the same document renders the same bytes on every call', () => {
    expect(renderSkillMarkdown(document)).toBe(renderSkillMarkdown(document));
  });

  test('empty sections are rendered as `None recorded.` — a missing section is a bug, never OK', () => {
    const markdown = renderSkillMarkdown({
      name: 'empty',
      description: 'd',
      version: '1.0.0',
      when_to_use: [],
      prerequisites: [],
      procedure: [],
      commands: [],
      validation: [],
      known_failure_modes: [],
    });
    expect(markdown.match(/None recorded\./g)).toHaveLength(6);
    expect([...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[0])).toEqual(
      SKILL_MD_SECTIONS.map((section) => `## ${section}`),
    );
  });

  test('whitespace is collapsed per line — the canonical form never depends on input spacing', () => {
    const noisy = renderSkillMarkdown({
      ...document,
      when_to_use: ['  The   same   failure\trecurs: deploy OOM.  '],
      procedure: ['Raise   the limit to 4 GiB.', '', 'Redeploy the service.'],
    });
    expect(noisy).toContain('- The same failure recurs: deploy OOM.\n');
    expect(noisy).toContain('1. Raise the limit to 4 GiB.\n2. Redeploy the service.\n');
  });
});
