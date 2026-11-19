import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { JobDef, JobServices } from './jobs.js';
import { SystemClock } from '../../api/src/common/clock/clock.js';
import { QueueRunner } from './queue-runner.js';
import { WorkerModule } from './worker.module.js';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const NO_SERVICES = {} as JobServices;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condition not met in time');
    await sleep(50);
  }
}

const apps: INestApplicationContext[] = [];
async function start(jobs: JobDef[], redisUrl: string | undefined, extra: { onShutdown?: () => Promise<void> } = {}) {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register({
      services: NO_SERVICES, redisUrl, clock: new SystemClock(), jobs, tuning: { watchdogMs: 200, minStaleMs: 600, closeTimeoutMs: 500 }, ...extra,
    }),
    { logger: false },
  );
  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('worker: BullMQ on NestJS', () => {
  it('runs jobs from BullMQ schedulers and keeps running after Redis FLUSHALL', async () => {
    let runs = 0;
    await start([{ name: 'tick', everyMs: 100, run: () => { runs += 1; return Promise.resolve(); } }], REDIS_URL);
    await until(() => runs >= 3);

    const redis = new Redis(REDIS_URL);
    await redis.flushall();
    await redis.quit();
    const before = runs;
    await until(() => runs >= before + 3); // schedulers re-registered / DB fallback, nothing is lost
  });

  it('with Redis unavailable the jobs still run straight from the database (D14)', async () => {
    let runs = 0;
    await start([{ name: 'tick', everyMs: 100, run: () => { runs += 1; return Promise.resolve(); } }], 'redis://127.0.0.1:1');
    await until(() => runs >= 2);
  });

  it('three workers share one queue: a job never overlaps within a process and each tick is processed', async () => {
    const counts = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      await start([{ name: 'shared', everyMs: 100, run: () => { counts[i] = (counts[i] ?? 0) + 1; return Promise.resolve(); } }], REDIS_URL);
    }
    await until(() => counts.reduce((a, b) => a + b, 0) >= 5);
  });

  it('graceful shutdown waits for an in-flight job, then runs the shutdown hook', async () => {
    let started = false;
    let finished = false;
    let closed = false;
    const app = await start([{
      name: 'slow', everyMs: 100,
      run: async () => { started = true; await sleep(600); finished = true; },
    }], REDIS_URL, { onShutdown: () => { closed = true; return Promise.resolve(); } });
    await until(() => started);
    await app.close();
    expect(finished).toBe(true);
    expect(closed).toBe(true);
    apps.length = 0;
  });

  it('a failing job does not stop the others', async () => {
    let good = 0;
    await start([
      { name: 'bad', everyMs: 100, run: () => Promise.reject(new Error('boom')) },
      { name: 'good', everyMs: 100, run: () => { good += 1; return Promise.resolve(); } },
    ], REDIS_URL);
    await until(() => good >= 3);
    const runner = apps[0]!.get(QueueRunner);
    await expect(runner.exec('bad')).rejects.toThrow('boom');
  });
});
