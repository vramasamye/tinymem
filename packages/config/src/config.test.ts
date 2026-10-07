/**
 * Tests for the configuration layer: strict validation, fail-closed cross-field rules, discovery,
 * env-name resolution (never values), machine-managed project state, and the derived decisions the
 * composition root consumes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  CONFIG_FILE_NAME,
  ConfigError,
  ConfigNotFoundError,
  DEFAULT_DAEMON_PORT,
  OnememoryConfigSchema,
  ProjectStateSchema,
  configSummary,
  defaultConfigObject,
  embedderSelection,
  exclusionGlobs,
  findConfigFile,
  llmProfileSummary,
  loadConfig,
  loadProjectState,
  networkGuardPlan,
  parseConfig,
  redactionOptions,
  renderConfigForProject,
  renderDefaultConfigYaml,
  resolvePgUrl,
  safeParseConfig,
  saveProjectState,
  vectorIndexBinding,
} from './index';

function tmpdir(name: string): string {
  const path = join(process.env.TMPDIR ?? '/tmp', `onemem-config-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeProjectConfig(root: string, yaml: string, fileName: string = CONFIG_FILE_NAME): string {
  mkdirSync(join(root, '.onememory'), { recursive: true });
  const path = join(root, '.onememory', fileName);
  writeFileSync(path, yaml, 'utf8');
  return path;
}

describe('strict schema validation', () => {
  test('defaults are fully local: embedded storage, zero providers, no embedder', () => {
    const config = defaultConfigObject();
    expect(config.version).toBe(1);
    expect(config.storage.mode).toBe('embedded');
    expect(config.storage.data_dir).toBe('.onememory/data');
    expect(config.storage.pg_url).toBeUndefined();
    expect(config.embeddings.provider).toBeUndefined();
    expect(config.llm.profile).toBe('local');
    expect(config.llm.providers).toEqual([]);
    expect(config.llm.routes).toEqual({});
    expect(config.daemon.host).toBe('127.0.0.1');
    expect(config.daemon.port).toBe(DEFAULT_DAEMON_PORT);
    expect(config.security.network_guard).toBe('auto');
    expect(config.skills.dir).toBeUndefined(); // absent → promote defaults to <project root>/skills
    expect(networkGuardPlan(config).enforce).toBe(true);
  });

  test('skills.dir is optional and accepts a runtime skills root (project-relative or ~/global)', () => {
    expect(parseConfig({ version: 1, skills: { dir: '.claude/skills' } }).skills.dir).toBe('.claude/skills');
    expect(parseConfig({ version: 1, skills: { dir: '~/.opencode/skills' } }).skills.dir).toBe('~/.opencode/skills');
    expect(parseConfig({ version: 1, skills: {} }).skills.dir).toBeUndefined();
  });

  test('an empty skills.dir is rejected (a directory, not a blank string)', () => {
    const result = safeParseConfig({ version: 1, skills: { dir: '' } });
    expect(result.success).toBeFalse();
  });

  test('export.dir is optional and accepts a project-relative or ~/global export root', () => {
    expect(parseConfig({ version: 1, export: { dir: 'docs/memory' } }).export.dir).toBe('docs/memory');
    expect(parseConfig({ version: 1, export: { dir: '~/memory' } }).export.dir).toBe('~/memory');
    expect(parseConfig({ version: 1, export: {} }).export.dir).toBeUndefined();
  });

  test('an empty export.dir is rejected (a directory, not a blank string)', () => {
    expect(safeParseConfig({ version: 1, export: { dir: '' } }).success).toBeFalse();
  });

  test('an unknown key is rejected with its path (a typo is not forward compatibility)', () => {
    const result = safeParseConfig({ version: 1, embedding: { provider: 'ollama' } });
    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.issues.some((issue) => issue.path === 'embedding' || issue.path === '(root)')).toBeTrue();
    }
  });

  test('an unknown version fails loudly', () => {
    expect(() => parseConfig({ version: 2 })).toThrow(/version/i);
  });

  test('llm.profile local rejects a hosted provider kind (AGENTS.md rule 4)', () => {
    const result = safeParseConfig({
      version: 1,
      llm: {
        profile: 'local',
        providers: [{ id: 'openai', kind: 'openai' }],
        routes: {},
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.issues.some((issue) => issue.message.includes('llm.profile'))).toBeTrue();
    }
  });

  test('llm.profile local rejects a non-loopback base_url', () => {
    const result = safeParseConfig({
      version: 1,
      llm: {
        profile: 'local',
        providers: [{ id: 'llama', kind: 'openai-compatible', base_url: 'https://api.example.com/v1' }],
        routes: {},
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.issues.some((issue) => issue.path.startsWith('llm.providers[0]'))).toBeTrue();
    }
  });

  test('an inline api_key outside loopback is rejected — env names only', () => {
    const result = safeParseConfig({
      version: 1,
      llm: {
        profile: 'hybrid',
        providers: [{ id: 'openai', kind: 'openai', api_key: 'sk-live-secret-value' }],
        routes: {},
      },
    });
    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.issues.some((issue) => issue.message.includes('api_key_env') || issue.path === 'llm.providers[0].api_key')).toBeTrue();
      // the secret value is never echoed in an issue
      expect(JSON.stringify(result.issues)).not.toContain('sk-live-secret-value');
    }
  });

  test("network_guard 'off' is rejected while llm.profile is local", () => {
    const result = safeParseConfig({ version: 1, security: { network_guard: 'off' } });
    expect(result.success).toBeFalse();
    if (!result.success) {
      expect(result.issues.some((issue) => issue.path === 'security.network_guard')).toBeTrue();
    }
  });

  test('server mode without pg_url is rejected; embedded does not need one', () => {
    const serverNoUrl = safeParseConfig({ version: 1, storage: { mode: 'server' } });
    expect(serverNoUrl.success).toBeFalse();
    expect(parseConfig({ version: 1, storage: { mode: 'embedded' } }).storage.mode).toBe('embedded');
  });

  test('a credential-bearing pg_url parses (schema) but fails at load (resolution) with a value-free message', () => {
    // The schema accepts any pg_url string; the credential rule is enforced where the URL is
    // actually used (load), so the failure message can name the file and the fix.
    const root = tmpdir('cred');
    try {
      writeProjectConfig(
        root,
        renderDefaultConfigYaml()
          .replace('  mode: embedded', '  mode: server')
          .replace('  data_dir: .onememory/data', '  pg_url: postgres://user:secret@db.example.com:5432/onememory'),
      );
      expect(() => loadConfig({ cwd: root, env: {} })).toThrow(/credential/i);
      try {
        loadConfig({ cwd: root, env: {} });
      } catch (error) {
        // the password value itself is never echoed
        expect((error as ConfigError).message).not.toContain('secret');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the annotated template round-trips', () => {
  test('the rendered YAML parses back to the built-in defaults (plus the project name)', () => {
    const fromTemplate = parseConfig(parseYaml(renderConfigForProject('demo')));
    expect(fromTemplate).toEqual({ ...defaultConfigObject(), project: { name: 'demo' } });
  });

  test('the project name is substituted and safe for special characters', () => {
    expect(renderConfigForProject('my-project')).toContain('name: my-project');
    expect(renderConfigForProject('my project: "quoted"')).toContain('"my project: \\"quoted\\""');
  });
});

describe('loadConfig', () => {
  let root: string;

  beforeEach(() => {
    root = tmpdir('load');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('discovers the nearest .onememory/onememory.yaml upward', () => {
    const path = writeProjectConfig(root, renderDefaultConfigYaml());
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(path);
  });

  test('loads the discovered file and resolves paths against it', () => {
    const path = writeProjectConfig(root, renderDefaultConfigYaml());
    const loaded = loadConfig({ cwd: root, env: {} });
    expect(loaded.paths.config_path).toBe(path);
    expect(loaded.paths.config_dir).toBe(join(root, '.onememory'));
    expect(loaded.paths.data_dir.startsWith(join(root, '.onememory'))).toBeTrue();
    expect(loaded.project_state).toBeNull();
  });

  test('without a file it throws ConfigNotFoundError with the fix in the message', () => {
    expect(() => loadConfig({ cwd: root, env: {} })).toThrow(ConfigNotFoundError);
    try {
      loadConfig({ cwd: root, env: {} });
    } catch (error) {
      expect((error as ConfigError).message).toContain('onemem init');
    }
  });

  test('an explicit --config path must exist', () => {
    expect(() => loadConfig({ cwd: root, configPath: join(root, 'nope.yaml'), env: {} })).toThrow(/does not exist/);
  });

  test('ONEMEMORY_CONFIG wins over discovery', () => {
    const other = tmpdir('other');
    writeProjectConfig(root, renderDefaultConfigYaml());
    const otherPath = writeProjectConfig(other, renderDefaultConfigYaml());
    const loaded = loadConfig({ cwd: root, env: { ONEMEMORY_CONFIG: otherPath } });
    expect(loaded.paths.config_path).toBe(otherPath);
    rmSync(other, { recursive: true, force: true });
  });

  test('pg_url: <env name> resolves from the environment, literals pass through', () => {
    writeProjectConfig(
      root,
      renderDefaultConfigYaml().replace('  mode: embedded', '  mode: server').replace('  data_dir: .onememory/data', `  pg_url: ONEMEMORY_PG_URL`),
    );
    const loaded = loadConfig({ cwd: root, env: { ONEMEMORY_PG_URL: 'postgres://127.0.0.1:5432/onememory' } });
    expect(loaded.pg_url).toBe('postgres://127.0.0.1:5432/onememory');
    expect(loaded.pg_url_source).toBe('env:ONEMEMORY_PG_URL');
    expect(() => loadConfig({ cwd: root, env: {} })).toThrow(ConfigError);
  });
});

describe('resolvePgUrl', () => {
  test('a credential-free URL passes; inline credentials (even a bare username) never do', () => {
    expect(resolvePgUrl('postgres://127.0.0.1:5432/onememory', {})).toEqual({
      url: 'postgres://127.0.0.1:5432/onememory',
      source: 'literal',
    });
    expect(() => resolvePgUrl('postgres://user:password@h:5432/db', {})).toThrow(/credential/i);
    expect(() => resolvePgUrl('postgres://user@h:5432/db', {})).toThrow(/credential/i);
  });

  test('an env NAME resolves from the environment and fails when it is unset', () => {
    expect(resolvePgUrl('ONEMEMORY_PG_URL', { ONEMEMORY_PG_URL: 'postgres://127.0.0.1:5432/onememory' })).toEqual({
      url: 'postgres://127.0.0.1:5432/onememory',
      source: 'env:ONEMEMORY_PG_URL',
    });
    expect(() => resolvePgUrl('ONEMEMORY_PG_URL', {})).toThrow(/not set/);
  });
});

describe('project state', () => {
  let root: string;

  beforeEach(() => {
    root = tmpdir('state');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('round-trips and validates', () => {
    const state = ProjectStateSchema.parse({
      project_id: '0195a7f0-9f5e-7a1d-bc2d-000000000001',
      name: 'demo',
      root_path: root,
      created_at: new Date().toISOString(),
    });
    saveProjectState(root, state);
    expect(loadProjectState(root)).toEqual(state);
  });

  test('a malformed file fails with an actionable message, not silence', () => {
    writeFileSync(join(root, 'project.json'), '{ not json', 'utf8');
    expect(() => loadProjectState(root)).toThrow(ConfigError);
  });

  test('a missing file is null', () => {
    expect(loadProjectState(root)).toBeNull();
  });
});

describe('derived decisions', () => {
  test('no embeddings section → no embedder; a loopback provider is selected with its default URL', () => {
    expect(embedderSelection(defaultConfigObject())).toBeNull();
    const withOllama = parseConfig({
      version: 1,
      embeddings: { provider: 'ollama', model: 'nomic-embed-text' },
    });
    expect(embedderSelection(withOllama)).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
      dim: null,
      base_url: 'http://127.0.0.1:11434',
    });
  });

  test('vector binding follows the embedder (null = unbound)', () => {
    const binding = vectorIndexBinding(defaultConfigObject());
    expect(binding.model).toBeNull();
    expect(binding.dim).toBeNull();
    expect(binding.backend).toBe('auto');
  });

  test("the guard is 'auto'-enforced with zero network-capable components and off with an ollama embedder", () => {
    const offline = networkGuardPlan(defaultConfigObject());
    expect(offline.enforce).toBeTrue();
    expect(offline.network_capable).toEqual([]);

    const withOllama = networkGuardPlan(
      parseConfig({ version: 1, embeddings: { provider: 'ollama', model: 'nomic-embed-text' } }),
    );
    expect(withOllama.enforce).toBeFalse();
    expect(withOllama.network_capable).toEqual(['embeddings:ollama']);
  });

  test('redaction options pass partial groups and extra patterns through for the security package', () => {
    const config = parseConfig({
      version: 1,
      security: {
        redaction: {
          groups: { jwt: false },
          extra_patterns: [{ id: 'stripe', kind: 'api-key', pattern: 'sk_live_[A-Za-z0-9]{24}' }],
        },
      },
    });
    expect(redactionOptions(config)).toEqual({
      groups: { jwt: false },
      extraPatterns: [{ id: 'stripe', kind: 'api-key', pattern: 'sk_live_[A-Za-z0-9]{24}' }],
    });
    // A partial group map is the documented way to switch one group off; an unknown id is a typo.
    const unknownGroup = safeParseConfig({
      version: 1,
      security: { redaction: { groups: { 'not-a-group': false } } },
    });
    expect(unknownGroup.success).toBeFalse();
    expect(redactionOptions(defaultConfigObject())).toEqual({});
  });

  test('exclusion globs carry only config ADDITIONS (the invariants live in @onememory-ai/security)', () => {
    expect(exclusionGlobs(defaultConfigObject())).toEqual([]);
    expect(exclusionGlobs(parseConfig({ version: 1, security: { exclude_globs: ['secrets/**'] } }))).toEqual([
      'secrets/**',
    ]);
  });

  test('profile summary reports routed vs unconfigured operations', () => {
    const summary = llmProfileSummary(defaultConfigObject());
    expect(summary.profile).toBe('local');
    expect(summary.routed_operations).toEqual([]);
    expect(summary.unconfigured_operations.length).toBeGreaterThan(0);
  });

  test('configSummary names the storage profile and data dir', () => {
    const summary = configSummary(defaultConfigObject(), '/x/onememory.yaml', '/x/.onememory/data');
    expect(summary.storage.mode).toBe('embedded');
    expect(summary.storage.data_dir).toBe('/x/.onememory/data');
  });
});

describe('OnememoryConfigSchema direct use', () => {
  test('safeParse returns the fully-defaulted config on success', () => {
    const result = OnememoryConfigSchema.safeParse({ version: 1 });
    expect(result.success).toBeTrue();
    if (result.success) expect(result.data.storage.mode).toBe('embedded');
  });
});
