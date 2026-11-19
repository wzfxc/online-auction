import { z } from 'zod';

const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  MEILI_URL: z.string().url(),
  MEILI_MASTER_KEY: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  MAIL_FROM: z.string().min(1).default('auction@example.test'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PAYMENT_WEBHOOK_SECRET: z.string().min(8),
  PAYMENT_STUB_MODE: z.enum(['none', 'chaos']).default('none'),
  PAYMENT_STUB_BASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  INSTANCE_ID: z.string().default('api'),
  TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(DEFAULT_TOKEN_TTL_SECONDS),
});

export type Env = z.infer<typeof envSchema>;

/** Fails at startup, listing every missing or invalid variable, instead of crashing later in a request. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
