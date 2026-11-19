import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import sharp from 'sharp';
import { hashPassword } from '../auth/crypto.js';
import type { Db } from '../db/client.js';
import { categories, cities, lotPhotos } from '../db/schema.js';
import { topUp } from '../ledger/wallet.js';
import type { ObjectStorage } from '../media/storage.js';

export const SEED_KEY = 'seed:v1';
export const SEED_PASSWORD = 'password123';
const LOCK_KEY = 7_340_017;
const DEMO_BUYERS = 10;
const DEMO_FUNDS = 5_000_000;
const PHOTO_VARIANTS = 12;
const PHOTO_CHUNK = 50;

export interface SeedOptions {
  users: number;
  lots: number;
  active: number;
  endingSoon: number;
  inReview: number;
  bids: number;
  moderators: number;
  finance: number;
  sellers: number;
}

/** The scale required by the assignment: 10k users, 50k lots (5k active), 500k bids. */
export const SEED_DEFAULTS: SeedOptions = {
  users: 10_000, lots: 50_000, active: 5_000, endingSoon: 200, inReview: 100, bids: 500_000,
  moderators: 3, finance: 1, sellers: 2_000,
};

const CATEGORIES: readonly [string, string, string, string][] = [
  ['electronics', 'Електроніка', 'Electronics', 'Elektronika'], ['phones', 'Телефони', 'Phones', 'Telefony'],
  ['computers', 'Комп’ютери', 'Computers', 'Komputery'], ['photo', 'Фототехніка', 'Photo gear', 'Sprzęt foto'],
  ['audio', 'Аудіо', 'Audio', 'Audio'], ['tv', 'Телевізори', 'TVs', 'Telewizory'],
  ['appliances', 'Побутова техніка', 'Appliances', 'AGD'], ['furniture', 'Меблі', 'Furniture', 'Meble'],
  ['clothing', 'Одяг', 'Clothing', 'Odzież'], ['shoes', 'Взуття', 'Shoes', 'Obuwie'],
  ['accessories', 'Аксесуари', 'Accessories', 'Akcesoria'], ['jewelry', 'Прикраси', 'Jewelry', 'Biżuteria'],
  ['watches', 'Годинники', 'Watches', 'Zegarki'], ['books', 'Книги', 'Books', 'Książki'],
  ['instruments', 'Музичні інструменти', 'Instruments', 'Instrumenty'], ['sports', 'Спорт', 'Sports', 'Sport'],
  ['bikes', 'Велосипеди', 'Bikes', 'Rowery'], ['toys', 'Іграшки', 'Toys', 'Zabawki'],
  ['kids', 'Дитячі товари', 'Kids', 'Dla dzieci'], ['garden', 'Сад і город', 'Garden', 'Ogród'],
  ['tools', 'Інструменти', 'Tools', 'Narzędzia'], ['auto-parts', 'Автозапчастини', 'Auto parts', 'Części auto'],
  ['collectibles', 'Колекційне', 'Collectibles', 'Kolekcje'], ['art', 'Мистецтво', 'Art', 'Sztuka'],
  ['antiques', 'Антикваріат', 'Antiques', 'Antyki'], ['coins', 'Монети', 'Coins', 'Monety'],
  ['games', 'Ігри', 'Games', 'Gry'], ['health', 'Здоров’я', 'Health', 'Zdrowie'],
  ['pets', 'Товари для тварин', 'Pets', 'Zwierzęta'], ['office', 'Офіс', 'Office', 'Biuro'],
];

const CITIES: readonly [string, string, string, string][] = [
  ['kyiv', 'Київ', 'Kyiv', 'Kijów'], ['kharkiv', 'Харків', 'Kharkiv', 'Charków'],
  ['odesa', 'Одеса', 'Odesa', 'Odessa'], ['dnipro', 'Дніпро', 'Dnipro', 'Dniepr'],
  ['lviv', 'Львів', 'Lviv', 'Lwów'], ['zaporizhzhia', 'Запоріжжя', 'Zaporizhzhia', 'Zaporoże'],
  ['kryvyi-rih', 'Кривий Ріг', 'Kryvyi Rih', 'Krzywy Róg'], ['mykolaiv', 'Миколаїв', 'Mykolaiv', 'Mikołajów'],
  ['vinnytsia', 'Вінниця', 'Vinnytsia', 'Winnica'], ['poltava', 'Полтава', 'Poltava', 'Połtawa'],
  ['chernihiv', 'Чернігів', 'Chernihiv', 'Czernihów'], ['cherkasy', 'Черкаси', 'Cherkasy', 'Czerkasy'],
  ['zhytomyr', 'Житомир', 'Zhytomyr', 'Żytomierz'], ['sumy', 'Суми', 'Sumy', 'Sumy'],
  ['rivne', 'Рівне', 'Rivne', 'Równe'],
];

