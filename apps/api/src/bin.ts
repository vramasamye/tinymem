#!/usr/bin/env bun
/**
 * `@onememory/api` serve entry (`bun run src/bin.ts` / `bun run serve`).
 *
 * The user-facing command is `onemem serve` (apps/cli); this entry exists so the daemon can be
 * started without the CLI package (e.g. `bunx --package @onememory/api bun src/bin.ts` in tests
 * and container images). Same rule either way: one daemon owns the embedded data directory.
 */

import { startDaemon } from './runtime/daemon';
import { ONEMEMORY_VERSION } from './runtime/version';

function parseArgs(argv: readonly string[]): { host?: string; port?: number; listenPublic: boolean } {
  const options: { host?: string; port?: number; listenPublic: boolean } = { listenPublic: false };
  const ignored: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--listen-public') {
      options.listenPublic = true;
    } else if (argument.startsWith('--host=')) {
      options.host = argument.slice('--host='.length);
    } else if (argument.startsWith('--port=')) {
      const value = Number(argument.slice('--port='.length));
      if (Number.isInteger(value) && value >= 0) options.port = value;
    } else if (argument === '--host' || argument === '--port') {
      const value = argv[index + 1];
      if (value !== undefined && argument === '--host') options.host = value;
      if (value !== undefined && argument === '--port') {
        const numberValue = Number(value);
        if (Number.isInteger(numberValue) && numberValue >= 0) options.port = numberValue;
      }
      index += 1;
    } else {
      ignored.push(argument);
    }
  }
  for (const argument of ignored) console.error(`onememory serve: ignoring unknown argument: ${argument}`);
  return options;
}

const options = parseArgs(process.argv.slice(2));

try {
  const daemon = await startDaemon({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    listenPublic: options.listenPublic,
  });
  const info = daemon.info;
  console.error(`onememory ${ONEMEMORY_VERSION} serving ${info.url}`);
  console.error(`  config: ${info.config_path ?? '(defaults, no file)'}`);
  console.error(`  data:   ${info.data_dir}`);
  console.error(`  worker: ${daemon.runtime.registered_kinds.join(', ')}`);
  for (const warning of info.warnings) console.error(`  note:   ${warning}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`onememory serve: ${message}`);
  process.exit(1);
}
