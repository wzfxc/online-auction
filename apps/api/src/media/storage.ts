import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

/** Port to the private bucket. The S3 adapter is used in production; tests use `MemoryStorage`. */
export interface ObjectStorage {
  /** POST policy pinned to one content type and a size range: any other file is refused by the store itself. */
  presignUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds: number): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface S3StorageConfig {
  endpoint: string;
  /** Endpoint the browser can reach (differs from `endpoint` inside docker). */
  publicEndpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
}

export class S3Storage implements ObjectStorage {
  private readonly internal: S3Client;
  private readonly external: S3Client;

  constructor(private readonly cfg: S3StorageConfig) {
    const base = { region: cfg.region, forcePathStyle: true, credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey } };
    this.internal = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.external = new S3Client({ ...base, endpoint: cfg.publicEndpoint });
  }

  /** Creates the (private) bucket if missing; safe to call on every start. */
  async ensureBucket(): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.cfg.bucket }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
      await this.internal.send(new CreateBucketCommand({ Bucket: this.cfg.bucket }));
    }
  }

  async presignUpload(key: string, contentType: string, maxBytes: number, ttlSeconds: number): Promise<PresignedUpload> {
    return createPresignedPost(this.external, {
      Bucket: this.cfg.bucket,
      Key: key,
      Expires: ttlSeconds,
      Fields: { 'Content-Type': contentType },
      Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]],
    });
  }

  presignDownload(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.external, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const r = await this.internal.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.internal.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.internal.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}

/** In-memory store for unit/integration tests; presigned values are opaque markers, not enforced. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  presignUpload(key: string, contentType: string, maxBytes: number): Promise<PresignedUpload> {
    return Promise.resolve({ url: 'memory://upload', fields: { key, 'Content-Type': contentType, maxBytes: String(maxBytes) } });
  }
  presignDownload(key: string): Promise<string> {
    return Promise.resolve(`memory://download/${key}`);
  }
  head(key: string): Promise<{ size: number } | null> {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.body.length } : null);
  }
  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.objects.get(key)?.body ?? null);
  }
  put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
