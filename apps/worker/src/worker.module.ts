import { Module, type DynamicModule } from '@nestjs/common';
import { buildJobs, type JobDef, type JobServices } from './jobs.js';
import { QueueRunner, type Tuning } from './queue-runner.js';
import type { Clock } from '../../api/src/common/clock/clock.js';
import { CLOCK, JOBS, ON_SHUTDOWN, REDIS_URL, TUNING } from './tokens.js';

export interface WorkerDeps {
  services: JobServices;
  redisUrl: string | undefined;
  clock: Clock;
  /** Replaces the default job table (tests). */
  jobs?: JobDef[];
  /** Watchdog timing (tests shorten it). */
  tuning?: Partial<Tuning>;
  /** Called after in-flight jobs finished on shutdown (closes the DB pool). */
  onShutdown?: () => Promise<void>;
}

/** NestJS composition root of the worker process: BullMQ queue + processors over the shared domain services. */
@Module({})
export class WorkerModule {
  static register(deps: WorkerDeps): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        { provide: JOBS, useValue: deps.jobs ?? buildJobs(deps.services) },
        { provide: REDIS_URL, useValue: deps.redisUrl },
        { provide: ON_SHUTDOWN, useValue: deps.onShutdown ?? (() => Promise.resolve()) },
        { provide: TUNING, useValue: deps.tuning ?? {} },
        { provide: CLOCK, useValue: deps.clock },
        QueueRunner,
      ],
      exports: [QueueRunner],
    };
  }
}
