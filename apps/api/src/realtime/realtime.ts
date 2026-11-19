import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { and, asc, eq, gt } from 'drizzle-orm';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import type { Clock } from '../common/clock/clock.js';
import type { Db } from '../db/client.js';
import { bids, lots, users } from '../db/schema.js';
import type { Principal } from '../lots/lots.js';
import { LIVE_STATUSES, toLiveBid, toLiveDto, toOutbidDto, type LiveBidDto, type LotLiveDto } from './dto.js';

export const MAX_MISSED_BIDS = 100;
const CHANNEL = 'lot_changed';
const RECONNECT_MS = 500;

const subscribeSchema = z.object({ lotId: z.string().uuid(), lastSeq: z.number().int().min(0).optional() }).strict();
const notificationSchema = z.object({ lotId: z.string().uuid(), outbidUserId: z.string().uuid().nullable() });

export type SubscribeAck =
  | { ok: true; snapshot: LotLiveDto; missed: LiveBidDto[]; truncated: boolean }
  | { ok: false; error: { code: string; message: string } };

export interface RealtimeOptions {
  db: Db;
  clock: Clock;
  /** Source of the dedicated LISTEN connection; a pooled connection must not be held forever. */
  databaseUrl: string;
  /** Resolves a bearer token to a principal, or null when invalid. */
  authenticate: (token: string) => Promise<Principal | null>;
  /** Optional: Socket.IO Redis adapter for cross-replica operations (e.g. disconnecting a user everywhere). */
  redisUrl?: string;
  corsOrigin?: string | string[];
  onError?: (err: unknown) => void;
}

export const lotRoom = (lotId: string): string => `lot:${lotId}`;
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Socket.IO gateway. Fan-out does not depend on Redis: every replica LISTENs to Postgres NOTIFY (sent on commit by
 * a trigger on `lots`, so also for changes made by the worker) and emits to its own clients only. Redis, when
 * configured, only backs the adapter; losing it never loses a live update (invariants 10, 13).
 */
