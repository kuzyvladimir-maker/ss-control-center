# CLAUDE CODE PROMPT — SKU Database Migration (Google Sheets → Internal DB)

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-12
> **Reference spec:** `docs/wiki/sku-database-migration.md`
> **Execution mode:** один цельный коммит в конце задачи

---

## 🎯 ЦЕЛЬ

Убрать зависимость от Google Sheets (`SKU Shipping Database v2`) — последнего внешнего Google-файла на котором держится модуль Shipping Labels. Перенести все данные SKU в нашу собственную БД (Prisma + SQLite локально / Turso на проде). Сохранить внешний контракт API роутов неизменным, чтобы UI Shipping Labels и popup редактирования SKU продолжили работать без правок.

**После миграции:**
- Проект работает БЕЗ переменных `GOOGLE_SHEETS_ID` и `GOOGLE_SHEETS_API_KEY` в `.env`.
- Все SKU-данные лежат в таблице `SkuShippingData` БД проекта.
- Начальный дамп данных из Google коммитится в репозиторий (`prisma/seed/sku-database.json`) — проект самодостаточен, при клонировании можно за один скрипт восстановить рабочую базу.
- Внешние роуты `/api/sku` и `/api/shipping/fix-sku` сохраняют тот же интерфейс — никаких изменений в UI не требуется.
- Файл `src/lib/google-sheets.ts` остаётся в репозитории нетронутым, но больше нигде НЕ импортируется (Google Sheets как архив, на случай отката).

---

## 📚 СПРАВОЧНЫЕ ДОКУМЕНТЫ

Прочитать перед началом работы:

1. **`docs/wiki/google-sheets-sku-db.md`** — описание текущей Google-таблицы, структура колонок
2. **`docs/wiki/sku-database-migration.md`** — wiki-статья этой миграции (создаётся в рамках этого промпта)
3. **`CLAUDE.md`** в корне проекта — стек, env vars, паттерны
4. **`src/lib/google-sheets.ts`** — текущая реализация чтения/записи Google Sheets (изучить интерфейс `SkuRow` и сигнатуры функций)
5. **`src/lib/prisma.ts`** — как настроен Prisma client (libsql adapter, dev=SQLite / prod=Turso)
6. **`scripts/turso-migrate.mjs`** — паттерн скрипта миграции схемы на Turso

---

## 🏗️ ШАГ 1 — Добавить модель `SkuShippingData` в Prisma schema

### Файл: `prisma/schema.prisma`

Добавить в конец файла:

```prisma
// SKU Shipping Database — справочник весов, размеров коробок и типа товара
// (Frozen/Dry) для shipping labels. Заменяет Google Sheets "SKU Shipping
// Database v2" — данные мигрированы 2026-05-12. См. docs/wiki/sku-database-migration.md
model SkuShippingData {
  id          String   @id @default(cuid())
  sku         String   @unique
  productTitle String?
  marketplace String?  // Amazon | Walmart | Both | Other
  category    String?  // Frozen | Dry
  length      Float?   // дюймы
  width       Float?   // дюймы
  height      Float?   // дюймы
  weight      Float?   // lbs — для UPS/USPS/FedEx (без One Rate)
  weightFedex Float?   // lbs — ТОЛЬКО для FedEx One Rate (обычно H × 1.25)
  sampleCount Int      @default(0)  // сколько раз отгружали этот SKU (для статистики)
  notes       String?
  source      String   @default("manual") // google_sheets_migration | manual | veeqo_history
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

> **Замечание по полям:** `length/width/height/weight/weightFedex` сделаны nullable. В Google-таблице бывают SKU с неполными данными (только название, без весов) — мигрируем как есть, пусть `hasCompleteData` определяется на уровне приложения (как сейчас делает `SkuRow` интерфейс).

### Применить схему локально

```bash
cd ss-control-center
npx prisma db push
npx prisma generate
```

> ⚠️ НЕ запускать `prisma migrate dev` — в этом проекте используется libsql adapter, миграции последний раз делались через `migrate` 2026-04-08, после перешли на `db push` + отдельные mjs-скрипты для Turso. См. предыдущие промпты `CLAUDE_CODE_PROMPT_PROCUREMENT_PHASE_1.md` — там тот же паттерн.

---

## 🏗️ ШАГ 2 — Скрипт миграции схемы на Turso (production)

### Файл: `scripts/turso-migrate-sku-shipping-data.mjs`

Создать новый файл по образцу `scripts/turso-migrate.mjs`:

```javascript
// One-off migration: create SkuShippingData table on Turso.
// Run with: node scripts/turso-migrate-sku-shipping-data.mjs
// Idempotent — safe to re-run (uses IF NOT EXISTS).

