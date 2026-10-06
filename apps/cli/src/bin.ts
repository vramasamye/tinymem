#!/usr/bin/env bun
/**
 * `onemem` — the onememory CLI (Commander for the command grammar, @clack/prompts for the two
 * interactive moments: `init` and nothing else).
 *
 * Structure: bin.ts owns argv → options → command dispatch and error presentation; each command
 * in `src/commands/` is a plain async function over injectable I/O, so behaviour is testable
 * without a terminal. The backend decision (daemon vs. direct) happens once per command in
 * `resolveBackend` (ADR-0002) and is invisible to the command logic.
 */

import { Command, InvalidOptionArgumentError, type OptionValues } from 'commander';

import { ConfigError, ConfigNotFoundError } from '@onememory/config';
import { BackendError, ONEMEMORY_VERSION } from '@onememory/api/runtime';

import { createIo, type Io } from './io';
import { createClackPrompt, createNonInteractivePrompt, PromptRequiredError, type Prompt } from './prompt';
import { runAuth } from './commands/auth';
import { runDoctor } from './commands/doctor';
import { runInit } from './commands/init';
import { runSearch } from './commands/search';
import { runRemember } from './commands/remember';
import { runForget, runPurge, runRestore } from './commands/forget';
import { runInspect } from './commands/inspect';
import { runStats } from './commands/stats';
import { runServe } from './commands/serve';
import { runConsolidate } from './commands/consolidate';
import { runDigest } from './commands/digest';
import { runCompact, parseWindowDays } from './commands/compact';
import { runSkillsGenerate } from './commands/skills-generate';
import { runSkillsList } from './commands/skills-list';
import { runSkillsReview } from './commands/skills-review';
import { runSkillsPromote } from './commands/skills-promote';

export interface MainDeps {
  /** Injected stdout (tests capture it; `--json` still routes through it). */
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  /** Environment for `pg_url` / `api_key_env` resolution (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Interactive stdin (default: `process.stdin.isTTY === true`). */
  interactive?: boolean;
}

/** Positive-integer option parser (fail closed on garbage). */
function int(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidOptionArgumentError('expected a positive integer');
  }
  return parsed;
}

/** 0..1 option parser for importance/confidence. */
function fraction(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidOptionArgumentError('expected a number between 0 and 1');
  }
  return parsed;
}

/** Repeatable option (`--type a --type b`, also `--type a,b`). */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function positivePort(value: string): number {
  const parsed = int(value);
  if (parsed > 65_535) throw new InvalidOptionArgumentError('expected a port between 1 and 65535');
  return parsed;
}

/**
 * Whole-day duration for the compaction windows (`90`, `90d`; `0` = keep forever — the window
 * constraints themselves are enforced by the core schema at the command boundary).
 */
