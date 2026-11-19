# Онлайн-аукціон б/в речей

Повноцінна платформа онлайн-аукціону з подвійним бухгалтерським записом у PostgreSQL, живими оновленнями через дві репліки API за nginx, пошуком у Meilisearch через транзакційний outbox, приватним S3-сховищем MinIO без EXIF, платіжною заглушкою з HMAC та режимом хаосу, поштовою заглушкою Mailpit і веб-клієнтом на Next.js 15 з локалями `uk`, `en`, `pl`.

---

## 1. Запуск і тести

### Вимоги
- Docker Desktop / Docker Engine з `docker compose`
- Node.js `>= 22`, `pnpm@10` (через Corepack)

### Швидкий старт у Docker Compose (без ручних кроків)

```bash
cp .env.example .env
docker compose up --build
```

Під час запуску автоматично піднімаються:
- **PostgreSQL 16** (`127.0.0.1:5433`) — автоматично застосовуються міграції Drizzle (`apps/api/drizzle/0000..0005`);
- **Redis 7** (`127.0.0.1:6379`) — Socket.IO Redis-адаптер (джерело правди — Postgres, втрата Redis не губить дані);
- **Meilisearch v1.11** (`127.0.0.1:7700`) — пошуковий індекс `lots` із фасетами;
- **MinIO (`chainguard/minio`)** (`127.0.0.1:9000`, консоль `:9001`) — приватний бакет `lots`;
- **Mailpit** (`http://127.0.0.1:8025` веб-інтерфейс листів, SMTP `:1025`);
- **API ×2 (`api1`, `api2`) за Nginx** (`http://127.0.0.1:8080`, Swagger OpenAPI на `http://127.0.0.1:8080/docs`);
- **Worker** — цикли-свіпери БД + автоматичний ідемпотентний сид при `SEED_ON_START=true` (`10 000` користувачів, `30` категорій, `15` міст, `50 000` лотів, `500 000` ставок, `5 100` фото-заглушок);
- **Web (`apps/web`)** (`http://127.0.0.1:3000`, локалі `/uk`, `/en`, `/pl`).

### Демо-логіни (після сиду, пароль для всіх: `password123`)
- **Покупці з поповненим гаманцем (50 000 ₴):** `buyer1@auction.test` … `buyer10@auction.test` (та ще `buyer11..buyer7996@auction.test`)
- **Продавці:** `seller1@auction.test` … `seller2000@auction.test`
- **Модератори:** `moderator1@auction.test` … `moderator3@auction.test`
- **Фінансист:** `finance1@auction.test`

### Команди розробки та перевірки

```bash
pnpm install                                  # встановлення залежностей
pnpm verify                                   # typecheck + eslint + gen:check + unit-тести
pnpm gen:openapi && pnpm gen:client           # перегенерація OpenAPI та TS-клієнта
pnpm test:int                                 # інтеграційні тести (потрібні postgres, redis, meilisearch, minio, mail)
pnpm e2e                                      # Playwright e2e (проти запущеного docker compose)
node scripts/acceptance/verify-compose.mjs    # жива перевірка Meilisearch outage, FLUSHALL + 3 worker, звірки
pnpm --filter @auction/api seed               # ручний запуск сиду
pnpm --filter @auction/api exec tsx -e "..."  # або SearchIndexer.reindexAll() для повної переіндексації
```

---

## 2. Ставки, автоставки, блокування та транзакції

- **Гроші:** єдина валюта UAH, зберігаються цілими числами в копійках (`bigint` у БД).
- **Крок ставки (`bidStep` у `packages/shared/src/money.ts`):**
  - `< 100 ₴` (`< 10 000` коп.) → `5 ₴` (`500` коп.)
  - `100 – 999,99 ₴` → `10 ₴` (`1 000` коп.)
  - `1 000 – 9 999,99 ₴` → `50 ₴` (`5 000` коп.)
  - `≥ 10 000 ₴` → `100 ₴` (`10 000` коп.)
