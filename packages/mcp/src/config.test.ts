import { describe, expect, test } from 'bun:test';

import { mcpConfigFromEnv, resolveMcpConfig } from './config';
import { DEFAULT_TOOLS, FULL11_EXTRA_TOOLS, toolsForProfile, type ToolProfile } from './schemas';

describe('mcp config', () => {
  test('defaults: default8 profile, embedded storage, local-first agent id', () => {
    const config = resolveMcpConfig();
    expect(config.profile).toBe('default8');
    expect(config.storage).toEqual({ mode: 'embedded', dataDir: '.onememory' });
    expect(config.agentId).toBe('onememory-mcp');
    expect(config.projectId).toBeUndefined();
    expect(config.embedder).toBeUndefined();
  });

  test('profile is runtime-configurable: default8 exposes exactly the 8 ADR-0010 tools', () => {
    expect(toolsForProfile('default8')).toEqual([...DEFAULT_TOOLS]);
    expect(toolsForProfile('default8')).toHaveLength(8);
  });

  test('profile full11 adds exactly the three curated list tools, same order', () => {
    const full11 = toolsForProfile('full11');
    expect(full11).toHaveLength(11);
    expect(full11.slice(0, 8)).toEqual([...DEFAULT_TOOLS]);
    expect(full11.slice(8)).toEqual([...FULL11_EXTRA_TOOLS]);
  });

  test('explicit config wins over defaults', () => {
    const config = resolveMcpConfig({
      profile: 'full11',
      storage: { mode: 'server', url: 'postgres://localhost:5432/onemem' },
      projectId: '0199aaaa-0000-7000-8000-000000000001',
      agentId: 'claude-code',
    });
    expect(config.profile).toBe('full11');
    expect(config.storage.mode).toBe('server');
    expect(config.agentId).toBe('claude-code');
  });

  test('invalid profile value is rejected loudly', () => {
    expect(() => resolveMcpConfig({ profile: 'all' as ToolProfile })).toThrow();
  });
});

describe('mcpConfigFromEnv', () => {
  test('empty env → defaults (fully offline local profile)', () => {
    const config = mcpConfigFromEnv({});
    expect(config.profile).toBe('default8');
    expect(config.storage).toEqual({ mode: 'embedded', dataDir: '.onememory' });
  });

  test('ONEMEMORY_DATA_DIR switches the embedded dir', () => {
    const config = mcpConfigFromEnv({ ONEMEMORY_DATA_DIR: '/tmp/om-data' });
    expect(config.storage).toEqual({ mode: 'embedded', dataDir: '/tmp/om-data' });
  });

  test('ONEMEMORY_PG_URL switches to the server storage profile (shared-server mode)', () => {
    const config = mcpConfigFromEnv({ ONEMEMORY_PG_URL: 'postgres://user:secret@db:5432/onememory' });
    expect(config.storage.mode).toBe('server');
    // The URL is config, never surfaced by any tool result (secrets never enter memory).
  });

  test('ONEMEMORY_PG_URL beats ONEMEMORY_DATA_DIR (server mode is the explicit shared choice)', () => {
    const config = mcpConfigFromEnv({
      ONEMEMORY_DATA_DIR: '/tmp/om-data',
      ONEMEMORY_PG_URL: 'postgres://db/onememory',
    });
    expect(config.storage.mode).toBe('server');
  });

  test('ONEMEMORY_PROJECT_ID + ONEMEMORY_MCP_PROFILE + agent id are honored', () => {
    const config = mcpConfigFromEnv({
      ONEMEMORY_PROJECT_ID: '0199bbbb-0000-7000-8000-000000000002',
      ONEMEMORY_MCP_PROFILE: 'full11',
      ONEMEMORY_MCP_AGENT_ID: 'codex',
    });
    expect(config.projectId).toBe('0199bbbb-0000-7000-8000-000000000002');
    expect(config.profile).toBe('full11');
    expect(config.agentId).toBe('codex');
  });

  test('invalid ONEMEMORY_MCP_PROFILE fails loudly at boot (never silently ignored)', () => {
    expect(() => mcpConfigFromEnv({ ONEMEMORY_MCP_PROFILE: 'everything' })).toThrow(/ONEMEMORY_MCP_PROFILE/);
  });
});
