import { Inject, Injectable, Logger, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import type { Clock } from '../common/clock/clock.js';
import { AppError } from '../common/errors/app-error.js';
import type { Principal } from '../lots/lots.js';
import { CLOCK, RATE_LIMIT_POLICY, RATE_LIMIT_STORE } from './tokens.js';

export const SKIP_THROTTLE_KEY = 'auction:skip_throttle';
export const RATE_LIMIT_TIER_KEY = 'auction:rate_limit_tier';

export type RateLimitTier = 'auth' | 'bid' | 'mutation' | 'read';

export const SkipThrottle = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_THROTTLE_KEY, true);
export const RateLimitTier = (tier: RateLimitTier): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_TIER_KEY, tier);

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export interface RateLimitStore {
  consume(key: string, max: number, windowMs: number): Promise<RateLimitDecision>;
}

export interface TierLimit {
  max: number;
  windowMs: number;
  keyBy: 'ip' | 'user_or_ip';
}

export type RateLimitPolicyMap = Record<RateLimitTier, TierLimit>;

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicyMap = {
  auth: { max: 15, windowMs: 60_000, keyBy: 'ip' },
  bid: { max: 60, windowMs: 60_000, keyBy: 'user_or_ip' },
  mutation: { max: 20, windowMs: 60_000, keyBy: 'user_or_ip' },
  read: { max: 180, windowMs: 60_000, keyBy: 'user_or_ip' },
};

const LUA_FIXED_WINDOW = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return { current, tonumber(ARGV[1]) }
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return { current, pttl }
`;

/**
 * Distributed Redis fixed-window limiter with fail-open fallback.
 * Redis outage or FLUSHALL never causes 500s (invariants 13, 15).
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly log = new Logger('RedisRateLimitStore');
  private warnedUnavailable = false;

  constructor(private readonly redis: Redis) {}

  async consume(key: string, max: number, windowMs: number): Promise<RateLimitDecision> {
    try {
      const raw = (await this.redis.eval(LUA_FIXED_WINDOW, 1, key, String(windowMs))) as [number, number];
      this.warnedUnavailable = false;
      const count = Number(raw[0]);
      const pttl = Math.max(0, Number(raw[1]));
      const resetAfterSeconds = Math.max(1, Math.ceil(pttl / 1000));
      return {
        allowed: count <= max,
        limit: max,
        remaining: Math.max(0, max - count),
        resetAfterSeconds,
      };
    } catch (e) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.log.warn(`Redis rate limiter unavailable, failing open: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        allowed: true,
        limit: max,
        remaining: max,
        resetAfterSeconds: Math.ceil(windowMs / 1000),
      };
    }
  }
}

/** Single-process fallback store backed by Clock (used in unit/HTTP tests without Redis). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  constructor(private readonly clock: Clock) {}

  consume(key: string, max: number, windowMs: number): Promise<RateLimitDecision> {
    const nowMs = this.clock.now().getTime();
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) {
        if (v.resetAtMs <= nowMs) this.buckets.delete(k);
      }
    }
    const cur = this.buckets.get(key);
    if (!cur || cur.resetAtMs <= nowMs) {
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return Promise.resolve({
        allowed: true,
        limit: max,
        remaining: Math.max(0, max - 1),
        resetAfterSeconds: Math.ceil(windowMs / 1000),
      });
    }
    cur.count += 1;
    const resetAfterSeconds = Math.max(1, Math.ceil((cur.resetAtMs - nowMs) / 1000));
    return Promise.resolve({
      allowed: cur.count <= max,
      limit: max,
      remaining: Math.max(0, max - cur.count),
      resetAfterSeconds,
    });
  }
}

type AuthedRequest = Request & { principal?: Principal | null };

export function resolveClientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_POLICY) private readonly policy: RateLimitPolicyMap,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(SKIP_THROTTLE_KEY, targets) === true) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();

    const explicitTier = this.reflector.getAllAndOverride<RateLimitTier | undefined>(RATE_LIMIT_TIER_KEY, targets);
    const tier: RateLimitTier =
      explicitTier ?? (req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'mutation');

    const cfg = this.policy[tier];
    const ip = resolveClientIp(req);
    const subject =
      cfg.keyBy === 'user_or_ip' && req.principal?.id ? `user:${req.principal.id}` : `ip:${ip}`;
    const bucket = tier === 'auth' ? `auth:${req.path}` : tier;
    const windowSlot = Math.floor(this.clock.now().getTime() / cfg.windowMs);
    const key = `rl:${bucket}:${subject}:${windowSlot}`;

    const decision = await this.store.consume(key, cfg.max, cfg.windowMs);
    res.setHeader('X-RateLimit-Limit', String(decision.limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    res.setHeader('X-RateLimit-Reset', String(decision.resetAfterSeconds));

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.resetAfterSeconds));
      throw new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests, please try again later', {
        retryAfterSeconds: decision.resetAfterSeconds,
        tier,
      });
    }
    return true;
  }
}
