import { describe, expect, test } from 'bun:test';

import {
  AGENTS_BLOCK_BEGIN_PREFIX,
  AGENTS_BLOCK_END_MARKER,
  hasOnememoryAgentsBlock,
  patchAgentsMd,
  renderOnememoryAgentsBlock,
} from './agents-md';

const PROJECT_ID = '01900000-0000-7000-8000-000000000c07';

describe('renderOnememoryAgentsBlock', () => {
  test('is a compact pointer, not a knowledge base', () => {
    const block = renderOnememoryAgentsBlock({ projectId: PROJECT_ID });
    expect(block.length).toBeLessThan(1200);
    expect(block.startsWith(`${AGENTS_BLOCK_BEGIN_PREFIX}${PROJECT_ID}`)).toBe(true);
    expect(block.trimEnd().endsWith(AGENTS_BLOCK_END_MARKER)).toBe(true);
    expect(block).toContain('memory_search');
    expect(block).toContain('memory_get');
    expect(block).toContain('memory_store');
    expect(block).toContain('do not maintain a duplicate knowledge');
  });

  test('carries no memory content and no secrets — only tool guidance', () => {
    const block = renderOnememoryAgentsBlock({ projectId: PROJECT_ID });
    // No memory-body text: the block must never carry decisions, failures, or credentials —
    // it points at the MCP tools instead of embedding their output.
    expect(block).not.toContain('password');
    expect(block).not.toContain('sk-');
    expect(block).not.toContain('postgres://');
    expect(block).not.toMatch(/^## Decisions/m);
  });
});

describe('patchAgentsMd', () => {
  test('appends with clean separation to an existing file', () => {
    const existing = '# AGENTS.md\n\n- Run `npm test` before opening a PR.\n';
    const patched = patchAgentsMd(existing, renderOnememoryAgentsBlock({ projectId: PROJECT_ID }));
    expect(patched.startsWith(existing)).toBe(true);
    expect(patched).toContain(`${AGENTS_BLOCK_BEGIN_PREFIX}${PROJECT_ID}`);
    expect((patched.match(new RegExp(AGENTS_BLOCK_END_MARKER, 'g')) ?? []).length).toBe(1);
  });

  test('creates the file when the document is empty', () => {
    const patched = patchAgentsMd('', renderOnememoryAgentsBlock({ projectId: PROJECT_ID }));
    expect(patched.startsWith(AGENTS_BLOCK_BEGIN_PREFIX)).toBe(true);
  });

  test('replaces its own block in place, preserving everything around it', () => {
    const block = renderOnememoryAgentsBlock({ projectId: PROJECT_ID });
    const existing = `# Header

${block}

## Tail section

- user content stays
`;
    const replacement = renderOnememoryAgentsBlock({ projectId: '01900000-0000-7000-8000-000000000d99' });
    const patched = patchAgentsMd(existing, replacement);
    expect(patched).toContain('# Header');
    expect(patched).toContain('- user content stays');
    expect(patched).toContain('project=01900000-0000-7000-8000-000000000d99');
    expect(patched).not.toContain(PROJECT_ID);
    expect((patched.match(new RegExp(AGENTS_BLOCK_END_MARKER, 'g')) ?? []).length).toBe(1);
  });

  test('re-patching the same block is byte-idempotent', () => {
    const block = renderOnememoryAgentsBlock({ projectId: PROJECT_ID });
    const once = patchAgentsMd('# AGENTS.md\n\nuser line\n', block);
    const twice = patchAgentsMd(once, block);
    expect(twice).toBe(once);
  });

  test('an orphaned begin marker leaves the file untouched (never clobbers blindly)', () => {
    const corrupt = `# AGENTS.md\n${AGENTS_BLOCK_BEGIN_PREFIX}${PROJECT_ID} x)\norphan content with no end marker\n`;
    const patched = patchAgentsMd(corrupt, renderOnememoryAgentsBlock({ projectId: PROJECT_ID }));
    expect(patched).toBe(corrupt);
    expect(hasOnememoryAgentsBlock(corrupt, PROJECT_ID)).toBe(false);
  });

  test('hasOnememoryAgentsBlock detects a complete block for the project', () => {
    const content = patchAgentsMd('# x\n', renderOnememoryAgentsBlock({ projectId: PROJECT_ID }));
    expect(hasOnememoryAgentsBlock(content, PROJECT_ID)).toBe(true);
    expect(hasOnememoryAgentsBlock(content, '01900000-0000-7000-8000-000000000eee')).toBe(false);
  });
});
