import { describe, expect, test } from 'bun:test';

import {
  DecisionPayloadSchema,
  FailurePayloadSchema,
  MemoryPayloadSchema,
  MemoryRecordSchema,
  SkillPayloadSchema,
} from './memory';
import { ExtractionResultSchema } from './extraction';
import { MemorySearchRequestSchema, MemorySearchResponseSchema } from './search';
import { NewMemorySchema } from './persistence';

const evidence = [
  {
    source_id: '0192f3c0-0000-7000-8000-000000000010',
    kind: 'message',
    locator: 'session.jsonl:183',
    excerpt: 'We upgraded to Node 22',
  },
] as const;

describe('memory wire representation (§4)', () => {
  const record = {
    id: '0192f3c0-0000-7000-8000-000000000001',
    type: 'decision',
    title: 'Node 22',
    content: 'This project uses Node 22.',
    status: 'active',
    importance: 0.8,
    confidence: 0.9,
    access_count: 0,
    observed_at: '2025-06-01T00:00:00.000Z',
    valid_from: '2025-06-01T00:00:00.000Z',
    created_at: '2025-06-01T00:00:01.000Z',
    updated_at: '2025-06-01T00:00:01.000Z',
    provenance: {
      source: {
        id: '0192f3c0-0000-7000-8000-000000000010',
        kind: 'conversation',
        uri: 'conversation/session/x',
      },
      evidence: [...evidence],
      extraction: { method: 'heuristic', prompt_version: 'v1' },
    },
    entities: [
      { id: '0192f3c0-0000-7000-8000-000000000011', name: 'Node.js', kind: 'language' },
    ],
    tags: ['runtime'],
    token_estimate: 12,
  };

  test('a doc-shaped MemoryRecord validates', () => {
    const parsed = MemoryRecordSchema.safeParse(record);
    expect(parsed.success).toBe(true);
  });

  test('importance/confidence bounds are enforced', () => {
    expect(MemoryRecordSchema.safeParse({ ...record, importance: 1.5 }).success).toBe(false);
    expect(MemoryRecordSchema.safeParse({ ...record, confidence: -0.1 }).success).toBe(false);
  });

  test('all seven memory types (incl. working) are accepted on the wire', () => {
    for (const type of [
      'episodic',
      'semantic',
      'procedural',
      'decision',
      'failure',
      'preference',
      'working',
    ]) {
      expect(MemoryRecordSchema.safeParse({ ...record, type }).success).toBe(true);
    }
  });

  test('typed payloads attach per type (§5)', () => {
    const withPayload = {
      ...record,
      payload: {
        title: 'Node 22',
        decision: 'Use Node 22',
        alternatives: [{ option: 'stay on 20', why_rejected: 'EOL' }],
        rationale: 'LTS support',
        participants: ['team'],
        decided_at: '2025-06-01T00:00:00.000Z',
        status: 'accepted',
        evidence: [...evidence],
      },
    };
    expect(MemoryPayloadSchema.safeParse(withPayload.payload).success).toBe(true);
    expect(MemoryRecordSchema.safeParse(withPayload).success).toBe(true);
  });
});

describe('typed payloads (§5)', () => {
  test('decision payload validates', () => {
    expect(
      DecisionPayloadSchema.safeParse({
        title: 'Postgres dialect',
        decision: 'One Postgres dialect, three targets',
        alternatives: [],
        rationale: 'avoid two dialects (risk R14)',
        participants: ['architect'],
        decided_at: '2026-10-03T00:00:00.000Z',
        status: 'accepted',
        evidence: [...evidence],
      }).success,
    ).toBe(true);
  });

  test('failure payload validates and requires the recurrence fields', () => {
    expect(
      FailurePayloadSchema.safeParse({
        problem: 'pglite SIGSEGV',
        context: 'two processes, one data dir',
        status: 'open',
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-01T00:00:00.000Z',
        occurrence_count: 1,
      }).success,
    ).toBe(true);
    expect(
      FailurePayloadSchema.safeParse({
        problem: 'x',
        context: 'y',
        status: 'open',
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_seen_at: '2026-07-01T00:00:00.000Z',
        occurrence_count: 0,
      }).success,
    ).toBe(false);
  });

  test('skill payload enforces kebab-case name + semver version', () => {
    const skill = {
      name: 'cloud-run-permission-fix',
      description: 'Fix Cloud Run deploy permission errors',
      version: '1.0.0',
      status: 'candidate',
      source: { failure_ids: ['0192f3c0-0000-7000-8000-000000000021'] },
      verification: {
        evidence: [...evidence],
        verified_at: '2026-10-01T00:00:00.000Z',
      },
      path: 'skills/cloud-run-permission-fix/SKILL.md',
      usage_count: 0,
    };
    expect(SkillPayloadSchema.safeParse(skill).success).toBe(true);
    expect(SkillPayloadSchema.safeParse({ ...skill, name: 'Not Kebab' }).success).toBe(false);
    expect(SkillPayloadSchema.safeParse({ ...skill, version: 'v1' }).success).toBe(false);
  });
});

