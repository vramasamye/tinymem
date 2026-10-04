/**
 * `onemem init` — create `.onememory/onememory.yaml`, register the project, write the pointer.
 *
 * Three presets, all offline by construction:
 * - **local** (default): the annotated template, unchanged — PGlite, lexical + graph retrieval,
 *   heuristic extraction. This is the state AGENTS.md rule 4 requires of a default install.
 * - **ollama**: everything in `local`, plus a loopback Ollama provider for extraction and
 *   embeddings (still zero cloud calls).
 * - **server**: Postgres + pgvector through an environment variable name (`pg_url`), for the
 *   shared/daemon deployment (ADR-0002). The URL itself never enters a file.
 *
 * The config file is validated in memory *before* it is written, and the storage layer is opened
 * (migrations included) before the project row is created — so a successful init means the whole
 * default pipeline answered, not just that a file exists.
 *
 * After the project is registered, the scaffold phase (`wire-runtimes.ts`) wires the agent
 * runtimes the user consented to — Claude Code and/or Codex — to the daemon's MCP surface. On an
 * already-initialized project, `--with-claude` / `--with-codex` run that phase alone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parse as parseYaml } from 'yaml';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CONFIG_FILE_NAME_ALT,
  ProjectStateSchema,
  loadConfig,
  loadProjectState,
  safeParseConfig,
  renderConfigForProject,
  saveProjectState,
  type ProjectState,
} from '@onememory/config';
import { BackendError, daemonMcpUrl, openRuntime, probeDaemon } from '@onememory/api/runtime';

import type { Io } from '../io';
import type { Prompt } from '../prompt';
import {
  chooseRuntimes,
  detectRuntimes,
  printScaffoldPhase,
  requiredReview,
  runScaffoldPhase,
  RUNTIME_TITLES,
  type AgentRuntime,
  type PathExists,
  type ScaffoldPhaseResult,
} from './wire-runtimes';

export type InitPreset = 'local' | 'ollama' | 'server';

export interface InitOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** `--name` */
  name?: string;
  /** `--preset`; defaults are chosen without prompting. */
  preset?: InitPreset;
  /** `--pg-url-env` (server preset): the environment variable NAME holding the Postgres URL. */
  pgUrlEnv?: string;
  /** `--ollama-url` (ollama preset), loopback only. */
  ollamaUrl?: string;
  /** `--ollama-model` (ollama preset) for the routed LLM operations. */
  ollamaModel?: string;
  /** `--embed-model` (ollama preset). */
  embedModel?: string;
  /** `--with-claude`: wire Claude Code (consent for non-interactive runs). */
  withClaude?: boolean;
  /** `--with-codex`: wire Codex (consent for non-interactive runs). */
  withCodex?: boolean;
  /** Runtime-detection probe (tests inject one; default `existsSync`). */
  pathExists?: PathExists;
}

export interface InitResult {
  preset: InitPreset;
  config_path: string;
  data_dir: string;
  project: { id: string; name: string; root_path: string; git_remote: string | null };
  project_state_path: string;
  /** The scaffold phase: detected and wired runtimes, files written, notes. */
  runtimes: ScaffoldPhaseResult;
  /** Runtime-mandated review steps (trust prompts, hook approval, …) and merge-skip outcomes. */
  required_review: string[];
  next_steps: string[];
}

/** `onemem init` on an existing configuration (with the runtime flags: the scaffold phase only). */
export interface InitAlreadyResult {
  status: 'already-initialized';
  config_path: string;
  config_dir: string;
  runtimes?: ScaffoldPhaseResult;
  required_review?: string[];
}

const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** YAML scalar that survives special characters the way the annotated template does. */
function yamlScalar(value: string): string {
  return /^[A-Za-z0-9._@\/-]+$/.test(value) ? value : JSON.stringify(value);
}

function packageName(cwd: string): string | null {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null;
  } catch {
    return null;
  }
}

/** `git config --get remote.origin.url` — invoked, not reimplemented; `null` outside a repo. */
function gitRemote(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const remote = result.stdout.trim();
    return remote === '' ? null : remote;
  } catch {
    return null;
  }
}

function renderOllamaConfig(
  name: string,
  baseUrl: string,
  model: string,
  embedModel: string,
): string {
  return `# onememory configuration — generated by 'onemem init' (local + Ollama preset).
# The Ollama server runs on this machine (loopback): still no account, no telemetry, no cloud
# calls (AGENTS.md rule 4). Keys are strict; every option is documented in the annotated template.

version: 1

project:
  name: ${yamlScalar(name)}

storage:
  mode: embedded
  data_dir: .onememory/data
  vector_backend: auto        # auto probes for pgvector, falls back to float8

embeddings:
  provider: ollama
  model: ${yamlScalar(embedModel)}
  base_url: ${yamlScalar(baseUrl)}

llm:
  profile: local
  providers:
    - id: ollama
      kind: ollama
      base_url: ${yamlScalar(baseUrl)}
  routes:
    extract: { provider: ollama, model: ${yamlScalar(model)} }
    classify: { provider: ollama, model: ${yamlScalar(model)} }
    consolidate: { provider: ollama, model: ${yamlScalar(model)} }
    conflict: { provider: ollama, model: ${yamlScalar(model)} }
    summarize: { provider: ollama, model: ${yamlScalar(model)} }
`;
}

