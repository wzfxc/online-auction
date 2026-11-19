import { and, asc, eq, sql } from 'drizzle-orm';
import {
  MAX_PHOTOS, PHOTO_CONTENT_TYPES, PHOTO_MAX_BYTES, PHOTO_UPLOAD_TTL_SECONDS, PHOTO_VIEW_TTL_SECONDS,
  type LotStatus,
} from '@auction/shared';
import { z } from 'zod';
import type { Clock } from '../common/clock/clock.js';
import { Errors } from '../common/errors/app-error.js';
import type { Db } from '../db/client.js';
import { lotEvents, lotPhotos, lots } from '../db/schema.js';
import type { Principal } from '../lots/lots.js';
import { processImage } from './process-image.js';
import type { ObjectStorage, PresignedUpload } from './storage.js';

export const requestUploadSchema = z.object({
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(PHOTO_MAX_BYTES),
});

export interface PhotoUploadDto {
  photoId: string;
  position: number;
  upload: PresignedUpload;
}
export interface PhotoDto {
  id: string;
  position: number;
  status: 'pending_upload' | 'uploaded' | 'processed';
}

/** Statuses in which a lot, and so its processed photos, is public. */
const PUBLIC_STATUSES: readonly LotStatus[] = ['active', 'ended_unsold', 'awaiting_payment', 'paid', 'shipped', 'completed'];

const rawKey = (lotId: string, photoId: string): string => `raw/${lotId}/${photoId}`;
const originalKey = (lotId: string, photoId: string): string => `photos/${lotId}/${photoId}`;
const previewKey = (lotId: string, photoId: string): string => `previews/${lotId}/${photoId}.webp`;

/**
 * Photos: the bucket is private. The browser uploads straight to a presigned POST pinned to one type and size;
 * a worker re-encodes the file (no EXIF) and makes a 400 px preview. Downloads are short-lived presigned GETs
 * issued only to the owner/moderators, or to anyone once the lot is published (invariant 12).
 */
export class MediaService {
  constructor(private readonly db: Db, private readonly clock: Clock, private readonly storage: ObjectStorage) {}

  async requestUpload(user: Principal, lotId: string, raw: unknown): Promise<PhotoUploadDto> {
    const parsed = requestUploadSchema.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const { contentType, sizeBytes } = parsed.data;
    const { photoId, position } = await this.db.transaction(async (tx) => {
      const [lot] = await tx.select().from(lots).where(eq(lots.id, lotId)).for('update');
      if (!lot || lot.sellerId !== user.id) throw Errors.notFound('Lot');
      if (lot.status !== 'draft') throw Errors.conflict('LOT_NOT_EDITABLE', 'Photos can be changed only while the lot is a draft');
      const taken = await tx.select({ position: lotPhotos.position }).from(lotPhotos).where(eq(lotPhotos.lotId, lotId));
      if (taken.length >= MAX_PHOTOS) throw Errors.unprocessable('PHOTO_LIMIT', `At most ${MAX_PHOTOS} photos per lot`);
      const used = new Set(taken.map((t) => t.position));
      const free = Array.from({ length: MAX_PHOTOS }, (_, i) => i).find((i) => !used.has(i))!;
      const [row] = await tx.insert(lotPhotos).values({
        lotId, position: free, objectKey: `pending/${lotId}/${free}-${this.clock.now().getTime()}`, contentType, sizeBytes,
      }).returning();
      // The final key embeds the row id, so it is set once the id exists (same transaction).
      await tx.update(lotPhotos).set({ objectKey: rawKey(lotId, row!.id) }).where(eq(lotPhotos.id, row!.id));
      return { photoId: row!.id, position: free };
    });
    const upload = await this.storage.presignUpload(rawKey(lotId, photoId), contentType, sizeBytes, PHOTO_UPLOAD_TTL_SECONDS);
    return { photoId, position, upload };
  }

  /** Owner confirms the browser finished uploading; we verify the object really exists within the declared size. */
  async confirmUpload(user: Principal, lotId: string, photoId: string): Promise<PhotoDto> {
    const photo = await this.ownPhoto(user, lotId, photoId);
    if (photo.status !== 'pending_upload') return toPhotoDto(photo);
    const head = await this.storage.head(photo.objectKey);
    if (!head) throw Errors.unprocessable('PHOTO_NOT_UPLOADED', 'The file has not been uploaded yet');
    if (head.size > PHOTO_MAX_BYTES || head.size > photo.sizeBytes) {
      await this.storage.delete(photo.objectKey);
      await this.db.delete(lotPhotos).where(eq(lotPhotos.id, photoId));
      throw Errors.unprocessable('PHOTO_TOO_LARGE', 'The uploaded file is larger than declared');
    }
    const [row] = await this.db.update(lotPhotos).set({ status: 'uploaded' })
      .where(and(eq(lotPhotos.id, photoId), eq(lotPhotos.status, 'pending_upload'))).returning();
    return toPhotoDto(row ?? photo);
  }

