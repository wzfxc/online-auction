import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobDef } from './jobs.js';
import type { Clock } from '../../api/src/common/clock/clock.js';
import { CLOCK, JOBS, ON_SHUTDOWN, REDIS_URL, TUNING } from './tokens.js';

export const QUEUE_NAME = 'auction-jobs';
const WATCHDOG_MS = 5_000;

export interface Tuning {
  /** How often the watchdog heals schedulers and checks for stale jobs. */
  watchdogMs: number;
  /** A job is never considered stale before this long since its last run. */
  minStaleMs: number;
  /** Upper bound for closing BullMQ connections on shutdown (a dead Redis would otherwise hang it). */
  closeTimeoutMs: number;
}
/** A job that has not run for this many intervals (Redis down/flushed) is run directly from the DB (D14). */
const STALE_FACTOR = 3;
const WORKER_CONCURRENCY = 4;

/**
 * BullMQ-driven job processing. Each `JobDef` is a repeatable job scheduler; a BullMQ `Worker` executes them.
 * Postgres stays the source of truth: the jobs are idempotent DB sweepers, and a watchdog (a) re-registers the
 * schedulers (so `FLUSHALL` is healed within seconds) and (b) runs any job that BullMQ did not run in time
 * straight from the DB, so losing Redis never loses or delays work for long (invariant 13).
 */
@Injectable()
export class QueueRunner implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('QueueRunner');
  private readonly byName: Map<string, JobDef>;
  private readonly lastRun = new Map<string, number>();
  private readonly running = new Set<string>();
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private readonly redis: Redis[] = [];
  private watchdog: NodeJS.Timeout | null = null;
  private closing = false;
  private registering = false;
  private readonly tuning: Tuning;

  constructor(
    @Inject(JOBS) private readonly jobs: JobDef[],
    @Inject(REDIS_URL) private readonly redisUrl: string | undefined,
    @Inject(ON_SHUTDOWN) private readonly onShutdown: () => Promise<void>,
    @Inject(TUNING) tuning: Partial<Tuning>,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.byName = new Map(jobs.map((j) => [j.name, j]));
    this.tuning = { watchdogMs: WATCHDOG_MS, minStaleMs: WATCHDOG_MS * 2, closeTimeoutMs: 5_000, ...tuning };
  }

  async onModuleInit(): Promise<void> {
    if (this.redisUrl) {
      this.queue = new Queue(QUEUE_NAME, {
        connection: this.connect(),
        defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 },
      });
      this.queue.on('error', () => undefined);
      this.worker = new Worker(QUEUE_NAME, (job: Job) => this.exec(job.name), {
        connection: this.connect(), concurrency: WORKER_CONCURRENCY,
      });
      this.worker.on('error', () => undefined);
      this.worker.on('failed', (job, e) => this.log.error(`job ${job?.name ?? '?'} failed: ${e.message}`));
      await this.registerBounded();
    }
    this.watchdog = setInterval(() => void this.watch(), this.tuning.watchdogMs);
    this.log.log(`${this.redisUrl ? 'bullmq' : 'db-only'} mode, ${this.jobs.length} jobs`);
  }

  /** Graceful shutdown: stop scheduling, let in-flight jobs finish, then close the connections. */
  async onApplicationShutdown(): Promise<void> {
    this.closing = true;
    if (this.watchdog) clearInterval(this.watchdog);
    const limit = this.tuning.closeTimeoutMs;
    const bounded = (p: Promise<unknown> | undefined): Promise<unknown> =>
      Promise.race([p ?? Promise.resolve(), new Promise((r) => setTimeout(r, limit))]).catch(() => undefined);
    await bounded(this.worker?.close());
    await bounded(this.queue?.close());
    while (this.running.size > 0) await new Promise((r) => setTimeout(r, 50));
    for (const r of this.redis) r.disconnect();
    await this.onShutdown();
  }

  /** Runs one job once (what a BullMQ job does); skipped when the same job is already running in this process. */
  async exec(name: string): Promise<void> {
    const def = this.byName.get(name);
    if (!def || this.running.has(name)) return;
    this.running.add(name);
    try {
      await def.run();
      this.lastRun.set(name, this.clock.now().getTime());
    } finally {
      this.running.delete(name);
    }
  }

  private connect(): Redis {
    // BullMQ requires maxRetriesPerRequest: null on its connections.
    const r = new Redis(this.redisUrl!, { maxRetriesPerRequest: null });
    r.on('error', (e: unknown) => this.log.warn(`redis: ${e instanceof Error ? e.message : String(e)}`));
    this.redis.push(r);
    return r;
  }

  /**
   * Registers the schedulers but never blocks on a dead Redis (its commands queue up until it returns):
   * waits at most 2 s and does not start a second attempt while one is still pending.
   */
  private async registerBounded(): Promise<void> {
    if (this.registering) return;
    this.registering = true;
    const attempt = this.registerSchedulers().catch(() => undefined).finally(() => { this.registering = false; });
    await Promise.race([attempt, new Promise((r) => setTimeout(r, 2_000))]);
  }

  private async registerSchedulers(): Promise<void> {
    if (!this.queue) return;
    for (const j of this.jobs) {
      await this.queue.upsertJobScheduler(j.name, { every: j.everyMs }, { name: j.name });
    }
  }

  private async watch(): Promise<void> {
    if (this.closing) return;
    // Heals a flushed/restarted Redis: upsert is idempotent, so doing it on every tick is safe.
    await this.registerBounded();
    const now = this.clock.now().getTime();
    for (const j of this.jobs) {
      const last = this.lastRun.get(j.name) ?? 0;
      if (now - last < Math.max(j.everyMs * STALE_FACTOR, this.tuning.minStaleMs)) continue;
      this.exec(j.name).catch((e: unknown) =>
        this.log.error(`fallback ${j.name} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