function renderServerConfig(name: string, pgUrlEnv: string): string {
  return `# onememory configuration — generated by 'onemem init' (server preset).
# Storage is a Postgres database with pgvector (Docker or hosted). The URL is NEVER written here:
# it is read from the environment variable named below, and must be credential-free in config.

version: 1

project:
  name: ${yamlScalar(name)}

storage:
  mode: server
  pg_url: ${yamlScalar(pgUrlEnv)}   # environment variable NAME — set it before running onemem
  vector_backend: auto
`;
}

/** Validate the generated text exactly the way load will (strict keys + cross-field rules). */
function validateGeneratedYaml(text: string, path: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new BackendError(
      `init generated invalid YAML — this is a bug in onemem, please report it (${error instanceof Error ? error.message : String(error)})`,
      'internal',
    );
  }
  const result = safeParseConfig(parsed);
  if (!result.success) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new BackendError(
      `init generated an invalid configuration — this is a bug in onemem, please report it (${detail}; would have written ${path})`,
      'internal',
    );
  }
}

export async function runInit(options: InitOptions, io: Io, prompt: Prompt): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configDir = join(cwd, CONFIG_DIR_NAME);
  const configPath = join(configDir, CONFIG_FILE_NAME);

  const env = options.env ?? process.env;
  const wantsWiring = options.withClaude === true || options.withCodex === true;

  for (const name of [CONFIG_FILE_NAME, CONFIG_FILE_NAME_ALT]) {
    const existing = join(configDir, name);
    if (existsSync(existing)) {
      io.out(`onememory is already initialized here: ${existing}`);
      if (!wantsWiring) {
        io.out(`configuration lives in ${configDir}; run 'onemem doctor' to check the setup.`);
        io.out('to wire an agent runtime, re-run with --with-claude and/or --with-codex.');
        const result: InitAlreadyResult = { status: 'already-initialized', config_path: existing, config_dir: configDir };
        io.emit(result);
        return 0;
      }
      return rewireExisting(options, io, { cwd, configDir, configPath: existing, env });
    }
  }

  prompt.intro('onememory init');
  const defaultName = options.name ?? packageName(cwd) ?? basename(cwd);

  const name =
    options.name ??
    (await prompt.text('Project name', { placeholder: defaultName, defaultValue: defaultName }));

  const preset: InitPreset =
    options.preset ??
    (await prompt.select<InitPreset>(
      'How should onememory run?',
      [
        {
          value: 'local',
          label: 'Fully local (default)',
          hint: 'embedded PGlite, lexical + graph retrieval, heuristic extraction — zero external calls',
        },
        {
          value: 'ollama',
          label: 'Local with Ollama',
          hint: 'adds a loopback Ollama server for extraction and embeddings — still zero cloud calls',
        },
        {
          value: 'server',
          label: 'Postgres (server mode)',
          hint: 'shared Postgres + pgvector via an environment variable; for daemon deployments',
        },
      ],
      'local',
    ));

  let text: string;
  if (preset === 'local') {
    text = renderConfigForProject(name);
  } else if (preset === 'server') {
    const pgUrlEnv =
      options.pgUrlEnv ??
      (await prompt.text('Environment variable holding the Postgres URL', {
        placeholder: 'ONEMEMORY_PG_URL',
        defaultValue: 'ONEMEMORY_PG_URL',
      }));
    if (!ENV_NAME_PATTERN.test(pgUrlEnv)) {
      throw new BackendError(
        `'${pgUrlEnv}' is not a valid environment variable name (expected UPPERCASE_IDENTIFIER)`,
        'invalid_request',
      );
    }
    if (env[pgUrlEnv] === undefined || env[pgUrlEnv] === '') {
      throw new BackendError(
        `the environment variable ${pgUrlEnv} is not set — set it to a credential-free Postgres URL (postgres://user@host:5432/onememory) and run init again, or use the local preset`,
        'invalid_request',
      );
    }
    text = renderServerConfig(name, pgUrlEnv);
  } else {
    const baseUrl = options.ollamaUrl ?? 'http://127.0.0.1:11434';
    text = renderOllamaConfig(name, baseUrl, options.ollamaModel ?? 'qwen3:8b', options.embedModel ?? 'nomic-embed-text');
  }

  validateGeneratedYaml(text, configPath);

  const detection = detectRuntimes(cwd, env, options.pathExists);
  const chosen = await chooseRuntimes(options, detection, io, prompt);

  // A daemon that owns this data directory would race the project creation below.
  const daemon = await probeDaemon(configDir);
  if (daemon !== null) {
    throw new BackendError(
      `a daemon is serving this project at ${daemon.lock.url} — stop it (or use its REST API) before initializing a new configuration`,
      'conflict',
    );
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, text, 'utf8');
  io.err(`wrote ${configPath}`);

  // Open the real pipeline: config load (env resolution) → storage (migrations) → project row.
  const runtime = await openRuntime({ cwd, env, startWorker: false });
  try {
    const remote = gitRemote(cwd);
    const project = await runtime.storage.store.createProject({
      name,
      root_path: cwd,
      ...(remote === null ? {} : { git_remote: remote }),
    });

    const state: ProjectState = ProjectStateSchema.parse({
      project_id: project.id,
      name: project.name,
      root_path: cwd,
      ...(remote === null ? {} : { git_remote: remote }),
      created_at: new Date().toISOString(),
    });
    const projectStatePath = saveProjectState(configDir, state);

    const phase = runScaffoldPhase({
      root: cwd,
      projectId: project.id,
      projectName: project.name,
      mcpUrl: daemonMcpUrl(runtime.config.daemon),
      runtimes: chosen,
      detected: detection.filter((entry) => entry.detected).map((entry) => entry.runtime),
    });
    const wiredRuntimes: AgentRuntime[] = phase.wired.map((wired) => wired.runtime);

    const result: InitResult = {
      preset,
      config_path: configPath,
      data_dir: runtime.loaded.paths.data_dir,
      project: {
        id: project.id,
        name: project.name,
        root_path: project.root_path ?? cwd,
        git_remote: remote,
      },
      project_state_path: projectStatePath,
      runtimes: phase,
      required_review: requiredReview(phase),
      next_steps: [
        "onemem doctor — verify the full pipeline (storage, vector backend, redaction, router, wired runtimes)",
        wiredRuntimes.length > 0
          ? `onemem serve — start the daemon BEFORE launching ${wiredRuntimes.map((name) => RUNTIME_TITLES[name]).join(' / ')}: it serves their MCP at ${phase.mcp_url}, receives the capture hooks and runs the job worker`
          : preset === 'server' || preset === 'ollama'
            ? 'onemem serve — own storage and run the normalize/extract/re_embed job worker'
            : 'onemem serve — own storage and run the job worker once you add providers (optional in fully-local mode)',
        "onemem remember '…' — store a durable memory explicitly",
        'onemem search "…" — token-budgeted retrieval',
      ],
    };

    io.emit(result);
    io.out(`initialized project '${project.name}' (${project.id})`);
    io.out(`  config: ${result.config_path}`);
    io.out(`  data:   ${result.data_dir}`);
    if (remote !== null) io.out(`  git:    ${remote}`);
    printScaffoldPhase(io, phase, cwd);
    io.out('next steps:');
    for (const step of result.next_steps) io.out(`  - ${step}`);
    prompt.outro('ready — run onemem doctor to check the setup.');
    return 0;
  } finally {
    await runtime.close();
  }
}

