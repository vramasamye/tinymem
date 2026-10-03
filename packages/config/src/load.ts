/**
 * Config discovery + loading.
 *
 * Resolution order (highest wins): an explicit `--config` path > the `ONEMEMORY_CONFIG` environment
 * variable > the nearest `.onememory/onememory.yaml` walking up from the working directory.
 *
 * The loader reads exactly one file and the process environment. It never reads `.env` files, never
 * logs a secret, and resolves an environment reference to a *name + presence flag* for reporting —
 * the value itself only ever travels into the component that needs it (`pg_url` → storage driver,
 * `api_key_env` → the model router, which resolves it itself).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, CONFIG_FILE_NAME_ALT, CONFIG_PATH_ENV, defaultConfigObject } from './defaults';
import { ConfigError, ConfigNotFoundError } from './errors';
import { CONFIG_VERSION, safeParseConfig, type OnememoryConfig } from './schema';
import { loadProjectState, projectStatePath, type ProjectState } from './project-state';

export interface LoadConfigOptions {
  /** Directory to start discovery from (default `process.cwd()`). */
  cwd?: string;
  /** Explicit config file (`--config`). When set, discovery is skipped and the file must exist. */
  configPath?: string | null;
  /** Environment used for `ONEMEMORY_CONFIG` and env references (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Require a config file to exist (default true). `false` returns the built-in defaults. */
  required?: boolean;
}

/** How an environment-referenced value was resolved (never the value itself). */
export interface EnvResolution {
  /** The environment variable name. */
  env: string;
  /** Whether the variable is present in the environment. */
  present: boolean;
}

export interface ResolvedPaths {
  /** Absolute path of the loaded config file, or `null` for the built-in defaults. */
  config_path: string | null;
  /** Absolute path of the `.onememory` directory (real or would-be). */
  config_dir: string;
  /** Absolute project root: the directory containing `.onememory`. */
  root: string;
  /** Absolute data directory for embedded storage. */
  data_dir: string;
  /** Absolute `.onememory/project.json` path. */
  project_state_path: string;
}

export interface LoadedConfig {
  config: OnememoryConfig;
  paths: ResolvedPaths;
  /** Registered project pointer, when `.onememory/project.json` exists. */
  project_state: ProjectState | null;
  /** Resolved `storage.pg_url`, or `null` in embedded mode. */
  pg_url: string | null;
  /** `literal` when the URL was written in config, `env:<NAME>` when it came from the environment. */
  pg_url_source: 'literal' | `env:${string}` | null;
  /** Provider key references (names + presence only, never values). */
  api_key_refs: Array<{ provider_id: string; env: string; present: boolean }>;
  /** Non-fatal notes surfaced by doctor / init. */
  warnings: string[];
}

/** Find the nearest `.onememory/onememory.yaml` from `startDir` upward. */
export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of [CONFIG_FILE_NAME, CONFIG_FILE_NAME_ALT]) {
      const candidate = join(dir, CONFIG_DIR_NAME, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parsePath(dir).root) return null;
    dir = parent;
  }
}

function resolveConfigPath(options: LoadConfigOptions, env: Record<string, string | undefined>): string | null {
  if (options.configPath !== undefined && options.configPath !== null) {
    const path = isAbsolute(options.configPath) ? options.configPath : resolve(options.cwd ?? process.cwd(), options.configPath);
    if (!existsSync(path)) {
      throw new ConfigError('the file named by --config does not exist', [
        { path: options.configPath, message: 'not found' },
      ]);
    }
    return path;
  }
  const fromEnv = env[CONFIG_PATH_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    const path = isAbsolute(fromEnv) ? fromEnv : resolve(options.cwd ?? process.cwd(), fromEnv);
    if (!existsSync(path)) {
      throw new ConfigError(`the file named by ${CONFIG_PATH_ENV} does not exist`, [
        { path: fromEnv, message: 'not found — unset ONEMEMORY_CONFIG or point it at an existing file' },
      ]);
    }
    return path;
  }
  return findConfigFile(options.cwd ?? process.cwd());
}

/** The base directory relative config paths resolve against (the project root). */
export function configBaseDir(configFilePath: string): string {
  const dir = dirname(configFilePath);
  return dir.endsWith(CONFIG_DIR_NAME) ? dirname(dir) : dir;
}

function readYamlFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError('cannot read the config file', [
      { path, message: error instanceof Error ? error.message : String(error) },
    ]);
  }
  try {
    return parseYaml(text);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : error instanceof Error ? error.message : String(error);
    throw new ConfigError('the config file is not valid YAML', [{ path: '(yaml)', message: detail }], path);
  }
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Resolve `storage.pg_url`: a literal credential-free URL, or an environment variable name. */
export function resolvePgUrl(
  raw: string | undefined,
  env: Record<string, string | undefined>,
): { url: string | null; source: 'literal' | `env:${string}` | null } {
  if (raw === undefined) return { url: null, source: null };

  if (!raw.startsWith('postgres://') && !raw.startsWith('postgresql://')) {
    if (!ENV_NAME_PATTERN.test(raw)) {
      throw new ConfigError('storage.pg_url is neither a postgres:// URL nor an environment variable name', [
        {
          path: 'storage.pg_url',
          message: `'${raw}' — use e.g. pg_url: postgres://onemem@127.0.0.1:5432/onememory, or the NAME of an environment variable such as ONEMEMORY_PG_URL`,
        },
      ]);
    }
    const value = env[raw];
    if (value === undefined || value === '') {
      throw new ConfigError(`environment variable ${raw} referenced by storage.pg_url is not set`, [
        { path: 'storage.pg_url', message: `set ${raw} to a postgres:// connection URL` },
      ]);
    }
    assertCredentialFree(value, `environment variable ${raw}`);
    return { url: value, source: `env:${raw}` };
  }

  assertCredentialFree(raw, 'storage.pg_url');
  return { url: raw, source: 'literal' };
}

function assertCredentialFree(url: string, where: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${where} is not a valid connection URL`, [
      { path: 'storage.pg_url', message: 'expected a postgres:// URL' },
    ]);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError(
      `${where} carries inline credentials`,
      [
        {
          path: 'storage.pg_url',
          message:
            'never write a database password into configuration — keep it in the environment and reference the variable by name',
        },
      ],
    );
  }
}

/**
 * Load and validate the configuration. Throws {@link ConfigError} with file-scoped, actionable
 * issues; never returns a partially-defaulted config.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveConfigPath(options, env);

  if (configPath === null) {
    if (options.required === false) {
      const config = defaultConfigObject();
      const root = resolve(cwd);
      const configDir = join(root, CONFIG_DIR_NAME);
      return {
        config,
        paths: {
          config_path: null,
          config_dir: configDir,
          root,
          data_dir: isAbsolute(config.storage.data_dir)
            ? config.storage.data_dir
            : resolve(root, config.storage.data_dir),
          project_state_path: projectStatePath(configDir),
        },
        project_state: null,
        pg_url: null,
        pg_url_source: null,
        api_key_refs: [],
        warnings: ['no config file found: built-in local-first defaults are in use'],
      };
    }
    throw new ConfigNotFoundError(resolve(cwd), `version ${CONFIG_VERSION} is the only supported config version`);
  }

  const raw = readYamlFile(configPath);
  const parsed = safeParseConfig(raw);
  if (!parsed.success) {
    const unknownKey = parsed.issues.find((issue) => issue.message.toLowerCase().includes('unrecognized'));
    throw new ConfigError(
      unknownKey === undefined
        ? 'the config file failed validation'
        : 'the config file has an unknown key (unknown keys are rejected — an unknown key is a typo, not forward compatibility)',
      parsed.issues,
      configPath,
    );
  }

  const config = parsed.data;
  const baseDir = configBaseDir(configPath);
  const configDir = join(baseDir, CONFIG_DIR_NAME);
  const warnings: string[] = [];

  const resolvedPg = resolvePgUrl(config.storage.pg_url, env);
  if (resolvedPg.source?.startsWith('env:') === true && resolvedPg.url !== null) {
    warnings.push(`storage.pg_url resolved from ${resolvedPg.source.slice(4)}`);
  }

  const apiKeyRefs = config.llm.providers
    .filter((provider) => provider.api_key_env !== undefined)
    .map((provider) => ({
      provider_id: provider.id,
      env: provider.api_key_env!,
      present: (env[provider.api_key_env!] ?? '') !== '',
    }));

  return {
    config,
    paths: {
      config_path: configPath,
      config_dir: configDir,
      root: baseDir,
      data_dir: isAbsolute(config.storage.data_dir) ? config.storage.data_dir : resolve(baseDir, config.storage.data_dir),
      project_state_path: projectStatePath(configDir),
    },
    project_state: loadProjectState(configDir),
    pg_url: resolvedPg.url,
    pg_url_source: resolvedPg.source,
    api_key_refs: apiKeyRefs,
    warnings,
  };
}