import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "SkuShippingData" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "productTitle" TEXT,
    "marketplace" TEXT,
    "category" TEXT,
    "length" REAL,
    "width" REAL,
    "height" REAL,
    "weight" REAL,
    "weightFedex" REAL,
    "sampleCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SkuShippingData_sku_key" ON "SkuShippingData"("sku")`,
];

for (const sql of STATEMENTS) {
  const head = sql.replace(/\s+/g, " ").slice(0, 80);
  try {
    await client.execute(sql);
    console.log(`OK  ${head}`);
  } catch (e) {
    console.error(`ERR ${head}`);
    console.error("    ", e.message ?? e);
    process.exit(2);
  }
}

console.log("\n✓ SkuShippingData table ensured on Turso.");
process.exit(0);
```

Этот скрипт запускается вручную **один раз** перед деплоем (см. ШАГ 7 ниже).

---

## 🏗️ ШАГ 3 — Скрипт одноразовой выгрузки из Google в БД

### Файл: `scripts/migrate-sku-from-sheets.ts`

Создать скрипт который:
1. Читает текущий Google Sheets (через существующий `fetchSkuDatabase` из `src/lib/google-sheets.ts`).
2. Сохраняет дамп в `prisma/seed/sku-database.json` (для коммита в репозиторий).
3. Делает upsert каждой строки в таблицу `SkuShippingData` (по `sku` как уникальному ключу).
4. Выводит статистику: сколько прочитано, сколько вставлено, сколько обновлено, сколько skipped.

```typescript
// One-off migration: pull all SKU data from Google Sheets v2 → write to DB.
// Run with: npx tsx scripts/migrate-sku-from-sheets.ts
// Safe to re-run — uses upsert by `sku` field.
//
// REQUIRES env vars: GOOGLE_SHEETS_ID, GOOGLE_SHEETS_API_KEY
// (one-time use — these vars can be removed from .env after migration succeeds)

import { fetchSkuDatabase } from "@/lib/google-sheets";
import { prisma } from "@/lib/prisma";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

async function main() {
  console.log("Fetching SKU data from Google Sheets...");
  const rows = await fetchSkuDatabase();
  console.log(`  Found ${rows.length} rows`);

  // 1. Save raw dump to prisma/seed/sku-database.json (committed to git)
  const seedDir = resolve(process.cwd(), "prisma", "seed");
  if (!existsSync(seedDir)) mkdirSync(seedDir, { recursive: true });

  const seedPath = resolve(seedDir, "sku-database.json");
  writeFileSync(
    seedPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        source: "Google Sheets SKU Shipping Database v2",
        rowCount: rows.length,
        rows,
      },
      null,
      2
    )
  );
  console.log(`  Saved dump → ${seedPath}`);

  // 2. Upsert each row into SkuShippingData
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.sku) {
      skipped++;
      continue;
    }

    const existing = await prisma.skuShippingData.findUnique({
      where: { sku: row.sku },
    });

    await prisma.skuShippingData.upsert({
      where: { sku: row.sku },
      create: {
        sku: row.sku,
        productTitle: row.productTitle || null,
        marketplace: row.marketplace || null,
        category: row.category || null,
        length: row.length,
        width: row.width,
        height: row.height,
        weight: row.weight,
        weightFedex: row.weightFedex,
        source: "google_sheets_migration",
      },
      update: {
        // Don't overwrite manual edits — only fill missing fields
        productTitle: row.productTitle || undefined,
        marketplace: row.marketplace || undefined,
        category: row.category || undefined,
        length: row.length ?? undefined,
        width: row.width ?? undefined,
        height: row.height ?? undefined,
        weight: row.weight ?? undefined,
        weightFedex: row.weightFedex ?? undefined,
      },
    });

    if (existing) updated++;
    else inserted++;
  }

  console.log(`\n✓ Migration complete:`);
  console.log(`    inserted: ${inserted}`);
  console.log(`    updated:  ${updated}`);
  console.log(`    skipped:  ${skipped}`);
  console.log(`    total:    ${rows.length}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
