/**
 * A limit on how many tasks (here: Gemini calls) run at the same time.
 *
 * At most `max` tasks run at once; the rest wait in arrival order. When a task finishes,
 * its slot goes straight to the next waiting task instead of being freed, so a task that
 * arrives at that moment cannot slip in ahead and push the count over `max`.
 */
export interface Limiter {
  readonly max: number;
  /** Tasks running now. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly waiting: number;
  /**
   * Run `task` once a slot is free. If `signal` aborts while the task is still waiting,
   * it leaves the line without running and the promise rejects with the abort reason.
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`A limiter needs a whole number of slots, at least 1 (got ${max}).`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', leave);
        resolve();
      };
      const leave = () => {
        const index = queue.indexOf(start);
        if (index !== -1) queue.splice(index, 1);
        reject(signal!.reason);
      };
      queue.push(start);
      signal?.addEventListener('abort', leave, { once: true });
    });
  };

  const release = () => {
    const next = queue.shift();
    // Hand the slot to the next waiting task; `active` stays the same.
    if (next) next();
    else active--;
  };

  return {
    max,
    get active() { return active; },
    get waiting() { return queue.length; },
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    }
  };
}
