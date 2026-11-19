import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { MAX_PHOTOS } from '@auction/shared';
import { FakeClock } from '../common/clock/clock.js';
import { createDb, runMigrations } from '../db/client.js';
import { categories, cities, lotPhotos, lots, users } from '../db/schema.js';
import type { Principal } from '../lots/lots.js';
import { MediaService } from './media.js';
import { MemoryStorage } from './storage.js';

const { db } = createDb(process.env.TEST_DATABASE_URL);
const clock = new FakeClock('2030-01-01T00:00:00.000Z');
const storage = new MemoryStorage();
const media = new MediaService(db, clock, storage);

let categoryId: string;
let cityId: string;
let seller: Principal;
let stranger: Principal;
let moderator: Principal;

async function newUser(role: Principal['role']): Promise<Principal> {
  const [u] = await db.insert(users).values({ email: `${Math.random()}@t.test`, displayName: 'Тест Юзер', passwordHash: 'x', role }).returning();
  return { id: u!.id, role };
}

async function newLot(status: typeof lots.$inferInsert['status'] = 'draft'): Promise<string> {
  const [lot] = await db.insert(lots).values({
    sellerId: seller.id, categoryId, cityId, title: 'L', description: 'D', startPrice: 10_000, currentPrice: 10_000,
    durationDays: 3, condition: 'good', status, createdAt: clock.now(),
  }).returning();
  return lot!.id;
}

/** JPEG with EXIF GPS coordinates and an orientation tag. */
async function jpegWithGps(width = 1200, height = 800): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c33' } })
    .withExif({ IFD0: { Orientation: '1' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 27/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '30/1 31/1 0/1' } })
    .jpeg().toBuffer();
}

async function uploaded(lotId: string, file: Buffer, contentType = 'image/jpeg'): Promise<string> {
  const req = await media.requestUpload(seller, lotId, { contentType, sizeBytes: file.length });
  const [row] = await db.select().from(lotPhotos).where(eq(lotPhotos.id, req.photoId));
  await storage.put(row!.objectKey, file, contentType);
  await media.confirmUpload(seller, lotId, req.photoId);
  return req.photoId;
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const [cat] = await db.insert(categories).values({ slug: 'c', nameUk: 'c', nameEn: 'c', namePl: 'c' }).returning();
  const [city] = await db.insert(cities).values({ slug: 'k', nameUk: 'k', nameEn: 'k', namePl: 'k' }).returning();
  categoryId = cat!.id;
  cityId = city!.id;
  seller = await newUser('seller');
  stranger = await newUser('buyer');
  moderator = await newUser('moderator');
});