```

> **Запуск скрипта** на dev (Vladimir's iMac): `npx tsx scripts/migrate-sku-from-sheets.ts` после ШАГа 1.
>
> **Запуск на prod (Turso):** этот же скрипт можно запустить локально с `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` в окружении — Prisma client автоматически переключится на Turso (см. `src/lib/prisma.ts`).

---

## 🏗️ ШАГ 4 — Новый слой доступа к данным: `src/lib/sku-database.ts`

### Создать новый файл `src/lib/sku-database.ts`

Этот модуль заменяет публичные функции `fetchSkuDatabase`, `lookupSku`, `appendSkuRow` из `src/lib/google-sheets.ts`. Сигнатуры **идентичны** старым, чтобы вызывающий код не пришлось менять кроме строки импорта.

```typescript
// Internal SKU shipping database — replaces Google Sheets "SKU Shipping Database v2"
// Same public API as src/lib/google-sheets.ts so callers swap only the import path.
// Migrated 2026-05-12. See docs/wiki/sku-database-migration.md

import { prisma } from "@/lib/prisma";

export interface SkuRow {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  weightFedex: number | null;
  hasCompleteData: boolean;
}

function toSkuRow(row: {
  sku: string;
  productTitle: string | null;
  marketplace: string | null;
  category: string | null;
  length: number | null;
  width: number | null;
  height: number | null;
  weight: number | null;
  weightFedex: number | null;
}): SkuRow {
  const hasCompleteData =
    row.weight !== null &&
    row.length !== null &&
    row.width !== null &&
    row.height !== null;

  return {
    sku: row.sku,
    productTitle: row.productTitle || "",
    marketplace: row.marketplace || "",
    category: row.category || "",
    length: row.length,
    width: row.width,
    height: row.height,
    weight: row.weight,
    weightFedex: row.weightFedex,
    hasCompleteData,
  };
}

export async function fetchSkuDatabase(): Promise<SkuRow[]> {
  const rows = await prisma.skuShippingData.findMany({
    orderBy: { sku: "asc" },
  });
  return rows.map(toSkuRow);
}

export async function lookupSku(sku: string): Promise<SkuRow | null> {
  const row = await prisma.skuShippingData.findUnique({
    where: { sku },
  });
  return row ? toSkuRow(row) : null;
}

export async function appendSkuRow(data: {
  sku: string;
  productTitle: string;
  marketplace: string;
  category: string;
  length: number;
  width: number;
  height: number;
  weight: number;
  weightFedex: number;
}): Promise<boolean> {
  await prisma.skuShippingData.upsert({
    where: { sku: data.sku },
    create: {
      sku: data.sku,
      productTitle: data.productTitle,
      marketplace: data.marketplace,
      category: data.category,
      length: data.length,
      width: data.width,
      height: data.height,
      weight: data.weight,
      weightFedex: data.weightFedex,
      sampleCount: 1,
      notes: "Added from Control Center",
      source: "manual",
    },
    update: {
      productTitle: data.productTitle,
      marketplace: data.marketplace,
      category: data.category,
      length: data.length,
      width: data.width,
      height: data.height,
      weight: data.weight,
      weightFedex: data.weightFedex,
    },
  });
  return true;
}
```

> **Замечание про `appendSkuRow`:** в Google-версии это был чистый append. В Prisma-версии используем `upsert` чтобы попап редактирования мог работать через ту же функцию (если SKU существует — обновляем). Если хочется сохранить именно semantic append-only — можно завернуть в `create` и кидать ошибку при дубле. Я выбрал upsert как более гибкий вариант, согласовать с Vladimir если есть сомнения.

---

## 🏗️ ШАГ 5 — Переключить все импорты с `google-sheets` на `sku-database`

### Найти все файлы, импортирующие `@/lib/google-sheets`

```bash
grep -rn "from \"@/lib/google-sheets\"" src/
grep -rn "from '@/lib/google-sheets'" src/
```

Ожидаемые места (по результатам аудита):
- `src/app/api/sku/route.ts` — использует `fetchSkuDatabase`
- `src/app/api/shipping/fix-sku/route.ts` — использует `appendSkuRow`
- Возможно `src/app/api/shipping/plan/route.ts` — использует `lookupSku` (проверить)
- Возможно в `src/lib/veeqo/...` — проверить

### В каждом файле

Заменить:
```typescript
import { fetchSkuDatabase, lookupSku, appendSkuRow } from "@/lib/google-sheets";
```
на:
```typescript
import { fetchSkuDatabase, lookupSku, appendSkuRow } from "@/lib/sku-database";
```

Остальной код не трогать — сигнатуры функций и тип `SkuRow` идентичны.

### Удалить кеширование `revalidate: 300`

Если в каком-то роуте стоит `next: { revalidate: 300 }` или подобный кеш ради защиты от частых запросов в Google — это теперь не нужно (БД быстрая, in-memory cache избыточен). НО не убирать без причины — если есть смысловой кеш (например, чтобы UI не дёргал базу на каждом нажатии), оставить.

---

## 🏗️ ШАГ 6 — НЕ удалять `src/lib/google-sheets.ts`

Файл остаётся в репозитории как архив, на случай если понадобится откатиться или восстановить данные из Google в будущем. Просто никто из приложения его больше не импортирует.

Добавить в начало файла комментарий:
```typescript
// ⚠️ DEPRECATED — мигрировано в src/lib/sku-database.ts (2026-05-12).
// Этот файл оставлен как архив на случай отката или повторной миграции.
// НЕ импортировать из приложения. См. docs/wiki/sku-database-migration.md
```

---

## 🏗️ ШАГ 7 — Workflow развёртывания (порядок действий Vladimir)

После того как Claude Code сделает все правки и закоммитит — Vladimir выполнит эти шаги по очереди:

### На dev (iMac):

```bash
cd "ss-control-center"