/** The already-initialized path with runtime flags: load config + project state, wire, report. */
async function rewireExisting(
  options: InitOptions,
  io: Io,
  context: { cwd: string; configDir: string; configPath: string; env: Record<string, string | undefined> },
): Promise<number> {
  const loaded = loadConfig({ cwd: context.cwd, configPath: context.configPath, env: context.env });
  const state = loadProjectState(context.configDir);
  if (state === null) {
    throw new BackendError(
      `${context.configDir} has a configuration but no registered project (project.json is missing) — move the configuration aside and run onemem init again to register the project`,
      'invalid_request',
    );
  }
  const detection = detectRuntimes(loaded.paths.root, context.env, options.pathExists);
  const phase = runScaffoldPhase({
    root: loaded.paths.root,
    projectId: state.project_id,
    projectName: state.name,
    mcpUrl: daemonMcpUrl(loaded.config.daemon),
    runtimes: [
      ...(options.withClaude === true ? (['claude-code'] as const) : []),
      ...(options.withCodex === true ? (['codex'] as const) : []),
    ],
    detected: detection.filter((entry) => entry.detected).map((entry) => entry.runtime),
  });
  const result: InitAlreadyResult = {
    status: 'already-initialized',
    config_path: context.configPath,
    config_dir: context.configDir,
    runtimes: phase,
    required_review: requiredReview(phase),
  };
  io.emit(result);
  printScaffoldPhase(io, phase, loaded.paths.root);
  if (phase.wired.length > 0) {
    io.out(`next: onemem serve — start the daemon before launching the agent (MCP at ${phase.mcp_url}); onemem doctor checks the wiring.`);
  }
  return 0;
}
