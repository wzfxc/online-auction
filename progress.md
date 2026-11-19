# progress.md

## Етапи
| # | Етап | Статус |
| --- | --- | --- |
| 0 | Аудит, план, CLAUDE.md, progress.md | ✅ |
| 1 | Каркас монорепо + CI | ✅ |
| 2 | Docker compose, інфраструктура | ✅ (сервіси застосунку не збиралися: це заглушки) |
| 3 | Схема БД, міграції | ✅ |
| 4 | Гроші/проводки/wallet/Clock/помилки/auth/idempotency | ✅ (чисті сервіси; Nest-обв'язка, guards і фільтр — з першими контролерами, етап 6) |
| 5 | Платіжна заглушка | ✅ (чиста логіка + провайдер-заглушка; HTTP-маршрути вебхука/сторінки оплати й таймер reconciler — з Nest-обв'язкою, етап 6/8) |
| 6 | Лоти | ✅ (доменний сервіс: створення, правила редагування, переходи, історія, DTO без резерву; Nest-контролери/guards — окремим кроком перед етапом 14, коли знадобиться OpenAPI) |
| 7 | Ставки, автоставки | ✅ (чиста `resolveBid` у shared + `BidService`: ставка, купити-зараз, історія з маскуванням; Nest-контролери — з етапом 14; антиснайпінг — етап 8) |
| 8 | Антиснайпінг, закриття, черги, другий шанс | ✅ (доменна логіка: антиснайпінг у `placeBid`, `ClosingService` — закриття, ланцюг неоплати, DB-свіпери; BullMQ-черги та цикл у `apps/worker` — з Nest-обв'язкою, етап 14/12; FLUSHALL-тест — тоді ж) |
| 9 | Модерація | ✅ (доменна логіка: черга з орендою 15 хв через SKIP LOCKED, повернення простроченого, зняття лота; Nest-контролери та таймер свіпера — етап 14/12) |
| 10 | Медіа | ✅ (доменна логіка: presigned POST на тип+розмір, підтвердження, обробка sharp без EXIF + прев'ю 400 px, приватність; S3-адаптер перевірено проти живого MinIO (int-тест: чужий тип і 20 МБ відхиляються, неподписаний GET — відмова); задачі BullMQ/свіпер `findUnprocessed` — етап 12/14) |
| 11 | Пошук + outbox | ✅ (тригер БД пише в `search_outbox` у транзакції запису; `SearchIndexer.drain` — SKIP LOCKED, апсерт/видалення, відкат при падінні Meilisearch; `reindexAll` — новий індекс + swap; `SearchService` з фільтрами/фасетами, 503 `SEARCH_UNAVAILABLE`. Цикл drain раз на ~1 с і CLI-команда реіндексу — з Nest-обв'язкою worker, етап 12/14) |
| 12 | Сокети (2 репліки) | ✅ (`RealtimeServer` на Socket.IO без Nest-обв'язки: auth у handshake, підписка на лот зі снапшотом і догоном по `seq`, приватна кімната користувача, `time:sync`; шина — Postgres NOTIFY з тригера на `lots`; int-тест на двох реплік з реальними Postgres і Redis. Nest-гейтвей-обгортка — етап 14) |
| 13 | Нотифікації | ✅ (`notifyOutbid` у транзакції ставки: in-app завжди, лист ≤ 1 за 15 хв на (user, lot); `NotificationService`: список/прочитано лише власні, нагадування за годину через CAS по `favorites.reminder_sent_at`, `drainEmails` — SKIP LOCKED з повтором при збої; цикли drain/нагадувань і SMTP-заглушка — з Nest-обв'язкою worker, етап 14) |
| 14 | OpenAPI-клієнт | ✅ (усі контролери: auth, лоти, ставки, гаманець, модерація, медіа, пошук, нотифікації, вебхук і сторінка оплати заглушки, `/health`; `main.ts` API з RealtimeServer; процес worker із DB-свіперами; клієнт згенеровано) |
| 14б | Продажі й довідники для веба | ✅ (SalesService: оплата виграшу з гаманця в межах 48 год із заліком залогу та проводками подвійного запису, відправка з трек-номером, підтвердження отримання + свіпер автопідтвердження через 7 днів, виплата продавцю за вирахуванням комісії D3; приховування переможця до оплати; обране + нагадування за 1 год; історія гаманця; «мої лоти» та сума до виплати; списки категорій/міст; повторне відкриття `ended_unsold` → `draft`; фільтр `noBids` у пошуку; контролери + OpenAPI + клієнт + int-тести) |
| 15 | Веб | ✅ (`apps/web`: Next.js 15 App Router, React 19, TanStack Query, React Hook Form, Tailwind, Socket.IO + clock sync; каталог з пошуком/фасетами/фільтрами/сортуванням/пагінацією в URL, сторінка лота з живими оновленнями, кабінети покупця/продавця/модератора/фінансиста, завантаження фото, оплата/відправка/підтвердження, `aria-describedby` та клавіатурна доступність; додано `@ZUuidParam` у OpenAPI) |
| 16 | Звіти, звірка | ✅ (`ReportService` + `ReportsController` `/reports/period`, `/reports/reconciliation`: оборот, комісія, частка неоплачених виграшів, розбивка по категоріях < 500 мс за 90 днів з індексом `sales(created_at, status)`; звірка: сума проводок = 0, баланси гаманців = сумі проводок, розбіжності з платіжною заглушкою; int-тести) |
| 17 | Сид | ✅ (`apps/api/src/seed/seed.ts`: set-based SQL, повний обсяг 10 000 користувачів / 30 категорій / 15 міст / 50 000 лотів (5 000 активних, 200 закінчуються за годину, 100 на модерації) / 500 000 ставок / 5 100 фото-заглушок за ~68 с; ідемпотентний (маркер `seed:v1` у `job_effects` в одній транзакції з даними + advisory lock для кількох worker); запуск у worker при `SEED_ON_START=true` з подальшим `reindexAll`; ручний `pnpm --filter @auction/api seed`; int-тест: обсяги, ідемпотентність, паралельні запуски, баланс ledger, реальна ставка на засіяному лоті) |
| 18 | Локалізація | ✅ (`next-intl` для `uk`, `en`, `pl`: форматування гривні `1 234,50 ₴` / `1,234.50 ₴`, дат, серверного таймера, ICU plural для ставок/лотів/часу, перемикач локалі зі збереженням URL; unit-тести форматування й повноти ключів) |
| 19 | e2e | ✅ (`e2e/auction.spec.ts` на живому Docker Compose стеку: два браузери на одному лоті через репліки, перебиття автоставкою зі сповіщенням, антиснайпінг у реальному часі, повний цикл поповнення через заглушку → Buy Now з клавіатури → оплата з клавіатури → відправка → підтвердження → виплата продавцю → звірка фінансиста, URL-стан каталогу й локалі `uk`/`en`/`pl`, SLA <200мс/<500мс на сиді; виправлено IPv4 healthcheck `127.0.0.1` у compose) |
| 20 | Фінальна перевірка | ✅ (`README.md`, `scripts/acceptance/verify-compose.mjs`, `docker compose up --build`, Meilisearch outage/recovery, `FLUSHALL` + 3 worker, звірка після усіх перевірок, усі інваріанти й пункти приймання 1–20 підтверджені) |

## Інваріанти (15)
- [x] 1 Ставки послідовні (50 паралельних, int-тест)
- [x] 2 Автоставка не залежить від порядку (unit-тест перестановок)
- [x] 3 Кінець лота за годинником сервера; закриття рівно раз (int-тест 5 паралельних closeLot)
- [x] 4 Гроші не з'являються/не зникають; залог звільняється в тій же транзакції (на рівні закриття/неоплати; звірка — етап 16)
- [x] 5 «Купити зараз» vs перша ставка (int-тест гонки)
- [x] 6 Поповнення рівно раз (сервісний рівень, int-тест)
- [x] 7 Ідемпотентність (ставки, купити-зараз, поповнення, оплата виграшу: повтор → кешована відповідь, інше тіло → 422 `IDEMPOTENCY_KEY_REUSED`, int-тести)
- [x] 8 Другий шанс (сервісний рівень, int-тест)
- [x] 9 Модерація (сервісний рівень, int-тести: паралельні claim, повернення після оренди)
- [x] 10 Живі оновлення через дві репліки (int-тест: < 1 с між репліками, догін по seq, приватне «перебили», час сервера, резерв не в подіях; браузерна перевірка — етап 19)
- [x] 11 Пошук ≤ 5 с відставання (int-тести на живому Meilisearch: відставання, відмова й наздоганяння, реіндекс; резерв не потрапляє в документ)
- [x] 12 Фото (сервісний рівень, int-тести: приватність, EXIF/GPS, тип за вмістом, підтверджено на живому MinIO; підтвердження фото лише для draft)
- [x] 13 Втрата Redis нічого не ламає (int-тест із `FLUSHALL` на живому Redis + 3 паралельні worker: закриття лотів, нагадування, відправка листів без дублів і втрат)
- [x] 14 Права на сервері та в сокетах (int-тести: резервна ціна не витікає в API/пошук/сокети/продажі, переможець прихований до оплати, чужий гаманець/лоти/продажі недоступні, ролі buyer/seller/moderator/finance розділені)
- [x] 15 Єдиний формат помилок (`{code, message, details}` у всіх контролерах, ErrorFilter, OpenAPI; 500 без внутрішніх деталей)

## Приймання (20)
- [x] 1 compose up без ручних кроків (`docker compose up --build` підняв усі 10 сервісів healthy, авто-міграції, бакети, індекс, сид)
- [x] 2 typecheck/lint/клієнт/тести/CI (`pnpm verify`, `pnpm test:int`, `pnpm e2e`, GitHub Actions зелені)
- [x] 3 Два браузери, різні репліки, < 1 с (int-тест на 2 репліках + Playwright E2E)
- [x] 4 50 одночасних ставок (int-тест)
- [x] 5 Автоставки 1000/1500 → 1050 (int-тест + unit-тести перестановок)
- [x] 6 Антиснайпінг і ставка після кінця (int-тест + Playwright E2E)
- [x] 7 10 ставок, грошей на 3 залоги (int-тест)
- [x] 8 Купити зараз vs ставка (int-тест гонки)
- [x] 9 Хаос-вебхуки (int-тести + unit-тести хаосу + shared DB stub sessions)
- [x] 10 Неоплата → другий → третій (int-тест)
- [x] 11 Два модератори (int-тест паралельного claim)
- [x] 12 Відключення клієнта (int-тест догін по `seq` + `lot:subscribe {lastSeq}`)
- [x] 13 Зупинка Meilisearch (`verify-compose.mjs`: stop meilisearch → 503 SEARCH_UNAVAILABLE + ставки працюють → start → outbox наздогнав)
- [x] 14 Фото неодобреного лота / 20 МБ (int-тест на живому MinIO + `MediaService`)
- [x] 15 FLUSHALL + 3 worker (`verify-compose.mjs` + int-тест з `FLUSHALL` і 3 паралельними worker)
- [x] 16 Резервна ціна / чужий гаманець (int-тести HTTP, пошуку, сокетів, продажів)
- [x] 17 Звірка після усього (`GET /reports/reconciliation` → `healthy: true`, `entriesSum: 0`, без розбіжностей)
- [x] 18 Пошук/звіт швидко; стан з URL (Playwright E2E: <200 мс пошук і сторінка лота, <500 мс звіт за 90 днів на сиді; URL reload/Back)
- [x] 19 uk/en/pl (Playwright E2E + unit-тести форматування грошей/дат/таймерів/ICU plural)
- [x] 20 README (`README.md` створено згідно з розділом «Что сдать»)

## Рішення щодо неоднозначностей
| # | Питання | Рішення |
| --- | --- | --- |
| D1 | Залог при зростанні автоставки | Залог = max(10% від поточного максимуму, 50 ₴) на пару (user, lot); підвищення максимуму утримує лише різницю; зниження максимуму заборонено |
| D2 | Перебиття автоставкою | Залог перебитого звільняється в тій самій транзакції, що приймає перебиваючу ставку |
| D3 | Комісія й округлення | `fee = max(1000, floor(price*5/100))` коп., ціле; floor = на користь продавця; fee ≤ price |
| D4 | Залог при другому шансі | Залог переможця-неплатника іде продавцю; для другого утримується залог 10% (мін. 50 ₴) від пропонованої ціни на час пропозиції |
| D5 | Ціна другого шансу | Максимальна ставка другого учасника (ТЗ) |
| D6 | Гонка продовження й закриття | Закриття перечитує `ends_at` під `FOR UPDATE`; якщо ще не настало — no-op; CAS по статусу |
| D7 | Ідемпотентність з іншим тілом | 422 `IDEMPOTENCY_KEY_REUSED`; ключ унікальний у (user, scope); хеш тіла SHA-256 канонічного JSON |
| D8 | Маскування імен | `перша***остання` літери; власні ставки — без маски |
| D9 | Підміна часу | Інжектований `Clock`; sweeper отримує `now` з Clock, а не з `now()` БД |
| D10 | Рівні максимуми | Раніший `(created_at, id)` лідирує |
| D11 | Автоставка власника | Заборонена, 403 `OWN_LOT` |
| D12 | Резерв не досягнуто | `ended_unsold`, залоги звільняються |
| D13 | Валюта | UAH, `bigint` копійки |
| D14 | Втрата Redis | Postgres — джерело правди; sweeper по БД; BullMQ лише прискорює |
| D15 | Образ MinIO | `minio/minio` недоступний (pull denied на Docker Hub і quay), використано `chainguard/minio`; healthcheck немає (немає shell), клієнти ретраять підключення |
| D16 | Порт Postgres | На Windows порт 5432 заблоковано, хост-порт Postgres у compose — 5433; у URL використовуємо `127.0.0.1` (localhost резолвиться в IPv6, а Docker слухає лише IPv4) |
| D17 | Цілісність ledger | Баланс рахунку оновлює тригер; сума проводок транзакції = 0 перевіряється deferred constraint trigger при commit; `ledger_entries` append-only; `user_available`/`user_hold` не можуть піти в мінус (CHECK) |
| D18 | Другий шанс у БД | Кожна спроба оплати — рядок `sales` (attempt); часткові унікальні індекси: один `awaiting_payment` на лот, одна оплачена спроба на лот |
| D20 | Модель ставки | `amount` — ставка, `maxAmount` — необов'язкова стеля автоставки (макс. = `maxAmount ?? amount`). Ціна = мін. потрібна для лідерства (крок за `bidStep`); перша ставка = `amount`. Значення має лише максимум лідера, тож результат не залежить від порядку. Лідер може лише підвищити власний максимум. Програвший максимум видаляється, залог звільняється. Купити зараз — лише до першої ставки; утримує залог 10% (без коштів — 422, лот не блокується); створює `sales` attempt 1 (оплата 48 год) |
| D21 | Другий шанс: кандидати й залог | Кандидат — користувач без попередньої спроби з найбільшим `max(bids.max_amount)` (рівні — раніша ставка); ціна = його максимум (без перевірки резерву); якщо не вистачає коштів на залог 10% — пропускається. Залог неплатника → `seller_payable` (effectKey `forfeit:lot:user`). Нікого не лишилось → `ended_unsold` |
| D22 | Модерація | Лот у черзі вільний, якщо `review_lease_until` null або минув (за `Clock`); claim — `FOR UPDATE SKIP LOCKED`, оренда 15 хв; рішення під чужою живою орендою — 409 `LOT_CLAIMED`; прострочену оренду очищає `releaseExpiredLeases` (подія `review_lease_expired`). Зняття: залоги звільняються в тій же транзакції, `bidder_maxes` видаляються (другий шанс неможливий), у подію `removed` пишуться `notifyUserIds` для листів |
| D23 | Шина живих оновлень | Postgres `NOTIFY lot_changed` з тригера на `lots` (відправляється на commit, також зі змін worker); кожна репліка емітить лише своїм клієнтам (`io.local`). Redis-адаптер лише для міжрепліковых операцій (`disconnectUser`); втрата Redis оновлень не губить. Клієнт застосовує оновлення, якщо `seq` не менший за відомий; при перепідключенні — `lot:subscribe {lastSeq}` повертає пропущені ставки (≤100) |
| D24 | Nest-шар | Контролери тонкі: вхід валідують сервіси (Zod із shared), відповіді описані Zod-схемами в `http/schemas.ts` → OpenAPI (`zod-to-json-schema`, без nestjs-zod: конфлікт peer-версій). Guard глобальний і «закритий за замовчуванням»: відкриті лише `@Public()`; ролі — `@Roles()`. Усі помилки (AppError, HttpException, помилки body-parser) → `{code,message,details}`; невідоме → 500 `INTERNAL_ERROR` без деталей. Не-UUID у шляху → 400 |
| D25 | Worker | Звичайний Node-процес (без Nest і BullMQ): цикли-свіпери по БД (пошук 1 с, закриття 1 с, неоплата, автопідтвердження доставки 7 дн., оренди модерації, фото, листи, нагадування, звірка платежів) із compare-and-set/SKIP LOCKED у сервісах; кілька worker безпечні, втрата Redis нічого не змінює (D14). Листи відправляються через SMTP у Mailpit (`SmtpEmailSender`). Сесії платіжної заглушки зберігаються в Postgres (`payment_stub_sessions`), тому доступні на обох репліках `api` та у `worker` |
| D26 | Сид | Історичні дані сиду (завершені/неоплачені продажі, ставки) — лише дані без проводок ledger, тому звірка залишається нульовою; ledger-підкріплені лише гаманці демо-покупців `buyer1..buyer10@auction.test` (50 000 ₴). Логіни: `buyer<N>@auction.test` (N ≤ 7996), `seller<N>` (≤ 2000), `moderator1..3`, `finance1`; пароль `password123`. Фото-заглушки (згенеровані sharp, 12 варіантів) — по одному на активні й `in_review` лоти (5 100 об'єктів у MinIO). Тести int запускаються на БД з `TEST_DATABASE_URL` (за відсутності — на dev-БД `auction`, яку вони перестворюють) |
| D19 | Стан платежу | `succeeded` термінальний і виграє в `failed`/`expired`; кредит рівно раз (блок рядка + `effectKey topup:<id>` + дедуп за `provider_event_id`); `failed`/`expired` лише з `pending`; `created_at` платежу з `Clock`. Сесії заглушки in-memory (одна інстанція) |
| D27 | Rate limiting і проксі | `nginx.conf` перезаписує `X-Forwarded-For` на `$remote_addr`; Express використовує `trust proxy = 1`. Глобальний `RateLimitGuard` на Redis (атомарний Lua fixed-window з fail-open при збої чи `FLUSHALL` Redis): `auth` (15/хв за `ip:<clientIp>`), `bid` (60/хв за `user:<id>`), інші мутації (20/хв), `read` (180/хв), `@SkipThrottle()` для `/health` і вебхуків; `429 RATE_LIMIT_EXCEEDED` + `Retry-After` |
| D28 | Безпека медіа і сесій | `confirmUpload` перевіряє магічні байти й формат через `sharp`, фіксує `sha256` та переносить об'єкт із клієнтського `raw/` у незмінний серверний `verified/` (`processPhoto` перевіряє `sha256`); `POST /auth/logout` відкликає `jti` в Postgres (`revoked_tokens`) для HTTP і Socket.IO |
| D29 | Другий шанс, заглушка, міграції, активні лоти | `ClosingService.nextOffer` використовує `DISTINCT ON (user_id) ... ORDER BY max_amount DESC, seq ASC` (час досягнення максимуму, а не найпершої ставки); `StubPaymentProvider.resolve` блокує оплату простроченої сесії (`409 PAYMENT_SESSION_EXPIRED`); `runMigrations` серіалізовано через `pg_advisory_lock`; активний лот із `bidCount === 0` дозволяє повне редагування, після першої ставки — лише `append`; FK (`23503`), null-байти (`22021`) та переповнення меж → `400 VALIDATION_ERROR` |
| D30 | Веб, інфра, CI | Пакетні прев'ю каталогу через `GET /media/thumbnails` (усунуто N+1), валідація/нормалізація URL-параметрів каталогу, видима валідація форми продавця, повна i18n `uk`/`en`/`pl`, `--frozen-lockfile` у `node.Dockerfile`, `127.0.0.1` у `.env.example`, а також `@auction/web build` і `e2e` у CI |

## Журнал комітів
| Коміт | Опис |
| --- | --- |
| (етап 0) | `chore: audit, plan, CLAUDE.md, progress.md` |
| (етап 1) | `chore: monorepo scaffold, lint rules, CI, money rules in shared` |
| (етап 2) | `chore: docker compose, nginx, .env.example` |
| (етап 2, fix) | `fix: bind published compose ports to loopback` |
| (етап 3) | `feat(db): drizzle schema, migrations, ledger triggers` |
| (етап 4) | `feat(core): clock, errors, ledger, wallet, idempotency, auth primitives` |
| (етап 5) | `feat(payments): stub provider, HMAC webhooks, chaos modes, reconciler` |
| (етап 6) | `feat(lots): status transition table, lot service, history, reserve-safe DTOs` |
| (етап 7) | `feat(bids): proxy bidding, deposits, buy now, masked history` |
| (етап 8) | `feat(closing): anti-sniping, lot closing, unpaid-sale chain, second chance` |
| (етап 9) | `feat(moderation): review queue leases, lot removal with deposit release` |
| (етап 10) | `feat(media): presigned uploads, sharp processing without EXIF, private photo access` |
| (етап 11) | `feat(search): trigger-fed outbox, meilisearch indexer, reindex swap, search service` |
| (етап 12) | `feat(realtime): socket.io gateway, pg-notify bus, seq catch-up, private outbid; fix(search): per-lot advisory lock in indexer` |
| (етап 13) | `feat(notifications): outbid notices with 15-min email limit, ending reminders, email outbox drain` |
| (етап 14, ч.1) | `feat(api): nest http layer, auth, lots, bids, wallet, openapi client generation` |
| (етап 14, ч.2) | `feat(api): bootstrap api and worker processes, health, config` |
| (крок 0) | `feat(api): connect smtp mail stub, share payment stub sessions in db, fix ci services` |
| (етап 14б) | `feat(sales): win payment with deposit credit, shipping, receipt confirmation, payout, favorites, references` |
| (етап 16) | `feat(reports): period report with category breakdown and ledger/stub reconciliation` |
| (етап 17) | `feat(seed): idempotent set-based seed of 10k users, 50k lots, 500k bids, placeholder photos` |
| (етапи 15, 18) | `feat(web): nextjs 15 frontend with live bidding, cabinets, uk/en/pl i18n, and openapi path params` |
| (етап 19) | `test(e2e): playwright e2e suite against compose stack and ipv4 healthchecks` |
| (етап 20) | `docs: add README, acceptance script and final verification sign-off` |
| `02fed1e` | `feat(security): add distributed Redis rate limiting, proxy hardening, S3 verification, and JWT logout` |
| `67329e2` | `fix(api): serialize migrations, enforce stub TTL, fix tie-break, bounds and active-lot edits` |
| `8680497` | `fix(web): eliminate catalog N+1 thumbnails, add seller form validation, normalize URL params and complete i18n` |
| `32e29dd` | `chore(ci): add web build and e2e to CI, use frozen lockfile in Dockerfile, bind 127.0.0.1 in .env.example` |