# 1. Обновить локальную схему
npx prisma db push
npx prisma generate

# 2. Прогнать миграцию данных из Google
npx tsx scripts/migrate-sku-from-sheets.ts
# Должно вывести: inserted: N, updated: 0, total: N

# 3. Запустить dev server и проверить страницу Shipping Labels
npm run dev
# Открыть http://localhost:3000/shipping → Generate Plan
# Данные SKU должны прилетать как раньше (но из БД, не из Google)
```

### На prod (Turso + Vercel):

```bash
# 4. Создать таблицу на Turso (с локального терминала, env vars TURSO_* должны быть установлены)
node scripts/turso-migrate-sku-shipping-data.mjs
# Должно вывести: OK CREATE TABLE..., ✓ SkuShippingData table ensured on Turso.

# 5. Запустить миграцию данных в Turso
# (тот же скрипт, но Prisma client сам подхватит TURSO_DATABASE_URL если он установлен)
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/migrate-sku-from-sheets.ts

# 6. Закоммитить и запушить — Vercel задеплоит новый код
git add .
git commit -m "feat: migrate SKU database from Google Sheets to internal DB"
git push origin main

# 7. После деплоя проверить https://salutemsolutions.info/shipping
```

---

## 🏗️ ШАГ 8 — Очистить `.env.example`

### Файл: `ss-control-center/.env.example`

Удалить или закомментировать блок:
```
# Google
# Both vars required for SKU database load (src/lib/google-sheets.ts).
# Without the API key the shipping plan generator can't read product SKUs and
# every order falls out for "no SKU" — see /api/integrations status.
GOOGLE_SHEETS_ID=
GOOGLE_SHEETS_API_KEY=
GOOGLE_DRIVE_ROOT_FOLDER=
```

Заменить на:
```
# Google Drive — used for shipping label PDF storage
GOOGLE_DRIVE_ROOT_FOLDER=