- **Послідовність та блокування (`apps/api/src/bids/bids.ts`):**
  - Кожна ставка, «Купити зараз» та закриття лота відкривають транзакцію Postgres і беруть ексклюзивне блокування рядка **`SELECT ... FROM lots WHERE id = $1 FOR UPDATE`**.
  - Перевіряються права (`OWN_LOT` → 403), статус `active` та час завершення за серверним `Clock` (`endsAt > clock.now()`, інакше 409 `AUCTION_ENDED`).
  - Підтримується `Idempotency-Key` (унікальний у `(user_id, scope, key)`): повтор з тим самим тілом повертає збережену відповідь (`Idempotency-Replayed: true`), повтор з іншим SHA-256 канонічного JSON тіла → `422 IDEMPOTENCY_KEY_REUSED`.
  - Кожній прийнятій ставці присвоюється безперервний порядковий номер `seq = lots.last_seq + 1` (унікальний індекс `(lot_id, seq)`).
- **Автоставка (`resolveBid` у `packages/shared/src/bidding.ts`):**
  - Значення має лише максимум поточного лідера (`bidder_maxes`) — тому порядок надходження ставок не змінює підсумкову ціну (рівні максимуми віддають перевагу більш ранньому за `(created_at, id)` / `reached_seq`).
  - Якщо новий учасник перебиває максимум лідера, ціна стає `min(newMax, max(amount, leaderMax + bidStep(leaderMax)))`, а застава попереднього лідера звільняється **в тій самій транзакції**.
  - Якщо новий максимум не перевищує максимум лідера, система автоматично робить зустрічну ставку за лідера (`kind = 'auto'`) до мінімуму, потрібного для збереження лідерства (`min(leaderMax, newMax + bidStep(newMax))` або `leaderMax` при рівності), а застава перебитого учасника звільняється одразу.
  - Поточний лідер може лише підвищити власний максимум (зменшення заборонене: `BID_MAX_DECREASE`).
- **Антиснайпінг (`endsAtAfterBid`):** ставка в останні 2 хвилини до `endsAt` переносить `endsAt` на `max(endsAt, now + 2 хв)`; кількість продовжень не обмежена.
- **«Купити зараз»:** дозволяється лише до першої ставки (`bidCount === 0`), блокує рядок лота `FOR UPDATE` (гонка з першою ставкою завжди пропускає рівно одну операцію, інша отримує 409), утримує заставу 10% (мін. 50 ₴) та переводить лот в `awaiting_payment`.

---

## 3. Схема проводок подвійного запису (`ledger`)

Усі фінансові рухи проходять через `ledger.post()` (`apps/api/src/ledger/ledger.ts`). Для кожної операції створюється запис `ledger_transactions` (з опціональним `effect_key` для гарантії однократного виконання) і парні записи `ledger_entries` (дебет `-amount`, кредит `+amount`). Сума всіх `ledger_entries` кожної транзакції (та всієї бази) завжди дорівнює **0**.

