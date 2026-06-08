# 🔍 CLAUDE CODE PROMPT — Диагностика модуля Adjustments

## Контекст

Ты работаешь над **SS Control Center** — внутренней операционной панелью Vladimir для управления Amazon/Walmart e-commerce бизнесом (Salutem Solutions).

В проекте есть модуль **Adjustments** (`/adjustments`), который должен отслеживать shipping-транзакции из Amazon SP-API Finances API v2024-06-19 и Walmart Reconciliation Reports. На production (https://salutemsolutions.info/adjustments) модуль показывает:

- `0 transactions tracked`
- Все 4 карточки = `$0.00` (This Month / Last 30 Days / Amazon / Walmart)
- Пусто в "Shipping adjustments" и "SKU issues"
- НЕТ кнопки Sync
- НЕТ кнопки Upload CSV
- НЕТ date-range фильтра внутри страницы

**Sidebar показывает badge `15` рядом с Adjustments** — это противоречие с `0 transactions tracked`. Откуда берётся число — непонятно.

## Цель этой задачи

**ТОЛЬКО ДИАГНОСТИКА. НЕ ФИКСИТЬ НИЧЕГО.**

Провести полный аудит модуля и составить детальный отчёт о текущем состоянии:
- Что реально создано в коде
- Что отсутствует
- Что сломано
- Почему данные не приходят

На основе отчёта Vladimir и Claude в чате примут решение что именно фиксить и в каком порядке.

---

## 📚 ЧТО ПРОЧИТАТЬ ПЕРЕД НАЧАЛОМ

В порядке приоритета:

1. **`CLAUDE.md`** в корне проекта — общая техспецификация
2. **`docs/ADJUSTMENTS_ALGORITHM_v1_0.md`** — ГЛАВНАЯ спецификация модуля. **Если файла нет в `docs/`** — найти его в git history (`git log --all --full-history -- "docs/ADJUSTMENTS_ALGORITHM*"`) или сообщить Vladimir что файл утерян. В таком случае использовать `docs/ADJUSTMENTS_MONITOR_v1.0.md` (старая версия) для понимания концепции.
3. **`docs/wiki/adjustments-monitor.md`** — wiki-страница модуля
4. **`docs/CLAUDE_CODE_PROMPT_ADJUSTMENTS.md`** — оригинальный промпт реализации (если есть)
5. **`docs/WALMART_API_INTEGRATION_SPEC_v1_0.md`** — раздел про Walmart adjustments (recon reports)
6. **`prisma/schema.prisma`** — модели данных

## ⛔ ЧТО НЕ ДЕЛАТЬ

- **НЕ** менять код модуля
- **НЕ** модифицировать БД (только `SELECT`, никаких `UPDATE/INSERT/DELETE`)
- **НЕ** создавать git commits
- **НЕ** трогать другие модули (Customer Hub, Shipping Labels, Frozen Analytics)
- **НЕ** добавлять новые env переменные
- **НЕ** запускать миграции Prisma
- Если попытка ручного sync что-то сломает (например, прервётся с ошибкой) — задокументировать и продолжить, не пытаясь "починить по дороге"

---

## 🔬 ЭТАПЫ ДИАГНОСТИКИ

### ЭТАП 1 — Inventory кода

Для каждого пути проверить: существует ли, какой размер, последняя дата изменения (`ls -la`). Для существующих — кратко описать что внутри.

```
src/app/adjustments/page.tsx
src/app/adjustments/layout.tsx
src/components/adjustments/                    ← вся папка с компонентами
src/app/api/adjustments/route.ts
src/app/api/adjustments/sync/route.ts
src/app/api/adjustments/summary/route.ts
src/app/api/adjustments/sku-analysis/route.ts
src/app/api/adjustments/upload/route.ts        ← для CSV upload
src/lib/adjustments/sync.ts
src/lib/adjustments/transaction-parser.ts
src/lib/amazon-sp-api/finances.ts              ← клиент Finances API v2024-06-19
src/lib/walmart/reports.ts                     ← Walmart recon reports
```

**Для page.tsx и каждого API route** — прочитать полностью, кратко описать:
- Какие компоненты импортирует
- Какие endpoints вызывает на клиенте
- Какие функции из `lib/` вызывает на сервере
- Есть ли заглушки (`TODO`, `FIXME`, `throw new Error("not implemented")`)

**Особое внимание:**
- Есть ли в `page.tsx` кнопки `Sync` и `Upload CSV`? Если нет — отметить
- Есть ли date-range фильтр? Quick periods (7d/30d/90d/MTD)?
- Что показывают карточки — реальные данные или хардкод?

### ЭТАП 2 — Inventory БД

```bash
# Проверить что модели существуют в schema
grep -A 30 "model ShippingTransaction" prisma/schema.prisma
grep -A 20 "model SkuAdjustmentProfile" prisma/schema.prisma
grep -A 20 "model WalmartReconTransaction" prisma/schema.prisma
```

Запустить через **Prisma Studio** или `sqlite3` (для local SQLite) / `turso db shell` (для production):

```sql
-- Сколько вообще записей
SELECT COUNT(*) FROM "ShippingTransaction";
SELECT COUNT(*) FROM "SkuAdjustmentProfile";
SELECT COUNT(*) FROM "WalmartReconTransaction";

-- Распределение по типам
SELECT transactionType, COUNT(*), SUM(amount) 
FROM "ShippingTransaction" 
GROUP BY transactionType;

-- Распределение по store
SELECT storeId, COUNT(*) 
FROM "ShippingTransaction" 
GROUP BY storeId;

-- Когда последний sync был
SELECT MAX(syncedAt) FROM "ShippingTransaction";
SELECT MAX(transactionDate) FROM "ShippingTransaction";

-- Если 0 записей — проверить что таблица создана:
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%hipping%';
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%djustment%';
```

**Также:** откуда берётся badge `15` в sidebar? Найти в коде:

```bash
grep -r "Adjustments" src/components/layout/ | grep -i "badge\|count\|15"
grep -r "/api/adjustments" src/components/layout/
```

Часто badge подсчитывается через отдельный endpoint типа `/api/sidebar/counts` или `/api/adjustments/badge-count`. Найти и проверить какой SQL он запускает.

### ЭТАП 3 — ENV variables

Проверить `.env` и `.env.production` (или Vercel env vars) — НЕ выводить значения, только список ключей с пометкой "set" / "missing":

```
AMAZON_SP_CLIENT_ID_STORE1..5
AMAZON_SP_CLIENT_SECRET_STORE1..5
AMAZON_SP_REFRESH_TOKEN_STORE1..5
AMAZON_SP_MARKETPLACE_ID                  (должно быть ATVPDKIKX0DER)

WALMART_CLIENT_ID_STORE1
WALMART_CLIENT_SECRET_STORE1
```

**Критически важно:** проверить наличие роли **"Finance and Accounting"** в SP-API приложениях. Это можно сделать только в Amazon Seller Central → Develop apps → твоё приложение → проверить чекбокс. **Если есть возможность — попроси Vladimir проверить это вручную и приложить скрин в финальный отчёт. Если нет — отметь как "manual check required".**

### ЭТАП 4 — Sync attempt

**Попробовать запустить sync вручную для ОДНОГО магазина (Salutem Solutions) за последние 7 дней.**

Вариант 1 — через API route:

```bash
# Найти storeId для Salutem Solutions
sqlite3 prisma/dev.db "SELECT id, name FROM Store WHERE name LIKE '%Salutem%';"

# Вызвать sync (заменить STORE_ID)
curl -X POST http://localhost:3000/api/adjustments/sync \
  -H "Content-Type: application/json" \
  -d '{
    "storeId": "STORE_ID",
    "startDate": "2026-05-13",
    "endDate": "2026-05-20",
    "source": "api"
  }' \
  -v 2>&1 | tee /tmp/adjustments-sync-test.log
```

Вариант 2 — если route не существует, написать одноразовый scripts/test-finances-api.ts:

```typescript
// scripts/test-finances-api.ts
// ВРЕМЕННЫЙ СКРИПТ для диагностики. После — удалить.
import { prisma } from '@/lib/prisma';

async function main() {
  const store = await prisma.store.findFirst({ 
    where: { name: { contains: 'Salutem' } } 
  });
  if (!store) throw new Error('Store not found');
  
  console.log('Store:', store.name, store.id);
  
  // Попробовать импортировать существующий SP-API client
  try {
    const { listTransactions } = await import('@/lib/amazon-sp-api/finances');
    const result = await listTransactions({
      storeId: store.id,
      postedAfter: '2026-05-13T00:00:00Z',
      postedBefore: '2026-05-20T00:00:00Z',
      marketplaceId: 'ATVPDKIKX0DER'
    });
    console.log('Got transactions:', result.transactions?.length || 0);
    console.log('First 3 raw:', JSON.stringify(result.transactions?.slice(0, 3), null, 2));
  } catch (err: any) {
    console.error('ERROR:', err.message);
    console.error('Stack:', err.stack);
    // Это самое ценное — точная ошибка
  }
}

main().catch(console.error);
```

Запустить: `npx tsx scripts/test-finances-api.ts 2>&1 | tee /tmp/finances-test.log`

**Зафиксировать дословно:**
- Какой HTTP статус вернул Amazon (200? 401? 403? 429?)
- Какое тело ответа (или error)
- Сколько транзакций в ответе
- Какие `transactionType` встречаются (это ключевое — нужно для маппинга)
- Сохранить ОДНУ полную транзакцию из ответа в отчёт для анализа структуры

### ЭТАП 5 — UI inventory

Зайти на `https://salutemsolutions.info/adjustments` в DevTools открыть Network tab → refresh страницу.

Зафиксировать:

1. Какие API запросы делает страница при загрузке
2. Какие статусы они возвращают (200/4xx/5xx)
3. Содержимое response для каждого

Сделать аналогичный обход для:
- Какие компоненты отрендерены (есть фильтры? кнопка Sync? табы?)
- Что показывает sidebar badge

Если в UI отсутствуют компоненты из спеки (`docs/ADJUSTMENTS_ALGORITHM_v1_0.md`) — составить список:

```markdown
| Компонент из спеки | В коде есть? | В UI отрендерено? |
|---|---|---|
| AdjustmentFilters (store + date range + quick periods) | ? | ? |
| AdjustmentSummaryCards (4 карточки) | ? | ? |
| SyncButton | ? | ? |
| TransactionsTable | ? | ? |
| SkuAnalysisTable | ? | ? |
| CSV Upload button | ? | ? |
| Tabs: All / Adjustments Only / SKU Analysis | ? | ? |
```

---

## 📝 ФОРМАТ ОТЧЁТА

Создать файл **`docs/ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md`** со следующей структурой:

```markdown
# Adjustments Module — Diagnosis Report
## Date: 2026-05-22
## Auditor: Claude Code

---

## 1. EXECUTIVE SUMMARY

Краткое summary в 5-7 предложений: что работает, что нет, главные блокеры.

---

## 2. CODE INVENTORY

### 2.1 Files present
[список существующих файлов с размером и датой]

### 2.2 Files missing
[список отсутствующих файлов]

### 2.3 Key code excerpts
[критически важные куски кода: например классификатор isShippingTransaction(), маппер транзакций]

### 2.4 TODO / FIXME / заглушки
[все найденные пометки]

---

## 3. DATABASE STATE

### 3.1 Models
[ShippingTransaction / SkuAdjustmentProfile / WalmartReconTransaction — существуют ли]

### 3.2 Records
[количества по моделям, типам, store, датам]

### 3.3 Sidebar badge "15" — origin
[откуда берётся это число]

---

## 4. ENV VARIABLES

[список SP-API + Walmart переменных со статусом set/missing]

**Manual checks required:**
- [ ] Vladimir: проверить роль "Finance and Accounting" в SP-API приложении для каждого из 5 магазинов

---

## 5. SYNC ATTEMPT RESULTS

### 5.1 Test call to SP-API Finances v2024-06-19
[точный лог запроса/ответа]

### 5.2 Example raw transaction from API
```json
{
  // одна полная транзакция как пример структуры
}
```

### 5.3 Errors encountered
[все ошибки дословно]

---

## 6. UI INVENTORY

### 6.1 Components comparison (spec vs reality)
[таблица из этапа 5]

### 6.2 Network requests on page load
[список запросов и статусов]

---

## 7. ROOT CAUSE ANALYSIS

Для каждой найденной проблемы — гипотеза с уровнем уверенности:

### 7.1 Why 0 transactions in DB
**Уровень уверенности:** High / Medium / Low
**Причина:** ...
**Доказательства:** ...

### 7.2 Why no Sync button
...

### 7.3 Why sidebar badge shows 15
...

---

## 8. RECOMMENDED FIX ORDER

Список конкретных задач в порядке приоритета. **НЕ выполнять** — это input для следующего обсуждения с Vladimir.

1. [HIGH] Что фиксить первым и почему
2. [HIGH] ...
3. [MEDIUM] ...
4. [LOW] ...

---

## 9. UNKNOWNS / QUESTIONS FOR VLADIMIR

Список вопросов, на которые ты сам не смог ответить:

- ?
- ?

---

## 10. CLEANUP

- [ ] Удалить временный `scripts/test-finances-api.ts`
- [ ] Удалить лог-файлы из `/tmp/`
- [ ] Не оставить uncommitted changes в репозитории
```

---

## ⚙️ ВАЖНЫЕ ПРАВИЛА ПО ХОДУ РАБОТЫ

1. **Логируй всё.** Если ошибка непонятна — приложи полный stack trace в отчёт. Vladimir не сможет дать тебе больше контекста.
2. **Если что-то не очевидно — отметь "Unknown" в отчёте.** Лучше честное "не знаю" чем гипотеза без основания.
3. **Не оптимизируй формулировки.** Пиши прямо: "В файле X на строке Y закомментирован вызов Z. Это означает что sync ниоткуда не запускается."
4. **Скриншоты не нужны** (ты их сделать всё равно не можешь). Текстовые логи и грепы — главный инструмент.
5. **Время:** ориентировочно 30-45 минут на весь аудит. Если застрял на чём-то одном >15 мин — пропусти, отметь в "Unknowns".

---

## 📚 WIKI / ДОКУМЕНТАЦИЯ (после)

После создания отчёта:

1. Добавить запись в `docs/wiki/index.md` в раздел "Diagnostic reports" (создать если нет):
   ```markdown
   - [Adjustments Diagnosis 2026-05-22](../ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md)
   ```

2. **НЕ** обновлять `adjustments-monitor.md` в wiki — это только для финальных решений, не для диагностики.

3. **НЕ** делать git commit. Vladimir сам решит когда коммитить.

---

## 🎯 КРИТЕРИЙ ЗАВЕРШЕНИЯ

Задача выполнена когда:
- Создан `docs/ADJUSTMENTS_DIAGNOSIS_REPORT_2026-05-22.md`
- Все секции заполнены (включая "Unknowns" если есть)
- Временный `scripts/test-finances-api.ts` удалён
- Vladimir может прочитать отчёт и понять что именно сломано БЕЗ необходимости лезть в код
