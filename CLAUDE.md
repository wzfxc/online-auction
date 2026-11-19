# CLAUDE.md — онлайн-аукціон

Вимоги: `docs/test-assignment-13.md`. План: `docs/plan.md`. Стан: `progress.md`. **README.md не створювати**, доки користувач не дасть окрему команду.

## Структура монорепозиторію (pnpm workspaces)
- `apps/api` — NestJS: REST + OpenAPI + Socket.IO
- `apps/worker` — NestJS-процес: BullMQ, sharp, outbox→Meilisearch
- `apps/web` — Next.js 15, React 19, next-intl, TanStack Query, RHF, Tailwind
- `packages/shared` — Zod-схеми, константи правил, чисті функції (гроші, автоставка)
- `packages/api-client` — **генерований** з OpenAPI клієнт (не редагувати вручну)
- `e2e` — Playwright
- `docker/`, `docker-compose.yml`, `.env.example`

## Команди
- `pnpm install`
- `pnpm typecheck` · `pnpm lint` · `pnpm test` (unit) · `pnpm test:int` (потрібні сервіси з `docker compose up -d postgres redis meilisearch minio`)
- `pnpm gen:openapi && pnpm gen:client` — генерація схеми й клієнта; CI перевіряє `git diff --exit-code`
- `pnpm db:generate` / `pnpm db:migrate` — Drizzle
- `pnpm e2e` — Playwright
- `pnpm verify` — typecheck + lint + gen-check + test

## Заборони
- `any` і `@ts-ignore` без коментаря-обґрунтування (ESLint це забороняє)
- Ручні типи відповідей API (лише згенерований клієнт)
- Зовнішні сервіси (платежі, пошта, SMS, карти); секрети в коді — лише `.env`
- «Internal server error» на некоректний ввід

## Гроші
- UAH у копійках, цілі числа (`bigint` у БД, `number` безпечних меж або `bigint` у коді)
- Подвійний запис: сума проводок кожної операції = 0
- Усі зміни балансу — в транзакціях; `Idempotency-Key` для ставки, оплати, поповнення
- Комісія 5% (мін. 10 ₴), округлення на користь продавця; залог 10% (мін. 50 ₴)

## Час
Усюди `Clock` (інжектується). Кінець лота — за годинником сервера. У тестах `FakeClock`. Прямий `Date.now()`/`new Date()` у доменному коді заборонено.

## Локалі й доступність
`uk`, `en`, `pl`: гроші, дати, час до кінця, відмінювання (ICU plural). Форми з помилками біля полів (`aria-describedby`), ставка й оплата повністю з клавіатури.

## Права й приватність
Перевірка ролі/власності на сервері в кожному ендпоінті та в сокетах. Резервна ціна не потрапляє в API-відповіді, пошук і події сокетів — тільки явні DTO-мапери.

## Патерн роботи
Етап → код+тести → typecheck/lint/gen-check/tests зелені → оновити `progress.md` → коміт Conventional Commits. Не переходити далі з червоним CI.