export interface SeedSummary {
  seeded: boolean;
  users: number;
  lots: number;
  bids: number;
  photos: number;
}

/** Runs `fn` while holding a Postgres advisory lock, so several workers/replicas seed at most once. */
async function withLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    return await fn();
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function count(db: Db, table: string): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * Idempotent, reproducible-in-shape seed (volume and statuses are deterministic; names/times are relative to `now`).
 * Done in set-based SQL (generate_series), a few seconds for 50k lots / 500k bids. The marker row and all bulk data
 * commit together, so a crash never leaves a half-seeded database that would be mistaken for a finished one.
 * Seeded history is data only: it has no ledger entries (see D26); demo buyers get real, ledger-backed wallets.
 */
export async function runSeed(
  db: Db, pool: pg.Pool, now: Date, storage: ObjectStorage | null, opts: SeedOptions = SEED_DEFAULTS,
): Promise<SeedSummary> {
  return withLock(pool, async () => {
    const done = await db.execute(sql`select 1 from job_effects where key = ${SEED_KEY}`);
    let seeded = false;
    if (done.rows.length === 0) {
      await seedData(db, now, opts);
      seeded = true;
    }
    const photos = storage ? await seedPhotos(db, storage) : 0;
    return {
      seeded, users: await count(db, 'users'), lots: await count(db, 'lots'), bids: await count(db, 'bids'), photos,
    };
  });
}