export class RealtimeServer {
  readonly io: Server;
  private listener: pg.Client | null = null;
  private redis: Redis[] = [];
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: RealtimeOptions) {
    this.io = new Server({ cors: { origin: opts.corsOrigin ?? false }, serveClient: false });
    this.io.use((socket, next) => {
      this.authenticateSocket(socket).then(() => next(), () => next(new Error('UNAUTHORIZED')));
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  async start(httpServer: HttpServer): Promise<void> {
    if (this.opts.redisUrl) {
      const pub = new Redis(this.opts.redisUrl, { maxRetriesPerRequest: null });
      const sub = pub.duplicate();
      for (const r of [pub, sub]) r.on('error', (e: unknown) => this.opts.onError?.(e));
      this.redis = [pub, sub];
      this.io.adapter(createAdapter(pub, sub));
    }
    this.io.attach(httpServer);
    await this.listen();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.io.close();
    await this.listener?.end().catch(() => undefined);
    this.redis.forEach((r) => r.disconnect());
  }

  /** Disconnects a user's sockets on every replica (remote replicas need the Redis adapter). */
  disconnectUser(userId: string): void {
    this.io.in(userRoom(userId)).disconnectSockets(true);
  }

  private async authenticateSocket(socket: Socket): Promise<void> {
    const token: unknown = socket.handshake.auth.token;
    if (token === undefined || token === null || token === '') return; // anonymous: public lots only
    const principal = typeof token === 'string' ? await this.opts.authenticate(token) : null;
    if (!principal) throw new Error('UNAUTHORIZED');
    socket.data.principal = principal;
  }

  private onConnection(socket: Socket): void {
    const principal = (socket.data.principal as Principal | undefined) ?? null;
    if (principal) void socket.join(userRoom(principal.id));
    socket.on('lot:subscribe', (raw: unknown, ack?: (r: SubscribeAck) => void) => {
      this.subscribe(socket, principal, raw).then(
        (r) => ack?.(r),
        (e: unknown) => {
          this.opts.onError?.(e);
          ack?.({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Could not subscribe' } });
        },
      );
    });
    socket.on('lot:unsubscribe', (raw: unknown) => {
      const parsed = subscribeSchema.safeParse(raw);
      if (parsed.success) void socket.leave(lotRoom(parsed.data.lotId));
    });
    socket.on('time:sync', (ack?: (r: { serverTime: string }) => void) => ack?.({ serverTime: this.opts.clock.now().toISOString() }));
  }

  /** Subscribes to a lot room and returns the current state plus bids the client missed (catch-up by seq). */
  async subscribe(socket: Socket, viewer: Principal | null, raw: unknown): Promise<SubscribeAck> {
    const parsed = subscribeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid subscription' } };
    const { lotId, lastSeq } = parsed.data;
    const [lot] = await this.opts.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot || !LIVE_STATUSES.includes(lot.status)) return { ok: false, error: { code: 'NOT_FOUND', message: 'Lot not found' } };
    // Join first, then read: an update landing in between is delivered by the room instead of being lost.
    await socket.join(lotRoom(lotId));
    const [fresh] = await this.opts.db.select().from(lots).where(eq(lots.id, lotId));
    const missed = lastSeq === undefined ? [] : await this.missedBids(lotId, lastSeq, viewer?.id ?? null);
    const truncated = missed.length > MAX_MISSED_BIDS;
    return {
      ok: true, snapshot: toLiveDto(fresh ?? lot, this.opts.clock.now()),
      missed: truncated ? missed.slice(0, MAX_MISSED_BIDS) : missed, truncated,
    };
  }

  private async missedBids(lotId: string, lastSeq: number, viewerId: string | null): Promise<LiveBidDto[]> {
    const rows = await this.opts.db
      .select({ seq: bids.seq, userId: bids.userId, name: users.displayName, priceAfter: bids.priceAfter, kind: bids.kind, createdAt: bids.createdAt })
      .from(bids).innerJoin(users, eq(users.id, bids.userId))
      .where(and(eq(bids.lotId, lotId), gt(bids.seq, lastSeq))).orderBy(asc(bids.seq)).limit(MAX_MISSED_BIDS + 1);
    return rows.map((r) => toLiveBid(r, viewerId));
  }

  private async listen(): Promise<void> {
    if (this.closed) return;
    const client = new pg.Client({ connectionString: this.opts.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel === CHANNEL && msg.payload) this.handleNotification(msg.payload).catch((e: unknown) => this.opts.onError?.(e));
    });
    let lostOnce = false;
    const lost = (e?: unknown): void => {
      if (lostOnce) return;
      lostOnce = true;
      if (e) this.opts.onError?.(e);
      if (this.listener === client) this.listener = null;
      client.removeAllListeners();
      client.on('error', () => undefined);
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
      // Notifications sent while we were not listening are gone: push fresh state to every watched lot.
      await this.refreshWatchedLots();
    } catch (e) {
      lost(e);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.listen();
    }, RECONNECT_MS);
  }

  private async refreshWatchedLots(): Promise<void> {
    for (const room of this.io.of('/').adapter.rooms.keys()) {
      if (room.startsWith('lot:')) await this.broadcastLot(room.slice(4), null);
    }
  }

  private async handleNotification(payload: string): Promise<void> {
    const parsed = notificationSchema.safeParse(JSON.parse(payload));
    if (parsed.success) await this.broadcastLot(parsed.data.lotId, parsed.data.outbidUserId);
  }

  private async broadcastLot(lotId: string, outbidUserId: string | null): Promise<void> {
    const [lot] = await this.opts.db.select().from(lots).where(eq(lots.id, lotId));
    if (!lot) return;
    // `local`: each replica serves its own clients; every replica receives the NOTIFY, so nobody is served twice.
    if (LIVE_STATUSES.includes(lot.status)) this.io.local.to(lotRoom(lotId)).emit('lot:update', toLiveDto(lot, this.opts.clock.now()));
    else this.io.local.to(lotRoom(lotId)).emit('lot:removed', { lotId });
    if (outbidUserId) this.io.local.to(userRoom(outbidUserId)).emit('user:outbid', toOutbidDto(lot));
  }
}