# (Google Sheets vars removed 2026-05-12 — SKU data migrated to internal DB.
# See docs/wiki/sku-database-migration.md)
```

> **NOTE:** `GOOGLE_DRIVE_ROOT_FOLDER` оставить — Drive продолжает использоваться для PDF этикеток. Только Sheets-переменные убираем.
>
> Реальный `.env` Vladimir почистит сам после того как убедится, что всё работает (через 1-2 недели).

---

## 🏗️ ШАГ 9 — Wiki обновления

Wiki-статья `docs/wiki/sku-database-migration.md` уже создана отдельно. Также уже обновлены:
- `docs/wiki/google-sheets-sku-db.md` — добавлен DEPRECATED баннер
- `docs/wiki/index.md` — ссылка переключена на новую страницу
- `docs/wiki/CONNECTIONS.md` — все ссылки переключены, добавлена связь с Database Schema

Claude Code, проверь что эти файлы соответствуют состоянию выше. Если каких-то изменений нет — внеси по аналогии.

---

## ✅ ACCEPTANCE CRITERIA — как проверить что всё работает

После миграции должно выполняться:

1. **Таблица существует в БД** — `npx prisma studio` → видно таблицу `SkuShippingData` с записями.
2. **API `/api/sku?search=...` работает БЕЗ установленных `GOOGLE_SHEETS_*` env vars** — временно убрать их из `.env`, перезапустить dev server, открыть в браузере `http://localhost:3000/api/sku?search=jimmy` → должны вернуться SKU из БД.
3. **Страница `/shipping`**: открыть, нажать "Generate plan" — план собирается, lookup идёт из БД (можно проверить логами или просто временно отключив интернет — раньше падало бы на запросе к Google, теперь работает).
4. **Popup редактирования SKU**: на странице найти заказ с `NEED ATTENTION` из-за отсутствия SKU данных, открыть попап, заполнить, сохранить — новая запись появляется в БД, не в Google.
5. **Дамп существует** — файл `prisma/seed/sku-database.json` создан и закоммичен.
6. **Никаких импортов `@/lib/google-sheets` в `src/`** — `grep -r "@/lib/google-sheets" src/` возвращает пусто (кроме самого файла `google-sheets.ts`).
7. **На production (Turso + Vercel)** — после деплоя страница `https://salutemsolutions.info/shipping` работает идентично dev-у.

---

## ⚠️ На что обратить внимание (gotchas)

1. **Прогнать миграцию ДО первого деплоя.** Если задеплоить новый код раньше чем создать таблицу на Turso — production упадёт с ошибкой "no such table: SkuShippingData".

2. **Дамп в `prisma/seed/sku-database.json` идёт в git.** Это нужно чтобы любой, кто склонит репозиторий, мог восстановить базу. Проверь `.gitignore` — там не должно быть исключения `prisma/seed/`.

3. **Один SKU = одна строка.** В Google-таблице по факту бывают дубли (один SKU несколько раз). При upsert по `sku` они схлопнутся — это правильное поведение, но Vladimir должен быть в курсе на случай если в Google было что-то странное.

4. **Файлы `src/lib/google-sheets.ts` и `dev.db`** — НЕ трогать. Первый оставляем как архив, второй автоматически обновится через `prisma db push`.

5. **`updatedAt` в SQL для Turso.** В Prisma schema поле `updatedAt @updatedAt` обрабатывается на уровне Prisma, не БД. Но в `scripts/turso-migrate-sku-shipping-data.mjs` мы создаём колонку как `DATETIME NOT NULL` — это нормально, Prisma при upsert/update сам подставит текущее время.

6. **Возможные другие места использования.** Если grep по `@/lib/google-sheets` найдёт файлы вне `src/app/api/sku/` и `src/app/api/shipping/fix-sku/` — переключить их тоже. Особенно внимательно посмотреть на `src/app/api/shipping/plan/route.ts` и любой код в `src/lib/veeqo/` — может быть lookup SKU при формировании плана.

---

## 🚫 Что НЕ менять (regression scope)

- **UI Shipping Labels страницы (`src/app/shipping/page.tsx`)** — никаких правок. Внешний контракт API сохранён, страница работает as-is.
- **Логику формирования плана и покупки этикеток** — миграция чисто на уровне источника данных.
- **Алгоритмы Frozen/Dry, выбора carrier, бюджета** — не трогать.
- **`MASTER_PROMPT_v3.1.md`** — алгоритм агента не меняется.
- **Прод-данные Google-таблицы** — никаких записей в Google после миграции. Таблица остаётся read-only как архив у Vladimir в Google.

---

## 📦 Финальный коммит

Все правки одним коммитом:

```
feat: migrate SKU database from Google Sheets to internal DB

- Add SkuShippingData model to Prisma schema
- Add scripts/turso-migrate-sku-shipping-data.mjs for production
- Add scripts/migrate-sku-from-sheets.ts (one-time data import)
- Add src/lib/sku-database.ts (Prisma-based replacement for google-sheets.ts)
- Switch /api/sku and /api/shipping/fix-sku to internal source
- Mark src/lib/google-sheets.ts as deprecated (kept for rollback)
- Seed dump committed to prisma/seed/sku-database.json
- Remove GOOGLE_SHEETS_ID / GOOGLE_SHEETS_API_KEY from .env.example
- Add docs/wiki/sku-database-migration.md, update CONNECTIONS.md and index.md

After this: project no longer depends on Google Sheets API for SKU data.
The Google sheet remains as read-only archive (not used by app).
```

---

**End of prompt** — 2026-05-12
