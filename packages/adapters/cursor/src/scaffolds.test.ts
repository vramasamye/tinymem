import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CursorMcpDocumentSchema, buildCursorMcpJson, patchCursorMcpJson } from './mcp-scaffold';
import { CursorHooksFileSchema, buildCursorHooksFile, patchCursorHooksJson } from './hooks-scaffold';
import {
  RULES_BEGIN,
  RULES_END,
  buildOnememoryRuleBlock,
  hasOnememoryRuleBlock,
  patchCursorRule,
  renderCursorRule,
} from './rules';
import { scaffoldCursor } from './scaffold';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-cursor-scaffold-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const URL_7331 = 'http://127.0.0.1:7331/mcp';
const OPTIONS = { root: '', projectId: '019a7c0e-5b1f-7000-8000-00000000e001', projectName: 'demo' };

// ---------------------------------------------------------------------------
// .cursor/mcp.json
// ---------------------------------------------------------------------------

describe('cursor mcp.json', () => {
  test('http form emits {url} with no type, validated by the schema', () => {
    const document = buildCursorMcpJson({ transport: 'http', url: URL_7331 });
    expect(CursorMcpDocumentSchema.safeParse(document).success).toBe(true);
    expect(document).toEqual({ mcpServers: { onememory: { url: URL_7331 } } });
  });

  test('http form refuses a non-loopback URL (Phase 1 has no authentication)', () => {
    expect(() => buildCursorMcpJson({ transport: 'http', url: 'http://10.0.0.5:7331/mcp' })).toThrow(/loopback/);
    expect(() => buildCursorMcpJson({ transport: 'http', url: 'https://example.com/mcp' })).toThrow();
  });

  test('http form requires the url', () => {
    expect(() => buildCursorMcpJson({ transport: 'http' })).toThrow(/requires the daemon MCP url/);
  });

  test('stdio form carries type: "stdio" (the reference field table marks it required)', () => {
    const document = buildCursorMcpJson({});
    const entry = document.mcpServers.onememory;
    expect(entry).toMatchObject({ type: 'stdio', command: 'bun' });
    if (!('type' in entry) || entry.type !== 'stdio') throw new Error('expected a stdio entry');
    expect(entry.args?.[0]).toBe('${workspaceFolder}/node_modules/@onememory-ai/mcp/src/bin.ts');
    expect(entry.env?.['ONEMEMORY_MCP_AGENT_ID']).toBe('cursor');
    expect(entry.env?.['ONEMEMORY_DATA_DIR']).toBe('${workspaceFolder}/.onememory');
    expect(entry.env?.['ONEMEMORY_MCP_PROFILE']).toBeUndefined();
  });

  test('server-profile storage passes the Postgres URL through by env NAME, never as a value', () => {
    const document = buildCursorMcpJson({ storage: { mode: 'server' }, profile: 'full11' });
    const entry = document.mcpServers.onememory;
    if (!('env' in entry)) throw new Error('expected an env block');
    expect(entry.env?.['ONEMEMORY_PG_URL']).toBe('${env:ONEMEMORY_PG_URL}');
    expect(entry.env?.['ONEMEMORY_MCP_PROFILE']).toBe('full11');
  });

  test('patch creates, then is byte-identical on re-run (unchanged)', () => {
    const first = patchCursorMcpJson(null, { transport: 'http', url: URL_7331 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.action).toBe('created');
    const second = patchCursorMcpJson(first.content, { transport: 'http', url: URL_7331 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  test('patch preserves foreign servers and unknown top-level keys', () => {
    const existing = `${JSON.stringify(
      { mcpServers: { other: { url: 'http://127.0.0.1:9000/sse' } }, theme: 'dark' },
      null,
      2,
    )}\n`;
    const patched = patchCursorMcpJson(existing, { transport: 'http', url: URL_7331 });
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    const document = JSON.parse(patched.content) as Record<string, unknown>;
    expect(document['theme']).toBe('dark');
    expect((document['mcpServers'] as Record<string, unknown>)['other']).toEqual({
      url: 'http://127.0.0.1:9000/sse',
    });
    expect((document['mcpServers'] as Record<string, unknown>)['onememory']).toEqual({ url: URL_7331 });
  });

  test('patch refuses an unparseable or wrongly shaped file instead of clobbering it', () => {
    const broken = patchCursorMcpJson('{ not json', { transport: 'http', url: URL_7331 });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain('not valid JSON');
    const wrongShape = patchCursorMcpJson('{"mcpServers": []}', { transport: 'http', url: URL_7331 });
    expect(wrongShape.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// .cursor/hooks.json
// ---------------------------------------------------------------------------

describe('cursor hooks.json', () => {
  test('the generated document validates and subscribes exactly the mapped events', () => {
    const document = buildCursorHooksFile();
    expect(CursorHooksFileSchema.safeParse(document).success).toBe(true);
    expect(document.version).toBe(1);
    expect(Object.keys(document.hooks)).toEqual([
      'sessionStart',
      'sessionEnd',
      'beforeSubmitPrompt',
      'afterAgentResponse',
      'postToolUse',
      'postToolUseFailure',
      'afterFileEdit',
    ]);
    // stop is deliberately not subscribed (per-turn loop end; the sweep rides sessionEnd).
    expect(document.hooks['stop']).toBeUndefined();
    expect(document.hooks['preToolUse']).toBeUndefined();
    // postToolUse only spawns for Shell executions.
    expect(document.hooks['postToolUse']?.[0]?.matcher).toBe('Shell');
  });

  test('project hooks use a project-root-relative command (Cursor runs project hooks from the root)', () => {
    const entry = buildCursorHooksFile().hooks['sessionStart']?.[0];
    expect(entry?.command).toBe('bun node_modules/@onememory-ai/adapter-cursor/src/bin.ts');
    expect(entry?.timeout).toBe(10);
  });

  test('patch is idempotent and keeps foreign hooks', () => {
    const existing = `${JSON.stringify(
      { version: 1, hooks: { sessionStart: [{ command: './my-audit.sh' }], stop: [{ command: './stop.sh' }] } },
      null,
      2,
    )}\n`;
    const patched = patchCursorHooksJson(existing, {});
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.action).toBe('patched');
    const document = JSON.parse(patched.content) as { hooks: Record<string, Array<{ command: string }>> };
    expect(document.hooks['sessionStart']?.map((entry) => entry.command)).toEqual([
      './my-audit.sh',
      'bun node_modules/@onememory-ai/adapter-cursor/src/bin.ts',
    ]);
    expect(document.hooks['stop']).toEqual([{ command: './stop.sh' }]);
    const again = patchCursorHooksJson(patched.content, {});
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.action).toBe('unchanged');
  });

  test('patch refuses an unparseable file', () => {
    const broken = patchCursorHooksJson('nope', {});
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain('not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// .cursor/rules/onememory.mdc
// ---------------------------------------------------------------------------

describe('cursor rule', () => {
  test('a fresh rule declares alwaysApply: true (the whole point of a bootstrap)', () => {
    const content = renderCursorRule({ projectName: 'demo' });
    expect(content.startsWith('---\ndescription: "')).toBe(true);
    expect(content).toContain('\nalwaysApply: true\n---\n');
    expect(content).toContain('Project memory for demo (onememory)');
    expect(hasOnememoryRuleBlock(content)).toBe(true);
  });

  test('patch creates, then replaces only the fenced block (user frontmatter preserved)', () => {
    const created = patchCursorRule(null, {});
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.action).toBe('created');
    const unchanged = patchCursorRule(created.content, {});
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect(unchanged.action).toBe('unchanged');

    const userEdited = created.content;
    const withProse = userEdited.replace(RULES_END, `${RULES_END}\n\nMy own note below the block.`);
    // Prose outside the block is never the reason for a rewrite.
    const untouched = patchCursorRule(withProse, {});
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(untouched.action).toBe('unchanged');
    // A stale block IS regenerated, and the surrounding prose survives.
    const tampered = withProse.replace('## Project memory (onememory)', '## Project memory (stale heading)');
    const patched = patchCursorRule(tampered, {});
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.action).toBe('patched');
    expect(patched.content).toContain('My own note below the block.');
    expect(patched.content).toContain('## Project memory (onememory)');
    expect(patched.content).toContain('alwaysApply: true');
  });

  test('appending to a foreign file keeps the file and flags the missing frontmatter upstream', () => {
    const existing = '# My own rules\n\n- be nice\n';
    const patched = patchCursorRule(existing, {});
    expect(patched.ok).toBe(true);
    if (!patched.ok) return;
    expect(patched.content.startsWith('# My own rules')).toBe(true);
    expect(patched.content).toContain(RULES_BEGIN);
    expect(patched.content).toContain(RULES_END);
    expect(hasOnememoryRuleBlock(patched.content)).toBe(true);
  });

  test('the block is marker-fenced and self-describing', () => {
    expect(buildOnememoryRuleBlock()).toContain('mcp__onememory__*');
  });
});

// ---------------------------------------------------------------------------
// scaffoldCursor
// ---------------------------------------------------------------------------

describe('scaffoldCursor', () => {
  test('dryRun returns the exact bytes without touching disk', () => {
    const root = tempDir();
    const result = scaffoldCursor({ ...OPTIONS, root, transport: 'http', url: URL_7331, dryRun: true });
    expect(result.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    expect(result.files.map((file) => file.path)).toEqual([
      join(root, '.cursor', 'mcp.json'),
      join(root, '.cursor', 'hooks.json'),
      join(root, '.cursor', 'rules', 'onememory.mdc'),
    ]);
    // Every artifact parses / is well formed.
    expect(JSON.parse(result.files[0]!.content).mcpServers.onememory.url).toBe(URL_7331);
    expect(CursorHooksFileSchema.safeParse(JSON.parse(result.files[1]!.content)).success).toBe(true);
    expect(hasOnememoryRuleBlock(result.files[2]!.content)).toBe(true);
    expect(existsSync(join(root, '.cursor'))).toBe(false);
  });

  test('creates all three artifacts on a fresh project and is a no-op on re-run', () => {
    const root = tempDir();
    const first = scaffoldCursor({ ...OPTIONS, root, transport: 'http', url: URL_7331 });
    expect(first.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    expect(existsSync(join(root, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'hooks.json'))).toBe(true);
    expect(existsSync(join(root, '.cursor', 'rules', 'onememory.mdc'))).toBe(true);
    expect(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')).toBe(first.files[0]!.content);

    const second = scaffoldCursor({ ...OPTIONS, root, transport: 'http', url: URL_7331 });
    expect(second.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  test('warns about tool approval and about a frontmatter-less existing rule', () => {
    const root = tempDir();
    mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'rules', 'onememory.mdc'), '# no frontmatter\n', 'utf8');
    const result = scaffoldCursor({ ...OPTIONS, root, transport: 'http', url: URL_7331 });
    expect(result.warnings.some((warning) => warning.includes('tool approval'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('without frontmatter'))).toBe(true);
  });

  test('a malformed mcp.json is skipped with a warning and left untouched', () => {
    const root = tempDir();
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), '{ broken', 'utf8');
    const result = scaffoldCursor({ ...OPTIONS, root, transport: 'http', url: URL_7331 });
    expect(result.files[0]!.action).toBe('skipped');
    expect(result.warnings.some((warning) => warning.includes('not valid JSON'))).toBe(true);
    expect(readFileSync(join(root, '.cursor', 'mcp.json'), 'utf8')).toBe('{ broken');
    // The other two artifacts are still written.
    expect(result.files[1]!.action).toBe('created');
    expect(result.files[2]!.action).toBe('created');
  });
});
