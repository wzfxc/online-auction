import type { ClosingService } from '../../api/src/closing/closing.js';
import type { MediaService } from '../../api/src/media/media.js';
import type { ModerationService } from '../../api/src/moderation/moderation.js';
import type { NotificationService } from '../../api/src/notifications/notifications.js';
import type { PaymentService } from '../../api/src/payments/payments.js';
import type { SalesService } from '../../api/src/sales/sales.js';
import type { SearchIndexer } from '../../api/src/search/indexer.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** One recurring unit of work. `run` must be idempotent (compare-and-set / SKIP LOCKED inside the services). */
export interface JobDef {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

export interface JobServices {
  closing: ClosingService;
  sales: SalesService;
  moderation: ModerationService;
  notifications: NotificationService;
  media: MediaService;
  payments: PaymentService;
  indexer: SearchIndexer;
}

/**
 * Job table of the worker. BullMQ schedules these (repeatable job schedulers) and processes them in `QueueRunner`;
 * because Postgres is the source of truth (D14), each job only sweeps the DB, so a lost queue loses nothing.
 */
export function buildJobs(s: JobServices): JobDef[] {
  /** Keeps draining while a backlog exists (bounded per run) so search lag stays small after bursts. */
  const drainSearch = async (): Promise<number> => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const n = await s.indexer.drain();
      total += n;
      if (n === 0) break;
    }
    return total;
  };
  const processPhotos = async (): Promise<number> => {
    const ids = await s.media.findUnprocessed();
    for (const id of ids) await s.media.processPhoto(id);
    return ids.length;
  };
  return [
    { name: 'search-drain', everyMs: SECOND, run: drainSearch },
    // Empty/missing Meilisearch index (fresh volume, wipe) → rebuild with reindexAll().
    { name: 'search-recover', everyMs: 30 * SECOND, run: () => s.indexer.ensureIndexed() },
    { name: 'close-ended-lots', everyMs: SECOND, run: () => s.closing.sweepEndedLots() },
    { name: 'overdue-sales', everyMs: 10 * SECOND, run: () => s.closing.sweepOverdueSales() },
    { name: 'auto-confirm-sales', everyMs: 30 * SECOND, run: () => s.sales.sweepAutoConfirmSales() },
    { name: 'moderation-leases', everyMs: 30 * SECOND, run: () => s.moderation.releaseExpiredLeases() },
    { name: 'photos', everyMs: 2 * SECOND, run: processPhotos },
    { name: 'emails', everyMs: 2 * SECOND, run: () => s.notifications.drainEmails() },
    { name: 'ending-reminders', everyMs: MINUTE, run: () => s.notifications.sendEndingReminders() },
    { name: 'reconcile-payments', everyMs: 30 * SECOND, run: () => s.payments.reconcile() },
  ];
}
