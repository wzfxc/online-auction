import { beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from './storage.js';

const endpoint = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const storage = new S3Storage({
  endpoint, publicEndpoint: endpoint,
  accessKey: process.env.S3_ACCESS_KEY ?? 'minio_dev_access',
  secretKey: process.env.S3_SECRET_KEY ?? 'minio_dev_secret_key',
  bucket: 'lots-test', region: 'us-east-1',
});

async function post(up: { url: string; fields: Record<string, string> }, body: Buffer, type: string): Promise<number> {
  const form = new FormData();
  for (const [k, v] of Object.entries(up.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(body)], { type }));
  return (await fetch(up.url, { method: 'POST', body: form })).status;
}

beforeAll(() => storage.ensureBucket());

describe('presigned upload against real MinIO', () => {
  it('accepts the declared file, refuses another type or an oversized file', async () => {
    const key = `raw/t/${Date.now()}-a`;
    const up = await storage.presignUpload(key, 'image/jpeg', 1000, 60);
    expect(await post(up, Buffer.alloc(500), 'image/jpeg')).toBeLessThan(300);
    expect(await storage.head(key)).toEqual({ size: 500 });

    const k2 = `raw/t/${Date.now()}-b`;
    const up2 = await storage.presignUpload(k2, 'image/jpeg', 1000, 60);
    expect(await post({ ...up2, fields: { ...up2.fields, 'Content-Type': 'application/pdf' } }, Buffer.alloc(500), 'application/pdf')).toBeGreaterThanOrEqual(400);
    expect(await storage.head(k2)).toBeNull();

    const k3 = `raw/t/${Date.now()}-c`;
    const up3 = await storage.presignUpload(k3, 'image/jpeg', 1000, 60);
    expect(await post(up3, Buffer.alloc(20 * 1024 * 1024), 'image/jpeg')).toBeGreaterThanOrEqual(400);
    expect(await storage.head(k3)).toBeNull();
  });

  it('keeps the bucket private: unsigned GET is denied, signed GET works', async () => {
    const key = `photos/t/${Date.now()}`;
    await storage.put(key, Buffer.from('hello'), 'image/jpeg');
    expect((await fetch(`${endpoint}/lots-test/${key}`)).status).toBeGreaterThanOrEqual(400);
    const res = await fetch(await storage.presignDownload(key, 60));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });
});
