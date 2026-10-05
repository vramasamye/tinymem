/**
 * The interval scheduler for code-memory orchestration (M4f): periodically enqueues a
 * `drift_scan` pass so stale memories do not stay stale forever (backlog M4.3 exposure, parity
 * memo §5 Tier A item 2 — "job kinds already exist, nothing enqueues them").
 *
 * Deliberately tiny and dependency-free: the scheduler owns *when*, the injected `tick` owns
 * *what* (orchestration.ts builds the per-repository enqueue pass). The timer is injectable so
 * tests drive ticks deterministically without sleeping; production timers are `unref`-ed so a
 * short-lived process never hangs on the schedule.
 *
 * Ticks are chained, never overlapping: the next timer is armed only after the current pass
 * settles, so a slow scan cannot pile up concurrent passes.
 */

/** The timer seam: production uses the global clock; tests inject a manual one. */
export interface SchedulerTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CodeMemorySchedulerOptions {
  /** Interval between passes. */
  intervalMs: number;
  /** One pass: enqueue whatever the orchestration needs. Errors are reported, never thrown out. */
  tick: () => Promise<void>;
  /** Timer implementation (default: the process clock, `unref`-ed). */
  timer?: SchedulerTimer;
  /** Run a pass immediately on `start()` (default true) so freshness does not wait an interval. */
  runOnStart?: boolean;
  onError?: (error: unknown) => void;
}

export interface CodeMemoryScheduler {
  /** Begin the schedule. Idempotent. */
  start(): void;
  /** Stop the schedule and await the in-flight pass. Idempotent. */
  stop(): Promise<void>;
  /** Run exactly one pass now (the deterministic mode tests use). */
  runOnce(): Promise<void>;
  isRunning(): boolean;
  readonly interval_ms: number;
}

const defaultTimer: SchedulerTimer = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    // Never hold the event loop open for a background schedule (the daemon owns the lifetime).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodeMemoryScheduler(options: CodeMemorySchedulerOptions): CodeMemoryScheduler {
  const timer = options.timer ?? defaultTimer;
  const runOnStart = options.runOnStart ?? true;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`onememory: code-memory schedule pass failed: ${describeError(error)}`);
    });

  let running = false;
  let stopped = false;
  let handle: unknown = null;
  let inflight: Promise<void> | null = null;

  async function pass(): Promise<void> {
    try {
      await options.tick();
    } catch (error) {
      onError(error);
    }
  }

  function scheduleNext(): void {
    if (!running) return;
    handle = timer.set(() => {
      handle = null;
      inflight = pass().finally(() => {
        inflight = null;
        scheduleNext();
      });
    }, options.intervalMs);
  }

  return {
    interval_ms: options.intervalMs,
    start(): void {
      if (running) return;
      running = true;
      stopped = false;
      if (runOnStart) {
        inflight = pass().finally(() => {
          inflight = null;
          if (running) scheduleNext();
        });
      } else {
        scheduleNext();
      }
    },
    async stop(): Promise<void> {
      running = false;
      stopped = true;
      if (handle !== null) {
        timer.clear(handle);
        handle = null;
      }
      const pending = inflight;
      if (pending !== null) await pending;
      inflight = null;
    },
    runOnce(): Promise<void> {
      return pass();
    },
    isRunning(): boolean {
      return running && !stopped;
    },
  };
}