async function seedData(db: Db, now: Date, o: SeedOptions): Promise<void> {
  const hash = await hashPassword(SEED_PASSWORD);
  const NOW = sql`${now.toISOString()}::timestamptz`;
  const bidLots = o.lots - o.inReview;
  const base = Math.floor(o.bids / bidLots);
  const extra = o.bids - base * bidLots;
  const completed = Math.floor((o.lots - o.active - o.inReview) / 2);
  const M = o.moderators;
  const S = o.sellers;

  await db.transaction(async (tx) => {
    for (const [slug, uk, en, pl] of CATEGORIES) {
      await tx.insert(categories).values({ slug, nameUk: uk, nameEn: en, namePl: pl }).onConflictDoNothing();
    }
    for (const [slug, uk, en, pl] of CITIES) {
      await tx.insert(cities).values({ slug, nameUk: uk, nameEn: en, namePl: pl }).onConflictDoNothing();
    }

    await tx.execute(sql`
      insert into users (email, display_name, password_hash, role, created_at)
      select u.role || u.idx || '@auction.test',
        (array['Олег','Олена','Іван','Марія','Андрій','Ірина','Петро','Наталя','Богдан','Софія','Тарас','Юлія'])[1 + u.n % 12]
          || ' ' || (array['Коваль','Бойко','Шевчук','Мельник','Ткаченко','Кравець','Лисенко','Мороз','Бондар','Савчук','Гончар','Руденко'])[1 + (u.n * 7) % 12],
        ${hash}, u.role::user_role, ${NOW} - random() * interval '365 days'
      from (
        select n,
          case when n <= ${o.finance} then 'finance' when n <= ${o.finance + M} then 'moderator'
               when n <= ${o.finance + M + S} then 'seller' else 'buyer' end as role,
          case when n <= ${o.finance} then n when n <= ${o.finance + M} then n - ${o.finance}
               when n <= ${o.finance + M + S} then n - ${o.finance + M} else n - ${o.finance + M + S} end as idx
        from generate_series(1, ${o.users}::int) n
      ) u
      on conflict (email) do nothing`);

    await tx.execute(sql`create temp table seed_buyers on commit drop as
      select (row_number() over (order by email))::int as n, id from users where role = 'buyer' and email like 'buyer%@auction.test'`);
    await tx.execute(sql`create temp table seed_sellers on commit drop as
      select (row_number() over (order by email))::int as n, id from users where role = 'seller' and email like 'seller%@auction.test'`);
    await tx.execute(sql`create temp table seed_cats on commit drop as
      select (row_number() over (order by slug))::int as n, id from categories`);
    await tx.execute(sql`create temp table seed_cities on commit drop as
      select (row_number() over (order by slug))::int as n, id from cities`);

    await tx.execute(sql`
      create temp table seed_lots on commit drop as
      select x.i, x.id, x.st, x.start_price, x.step, x.nbids, x.ends_at,
        case when x.st in ('active', 'in_review') then ${NOW} - x.rnd * interval '2 days'
             else x.ends_at - interval '3 days' end as created_at
      from (
        select b.i, gen_random_uuid() as id, b.st, b.start_price,
          (case when b.start_price < 100000 then 1000 else 5000 end)::bigint as step,
          (case when b.bid_rank is null then 0
                else ${base} + (case when b.bid_rank <= ${extra} then 1 else 0 end) end)::int as nbids,
          random() as rnd,
          case
            when b.st = 'active' and b.i <= ${o.endingSoon} then ${NOW} + interval '1 minute' + random() * interval '55 minutes'
            when b.st = 'active' then ${NOW} + interval '1 day' + random() * interval '9 days'
            when b.st = 'in_review' then null
            else ${NOW} - ((b.i % 88) + 1) * interval '1 day' - random() * interval '1 day'
          end as ends_at
        from (
          select i,
            case when i <= ${o.active} then 'active' when i <= ${o.active + o.inReview} then 'in_review'
                 when i <= ${o.active + o.inReview + completed} then 'completed' else 'ended_unsold' end as st,
            case when i <= ${o.active} then i when i <= ${o.active + o.inReview} then null else i - ${o.inReview} end as bid_rank,
            ((10 + (i * 37) % 490) * 1000)::bigint as start_price
          from generate_series(1, ${o.lots}::int) i
        ) b
      ) x`);

    await tx.execute(sql`
      insert into lots (id, seller_id, title, description, category_id, city_id, condition, start_price, reserve_price,
        buy_now_price, duration_days, status, current_price, bid_count, leader_id, last_seq, ends_at, created_at, updated_at)
      select l.id, s.id,
        (array['Фотоапарат','Велосипед','Ноутбук','Годинник','Гітара','Куртка','Книга','Телефон','Лампа','Чайник'])[1 + l.i % 10] || ' №' || l.i,
        'Б/в річ у робочому стані. Лот №' || l.i || ', демонстраційні дані.',
        c.id, ci.id, (array['new','like_new','good','fair','poor'])[1 + l.i % 5]::item_condition, l.start_price,
        case l.st
          when 'active' then case when l.i % 3 = 0 then l.start_price + l.step * 3 end
          when 'in_review' then case when l.i % 3 = 0 then l.start_price end
          when 'completed' then case when l.i % 3 = 0 then l.start_price end
          else case when l.i % 10 = 0 then null else cur.price + l.step * 5 end
        end,
        case when l.i % 4 = 0 then l.start_price * 3 end,
        case when l.st = 'active' and l.i > ${o.endingSoon} then 10 else 3 end,
        l.st::lot_status, cur.price, l.nbids, lb.id, l.nbids, l.ends_at, l.created_at, l.created_at
      from seed_lots l
      join seed_sellers s on s.n = 1 + (l.i % (select count(*) from seed_sellers))
      join seed_cats c on c.n = 1 + (l.i % (select count(*) from seed_cats))
      join seed_cities ci on ci.n = 1 + (l.i % (select count(*) from seed_cities))
      left join seed_buyers lb on l.nbids > 0 and lb.n = 1 + ((l.i * 7 + l.nbids * 13) % (select count(*) from seed_buyers))
      cross join lateral (select case when l.nbids = 0 then l.start_price else l.start_price + (l.nbids - 1) * l.step end as price) cur`);

    await tx.execute(sql`
      insert into lot_events (lot_id, actor_id, type, payload, created_at)
      select lo.id, lo.seller_id, 'created', '{}'::jsonb, lo.created_at from lots lo join seed_lots l on l.id = lo.id
      union all
      select lo.id, lo.seller_id, 'submitted', '{}'::jsonb, lo.created_at + interval '1 minute' from lots lo join seed_lots l on l.id = lo.id
      union all
      select lo.id, (select id from users where email = 'moderator1@auction.test'), 'approved', '{}'::jsonb,
        lo.created_at + interval '5 minutes'
      from lots lo join seed_lots l on l.id = lo.id where l.st <> 'in_review'`);

    await tx.execute(sql`
      insert into bids (lot_id, user_id, seq, price_after, max_amount, kind, outcome, created_at)
      select l.id, b.id, k.k, p.price, p.price + case when k.k % 4 = 0 then l.step * 2 else 0 end,
        (case when k.k % 4 = 0 then 'auto' else 'manual' end)::bid_kind, 'leading',
        case when l.st = 'active' then ${NOW} - (l.nbids - k.k + 1) * interval '5 minutes'
             else l.ends_at - (l.nbids - k.k + 1) * interval '3 minutes' end
      from seed_lots l
      cross join lateral generate_series(1, l.nbids) as k(k)
      cross join lateral (select l.start_price + (k.k - 1) * l.step as price) p
      join seed_buyers b on b.n = 1 + ((l.i * 7 + k.k * 13) % (select count(*) from seed_buyers))`);

    // A live leader needs a stored maximum, otherwise the next real bid cannot be resolved.
    await tx.execute(sql`
      insert into bidder_maxes (lot_id, user_id, max_amount, reached_at, reached_seq)
      select b.lot_id, b.user_id, b.max_amount, b.created_at, b.seq
      from bids b join seed_lots l on l.id = b.lot_id where l.st = 'active' and b.seq = l.nbids`);

    await tx.execute(sql`
      insert into sales (lot_id, buyer_id, attempt, price, fee, status, pay_due_at, paid_at, shipped_at,
        tracking_number, confirmed_at, paid_out_at, created_at)
      select lo.id, lo.leader_id, 1, lo.current_price, least(lo.current_price, greatest(1000, lo.current_price * 5 / 100)),
        (case when l.st = 'completed' then 'completed' else 'defaulted' end)::sale_status,
        l.ends_at + interval '48 hours',
        case when l.st = 'completed' then l.ends_at + interval '5 hours' end,
        case when l.st = 'completed' then l.ends_at + interval '1 day' end,
        case when l.st = 'completed' then 'SEED-' || l.i end,
        case when l.st = 'completed' then l.ends_at + interval '3 days' end,
        case when l.st = 'completed' then l.ends_at + interval '3 days' end,
        l.ends_at
      from seed_lots l join lots lo on lo.id = l.id
      where lo.leader_id is not null and (l.st = 'completed' or (l.st = 'ended_unsold' and l.i % 10 = 0))`);

    // Demo buyers get ledger-backed funds so a reviewer can bid immediately.
    const demo = await tx.execute(sql`
      select id from users where role = 'buyer'
        and email in (select 'buyer' || g || '@auction.test' from generate_series(1, ${DEMO_BUYERS}) g)
      order by email`);
    for (const row of demo.rows) {
      const id = (row as { id: string }).id;
      await topUp(tx, id, DEMO_FUNDS, `seed:topup:${id}`);
    }
    await tx.execute(sql`insert into job_effects (key) values (${SEED_KEY}) on conflict do nothing`);
  });

  for (const t of ['users', 'lots', 'bids', 'bidder_maxes', 'sales', 'lot_events']) {
    await db.execute(sql.raw(`analyze ${t}`));
  }
}