  /**
   * Worker step. Safe to repeat and to run in several workers: the status CAS makes one of them win.
   * Returns false when the file is not a valid image of the declared type (the photo is discarded).
   */
  async processPhoto(photoId: string): Promise<boolean> {
    const [photo] = await this.db.select().from(lotPhotos).where(eq(lotPhotos.id, photoId));
    if (!photo || photo.status !== 'uploaded') return photo?.status === 'processed';
    const source = await this.storage.get(photo.objectKey);
    const result = source && source.length <= PHOTO_MAX_BYTES ? await processImage(source, photo.contentType) : null;
    if (!result) {
      await this.storage.delete(photo.objectKey);
      await this.db.delete(lotPhotos).where(and(eq(lotPhotos.id, photoId), eq(lotPhotos.status, 'uploaded')));
      return false;
    }
    const finalKey = originalKey(photo.lotId, photo.id);
    const thumbKey = previewKey(photo.lotId, photo.id);
    await this.storage.put(finalKey, result.original, result.contentType);
    await this.storage.put(thumbKey, result.preview, 'image/webp');
    const [done] = await this.db.update(lotPhotos)
      .set({ status: 'processed', objectKey: finalKey, previewKey: thumbKey, sizeBytes: result.original.length })
      .where(and(eq(lotPhotos.id, photoId), eq(lotPhotos.status, 'uploaded'))).returning();
    if (done) await this.storage.delete(photo.objectKey);
    return true;
  }

  async deletePhoto(user: Principal, lotId: string, photoId: string): Promise<void> {
    const photo = await this.ownPhoto(user, lotId, photoId);
    const [lot] = await this.db.select().from(lots).where(eq(lots.id, lotId));
    if (lot?.status !== 'draft') throw Errors.conflict('LOT_NOT_EDITABLE', 'Photos can be changed only while the lot is a draft');
    await this.db.delete(lotPhotos).where(eq(lotPhotos.id, photoId));
    await this.storage.delete(photo.objectKey);
    if (photo.previewKey) await this.storage.delete(photo.previewKey);
    await this.db.insert(lotEvents).values({ lotId, actorId: user.id, type: 'photo_deleted', payload: { photoId }, createdAt: this.clock.now() });
  }

  /** Ordered photo list; owners and moderators see all of them, everyone else only processed photos of a published lot. */
  async list(viewer: Principal | null, lotId: string): Promise<PhotoDto[]> {
    const lot = await this.visibleLot(viewer, lotId);
    const privileged = viewer?.id === lot.sellerId || viewer?.role === 'moderator';
    const rows = await this.db.select().from(lotPhotos)
      .where(privileged ? eq(lotPhotos.lotId, lotId) : and(eq(lotPhotos.lotId, lotId), eq(lotPhotos.status, 'processed')))
      .orderBy(asc(lotPhotos.position));
    return rows.map(toPhotoDto);
  }

  /** Short-lived signed link. Anything the viewer may not see looks like it does not exist. */
  async viewUrl(viewer: Principal | null, lotId: string, photoId: string, variant: 'original' | 'preview'): Promise<{ url: string; expiresInSeconds: number }> {
    const lot = await this.visibleLot(viewer, lotId);
    const [photo] = await this.db.select().from(lotPhotos).where(and(eq(lotPhotos.id, photoId), eq(lotPhotos.lotId, lotId)));
    const privileged = viewer?.id === lot.sellerId || viewer?.role === 'moderator';
    if (!photo || (!privileged && photo.status !== 'processed')) throw Errors.notFound('Photo');
    const key = variant === 'preview' ? photo.previewKey : photo.objectKey;
    if (!key || photo.status === 'pending_upload') throw Errors.notFound('Photo');
    return { url: await this.storage.presignDownload(key, PHOTO_VIEW_TTL_SECONDS), expiresInSeconds: PHOTO_VIEW_TTL_SECONDS };
  }

  /** Photos stuck in `uploaded` (worker died, Redis lost): the DB sweeper feeds them back, so no queue is required. */
  async findUnprocessed(limit = 100): Promise<string[]> {
    const rows = await this.db.select({ id: lotPhotos.id }).from(lotPhotos)
      .where(eq(lotPhotos.status, 'uploaded')).orderBy(sql`${lotPhotos.id}`).limit(limit);
    return rows.map((r) => r.id);
  }

  private async visibleLot(viewer: Principal | null, lotId: string): Promise<typeof lots.$inferSelect> {
    const [lot] = await this.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot) throw Errors.notFound('Lot');
    const privileged = viewer?.id === lot.sellerId || viewer?.role === 'moderator';
    if (!privileged && !PUBLIC_STATUSES.includes(lot.status)) throw Errors.notFound('Lot');
    return lot;
  }

  private async ownPhoto(user: Principal, lotId: string, photoId: string): Promise<typeof lotPhotos.$inferSelect> {
    const [row] = await this.db.select({ photo: lotPhotos }).from(lotPhotos)
      .innerJoin(lots, eq(lots.id, lotPhotos.lotId))
      .where(and(eq(lotPhotos.id, photoId), eq(lotPhotos.lotId, lotId), eq(lots.sellerId, user.id)));
    if (!row) throw Errors.notFound('Photo');
    return row.photo;
  }
}

function toPhotoDto(p: typeof lotPhotos.$inferSelect): PhotoDto {
  return { id: p.id, position: p.position, status: p.status };
}
