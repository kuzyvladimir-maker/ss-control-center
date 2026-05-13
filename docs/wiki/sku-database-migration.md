# 🗄️ SKU Database Migration — Google Sheets → Internal DB

## Суть
Перенос справочника весов, размеров и типа товара (Frozen/Dry) из Google Sheets `SKU Shipping Database v2` во внутреннюю БД проекта (Prisma + SQLite / Turso).

**Дата миграции:** 2026-05-12
**Промпт:** `docs/CLAUDE_CODE_PROMPT_SKU_DATABASE_MIGRATION.md`

## Зачем мигрировали
- Убрать единственную внешнюю Google-зависимость (после деплоя на Vercel становится критичной)
- Сделать проект самодостаточным — после `git clone` всё восстанавливается из репозитория
- Ускорить lookup (БД быстрее CSV-export через Google API)
- Управлять SKU прямо в SS Control Center (popup), а не открывать Google в отдельной вкладке

## Что хранится в БД

Таблица `SkuShippingData`:

| Поле | Тип | Назначение |
|------|-----|-----------|
| `sku` | String unique | Lookup key |
| `productTitle` | String? | Название товара (в план shipping) |
| `marketplace` | String? | Amazon / Walmart / Both |
| `category` | String? | Frozen / Dry |
| `length`, `width`, `height` | Float? | Dimensions (дюймы) для Veeqo |
| `weight` | Float? | Вес для UPS/USPS/FedEx стандарт (lbs) |
| `weightFedex` | Float? | Вес для FedEx One Rate (lbs) |
| `sampleCount` | Int | Сколько раз отгружали этот SKU |
| `notes` | String? | Заметки |
| `source` | String | google_sheets_migration / manual / veeqo_history |
| `createdAt`, `updatedAt` | DateTime | Метаданные |

## Архитектура

```
┌─────────────────────────────────────────────┐
│  src/lib/sku-database.ts                    │  ← новый слой доступа
│  fetchSkuDatabase(), lookupSku(),           │
│  appendSkuRow()                             │
└─────────────────────────────────────────────┘
              │ Prisma
              ▼
┌─────────────────────────────────────────────┐
│  SkuShippingData (БД)                       │
│  dev: SQLite (dev.db)                       │
│  prod: Turso (libsql)                       │
└─────────────────────────────────────────────┘
```

Старый файл `src/lib/google-sheets.ts` остаётся в репозитории как **архив** — помечен `DEPRECATED`, нигде не импортируется. Можно безопасно удалить через 1-2 недели после успешной работы новой системы.

## Public API (без изменений после миграции)

Сигнатуры остались такими же — вызывающий код менял только строку `import`:

```typescript
// Список SKU (с опциональным поиском)
GET /api/sku?search=jimmy
→ { total: N, rows: SkuRow[] }

// Добавление / обновление SKU из popup на странице Shipping Labels
POST /api/shipping/fix-sku
body: { sku, productTitle, marketplace, category, length, width, height, weight, weightFedex }
→ { success: true, method: "internal_db" }
```

## Где взять начальные данные
Дамп Google Sheets на момент миграции: `prisma/seed/sku-database.json` (в репозитории).

Восстановление с нуля (новая машина, новая БД):
```bash
npx prisma db push
npx tsx scripts/seed-sku-from-dump.ts  # читает prisma/seed/sku-database.json
```
> Скрипт `seed-sku-from-dump.ts` создаётся отдельной задачей если понадобится (пока есть `migrate-sku-from-sheets.ts` который читает напрямую из Google).

## Скрипты миграции

| Скрипт | Назначение |
|--------|-----------|
| `scripts/turso-migrate-sku-shipping-data.mjs` | Создаёт таблицу на Turso (production), идемпотентен |
| `scripts/migrate-sku-from-sheets.ts` | Одноразовая выгрузка из Google в БД + дамп в `prisma/seed/sku-database.json` |

## Workflow обновления данных (после миграции)

1. **Автоматически** — алгоритм Shipping Labels при fallback на историю Veeqo (см. `MASTER_PROMPT_v3.1.md` шаг 2) записывает новые SKU в БД с `source: "veeqo_history"`.
2. **Вручную через UI** — popup редактирования SKU на странице `/shipping` → `appendSkuRow` → upsert в БД с `source: "manual"`.
3. **Старая Google-таблица** — остаётся как read-only архив, приложение в неё больше не пишет.

## Связанные файлы кода
- `src/lib/sku-database.ts` — новый слой доступа (Prisma)
- `src/lib/google-sheets.ts` — старый слой (DEPRECATED, не импортируется)
- `src/app/api/sku/route.ts` — переключён на `sku-database`
- `src/app/api/shipping/fix-sku/route.ts` — переключён на `sku-database`
- `prisma/schema.prisma` — модель `SkuShippingData`
- `prisma/seed/sku-database.json` — начальный дамп

## 🔗 Связи
- **Используется в:** [Shipping Labels](shipping-labels.md), [Adjustments Monitor](adjustments-monitor.md)
- **Заменяет:** [SKU Database (Google Sheets)](google-sheets-sku-db.md) (DEPRECATED)
- **См. также:** [Database Schema](database-schema.md), [Project Architecture](project-architecture.md), [Veeqo API](veeqo-api.md) (fallback на историю)

## История
- 2026-05-12: Wiki-статья создана. Миграция из Google Sheets в БД.