function windowDays(value: string): number {
  try {
    return parseWindowDays(value, '--retention-window/--summary-window');
  } catch (error) {
    throw new InvalidOptionArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/** The built program plus a way to read the exit code its actions decided on. */
export interface ProgramHandle {
  program: Command;
  exitCode(): number;
}

export function buildProgram(deps: MainDeps = {}): ProgramHandle {
  let exitCode = 0;

  const env = deps.env ?? process.env;
  const ioFor = (options: OptionValues): Io =>
    createIo({
      ...(deps.write === undefined ? {} : { write: deps.write }),
      ...(deps.writeErr === undefined ? {} : { writeErr: deps.writeErr }),
      json: options.json === true,
      interactive: deps.interactive,
    });

  function reportError(error: unknown, io: Io): void {
    if (error instanceof ConfigError) {
      for (const line of error.message.split('\n')) io.err(line);
      return;
    }
    if (error instanceof BackendError) {
      io.err(`onemem: ${error.message}`);
      return;
    }
    if (error instanceof PromptRequiredError) {
      io.err(`onemem: ${error.message}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`onemem: ${message}`);
    if (!(error instanceof Error) || error.stack === undefined) return;
    for (const line of error.stack.split('\n').slice(1, 4)) io.err(line);
  }

  async function execute(io: Io, task: () => Promise<number>): Promise<void> {
    try {
      exitCode = await task();
    } catch (error) {
      reportError(error, io);
      if (io.json) {
        const code =
          error instanceof BackendError ? error.code
          : error instanceof ConfigNotFoundError ? 'invalid_request'
          : 'internal';
        io.emit({ error: { code, message: error instanceof Error ? error.message : String(error) } });
      }
      exitCode = 1;
    }
  }

  const common = (command: Command): Command =>
    command
      .option('--config <path>', 'config file (default: nearest .onememory/onememory.yaml)')
      .option('--project <id>', 'project id (default: the id registered by onemem init)')
      .option('--json', 'print one JSON document on stdout instead of human text')
      .option('--cwd <dir>', 'working directory (tests and wrappers)')
      .showHelpAfterError('(run onemem <command> --help for usage)');

  const program = new Command();

  program
    .name('onemem')
    .description(
      'persistent memory for AI coding agents — local-first, redacting, provenance-bound.\n' +
        'Run a daemon with "onemem serve" or use commands directly (embedded storage is opened by\n' +
        'exactly one process at a time).',
    )
    .version(ONEMEMORY_VERSION);

  program.action(() => {
    program.help();
  });

  common(program.command('init'))
    .description('create .onememory/onememory.yaml, register the project and run a self-check')
    .option('--name <name>', 'project name (default: the package name or directory name)')
    .option('--preset <preset>', 'configuration preset: local | ollama | server (default: local)')
    .option('--pg-url-env <var>', 'server preset: environment variable NAME holding the Postgres URL')
    .option('--ollama-url <url>', 'ollama preset: base URL (default: http://127.0.0.1:11434)')
    .option('--ollama-model <model>', 'ollama preset: routed LLM model (default: qwen3:8b)')
    .option('--embed-model <model>', 'ollama preset: embedding model (default: nomic-embed-text)')
    .option('--with-claude', 'wire Claude Code: .mcp.json (daemon MCP), .claude/settings.json hooks, CLAUDE.md pointer')
    .option('--with-codex', 'wire Codex: .codex/config.toml (daemon MCP), .codex/hooks.json, AGENTS.md pointer')
    .option('--with-cursor', 'wire Cursor: .cursor/mcp.json (daemon MCP), .cursor/hooks.json, .cursor/rules/onememory.mdc')
    .option('--with-pi', 'wire Pi: .pi/mcp.json (daemon MCP), .pi/extensions/onememory.ts, .pi/APPEND_SYSTEM.md pointer')
    .option(
      '--with-opencode',
      'wire OpenCode: opencode.json (daemon MCP), .opencode/plugins/onememory.ts, .opencode/onememory.md pointer',
    )
    .action(async (options) => {
      const io = ioFor(options);
      const preset = options.preset === undefined ? undefined : String(options.preset);
      if (preset !== undefined && preset !== 'local' && preset !== 'ollama' && preset !== 'server') {
        io.err(`onemem: --preset must be local, ollama or server (got '${preset}')`);
        exitCode = 1;
        return;
      }
      const prompt: Prompt =
        deps.interactive ?? process.stdin.isTTY === true ? createClackPrompt() : createNonInteractivePrompt();
      await execute(io, () =>
        runInit(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            env,
            ...(options.name === undefined ? {} : { name: String(options.name) }),
            ...(preset === undefined ? {} : { preset }),
            ...(options.pgUrlEnv === undefined ? {} : { pgUrlEnv: String(options.pgUrlEnv) }),
            ...(options.ollamaUrl === undefined ? {} : { ollamaUrl: String(options.ollamaUrl) }),
            ...(options.ollamaModel === undefined ? {} : { ollamaModel: String(options.ollamaModel) }),
            ...(options.embedModel === undefined ? {} : { embedModel: String(options.embedModel) }),
            ...(options.withClaude === true ? { withClaude: true } : {}),
            ...(options.withCodex === true ? { withCodex: true } : {}),
            ...(options.withCursor === true ? { withCursor: true } : {}),
            ...(options.withPi === true ? { withPi: true } : {}),
            // Commander camelCases --with-opencode to withOpencode (not withOpenCode).
            ...(options.withOpencode === true ? { withOpenCode: true } : {}),
          },
          io,
          prompt,
        ),
      );
    });

  common(program.command('serve'))
    .description('start the daemon: own storage, serve the REST API (loopback), drain the job queue')
    .option('--host <host>', 'bind host (default: daemon.host, 127.0.0.1)')
    .option('--port <port>', 'bind port (default: daemon.port)', positivePort)
    .option('--listen-public', 'required to bind a non-loopback host (Phase 1 has no authentication)')
    .option('--mcp-auth <issuer>', 'require OAuth 2.1 bearer tokens on the daemon /mcp endpoint (server mode)')
    .option(
      '--mcp-scopes <scopes>',
      'space-separated scopes the daemon requires (default: "onememory:read onememory:write")',
    )
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runServe(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            env,
            ...(options.host === undefined ? {} : { host: String(options.host) }),
            ...(options.port === undefined ? {} : { port: Number(options.port) }),
            listenPublic: options.listenPublic === true,
            ...(options.mcpAuth === undefined ? {} : { mcpAuthIssuer: String(options.mcpAuth) }),
            ...(options.mcpScopes === undefined ? {} : { mcpAuthScopes: String(options.mcpScopes).split(/\s+/).filter(Boolean) }),
          },
          io,
        ),
      );
    });

  common(program.command('auth'))
    .description('OAuth 2.1 loopback flow (server mode): authorize against the deployment authorization server, store the token securely')
    .option('--server-url <url>', 'the onememory MCP server URL (RFC 9728 discovery finds the authorization server)')
    .option('--issuer <url>', 'the authorization server issuer, when known directly')
    .option('--scope <scopes>', 'space-separated scopes to request (default: "onememory:read onememory:write")')
    .option('--port <port>', 'fixed loopback redirect port (default: ephemeral)', positivePort)
    .option('--status', 'print the stored credential status (default when no target is given)')
    .option('--logout', 'remove the stored credential')
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runAuth(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.serverUrl === undefined ? {} : { serverUrl: String(options.serverUrl) }),
            ...(options.issuer === undefined ? {} : { issuer: String(options.issuer) }),
            ...(options.scope === undefined ? {} : { scope: String(options.scope) }),
            ...(options.port === undefined ? {} : { port: Number(options.port) }),
            status: options.status === true,
            logout: options.logout === true,
          },
          io,
        ),
      );
    });

  common(program.command('doctor'))
    .description('check the whole pipeline: config, storage, vector backend, redaction, router, guard')
    .option('--no-probe', 'skip the embedder probe (dimension discovery)')
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runDoctor(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            env,
            probeEmbedder: options.probe === false ? false : undefined,
          },
          io,
        ),
      );
    });

  common(program.command('search'))
    .description('search memories (token-budgeted; provenance and relevance with every result)')
    .argument('<query...>', 'the search text')
    .option('--budget <tokens>', 'maximum tokens of packed context', int)
    .option('--limit <n>', 'maximum number of memories', int)
    .option('--type <type>', 'restrict to a memory type (repeatable, or comma-separated)', collect, [])
    .option('--no-explain', 'omit the per-result scoring explanation')
    .action(async (query: string[], options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runSearch(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            query: query.join(' '),
            ...(options.budget === undefined ? {} : { budget: Number(options.budget) }),
            ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
            ...(options.type === undefined || options.type.length === 0 ? {} : { types: options.type }),
            explain: options.explain !== false,
          },
          io,
        ),
      );
    });

  common(program.command('remember'))
    .description('store an explicit durable memory (redacted first; provenance recorded)')
    .argument('<content...>', 'the statement to remember')
    .option('--type <type>', 'episodic | semantic | procedural | decision | failure | preference')
    .option('--title <title>', 'short title (default: derived from the content)')
    .option('--tags <tags>', 'comma-separated tags', collect, [])
    .option('--importance <n>', '0..1 (default 0.7)', fraction)
    .option('--confidence <n>', '0..1 (default 0.9)', fraction)
    .action(async (content: string[], options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runRemember(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            content: content.join(' '),
            ...(options.type === undefined ? {} : { type: String(options.type) }),
            ...(options.title === undefined ? {} : { title: String(options.title) }),
            ...(options.tags === undefined || options.tags.length === 0 ? {} : { tags: options.tags }),
            ...(options.importance === undefined ? {} : { importance: Number(options.importance) }),
            ...(options.confidence === undefined ? {} : { confidence: Number(options.confidence) }),
          },
          io,
        ),
      );
    });

  common(program.command('forget'))
    .description('soft-forget a memory (audited status change to archived — never a deletion)')
    .argument('<id>', 'memory id (from onemem search / onemem inspect)')
    .option('--reason <reason>', 'why (recorded in the audit trail)')
    .option('--purge', 'hard purge instead: delete the row for real (destructive, NOT recoverable)')
    .option('--revision <rev>', 'the updated_at revision token from your last read (required with --purge)')
    .action(async (id: string, options) => {
      const io = ioFor(options);
      await execute(io, () =>
        (options.purge === true ? runPurge : runForget)(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            memoryId: id,
            ...(options.reason === undefined ? {} : { reason: String(options.reason) }),
            ...(options.purge === undefined ? {} : { purge: options.purge === true }),
            ...(options.revision === undefined ? {} : { revision: String(options.revision) }),
          },
          io,
        ),
      );
    });

  common(program.command('restore'))
    .description('undo a soft forget (archived → active, audited)')
    .argument('<id>', 'memory id')
    .option('--reason <reason>', 'why (recorded in the audit trail)')
    .action(async (id: string, options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runRestore(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            memoryId: id,
            ...(options.reason === undefined ? {} : { reason: String(options.reason) }),
          },
          io,
        ),
      );
    });

  common(program.command('inspect'))
    .description('show the full record: content, provenance, history, audit trail, entities, edges')
    .argument('<id>', 'memory id')
    .action(async (id: string, options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runInspect(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            memoryId: id,
          },
          io,
        ),
      );
    });

  common(program.command('stats'))
    .description('project counts, cache statistics, storage and router state')
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runStats(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
          },
          io,
        ),
      );
    });

  common(program.command('consolidate'))
    .description(
      'run the consolidation pass by hand: near-duplicate merges, contradiction resolution ' +
        '(ties become disputed), episodic→semantic derivation, decay/archive — all audited',
    )
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runConsolidate(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
          },
          io,
        ),
      );
    });

common(program.command('digest'))
    .description(
      'build the project digest rollup: one token-bounded project_context memory summarizing the ' +
        "top decisions, known failures and current procedures — it feeds the memory_project_context tool",
    )
    .option('--budget <tokens>', 'digest token budget (default 750, the memory_project_context budget)', int)
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runDigest(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            ...(options.budget === undefined ? {} : { budget: Number(options.budget) }),
          },
          io,
        ),
      );
    });

  common(program.command('compact'))
    .description(
      'compact the raw event log: summarize old events into memory_events_digest, purge raw rows ' +
        'past the retention window (lineage preserved; the audit trail and sources never move)',
    )
    .option('--dry-run', 'print the typed plan without changing anything')
    .option('--retention-window <dur>', 'days a raw event is kept, e.g. 90 or 90d (0 = keep forever)', windowDays)
    .option('--summary-window <dur>', 'days before a raw event is summarized, e.g. 30 or 30d', windowDays)
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runCompact(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            dryRun: options.dryRun === true,
            ...(options.retentionWindow === undefined ? {} : { retentionWindowDays: options.retentionWindow }),
            ...(options.summaryWindow === undefined ? {} : { summaryWindowDays: options.summaryWindow }),
          },
          io,
        ),
      );
    });

  // NOTE: the `skills` PARENT carries no options on purpose — Commander 15's default parsing
  // lets a middle command consume flags that appear after the subcommand name (verified by
  // probe), which would steal the leaf commands' --cwd/--config/--project/--json. Each leaf
  // registers them through common(); `onemem skills --help` still lists the group.
  const skills = program
    .command('skills')
    .description(
      'skill generation: recurring solved failures → SKILL.md candidates → review → promotion ' +
        '(skills/<name>/SKILL.md lands where Claude Code / OpenCode can load it)',
    );

  common(skills.command('generate'))
    .description(
      'run the skillify pass: group recurring failure signatures, gate on equivalent solutions ' +
        '+ verification evidence, write reviewable candidates (never promotes)',
    )
    .action(async (options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runSkillsGenerate(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
          },
          io,
        ),
      );
    });

  common(skills.command('list'))
    .description('the review queue: every skill with its status (candidate|verified|promoted|deprecated)')
    .option('--status <status>', 'one lifecycle stage: candidate | verified | promoted | deprecated')
    .option('--usage', 'fold the read-only usage hook: captured-session mentions per skill')
    .action(async (options) => {
      const io = ioFor(options);
      const status =
        options.status === undefined
          ? undefined
          : ['candidate', 'verified', 'promoted', 'deprecated'].includes(String(options.status))
            ? (String(options.status) as 'candidate' | 'verified' | 'promoted' | 'deprecated')
            : undefined;
      if (options.status !== undefined && status === undefined) {
        io.err(`onemem: --status must be candidate, verified, promoted or deprecated (got '${String(options.status)}')`);
        exitCode = 1;
        return;
      }
      await execute(io, () =>
        runSkillsList(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            ...(status === undefined ? {} : { status }),
            ...(options.usage === true ? { usage: true } : {}),
          },
          io,
        ),
      );
    });

  common(skills.command('review <id>'))
    .description('inspect a candidate read-only: the record, the SKILL.md exactly as promote would write it, the audit trail')
    .action(async (id: string, options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runSkillsReview(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            skillId: id,
          },
          io,
        ),
      );
    });

  common(skills.command('promote <id>'))
    .description('flip candidate → verified (audited) and write skills/<name>/SKILL.md — the human confirmation of the review flow')
    .option('--dir <dir>', 'skills directory to write into (default: <project root>/skills; Claude Code reads .claude/skills)')
    .option('--note <reason>', 'why (recorded in the audit trail)')
    .action(async (id: string, options) => {
      const io = ioFor(options);
      await execute(io, () =>
        runSkillsPromote(
          {
            ...(options.cwd === undefined ? {} : { cwd: String(options.cwd) }),
            ...(options.config === undefined ? {} : { configPath: String(options.config) }),
            ...(options.project === undefined ? {} : { projectId: String(options.project) }),
            env,
            skillId: id,
            ...(options.dir === undefined ? {} : { dir: String(options.dir) }),
            ...(options.note === undefined ? {} : { note: String(options.note) }),
          },
          io,
        ),
      );
    });

  return { program, exitCode: () => exitCode };
}

/** Parse and run. Returns the process exit code without ever calling process.exit (tests need that). */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const { program, exitCode } = buildProgram(deps);
  await program.parseAsync(argv, { from: 'user' });
  return exitCode();
}

// The bin entry. `process.exitCode` (not process.exit) so `onemem serve` keeps running: after a
// serve command the Bun.serve socket holds the loop open; after any other command the loop drains
// and the process exits with the code set here.
if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`onemem: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
