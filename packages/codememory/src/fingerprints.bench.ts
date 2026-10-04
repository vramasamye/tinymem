/** Pure comparison benchmark: no filesystem, model, database, or network setup noise. */
import { performance } from 'node:perf_hooks';

import { compareSnapshots } from './index';
import type { RepositorySnapshot } from './index';

for (const size of [1_000, 10_000, 100_000]) {
  const before: RepositorySnapshot = {
    version: 1, root_path: '/tmp/onemem-fingerprint-benchmark', mode: 'content',
    head_commit: null, hash_algorithm: 'sha256', exclusion_globs: [],
    captured_at: '2026-10-04T00:00:00.000Z', skipped: [], warnings: [],
    files: Array.from({ length: size }, (_, index) => ({
      path: `before/${index}.ts`, tier: 'worktree', hash_algorithm: 'sha256',
      blob_sha: (index + 1).toString(16).padStart(64, '0'), mode: '100644',
    })),
  };
  const after: RepositorySnapshot = {
    ...before,
    files: before.files.map((file, index) => ({ ...file, path: `after/${index}.ts` })),
  };
  const timings: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const changes = compareSnapshots(before, after);
    timings.push(performance.now() - started);
    if (changes.length !== size || changes.some((change) => change.kind !== 'renamed')) {
      throw new Error('comparison benchmark produced incorrect rename results');
    }
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ files: size, p50_ms: timings[2], max_ms: timings[4], model_calls: 0 }));
}
