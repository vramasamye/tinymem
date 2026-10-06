/**
 * The M15 golden skills dataset — committed failure→fix pairs the evaluator runs the REAL
 * generation engine over (grouping + gate + candidate build + canonical render; zero models,
 * zero network). Every fixture names its expected outcome: the skill a qualifying group must
 * produce (with content probes pinned to specific sections) or the typed reason a group must
 * be blocked with. A regression in the matcher, the gate, the extraction, or the renderer
 * breaks a probe and fails the gate — the benchmark is a CI contract, not a smoke test.
 */

import type { FailureObservation } from '@onememory/consolidation';

/** The char bound a generated SKILL.md must stay under (token-efficiency rule 7: a skill is a
 * retrieval artifact, never a transcript — the bound keeps the floor honest while the templated
 * form is the only tier). */
export const SKILL_MD_CHAR_BOUND = 4000;

/** One failure observation in the golden pool, with its fixture identity. */
export interface SkillsFixtureFailure {
  key: string;
  observation: FailureObservation;
}

/** A content probe: a substring the generated artifact must contain in a named section. */
export interface SkillsContentProbe {
  /** The canonical section heading the probe belongs under. */
  section: string;
  /** Text that must appear within that section's body. */
  contains: string;
}

export interface SkillsExpectedCandidate {
  /** The deterministic skill name the group must produce. */
  name: string;
  probes: SkillsContentProbe[];
}

export interface SkillsExpectedBlocked {
  reason: 'insufficient_solved_failures' | 'divergent_solutions' | 'no_verification_evidence';
}

/** The expected outcome of one signature group — exactly one of candidate / blocked. */
export interface SkillsFixtureCase {
  key: string;
  /** One sentence naming the scenario (reports and failures read it). */
  about: string;
  candidate?: SkillsExpectedCandidate;
  blocked?: SkillsExpectedBlocked;
}

export interface SkillsGoldenDataset {
  cases: SkillsFixtureCase[];
  failures: SkillsFixtureFailure[];
}

// ---------------------------------------------------------------------------
// The fixture pool
// ---------------------------------------------------------------------------

const CLOUD_RUN_PROJECT = '00000000-0000-7000-8003-0000000000c1';
const BILLING_PROJECT = '00000000-0000-7000-8003-0000000000c2';

interface FixtureInput {
  key: string;
  project: string;
  entity: string;
  signature: string;
  problem: string;
  context?: string;
  rootCause?: string;
  solution?: string;
  verification?: string;
  at: string;
  firstSeen?: string;
}

let seq = 0;
function observation(input: FixtureInput): SkillsFixtureFailure {
  seq += 1;
  const id = `00000000-0000-7000-8003-${String(seq).padStart(12, '0')}`;
  const observation: FailureObservation = {
    memory_id: id,
    scope_key: `${input.project}|∅`,
    project_id: input.project,
    observed_at: input.at,
    problem: input.problem,
    context: input.context ?? 'fixture context',
    root_cause: input.rootCause ?? null,
    solution: input.solution ?? null,
    verification: input.verification ?? null,
    signature_hash: input.signature,
    first_seen_at: input.firstSeen ?? input.at,
    last_seen_at: input.at,
    entities: [input.entity],
    evidence: [
      { source_id: `${id}-source`, kind: 'message', locator: `session.jsonl:${id}`, excerpt: input.problem.slice(0, 80) },
    ],
  };
  return { key: input.key, observation };
}

const OOM_SOLUTION =
  'Raise the Cloud Run memory limit to 4 GiB by running `gcloud run services update api --memory 4Gi`, then redeploy.';
const OOM_VERIFICATION = 'gcloud run deploy exited 0 and the deploy completes under the 4 GiB limit.';

const CONN_SOLUTION =
  'Raise the connection pool ceiling in the API config and restart the service with `kubectl rollout restart deploy/api`.';