describe('photo upload requests', () => {
  it('pins the presigned upload to the declared type and size', async () => {
    const lotId = await newLot();
    const r = await media.requestUpload(seller, lotId, { contentType: 'image/png', sizeBytes: 5000 });
    expect(r.upload.fields['Content-Type']).toBe('image/png');
    expect(r.upload.fields.maxBytes).toBe('5000');
  });

  it.each([
    [{ contentType: 'image/gif', sizeBytes: 100 }],
    [{ contentType: 'application/pdf', sizeBytes: 100 }],
    [{ contentType: 'image/jpeg', sizeBytes: 20 * 1024 * 1024 }],
    [{ contentType: 'image/jpeg', sizeBytes: 0 }],
  ])('refuses %j with a validation error', async (body) => {
    const lotId = await newLot();
    await expect(media.requestUpload(seller, lotId, body)).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('refuses the 11th photo and photos for foreign or published lots', async () => {
    const lotId = await newLot();
    for (let i = 0; i < MAX_PHOTOS; i++) await media.requestUpload(seller, lotId, { contentType: 'image/jpeg', sizeBytes: 10 });
    await expect(media.requestUpload(seller, lotId, { contentType: 'image/jpeg', sizeBytes: 10 })).rejects.toMatchObject({ code: 'PHOTO_LIMIT' });
    await expect(media.requestUpload(stranger, await newLot(), { contentType: 'image/jpeg', sizeBytes: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(media.requestUpload(seller, await newLot('active'), { contentType: 'image/jpeg', sizeBytes: 10 })).rejects.toMatchObject({ code: 'LOT_NOT_EDITABLE' });
  });

  it('refuses to confirm a file that was never uploaded', async () => {
    const lotId = await newLot();
    const r = await media.requestUpload(seller, lotId, { contentType: 'image/jpeg', sizeBytes: 100 });
    await expect(media.confirmUpload(seller, lotId, r.photoId)).rejects.toMatchObject({ code: 'PHOTO_NOT_UPLOADED' });
  });

  it('refuses to confirm a photo after the lot left draft', async () => {
    const lotId = await newLot();
    const r = await media.requestUpload(seller, lotId, { contentType: 'image/jpeg', sizeBytes: 100 });
    const [row] = await db.select().from(lotPhotos).where(eq(lotPhotos.id, r.photoId));
    await storage.put(row!.objectKey, Buffer.alloc(50), 'image/jpeg');
    await db.update(lots).set({ status: 'active' }).where(eq(lots.id, lotId));
    await expect(media.confirmUpload(seller, lotId, r.photoId)).rejects.toMatchObject({ code: 'LOT_NOT_EDITABLE' });
  });

  it('discards an upload larger than declared', async () => {
    const lotId = await newLot();
    const r = await media.requestUpload(seller, lotId, { contentType: 'image/jpeg', sizeBytes: 100 });
    const [row] = await db.select().from(lotPhotos).where(eq(lotPhotos.id, r.photoId));
    await storage.put(row!.objectKey, Buffer.alloc(500), 'image/jpeg');
    await expect(media.confirmUpload(seller, lotId, r.photoId)).rejects.toMatchObject({ code: 'PHOTO_TOO_LARGE' });
    expect(storage.objects.has(row!.objectKey)).toBe(false);
  });
});

describe('photo processing', () => {
  it('strips EXIF/GPS from the stored original and makes a 400 px preview', async () => {
    const source = await jpegWithGps();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const lotId = await newLot();
    const photoId = await uploaded(lotId, source);

    expect(await media.processPhoto(photoId)).toBe(true);
    const [row] = await db.select().from(lotPhotos).where(eq(lotPhotos.id, photoId));
    expect(row!.status).toBe('processed');
    const original = storage.objects.get(row!.objectKey)!.body;
    const preview = storage.objects.get(row!.previewKey!)!.body;
    expect((await sharp(original).metadata()).exif).toBeUndefined();
    expect((await sharp(preview).metadata()).exif).toBeUndefined();
    expect(original.includes(Buffer.from('GPS'))).toBe(false);
    expect((await sharp(preview).metadata()).width).toBe(400);
    expect([...storage.objects.keys()].some((k) => k.startsWith('raw/') && k.includes(photoId))).toBe(false);
  });

  it('does not upscale small images and is idempotent', async () => {
    const lotId = await newLot();
    const photoId = await uploaded(lotId, await jpegWithGps(200, 100));
    expect(await media.processPhoto(photoId)).toBe(true);
    expect(await media.processPhoto(photoId)).toBe(true);
    const [row] = await db.select().from(lotPhotos).where(eq(lotPhotos.id, photoId));
    expect((await sharp(storage.objects.get(row!.previewKey!)!.body).metadata()).width).toBe(200);
  });

  it('discards a file whose content is not the declared image type', async () => {
    const lotId = await newLot();
    const fake = await uploaded(lotId, Buffer.from('<?php echo 1; ?>'));
    expect(await media.processPhoto(fake)).toBe(false);
    expect(await db.select().from(lotPhotos).where(eq(lotPhotos.id, fake))).toHaveLength(0);

    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
    const mismatched = await uploaded(lotId, png, 'image/jpeg');
    expect(await media.processPhoto(mismatched)).toBe(false);
  });

  it('lets several workers process one photo without duplicating work', async () => {
    const lotId = await newLot();
    const photoId = await uploaded(lotId, await jpegWithGps(500, 500));
    const results = await Promise.all([1, 2, 3, 4].map(() => media.processPhoto(photoId)));
    expect(results.every(Boolean)).toBe(true);
    expect(await media.findUnprocessed()).not.toContain(photoId);
  });
});

describe('photo privacy (invariant 12)', () => {
  it('hides photos of an unapproved lot from everyone except owner and moderator', async () => {
    const lotId = await newLot();
    const photoId = await uploaded(lotId, await jpegWithGps(300, 300));
    await media.processPhoto(photoId);
    await db.update(lots).set({ status: 'in_review' }).where(eq(lots.id, lotId));

    for (const viewer of [null, stranger]) {
      await expect(media.viewUrl(viewer, lotId, photoId, 'original')).rejects.toMatchObject({ status: 404 });
      await expect(media.list(viewer, lotId)).rejects.toMatchObject({ status: 404 });
    }
    expect((await media.viewUrl(seller, lotId, photoId, 'original')).url).toContain('photos/');
    expect((await media.viewUrl(moderator, lotId, photoId, 'preview')).url).toContain('previews/');
  });

  it('shows only processed photos once the lot is published', async () => {
    const lotId = await newLot('active');
    const [pending] = await db.insert(lotPhotos).values({
      lotId, position: 0, objectKey: `raw/${lotId}/x`, contentType: 'image/jpeg', sizeBytes: 10,
    }).returning();
    const [ready] = await db.insert(lotPhotos).values({
      lotId, position: 1, objectKey: `photos/${lotId}/y`, previewKey: `previews/${lotId}/y.webp`,
      contentType: 'image/jpeg', sizeBytes: 10, status: 'processed',
    }).returning();
    expect((await media.list(null, lotId)).map((p) => p.id)).toEqual([ready!.id]);
    await expect(media.viewUrl(null, lotId, pending!.id, 'original')).rejects.toMatchObject({ status: 404 });
    expect((await media.viewUrl(null, lotId, ready!.id, 'preview')).expiresInSeconds).toBeGreaterThan(0);
  });

  it('does not let one seller delete or confirm another seller’s photo', async () => {
    const lotId = await newLot();
    const photoId = await uploaded(lotId, await jpegWithGps(100, 100));
    await expect(media.deletePhoto(stranger, lotId, photoId)).rejects.toMatchObject({ status: 404 });
    await expect(media.confirmUpload(stranger, lotId, photoId)).rejects.toMatchObject({ status: 404 });
    await media.deletePhoto(seller, lotId, photoId);
    expect(await db.select().from(lotPhotos).where(eq(lotPhotos.id, photoId))).toHaveLength(0);
  });
});
