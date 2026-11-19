import { and, asc, desc, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { IndexSwap, Meilisearch, Task } from 'meilisearch';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { lots, searchOutbox } from '../db/schema.js';
import { INDEX_SETTINGS, SEARCHABLE_STATUSES, toSearchDoc, type LotSearchDoc } from './document.js';

export const LOTS_INDEX = 'lots';
const BATCH = 500;
const TASK_TIMEOUT_MS = 30_000;

function assertOk(task: Task): void {
  if (task.status !== 'succeeded') throw new Error(`Meilisearch task ${task.uid} ${task.status}: ${task.error?.message ?? ''}`);
}

/**
 * Outbox → Meilisearch. A DB trigger enqueues a row for every indexed change, in the writer's transaction.
 * `drain` takes a batch under `FOR UPDATE SKIP LOCKED` (any number of workers, no double work), writes the
 * latest state of each lot to the index, and only then marks rows processed. If Meilisearch is down the
 * transaction rolls back and the rows simply wait: nothing is lost and the index catches up when it returns.
 * Index writes are upserts/deletes by id, so repeating a batch is harmless.
 */
export class SearchIndexer {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly meili: Meilisearch, private readonly indexName = LOTS_INDEX) {}

  async ensureIndex(uid = this.indexName): Promise<void> {
    await this.meili.createIndex(uid, { primaryKey: 'id' }).waitTask({ timeout: TASK_TIMEOUT_MS }).then(() => undefined);
    assertOk(await this.meili.index(uid).updateSettings(INDEX_SETTINGS).waitTask({ timeout: TASK_TIMEOUT_MS }));
  }

  /**
   * Self-healing: creates the index if missing and, when it holds no documents although public lots exist
   * (fresh/wiped Meilisearch volume), rebuilds it with `reindexAll`. Cheap when the index is healthy
   * (one stats call + one DB count only while it is empty), so the worker may run it periodically.
   */
  async ensureIndexed(): Promise<{ reindexed: boolean; documents: number }> {
    await this.ensureIndex();
    const { numberOfDocuments } = await this.meili.index(this.indexName).getStats();
    if (numberOfDocuments > 0) return { reindexed: false, documents: numberOfDocuments };
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(lots)
      .where(inArray(lots.status, [...SEARCHABLE_STATUSES]));
    if ((row?.n ?? 0) === 0) return { reindexed: false, documents: 0 };
    return { reindexed: true, documents: await this.reindexAll() };
  }

  /** Processes one batch; returns the number of outbox rows handled (0 = queue empty). */
  async drain(): Promise<number> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const pending = await tx.select({ id: searchOutbox.id, lotId: searchOutbox.lotId }).from(searchOutbox)
        .where(isNull(searchOutbox.processedAt)).orderBy(asc(searchOutbox.id)).limit(BATCH)
        .for('update', { skipLocked: true });
      if (pending.length === 0) return 0;
      await this.sync(tx, [...new Set(pending.map((p) => p.lotId))]);
      await tx.update(searchOutbox).set({ processedAt: now }).where(inArray(searchOutbox.id, pending.map((p) => p.id)));
      return pending.length;
    });
  }

  /**
   * Full rebuild into a fresh index, then an atomic swap: searches keep working throughout.
   * Also drops documents of lots that no longer exist or are no longer public.
   */
  async reindexAll(): Promise<number> {
    const tmp = `${this.indexName}_rebuild`;
    await this.meili.deleteIndexIfExists(tmp);
    await this.ensureIndex(tmp);
    await this.ensureIndex(this.indexName);
    const startedAt = await this.maxOutboxId();
    let total = 0;
    let cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await this.db.select().from(lots)
        .where(and(gt(lots.id, cursor), inArray(lots.status, [...SEARCHABLE_STATUSES]))).orderBy(asc(lots.id)).limit(BATCH);
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      assertOk(await this.meili.index(tmp).addDocuments(rows.map(toSearchDoc)).waitTask({ timeout: TASK_TIMEOUT_MS }));
      total += rows.length;
    }
    // Cast: the client types require `rename` (Meilisearch >= 1.18), but our pinned v1.11 server rejects that field.
    assertOk(await this.meili.swapIndexes([{ indexes: [this.indexName, tmp] } as IndexSwap]).waitTask({ timeout: TASK_TIMEOUT_MS }));
    await this.meili.deleteIndexIfExists(tmp);
    // Changes drained into the old index while rebuilding are gone with it: queue those lots again for the new one.
    await this.db.execute(sql`insert into search_outbox (lot_id, created_at)
      select distinct lot_id, ${this.clock.now().toISOString()}::timestamptz from search_outbox where id > ${startedAt}`);
    return total;
  }

  private async maxOutboxId(): Promise<number> {
    const [row] = await this.db.select({ id: searchOutbox.id }).from(searchOutbox).orderBy(desc(searchOutbox.id)).limit(1);
    return row?.id ?? 0;
  }

  /** Writes the current state of the given lots: public ones are upserted, everything else is removed. */
  private async sync(db: Pick<Db, 'select' | 'execute'>, ids: string[]): Promise<void> {
    // Serialise indexing per lot until the surrounding transaction ends: a worker that read an older state can
    // no longer overwrite (or resurrect) a lot after another worker wrote a newer one. Sorted order avoids deadlocks.
    for (const id of [...ids].sort()) await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'search:' + id}, 0))`);
    const rows = await db.select().from(lots).where(inArray(lots.id, ids));
    const index = this.meili.index<LotSearchDoc>(this.indexName);
    const publicRows = rows.filter((r) => SEARCHABLE_STATUSES.includes(r.status));
    const publicIds = new Set(publicRows.map((r) => r.id));
    const toDelete = ids.filter((id) => !publicIds.has(id));
    if (publicRows.length > 0) assertOk(await index.addDocuments(publicRows.map(toSearchDoc)).waitTask({ timeout: TASK_TIMEOUT_MS }));
    if (toDelete.length > 0) assertOk(await index.deleteDocuments(toDelete).waitTask({ timeout: TASK_TIMEOUT_MS }));
  }
}
