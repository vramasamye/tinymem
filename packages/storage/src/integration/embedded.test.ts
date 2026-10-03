/**
 * Full integration suite against the EMBEDDED profile (PGlite + @electric-sql/pglite-pgvector,
 * Bun 1.3.14) — the always-on leg of the ADR-0002 CI matrix. Every scenario runs in its own
 * throwaway data dir.
 */

import { openEmbeddedStorage } from './harness';
import { runStorageIntegrationSuite } from './scenarios';

runStorageIntegrationSuite('storage integration (embedded / PGlite)', () => openEmbeddedStorage());
