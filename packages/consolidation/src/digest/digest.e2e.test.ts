/**
 * The M14.5 acceptance scenario, end to end through the REAL tool surface (AC 6): seed a project
 * with decisions, failures and procedures → run the digest pass → read the project context back
 * through the MCP `memory_project_context` tool handler over the same storage the pass wrote.
 *
 * The tool's `digest` section is assembled from `projects.digest` (retrieval.md §2) — the digest
 * pass's renderable projection — so the rollup surfaces with ZERO changes to the tool surface:
 * the session-start context carries the digest entries (whole lines, within the 750-token
 * session budget), the "project digest not yet built (consolidation pending)" warning is gone,
 * and the durable digest memory the pass wrote sits in the store, well-formed and in budget.
 */

import { describe, expect, test } from 'bun:test';

import { createOnememoryMcpContext, handleMemoryProjectContext } from '@onememory/mcp';

import { runDigest } from './run';
import { seedDigestWorld, WORLD_NOW } from './fixtures';

describe('M14.5 acceptance: the digest surfaces via the MCP memory_project_context tool', () => {
  test('seed → runDigest → memory_project_context reads the rollup back, in budget', async () => {
    const world = await seedDigestWorld();
    try {
      // Before: the tool warns that the digest rollup has not been built yet.
      const ctxBefore = await createOnememoryMcpContext({ storage: world.storage, now: WORLD_NOW });
      const before = await handleMemoryProjectContext(ctxBefore, { project_id: world.projectId });
      expect(before.warnings.some((warning) => warning.includes('project digest not yet built'))).toBe(true);

      // The pass: created, in budget, well-formed (the full row-level assertions live in
      // run.test.ts — here the tool surface is the subject).
      const report = await runDigest({
        store: world.storage.store,
        client: world.storage.client,
        project_id: world.projectId,
        now: WORLD_NOW,
      });
      expect(report.outcome).toBe('created');
      expect(report.digest!.used).toBeLessThanOrEqual(750);
      const memory = await world.storage.store.getMemory(report.memory_id!);
      expect(memory!.subtype).toBe('project_context');
      expect(memory!.token_estimate).toBe(report.digest!.used);

      // After: the same tool reads the project back and the digest section carries the rollup —
      // the accepted decision (with its payload rationale), the recurring failure with its
      // solution, the top procedure — plus the preserved foreign digest keys.
      const ctx = await createOnememoryMcpContext({ storage: world.storage, now: WORLD_NOW });
      const structured = await handleMemoryProjectContext(ctx, { project_id: world.projectId });
      expect(structured.project_id).toBe(world.projectId);
      expect(structured.budget).toBe(750);
      expect(structured.used).toBeLessThanOrEqual(750);
      expect(structured.token_estimate).toBe(structured.used);

      const digest = structured.sections.find((section) => section.kind === 'digest');
      expect(digest).toBeDefined();
      expect(digest!.text).toContain('project: acme-api');
      expect(digest!.text).toContain(`decision 01: ${world.cited.decisionB.line}`);
      expect(digest!.text).toContain(`failure 01: ${world.cited.failureOpen.line}`);
      expect(digest!.text).toContain(`procedure 01: ${world.cited.procedureA.line}`);
      expect(structured.warnings.some((warning) => warning.includes('project digest not yet built'))).toBe(false);

      // The section accounting holds: tokens sum to used, text is the sections joined.
      expect(structured.used).toBe(structured.sections.reduce((sum, section) => sum + section.tokens, 0));
      expect(structured.text).toBe(structured.sections.map((section) => section.text).join('\n\n'));
    } finally {
      await world.close();
    }
  });
});