describe('extraction output schema (§3)', () => {
  const result = {
    memories: [
      {
        type: 'decision',
        content: 'This project uses Node 22.',
        importance: 0.8,
        confidence: 0.9,
        entities: ['Node.js'],
        evidence: [...evidence],
        future_value_rationale: 'recurring version question',
      },
      {
        type: 'semantic_candidate',
        content: 'The team prefers bun over npm.',
        importance: 0.6,
        confidence: 0.5,
        entities: [],
        evidence: [...evidence],
      },
    ],
    working: [{ kind: 'open_question', content: 'Why did the deploy fail?', session_id: 's1' }],
    session_summary: 'Upgraded Node and fixed the deploy.',
    extraction_meta: { method: 'heuristic', prompt_version: 'h1' },
  };

  test('a valid extraction result validates', () => {
    expect(ExtractionResultSchema.safeParse(result).success).toBe(true);
  });

  test('durable candidates REQUIRE evidence (provenance invariant)', () => {
    const noEvidence = {
      memories: [
        {
          type: 'episodic',
          content: 'x',
          importance: 0.5,
          confidence: 0.5,
          entities: [],
          evidence: [],
        },
      ],
      working: [],
      extraction_meta: { method: 'llm', prompt_version: 'p1' },
    };
    expect(ExtractionResultSchema.safeParse(noEvidence).success).toBe(false);
  });

  test('content length budget: ≤500 chars for candidates, ≤300 for working', () => {
    const longContent = { ...result, memories: [{ ...result.memories[0]!, content: 'x'.repeat(501) }] };
    expect(ExtractionResultSchema.safeParse(longContent).success).toBe(false);
    const longWorking = {
      ...result,
      working: [{ kind: 'task', content: 'y'.repeat(301), session_id: 's1' }],
    };
    expect(ExtractionResultSchema.safeParse(longWorking).success).toBe(false);
  });
});

describe('retrieval request/response (§6)', () => {
  test('a minimal search request validates with defaults left to the caller', () => {
    expect(MemorySearchRequestSchema.safeParse({ query: 'node version' }).success).toBe(true);
  });

  test('as_of + temporal mode validate; bad uuid does not', () => {
    expect(
      MemorySearchRequestSchema.safeParse({
        query: 'node',
        as_of: '2025-01-01T00:00:00.000Z',
        temporal_mode: 'historical',
        include: ['superseded'],
      }).success,
    ).toBe(true);
    expect(
      MemorySearchRequestSchema.safeParse({ query: 'node', project_id: 'nope' }).success,
    ).toBe(false);
  });

  test('a full response shape validates, including explain factors', () => {
    const response = {
      query_understanding: {
        intent: 'fact',
        entities: [{ name: 'Node.js', matched_id: '0192f3c0-0000-7000-8000-000000000011' }],
        time_scope: { mode: 'current' },
        keywords: ['node', 'version'],
      },
      memories: [
        {
          id: '0192f3c0-0000-7000-8000-000000000001',
          type: 'decision',
          summary: 'Uses Node 22.',
          relevance: 0.93,
          explain: [
            { factor: 'project_match', weight: 1.2, detail: 'same project scope' },
            { factor: 'temporal_validity', weight: 0.8, detail: 'currently valid' },
          ],
          temporal: {
            valid_from: '2025-06-01T00:00:00.000Z',
            status: 'active',
          },
          provenance: { source_kind: 'conversation' },
        },
      ],
      tokens: { budget: 800, used: 42, packing: 'summary' },
      warnings: [],
    };
    expect(MemorySearchResponseSchema.safeParse(response).success).toBe(true);
    expect(
      MemorySearchResponseSchema.safeParse({
        ...response,
        memories: [
          {
            ...response.memories[0]!,
            explain: [{ factor: 'bogus_factor', weight: 1, detail: 'x' }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('persistence input schemas (store port boundary)', () => {
  const candidate = {
    type: 'semantic',
    content: 'This project uses Node 22.',
    importance: 0.7,
    confidence: 0.8,
    observed_at: '2025-06-01T00:00:00.000Z',
    source_id: '0192f3c0-0000-7000-8000-000000000010',
    evidence: [...evidence],
    extraction: { method: 'heuristic', prompt_version: 'h1' },
  };

  test('a valid durable candidate validates', () => {
    expect(NewMemorySchema.safeParse(candidate).success).toBe(true);
  });

  test('durable types exclude working (it has its own table)', () => {
    expect(NewMemorySchema.safeParse({ ...candidate, type: 'working' }).success).toBe(false);
  });

  test('evidence is mandatory at the store boundary (ADR-0003 rule 4)', () => {
    expect(NewMemorySchema.safeParse({ ...candidate, evidence: [] }).success).toBe(false);
  });

  test('title ≤ 80 and content_summary ≤ 160 budgets', () => {
    expect(NewMemorySchema.safeParse({ ...candidate, title: 'x'.repeat(81) }).success).toBe(false);
    expect(
      NewMemorySchema.safeParse({ ...candidate, content_summary: 'x'.repeat(161) }).success,
    ).toBe(false);
  });
});
