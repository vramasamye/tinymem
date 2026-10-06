/**
 * The retention compaction suite against the EMBEDDED profile (PGlite + pgvector) — the
 * always-on leg of the ADR-0002 CI matrix. Every scenario runs in its own throwaway data dir.
 */

import { openEmbeddedStorage } from '../integration/harness';

import { runRetentionCompactionSuite } from './events-compaction.scenarios';

runRetentionCompactionSuite(
  'retention events compaction (embedded / PGlite)',
  () => openEmbeddedStorage(),
);
