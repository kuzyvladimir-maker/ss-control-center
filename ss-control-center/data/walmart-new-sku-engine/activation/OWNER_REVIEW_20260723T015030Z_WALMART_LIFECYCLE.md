# Walmart new-SKU: решение по защитной production-структуре

Статус: **ГОТОВО К ОТДЕЛЬНОМУ РЕШЕНИЮ ВЛАДЕЛЬЦА; НИЧЕГО НЕ ПРИМЕНЕНО**.

## Что предлагается применить

Один exact schema-only plan для migration
`20260719003000_walmart_publish_lifecycle_safety`:

- plan SHA-256: `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`;
- migration SHA-256: `d46c10fbf1e1c30071cf162a3c5f0cebb31954b76e844a8d4d4df610d065641e`;
- production preflight: `eligibleForApply=true`, `blockers=[]`;
- duplicate active UPC reservations: `0`;
- срок exact plan: до `2026-07-24T01:45:00.000Z`.

Migration создаёт две защитные таблицы:

1. `MarketplaceSubmissionAttempt` — one-attempt/idempotency/one-pilot-slot ledger,
   который блокирует повторный или параллельный POST.
2. `WalmartBuyerPublicationEvidence` — неизменяемое подтверждение Seller/buyer
   результата после отправки.

Также добавляются 15 индексов и 8 fail-closed triggers: запрет удаления и подмены
identity, запрет второго активного attempt, глобальный pilot cap и связь buyer evidence
с точным attempt/SKU.

## Чего это решение не разрешает

- backfill Product Truth;
- Walmart API calls или публикацию листинга;
- создание ITEM report;
- платные provider/model calls;
- делистинг, repricing или закупку;
- второй SKU, волны 15–20 или расписание.

## Риск и rollback

Это только структура БД. Apply повторно проверяет exact plan/migration/schema/preflight
и выполняет изменение транзакционно. Drift или ошибка до commit останавливает операцию
без частично принятой migration. После commit отдельная read-only проверка обязана
подтвердить таблицы, индексы, triggers, Prisma history и immutable activation receipt.

## Понятная формулировка решения

Для применения владелец должен отдельно написать в чате:

> Разрешаю применить exact Walmart lifecycle schema plan
> `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`.

Простое разрешение Product Truth migrations на этот отдельный plan не переносится.