### Рахунки (`accounts.type`)
| Рахунок | Скоп | Призначення |
| --- | --- | --- |
| `gateway` | Системний (`user_id IS NULL`) | Зовнішній шлюз поповнень (баланс від'ємний, дзеркалить суму грошей у системі) |
| `user_available` | Користувач | Доступний баланс гаманця (`CHECK balance >= 0`) |
| `user_hold` | Користувач | Заблоковані застави за активними ставками/офферами (`CHECK balance >= 0`) |
| `escrow` | Системний (`user_id IS NULL`) | Кошти оплаченого, але ще не підтвердженого замовлення |
| `seller_payable` | Користувач | Кошти, нараховані продавцю до виплати (виплати + конфісковані застави) |
| `platform_fee` | Системний (`user_id IS NULL`) | Комісія платформи |

### Основні проводки
| Подія | Дебет (`-`) | Кредит (`+`) | Примітка |
| --- | --- | --- | --- |
| **Поповнення** (`topup`) | `gateway` | `user_available` | `effectKey = topup:<paymentId>` |
| **Ставка / підняття max** (`deposit_hold`) | `user_available` | `user_hold` | `max(10% від max, 50 ₴)`; доутримується лише дельта |
| **Перебиття / зняття / програш** (`deposit_release`) | `user_hold` | `user_available` | У тій самій транзакції, що прийняла перебиваючу ставку чи закрила лот |
| **Оплата виграшу** (`sale_payment`) | `user_hold` (застава) + `user_available` (решта) | `escrow` | Застава зараховується в оплату; надлишок застави повертається на `user_available`; `effectKey = sale_pay:<saleId>` |
| **Неоплата за 48/24 год** (`deposit_forfeit`) | `user_hold` (переможця) | `seller_payable` (продавця) | `effectKey = forfeit:<lotId>:<buyerId>`; далі пропозиція 2-му учаснику |
| **Підтвердження / автопідтвердження (7 дн.)** (`sale_payout`) | `escrow` | `seller_payable` (`price - fee`) + `platform_fee` (`fee`) | `fee = min(price, max(1000, floor(price * 5 / 100)))`; `effectKey = payout:<saleId>` |

---

## 4. Таблиця статусів лота (`packages/shared/src/lots.ts`)

Статуси: `draft`, `in_review`, `rejected`, `active`, `ended_unsold`, `awaiting_payment`, `paid`, `shipped`, `completed`, `removed`.

| Зі статусу | У статус | Хто виконує | Умова / ефект |
| --- | --- | --- | --- |
| `draft` | `in_review` | `seller` | Власник відправляє чернетку на модерацію |
| `in_review` | `active` | `moderator` | Схвалення; встановлюється `endsAt = now + durationDays` |
| `in_review` | `rejected` | `moderator` | Відхилення з обов'язковою причиною |
| `rejected` | `draft` | `seller` | Повернення в чернетку для виправлення |
| `ended_unsold` | `draft` | `seller` | Повторне відкриття непроданого лота (очищення старих ставок/неактуальних спроб) |
| `active` | `removed` | `moderator` | Зняття з торгів; звільнення всіх застав і видалення `bidder_maxes`, листи учасникам |
| `active` | `ended_unsold` | `system` | Немає ставок або не досягнуто `reservePrice`; застави звільняються |
| `active` | `awaiting_payment` | `system` | Закриття з перемогою або «Купити зараз»; створюється `sales` на 48 год |
| `awaiting_payment` | `paid` | `system` | Покупець оплатив із гаманця (з заліком застави) |
| `awaiting_payment` | `ended_unsold` | `system` | Переможець і всі кандидати другого шансу не оплатили або не мають застави |
| `paid` | `shipped` | `seller` | Продавець вказав трек-номер |
| `shipped` | `completed` | `buyer` / `system` | Покупець підтвердив отримання, або минуло 7 днів (`sweepAutoConfirmSales`); виплата продавцю |

---

## 5. Розподіл даних і відновлення після збоїв

- **PostgreSQL 16 (єдине джерело правди):** користувачі, лоти, ставки, `bidder_maxes`, подвійний ledger, продажі, модерація, медіа-метадані, сесії платіжної заглушки, `search_outbox`, `email_outbox`, `notifications`, `idempotency_keys`, `job_effects`.
- **Redis 7:** лише адаптер Socket.IO для міжреплікових команд (наприклад, `disconnectUser`). Усі фонові процеси (`apps/api/src/worker/main.ts`) працюють як **БД-свіпери** з `FOR UPDATE SKIP LOCKED` і compare-and-set. Після `redis-cli FLUSHALL` і перезапуску/масштабування `worker` жодна задача (закриття лотів, 48/24 год прострочення, автопідтвердження за 7 днів, нагадування за 1 год, оренди модерації, фото, листи, звірка платежів) не губиться і не виконується двічі.
- **Meilisearch:** індекс пошуку й фасетів. Тригер Postgres `lots_search_outbox` у тій самій транзакції запису додає `lot_id` у `search_outbox`. Якщо Meilisearch падає, лоти та ставки продовжують працювати без збоїв, `/search` повертає `503 SEARCH_UNAVAILABLE`, а після повернення Meilisearch `SearchIndexer.drain()` автоматично доганяє накопичений outbox. Повна переіндексація без простою (`swapIndexes`) — через `SearchIndexer.reindexAll()`.
- **MinIO (S3):** приватний бакет `lots`. Завантаження напряму з браузера за presigned POST із політикою на конкретний `contentType` і `sizeBytes <= 10 МБ`. Воркер перекодовує зображення через `sharp` (видаляє EXIF/GPS) та генерує WebP-прев'ю `400 px`. Несхвалені лоти доступні лише власнику та модератору, а посилання на завантаження завжди короткоживучі presigned GET.

---

## 6. Доставка живих подій через 2 репліки `api`

1. Тригер Postgres `lots_notify_change` (`AFTER UPDATE ON lots`) при зміні публічного стану відправляє `pg_notify('lot_changed', ...)` на `COMMIT` (працює однаково для змін з `api1`, `api2` та `worker`).
2. Обидві репліки `api` тримають виділене з'єднання `LISTEN lot_changed`, перечитують лот через явний DTO-мапер (`toLiveDto`, без `reservePrice` та `leaderId`) і розсилають у кімнату `lot:<id>` через `io.local` лише своїм підключеним клієнтам (без дублів).
3. Приватна подія `user:outbid` іде в кімнату `user:<outbidUserId>` тільки перебитому учаснику.
4. Клієнт зберігає останній `seq` і ігнорує старіші повідомлення (`seq < lastSeq`). При перепідключенні викликає `lot:subscribe { lotId, lastSeq }`, отримує актуальний снапшот (разом із `serverTime` для корекції годинника) та пропущені ставки (`missed`, до 100).

---

## 7. Індекси та обмеження БД

- **Ledger:** deferred constraint trigger `ledger_entries_zero_sum` (сума кожної транзакції = 0 на commit), trigger `ledger_entries_immutable` (заборона `UPDATE`/`DELETE`), trigger `ledger_entries_apply` (атомарне оновлення `accounts.balance`), `CHECK` на невід'ємність `user_available` і `user_hold`.
- **Другий шанс і продажі:** частковий унікальний індекс `sales_one_open_per_lot_uq` (`status = 'awaiting_payment'`) гарантує максимум одну активну пропозицію на лот; `sales_one_live_per_lot_uq` (`status IN ('paid','shipped','completed')`) гарантує максимум одну оплачену угоду; `sales_created_status_idx` (`created_at, status`) забезпечує виконання 90-денного звіту `< 500 мс`.
- **Ставки й історія:** `bids_lot_seq_uq` (`lot_id, seq`), `bidder_maxes_rank_idx` (`lot_id, max_amount, reached_seq`).
- **Модерація й черги:** `lots_review_queue_idx` (`status, review_lease_until, created_at`), часткові індекси на `search_outbox(id)` і `email_outbox(id)` для швидкого `SKIP LOCKED`.

---

## 8. Прийняті рішення (`D1–D26`)

| # | Питання | Прийняте рішення |
| --- | --- | --- |
| D1–D2 | Застава при автоставці | `max(10% від max, 50 ₴)` на `(user, lot)`; підвищення доутримує дельту; зменшення заборонене; застава перебитого звільняється в тій же транзакції |
| D3 | Комісія | `min(price, max(1000, floor(price * 5 / 100)))` коп. (округлення вниз на користь продавця) |
| D4–D5 | Другий шанс | Застава неплатника → `seller_payable`; 2-му кандидату за його `maxAmount` на 24 год із заставою 10% (мін. 50 ₴); неплатоспроможні пропускаються |
| D6 | Гонка продовження/закриття | Закриття перечитує `ends_at` під `FOR UPDATE` і використовує CAS по статусу |
| D7 | Ідемпотентність | Унікальна в `(user, scope, key)`; інше тіло (SHA-256) → `422 IDEMPOTENCY_KEY_REUSED` |
| D8 | Маскування імен | `перша***остання`; власні ставки не маскуються; переможець відкривається продавцю після оплати |
| D9 | Час | Усюди інжектується `Clock` (`FakeClock` у тестах, `serverTime` на клієнті) |
| D14 | Відмова Redis | Postgres — джерело правди; БД-свіпери + `pg_notify` працюють і після `FLUSHALL` |
| D15 | Образ MinIO | Використано `chainguard/minio:latest` з тим самим S3 API |
| D16 | Порт Postgres | Хост-порт у compose — `5433`, у локальних URL — `127.0.0.1` |
| D17–D24 | Схема, DTO, Nest | Deferred zero-sum ledger, явні DTO-мапери без `reservePrice`, глобальний guard + єдиний формат помилок `{code, message, details}` |
| D25 | Worker і платіжна заглушка | Свіпери БД у `worker`; листи через `SmtpEmailSender` у Mailpit; сесії заглушки у Postgres `payment_stub_sessions` (спільні для `api1`, `api2`, `worker`) |
| D26 | Сид | Історія сиду без записів ledger (звірка = 0); демо-покупці `buyer1..10` мають реальні поповнення в ledger |
