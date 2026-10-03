/**
 * `onememory` (the `onemem` CLI) public surface.
 *
 * Everything here is a plain function over injectable I/O so tests (and other tools) can drive the
 * exact command code the binary drives:
 *
 * - {@link main} — the real entry (`src/bin.ts` runs this with `process.argv`);
 * - `run*` per command — for embedding (e.g. `npx` wrappers) without spawning a process.
 */

export { buildProgram, main, type MainDeps, type ProgramHandle } from './bin';
export { createIo, shortDate, type Io, type IoOptions } from './io';
export { resolveBackend, resolveProjectId, describeResolution, type Resolved, type ResolveOptions } from './resolve';
export { createClackPrompt, createNonInteractivePrompt, PromptRequiredError, type Prompt, type SelectOption } from './prompt';

export { runInit, type InitOptions, type InitPreset, type InitResult } from './commands/init';
export { runDoctor, printReport, type DoctorOptions } from './commands/doctor';
export { runSearch, printSearch, type SearchOptions } from './commands/search';
export { runRemember, printRemember, type RememberOptions } from './commands/remember';
export { runForget, runRestore, printTransition, type ForgetOptions } from './commands/forget';
export { runInspect, printInspect, type InspectOptions } from './commands/inspect';
export { runStats, printStats, type StatsOptions } from './commands/stats';
export { runServe, type ServeOptions } from './commands/serve';