/** Generated placeholder photos (no external assets): a handful of shapes, uploaded once per lot. */
async function seedPhotos(db: Db, storage: ObjectStorage): Promise<number> {
  const variants: { original: Buffer; preview: Buffer }[] = [];
  for (let v = 0; v < PHOTO_VARIANTS; v++) {
    const hue = (v * 360) / PHOTO_VARIANTS;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">`
      + `<rect width="800" height="600" fill="hsl(${hue},55%,75%)"/>`
      + `<circle cx="400" cy="300" r="${110 + v * 8}" fill="hsl(${hue},60%,45%)"/></svg>`;
    const original = await sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
    const preview = await sharp(original).resize({ width: 400 }).webp().toBuffer();
    variants.push({ original, preview });
  }

  let total = 0;
  for (;;) {
    const pending = await db.execute(sql`
      select l.id from lots l left join lot_photos p on p.lot_id = l.id
      where p.id is null and l.status in ('active', 'in_review') order by l.id limit ${PHOTO_CHUNK}`);
    if (pending.rows.length === 0) return total;
    const rows = await Promise.all(pending.rows.map(async (r, idx) => {
      const lotId = (r as { id: string }).id;
      const photoId = randomUUID();
      const v = variants[(total + idx) % PHOTO_VARIANTS]!;
      const objectKey = `photos/${lotId}/${photoId}`;
      const previewKey = `previews/${lotId}/${photoId}.webp`;
      await storage.put(objectKey, v.original, 'image/jpeg');
      await storage.put(previewKey, v.preview, 'image/webp');
      return {
        id: photoId, lotId, position: 0, objectKey, previewKey, contentType: 'image/jpeg',
        sizeBytes: v.original.length, status: 'processed' as const,
      };
    }));
    await db.insert(lotPhotos).values(rows).onConflictDoNothing();
    total += rows.length;
  }
}
