/**
 * The code-memory interval scheduler (M4f): deterministic ticks through an injected timer, chained
 * so passes never overlap, `unref`-free in tests, and errors reported rather than thrown out of a
 * background pass.
 */

import { describe, expect, test } from 'bun:test';

import { createCodeMemoryScheduler, type SchedulerTimer } from './index';

interface ManualTimer extends SchedulerTimer {
  fire(): Promise<void>;
  pending(): number;
  delays: number[];
}

function manualTimer(): ManualTimer {
  const tasks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    set(callback, ms) {
      delays.push(ms);
      tasks.push(callback);
      return callback;
    },
    clear() {
      tasks.length = 0;
    },
    pending() {
      return tasks.length;
    },
    async fire() {
      const task = tasks.shift();
      task?.();
      // Let the async tick settle before asserting.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('createCodeMemoryScheduler', () => {
  test('runs an immediate pass on start, then chains interval passes', async () => {
    const timer = manualTimer();
    let ticks = 0;
    const scheduler = createCodeMemoryScheduler({
      intervalMs: 1000,
      tick: async () => {
        ticks += 1;
      },
      timer,
    });

    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ticks).toBe(1);
    expect(timer.delays).toEqual([1000]);

    await timer.fire();
    expect(ticks).toBe(2);
    // The next timer is armed only after the previous pass settled (no overlap, no drift).
    expect(timer.pending()).toBe(1);

    await scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    expect(timer.pending()).toBe(0);
  });

  test('runOnce is the deterministic single pass and works before start', async () => {
    const timer = manualTimer();
    const seen: string[] = [];
    const scheduler = createCodeMemoryScheduler({
      intervalMs: 10,
      tick: async () => {
        seen.push('tick');
      },
      timer,
    });

    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(seen).toEqual(['tick', 'tick']);
    expect(scheduler.isRunning()).toBe(false);
    expect(timer.pending()).toBe(0);
  });

  test('a failing tick is reported and does not stop the schedule', async () => {
    const timer = manualTimer();
    const errors: unknown[] = [];
    let ticks = 0;
    const scheduler = createCodeMemoryScheduler({
      intervalMs: 5,
      tick: async () => {
        ticks += 1;
        if (ticks === 1) throw new Error('capture failed');
      },
      timer,
      onError: (error) => errors.push(error),
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('capture failed');
    expect(scheduler.isRunning()).toBe(true);

    await timer.fire();
    expect(ticks).toBe(2);
    await scheduler.stop();
  });

  test('start is idempotent and stop waits for the in-flight pass', async () => {
    const timer = manualTimer();
    let resolveTick: (() => void) | null = null;
    let started = 0;
    const scheduler = createCodeMemoryScheduler({
      intervalMs: 1,
      timer,
      tick: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          resolveTick = resolve;
        });
      },
    });

    scheduler.start();
    scheduler.start();
    expect(started).toBe(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false); // the in-flight pass is awaited
    (resolveTick as (() => void) | null)?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