/**
 * The committed cases. `same-signature-cross-scope` duplicates the connection-exhausted
 * signature across two projects ON PURPOSE: it pins both the scope discipline (the groups never
 * merge) and the collision path (the second qualifying group takes the signature-discriminated
 * name — deterministic, never a silent overwrite).
 */
export const SKILLS_GOLDEN_DATASET: SkillsGoldenDataset = {
  cases: [
    {
      key: 'cloud-run-oom',
      about: 'Two solved+verified OOM deploys with equivalent solutions become one skill',
      candidate: {
        name: 'cloud-run-deploy-failed-with-oom',
        probes: [
          { section: 'Commands', contains: 'gcloud run services update api --memory 4Gi' },
          { section: 'Validation', contains: 'gcloud run deploy exited 0' },
          { section: 'Known failure modes', contains: 'The 2 GiB default limit' },
          { section: 'When to use', contains: 'Cloud Run deploy failed with OOM' },
        ],
      },
    },
    {
      key: 'port-in-use',
      about: 'A single solved occurrence is never a skill (the ≥ 2 floor)',
      blocked: { reason: 'insufficient_solved_failures' },
    },
    {
      key: 'divergent-fixes',
      about: 'Two solved occurrences fixed different ways do not yield one procedure',
      blocked: { reason: 'divergent_solutions' },
    },
    {
      key: 'unverified-fix',
      about: 'Equivalent solutions without verification evidence stay out (the proof gate)',
      blocked: { reason: 'no_verification_evidence' },
    },
    {
      key: 'postgres-connections-cloud-run',
      about: 'The connection-exhausted signature qualifies in the cloud-run project',
      candidate: {
        // The deterministic slug: the first six significant words of the problem.
        name: 'postgres-says-too-many-connections-when',
        probes: [
          { section: 'Commands', contains: 'kubectl rollout restart deploy/api' },
          { section: 'Validation', contains: 'under the raised ceiling' },
        ],
      },
    },
    {
      key: 'postgres-connections-billing',
      about: 'The SAME signature in another project is a separate skill with its OWN name namespace',
      candidate: {
        // Skill names are project-scoped (like the SKILL.md path): the billing project's
        // skill takes the same base name without discrimination — never a merge, never a
        // cross-project overwrite.
        name: 'postgres-says-too-many-connections-when',
        probes: [{ section: 'When to use', contains: 'Seen 2 times' }],
      },
    },
  ],
  failures: [
    // cloud-run-oom: two solved + verified occurrences, equivalent solutions.
    observation({
      key: 'cloud-run-oom-1', project: CLOUD_RUN_PROJECT, entity: 'cloud-run', signature: 'sig:oom-deploy-exit-137',
      problem: 'Cloud Run deploy failed with OOM during the api build step.',
      context: 'Cloud Run 2 GiB default memory limit on the api service.',
      rootCause: 'The 2 GiB default limit is half of what the release build needs.',
      solution: OOM_SOLUTION, verification: OOM_VERIFICATION, at: '2026-04-01T09:00:00.000Z',
    }),
    observation({
      key: 'cloud-run-oom-2', project: CLOUD_RUN_PROJECT, entity: 'cloud-run', signature: 'sig:oom-deploy-exit-137',
      problem: 'Cloud Run deploy failed with OOM again during the release build.',
      context: 'Cloud Run 2 GiB default memory limit on the api service.',
      rootCause: 'The 2 GiB default limit is half of what the release build needs.',
      solution: OOM_SOLUTION, verification: 'The deploy passed with the 4 GiB limit configured.', at: '2026-04-05T09:00:00.000Z',
      firstSeen: '2026-04-01T09:00:00.000Z',
    }),
    // port-in-use: one solved occurrence.
    observation({
      key: 'port-in-use-1', project: CLOUD_RUN_PROJECT, entity: 'api', signature: 'sig:port-8080-in-use',
      problem: 'Port 8080 already in use when starting the API.',
      context: 'Local dev, macOS, a stale listener from the previous run.',
      solution: 'Kill the stale listener with `lsof -ti:8080 | xargs kill` and restart the API.',
      verification: 'lsof shows no listener and the API boots on 8080.', at: '2026-04-02T09:00:00.000Z',
    }),
    // divergent-fixes: two solved occurrences, different procedures.
    observation({
      key: 'divergent-fixes-1', project: CLOUD_RUN_PROJECT, entity: 'bun', signature: 'sig:bun-test-timeout',
      problem: 'bun test times out on the integration suite.',
      context: 'CI runner, cold database.',
      solution: 'Warm the database with a migration step before the suite.',
      verification: 'The suite completes under the timeout.', at: '2026-04-03T09:00:00.000Z',
    }),
    observation({
      key: 'divergent-fixes-2', project: CLOUD_RUN_PROJECT, entity: 'bun', signature: 'sig:bun-test-timeout',
      problem: 'bun test times out on the integration suite again.',
      context: 'CI runner, cold database.',
      solution: 'Raise the suite timeout in bunfig.toml to 120 seconds.',
      verification: 'The suite completes under the raised timeout.', at: '2026-04-04T09:00:00.000Z',
    }),
    // unverified-fix: two equivalent solutions, no proof either time.
    observation({
      key: 'unverified-fix-1', project: CLOUD_RUN_PROJECT, entity: 'docker', signature: 'sig:docker-ebusy',
      problem: 'docker compose up flakes with EBUSY on the mounted volume.',
      context: 'macOS runner, VirtioFS.',
      solution: 'Add a retry loop around the compose up call.',
      at: '2026-04-02T10:00:00.000Z',
    }),
    observation({
      key: 'unverified-fix-2', project: CLOUD_RUN_PROJECT, entity: 'docker', signature: 'sig:docker-ebusy',
      problem: 'docker compose up flakes with EBUSY on the mounted volume again.',
      context: 'macOS runner, VirtioFS.',
      solution: 'Add a retry loop around the compose up call.',
      at: '2026-04-03T10:00:00.000Z',
    }),
    // postgres-connections-cloud-run: qualifies in the cloud-run project.
    observation({
      key: 'postgres-connections-cloud-run-1', project: CLOUD_RUN_PROJECT, entity: 'postgres', signature: 'sig:conn-pool-exhausted',
      problem: 'Postgres says too many connections when running the test suite.',
      context: 'Server profile, Docker Postgres 17.',
      solution: CONN_SOLUTION, verification: 'The suite passes under the raised ceiling.', at: '2026-04-06T09:00:00.000Z',
    }),
    observation({
      key: 'postgres-connections-cloud-run-2', project: CLOUD_RUN_PROJECT, entity: 'postgres', signature: 'sig:conn-pool-exhausted',
      problem: 'Postgres says too many connections when running the test suite again.',
      context: 'Server profile, Docker Postgres 17.',
      solution: CONN_SOLUTION, verification: 'The suite stays under the raised ceiling.', at: '2026-04-07T09:00:00.000Z',
    }),
    // postgres-connections-billing: the SAME signature, a DIFFERENT project — never merged.
    observation({
      key: 'postgres-connections-billing-1', project: BILLING_PROJECT, entity: 'postgres', signature: 'sig:conn-pool-exhausted',
      problem: 'Postgres says too many connections when running the test suite.',
      context: 'Billing service profile, hosted Postgres.',
      solution: CONN_SOLUTION, verification: 'The suite passes under the raised ceiling.', at: '2026-04-06T09:00:00.000Z',
    }),
    observation({
      key: 'postgres-connections-billing-2', project: BILLING_PROJECT, entity: 'postgres', signature: 'sig:conn-pool-exhausted',
      problem: 'Postgres says too many connections when running the test suite again.',
      context: 'Billing service profile, hosted Postgres.',
      solution: CONN_SOLUTION, verification: 'The suite stays under the raised ceiling.', at: '2026-04-07T09:00:00.000Z',
    }),
  ],
};
