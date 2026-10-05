import { describe, expect, test } from 'bun:test';
import { parse } from 'smol-toml';

import {
  CODEX_TOML_BEGIN_MARKER,
  CODEX_TOML_END_MARKER,
  patchCodexConfigToml,
  PROJECT_MCP_COMMAND,
  renderCodexMcpServerToml,
  tomlString,
} from './config-scaffold';

const PROJECT_ID = '01900000-0000-7000-8000-000000000c07';

function render(options: Partial<Parameters<typeof renderCodexMcpServerToml>[0]> = {}) {
  return renderCodexMcpServerToml({ projectId: PROJECT_ID, ...options });
}

/** The generated block alone parses and carries exactly the verified Codex MCP fields. */
describe('renderCodexMcpServerToml', () => {
  test('parses as TOML with the stdio server table Codex requires', () => {
    const toml = parse(render()) as Record<string, Record<string, unknown>>;
    const server = (toml['mcp_servers'] as Record<string, unknown>)['onememory'] as Record<string, unknown>;
    // The published contract: the command IS the bin entry npm links into node_modules/.bin —
    // relative to the session cwd (Codex resolves it like a path), never a PATH-only assumption
    // and never a src/*.ts source path.
    expect(server['command']).toBe(PROJECT_MCP_COMMAND);
    expect(server['command']).toBe('./node_modules/.bin/onemem-mcp');
    expect(server['startup_timeout_sec']).toBe(20);
    expect(server['env_vars']).toEqual(['ONEMEMORY_PG_URL', 'ONEMEMORY_DATA_DIR']);
    const env = server['env'] as Record<string, string>;
    expect(env['ONEMEMORY_PROJECT_ID']).toBe(PROJECT_ID);
    expect(env['ONEMEMORY_MCP_PROFILE']).toBe('default8');
    expect(env['ONEMEMORY_MCP_AGENT_ID']).toBe('codex');
  });

  test('options are honored: command, args, cwd, dataDir, profile', () => {
    const toml = parse(
      render({
        mcpCommand: 'node',
        args: ['/opt/onememory/bin/onemem-mcp.js'],
        cwd: '/Users/me/project',
        dataDir: '/Users/me/project/.onememory/data',
        profile: 'full11',
      }),
    ) as Record<string, Record<string, unknown>>;
    const server = (toml['mcp_servers'] as Record<string, unknown>)['onememory'] as Record<string, unknown>;
    expect(server['command']).toBe('node');
    expect(server['args']).toEqual(['/opt/onememory/bin/onemem-mcp.js']);
    expect(server['cwd']).toBe('/Users/me/project');
    const env = server['env'] as Record<string, string>;
    expect(env['ONEMEMORY_MCP_PROFILE']).toBe('full11');
    expect(env['ONEMEMORY_DATA_DIR']).toBe('/Users/me/project/.onememory/data');
  });

  test('documents the per-tool output_token_limit budget without imposing one', () => {
    const text = render();
    expect(text).toContain('output_token_limit');
    // The example must stay commented out — an imposed budget is a user decision.
    expect(text).not.toMatch(/^\[mcp_servers\.onememory\.tools\./m);
    expect(text).toContain('# [mcp_servers.onememory.tools.memory_search]');
  });

  test('escapes TOML-hostile values', () => {
    expect(tomlString('a "quoted" \\ path')).toBe('"a \\"quoted\\" \\\\ path"');
    expect(parse(`x = ${tomlString('tab\tand "quotes"')}`)).toEqual({ x: 'tab\tand "quotes"' });
  });
});

/** Patching is idempotent and comment-preserving. */
describe('patchCodexConfigToml', () => {
  const USER_CONFIG = `# my codex config — do not rewrite me
model = "gpt-6.1-sol"

[features]
memories = false

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
`;

  test('appends to a user config and preserves every existing byte', () => {
    const patched = patchCodexConfigToml(USER_CONFIG, render());
    expect(patched.startsWith(USER_CONFIG)).toBe(true);
    const parsed = parse(patched) as Record<string, unknown>;
    expect((parsed['features'] as Record<string, unknown>)['memories']).toBe(false);
    const servers = parsed['mcp_servers'] as Record<string, unknown>;
    expect((servers['context7'] as Record<string, unknown>)['command']).toBe('npx');
    expect((servers['onememory'] as Record<string, unknown>)['command']).toBe(PROJECT_MCP_COMMAND);
  });

  test('replacing a marked block is byte-idempotent', () => {
    const first = patchCodexConfigToml(USER_CONFIG, render());
    const second = patchCodexConfigToml(first, render());
    expect(second).toBe(first);
  });

  test('replacing the block refreshes its options without touching the rest', () => {
    const first = patchCodexConfigToml(USER_CONFIG, render());
    const refreshed = patchCodexConfigToml(first, render({ profile: 'full11' }));
    expect(refreshed.startsWith(USER_CONFIG)).toBe(true);
    expect(refreshed).toContain('ONEMEMORY_MCP_PROFILE = "full11"');
    expect((parse(refreshed) as Record<string, unknown>)['mcp_servers']).toBeDefined();
  });

  test('a hand-added unmarked onememory table is replaced in place, never duplicated', () => {
    const handAdded = `model = "gpt-6.1-sol"

[mcp_servers.onememory]
command = "old-onemem-mcp"

[mcp_servers.context7]
command = "npx"
`;
    const patched = patchCodexConfigToml(handAdded, render());
    expect(patched).not.toContain('old-onemem-mcp');
    expect(patched.match(/^\[mcp_servers\.onememory\]$/gm)).toHaveLength(1);
    const parsed = parse(patched) as Record<string, Record<string, unknown>>;
    const servers = parsed['mcp_servers'] as Record<string, unknown>;
    expect((servers['onememory'] as Record<string, unknown>)['command']).toBe(PROJECT_MCP_COMMAND);
    expect((servers['context7'] as Record<string, unknown>)['command']).toBe('npx');
  });

  test('an empty document becomes just the block', () => {
    const patched = patchCodexConfigToml('', render());
    expect(patched.startsWith(CODEX_TOML_BEGIN_MARKER)).toBe(true);
    expect(patched.trimEnd().endsWith(CODEX_TOML_END_MARKER)).toBe(true);
    expect((parse(patched) as Record<string, unknown>)['mcp_servers']).toBeDefined();
  });

  test('patching twice onto a trailing-table config keeps a single onememory table', () => {
    const config = `${USER_CONFIG}[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "python3 x.py"\n`;
    const first = patchCodexConfigToml(config, render());
    const second = patchCodexConfigToml(first, render());
    expect(second.match(/^\[mcp_servers\.onememory\]$/gm)).toHaveLength(1);
    expect(parse(second)).toBeDefined();
  });
});

/** The daemon-backed Streamable HTTP form (ADR-0010 amendment 2026-10-04). */
describe('renderCodexMcpServerToml — http transport', () => {
  const URL_7331 = 'http://127.0.0.1:7331/mcp';
  const http = (options: Partial<Parameters<typeof renderCodexMcpServerToml>[0]> = {}) =>
    render({ transport: 'http', url: URL_7331, ...options });

  test('emits only url (no command/env/env_vars/startup timeout) and parses as TOML', () => {
    const text = http();
    const server = ((parse(text) as Record<string, unknown>)['mcp_servers'] as Record<string, unknown>)[
      'onememory'
    ] as Record<string, unknown>;
    expect(server).toEqual({ url: URL_7331 });
    expect(text.startsWith(CODEX_TOML_BEGIN_MARKER)).toBe(true);
    expect(text.endsWith(CODEX_TOML_END_MARKER)).toBe(true);
    expect(text).toContain('onemem serve');
  });

  test('stdio-only options are ignored; an explicit startup timeout is honored', () => {
    const server = ((parse(http({ mcpCommand: 'node', dataDir: '/x', startupTimeoutSec: 15 })) as Record<string, unknown>)[
      'mcp_servers'
    ] as Record<string, unknown>)['onememory'];
    expect(server).toEqual({ url: URL_7331, startup_timeout_sec: 15 });
  });

  test('refuses a missing, non-http or non-loopback url', () => {
    expect(() => render({ transport: 'http' })).toThrow(/requires the daemon MCP url/);
    expect(() => http({ url: 'https://127.0.0.1:7331/mcp' })).toThrow(/http:/);
    expect(() => http({ url: 'http://192.168.1.4:7331/mcp' })).toThrow(/loopback/);
    expect(() => http({ url: '::nope' })).toThrow(/not a valid URL/);
    expect(() => http({ url: 'http://localhost:7331/mcp' })).not.toThrow();
  });

  test('patching into an existing config is byte-idempotent and preserves user content', () => {
    const userConfig = `# mine\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.context7]\ncommand = "npx"\n`;
    const first = patchCodexConfigToml(userConfig, http());
    expect(first.startsWith(userConfig)).toBe(true);
    expect(patchCodexConfigToml(first, http())).toBe(first);
    const servers = (parse(first) as Record<string, unknown>)['mcp_servers'] as Record<string, Record<string, unknown>>;
    expect(servers['context7']!['command']).toBe('npx');
    expect(servers['onememory']).toEqual({ url: URL_7331 });
  });

  test('switching a stdio block to http (and the port) replaces it in place', () => {
    const stdio = patchCodexConfigToml('model = "m"\n', render());
    const switched = patchCodexConfigToml(stdio, http());
    expect(switched).not.toContain('command =');
    expect(switched.match(/^\[mcp_servers\.onememory\]$/gm)).toHaveLength(1);
    const moved = patchCodexConfigToml(switched, http({ url: 'http://127.0.0.1:9100/mcp' }));
    const servers = (parse(moved) as Record<string, unknown>)['mcp_servers'] as Record<string, unknown>;
    expect(servers['onememory']).toEqual({ url: 'http://127.0.0.1:9100/mcp' });
    expect(moved.startsWith('model = "m"\n')).toBe(true);
  });

  test('a hand-added stdio table is replaced by the http block, never duplicated', () => {
    const handAdded = `[mcp_servers.onememory]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "x"\n`;
    const patched = patchCodexConfigToml(handAdded, http());
    const servers = (parse(patched) as Record<string, unknown>)['mcp_servers'] as Record<string, unknown>;
    expect(servers['onememory']).toEqual({ url: URL_7331 });
    expect(servers['other']).toEqual({ command: 'x' });
  });
});
