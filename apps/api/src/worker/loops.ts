/**
 * Background loops. Every one is a database sweeper (compare-and-set / SKIP LOCKED inside the services), so any
 * number of workers can run them and losing Redis changes nothing (invariant 13, D14).
 */
export interface Loop {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

export interface LoopRunner {
  stop(): Promise<void>;
}

/** Runs each loop back to back with its own delay; a failing iteration is reported and retried next tick. */
export function startLoops(loops: readonly Loop[], onError: (name: string, err: unknown) => void): LoopRunner {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  const tick = (loop: Loop): void => {
    if (stopped) return;
    const job = loop.run().then(() => undefined, (e: unknown) => onError(loop.name, e)).then(() => {
      inFlight.delete(job);
      if (stopped) return;
      const t = setTimeout(() => { timers.delete(t); tick(loop); }, loop.intervalMs);
      timers.add(t);
    });
    inFlight.add(job);
  };

  loops.forEach(tick);
  return {
    async stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      await Promise.all(inFlight);
    },
  };
}
