# CLAUDE CODE PROMPT — Walmart Performance API Fix

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-15
> **Prepared by:** Vladimir (via Claude chat)
> **Branch:** `fix/walmart-performance-api`
> **Execution mode:** строго поэтапно, коммит после каждого этапа
> **Связано с:** `CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md` (Этап 3)

---

## 🎯 КОНТЕКСТ И ЦЕЛЬ

На странице `/account-health` → таб **Walmart** секция Performance metrics показывает «Not available via API for this account». Item compliance таблица при этом работает корректно (158 listings подтягиваются).

**Текущая ошибка:** наш код вызывает `/v3/sellerPerformance/*` и `/v3/insights/*` — получает `404 CONTENT_NOT_FOUND`.

**Главное открытие из research:** Walmart реструктурировал Seller Performance API. Старая схема с одним общим `summary` endpoint больше не существует. **Теперь каждая метрика имеет свой отдельный endpoint.**

### Что точно известно

1. **API существует** — Walmart официально документирует Seller Performance API в категории `Insights`: https://developer.walmart.com/us-marketplace/docs/seller-performance-api-overview
2. **Endpoints раздельные** — 11 штук (по reference IDs из документации):
   - `getotd` — On-time delivery summary
   - `getvtr` — Valid tracking rate summary
   - `getsrr` — Seller response rate summary
   - `getrefunds` — Refunds summary
   - `getcancel` — Cancellations summary
   - `getnegativefeedback` — Negative feedback summary
   - `getreturns-1` — Returns summary
   - `getinr` — Item not received summary
   - `getsfla` — Ship-from location accuracy summary
   - `getots` — On-time shipment summary
   - `getcma` — Carrier method accuracy summary
3. **Headers стандартные** — `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID` (UUID per request), `WM_SVC.NAME: Walmart Marketplace`, `Accept: application/json`
4. **Параметры**: `windowDays` (14/30/60/90), опционально `orderTypes`
5. **Альтернатива через On-Request Reports API**:
   - `POST /v3/reports/reportRequests?reportType=*&reportVersion=v1` → возвращает `requestID`
   - Опросить `/v3/reports/reportRequests?requestID=X` пока статус не `RESULTED`
   - Скачать через `/v3/reports/downloadReport?requestID=X`
6. **404 у Walmart часто означает «нет данных» или «не тот путь»**, не «endpoint не существует»
7. **Scopes можно проверить через `GET /v3/token/detail`** — возвращает текущие OAuth scopes и их access levels

### Что НЕ известно (Claude Code должен выяснить сам)

Точные URL пути новых endpoints — Walmart developer portal защищён JavaScript и не отдаёт curl-примеры из документации без авторизации. Возможные варианты (нужно эмпирически проверить):

```
Вариант A: /v3/sellerPerformance/onTimeDelivery/summary?windowDays=30
Вариант B: /v3/insights/sellerPerformance/onTimeDelivery?windowDays=30
Вариант C: /v3/insights/onTimeDelivery/summary?windowDays=30
Вариант D: /v3/getOtd?windowDays=30  (по reference ID напрямую)
Вариант E: /v3/sellerPerformance/getOtd?windowDays=30
Вариант F: /v3/sellerPerformanceStandards/onTimeDelivery?windowDays=30
```

Также может использоваться camelCase / kebab-case / snake_case в URL — нужно попробовать все.

---

## ⚠️ Принципы

- **Не угадывать** — пробовать эмпирически. Каждый вариант URL логировать, фиксировать точный response.
- **Логирование на максимум** — статус, headers, тело ответа, какой именно URL пробовали.
- **Fallback цепочкой** — если live summary endpoints не работают, переходим на On-Request Reports. Если и это не работает — показываем в UI конкретную причину с диагностикой.
- **Никаких mock data** — лучше честно показать ошибку, чем фейковые числа.
- **Не трогать Veeqo delegated key** — только наш собственный `WALMART_CLIENT_ID_STORE1` ключ.
- **Все запросы — через существующий `walmartFetch` / `WalmartClient`** в `src/lib/walmart/client.ts` (если нет — создать/расширить с rate-limit aware fetch).
- **Salutem Design System v1.0** в UI обновлениях (никакого чёрного текста, `tabular-nums` на числах).

---

## ЭТАП 1: Изучить текущий код

Перед любыми изменениями прочитать:
- `src/lib/walmart/client.ts` — как сейчас построен fetch
- `src/lib/walmart/seller-performance.ts` — что именно вызывается сейчас
- `src/app/api/account-health/walmart/sync/route.ts` — как sync обрабатывает ошибки
- `src/components/account-health/WalmartHealthTab.tsx` — где показывается «Not available»
- `prisma/schema.prisma` — модель `WalmartPerformanceSnapshot`

Зафиксировать в комментарии PR:
- Какие точно URL вызываются сейчас
- Какие headers отправляются
- Куда пишется error message в UI

**Этот этап заканчивается без коммита** — только понимание текущей системы.

---

## ЭТАП 2: Диагностический скрипт

### 2.1. Создать `scripts/walmart-diagnose-api.ts`

Standalone TypeScript скрипт, запускаемый через `npx tsx scripts/walmart-diagnose-api.ts`. Использует `WALMART_CLIENT_ID_STORE1` и `WALMART_CLIENT_SECRET_STORE1` из `.env`.

Скрипт делает следующее по порядку:

**Step 1.** Получить access token: `POST https://marketplace.walmartapis.com/v3/token` с Basic Auth и body `grant_type=client_credentials`. Залогировать `access_token`, `expires_in`, любые scopes которые могут вернуться.

**Step 2.** Вызвать `GET https://marketplace.walmartapis.com/v3/token/detail`. Залогировать ВЕСЬ ответ — `scopes` object с access levels по категориям (`reports`, `insights`, `orders`, `item`, etc.). Это покажет, есть ли у нас доступ к `insights` / `reports` / `seller-performance`.

**Step 3.** Попробовать 6 вариантов URL для **On-Time Delivery summary** (через try/catch каждый, не падать на ошибке):

```typescript
const URL_VARIANTS_OTD = [
  '/v3/sellerPerformance/onTimeDelivery/summary?windowDays=30',
  '/v3/insights/sellerPerformance/onTimeDelivery?windowDays=30',
  '/v3/insights/onTimeDelivery/summary?windowDays=30',
  '/v3/getOtd?windowDays=30',
  '/v3/sellerPerformance/getOtd?windowDays=30',
  '/v3/sellerPerformanceStandards/onTimeDelivery?windowDays=30',
];
```

Для каждого варианта залогировать:
- URL
- HTTP status
- Response body (первые 500 символов если большой)
- Headers (особенно `x-current-token-count`, `x-next-replenish-time`, `x-correlation-id`)

Если какой-то вариант вернёт **200 OK** — это победитель. Сохранить в результаты.

Если все вернут 404 — этого endpoint типа не существует под этими путями.

**Step 4.** Попробовать On-Request Reports подход. Список `reportType` значений для попыток (Walmart использует SCREAMING_SNAKE_CASE):

```typescript
const REPORT_TYPES = [
  'CANCELLATION',
  'DELIVERY_DEFECT',
  'ITEM_PERFORMANCE',
  'SELLER_PERFORMANCE',
  'SELLER_PERFORMANCE_SUMMARY',
  'ON_TIME_DELIVERY',
  'VALID_TRACKING',
  'NEGATIVE_FEEDBACK',
  'RETURNS',
  'ITEM_NOT_RECEIVED',
];
```

Для каждого:
- `POST /v3/reports/reportRequests?reportType={TYPE}&reportVersion=v1`
- Залогировать ответ. Если 200 OK + `requestID` — этот тип отчёта поддерживается, сохранить ID.
- НЕ ждать готовности отчёта на этом этапе — просто фиксируем, какие типы принимаются.

**Step 5.** Записать все findings в файл `docs/WALMART_API_DIAGNOSTIC_RESULTS.md` со структурой:

```markdown
# Walmart API Diagnostic Results
Date: YYYY-MM-DD HH:MM

## Token scopes
{json with all scopes}

## On-Time Delivery endpoint variants
| URL | Status | Notes |
|---|---|---|
| ... | 404 | CONTENT_NOT_FOUND |
| ... | 200 | ✅ WORKS |

## On-Request Reports types
| reportType | Status | requestID? |
|---|---|---|
| CANCELLATION | 200 | abc-123 |
| ... | 404 | not supported |

## Winning approach
{вывод: какой метод использовать как primary}
```

### 2.2. Запустить скрипт

```bash
npx tsx scripts/walmart-diagnose-api.ts
```

Если выпадает на отсутствии `dotenv` или `tsx` — добавить в `package.json` devDependencies, не игнорировать.

**Коммит:** `chore(walmart): add API diagnostic script + results`

---

## ЭТАП 3: Обновить `seller-performance.ts` на основе findings

После ЭТАПА 2 у нас есть данные. Действуем по сценариям:

### Сценарий A: Live summary endpoints работают (один из URL_VARIANTS вернул 200)

Переписать `src/lib/walmart/seller-performance.ts` так, чтобы он делал **11 отдельных запросов** — по одному на каждую метрику (на тот URL pattern который сработал).

Структура клиента:

```typescript
// src/lib/walmart/seller-performance.ts

const METRIC_ENDPOINTS = {
  onTimeDelivery:    'WORKING_URL_PATTERN/onTimeDelivery',
  validTracking:     'WORKING_URL_PATTERN/validTrackingRate',
  sellerResponse:    'WORKING_URL_PATTERN/responseRate',
  refunds:           'WORKING_URL_PATTERN/refundRate',
  cancellations:     'WORKING_URL_PATTERN/cancellationRate',
  negativeFeedback:  'WORKING_URL_PATTERN/negativeFeedback',
  returns:           'WORKING_URL_PATTERN/returns',
  itemNotReceived:   'WORKING_URL_PATTERN/itemNotReceived',
  shipFromAccuracy:  'WORKING_URL_PATTERN/shipFromLocationAccuracy',
  onTimeShipment:    'WORKING_URL_PATTERN/onTimeShipment',
  carrierAccuracy:   'WORKING_URL_PATTERN/carrierMethodAccuracy',
};

export async function fetchWalmartPerformance(windowDays: 14 | 30 | 60 | 90 = 30): Promise<WalmartPerformanceData> {
  // Параллельно (Promise.allSettled), не последовательно
  const results = await Promise.allSettled(
    Object.entries(METRIC_ENDPOINTS).map(async ([key, url]) => {
      const response = await walmartFetch(`${url}?windowDays=${windowDays}`);
      return { key, data: response };
    })
  );
  
  // Собрать все успешные. Залогировать failed.
  const performance: any = {};
  for (const result of results) {
    if (result.status === 'fulfilled') {
      performance[result.value.key] = result.value.data;
    } else {
      console.error(`Failed to fetch metric: ${result.reason}`);
    }
  }
  
  return performance;
}
```

**Важно про окна:** на скрине у Vladimir 5 метрик за 30 дней (On-time delivery, Cancellations, Valid tracking, Seller response, Late shipment) + 3 за 60 дней (Negative feedback, Returns, Item not received). Делать 2 параллельных запроса — один с `windowDays=30`, второй с `windowDays=60` — и брать соответствующие метрики из каждого.

### Сценарий B: Live endpoints не работают, но On-Request Reports работают

Использовать **двухшаговый flow**:

```typescript
// src/lib/walmart/seller-performance.ts

export async function fetchWalmartPerformanceViaReports(): Promise<WalmartPerformanceData> {
  // Step 1: Запросить отчёты для всех нужных reportType
  const reportTypes = ['ON_TIME_DELIVERY', 'CANCELLATION', /* etc, тех что работают */];
  const requestIds: Record<string, string> = {};
  
  for (const reportType of reportTypes) {
    const resp = await walmartFetch(
      `/v3/reports/reportRequests?reportType=${reportType}&reportVersion=v1`,
      { method: 'POST' }
    );
    requestIds[reportType] = resp.requestId;
  }
  
  // Step 2: Polling — каждые 30 секунд проверять статус, max 30 минут
  const downloadUrls: Record<string, string> = {};
  const start = Date.now();
  while (Object.keys(downloadUrls).length < reportTypes.length && Date.now() - start < 30 * 60 * 1000) {
    for (const [reportType, requestId] of Object.entries(requestIds)) {
      if (downloadUrls[reportType]) continue; // уже готов
      const statusResp = await walmartFetch(`/v3/reports/reportRequests?requestID=${requestId}`);
      if (statusResp.requestStatus === 'RESULTED') {
        const dlResp = await walmartFetch(`/v3/reports/downloadReport?requestID=${requestId}`);
        downloadUrls[reportType] = dlResp.downloadUrl;
      }
    }
    await sleep(30_000);
  }
  
  // Step 3: Скачать XLSX/JSON, распарсить, агрегировать в WalmartPerformanceData
  // ...
}
```

> ⚠️ Reports generation занимает 15-45 минут. Это значит **синхронный sync через UI button не подойдёт**. Нужно сделать асинхронный flow: создать отдельный `WalmartReportJob` table со статусами `REQUESTED` / `RESULTED` / `DOWNLOADED` / `FAILED`. Cron каждый час проверяет готовые отчёты и обновляет `WalmartPerformanceSnapshot`. UI показывает «Last synced X ago» и кнопку «Request fresh data».

### Сценарий C: Ничего не работает

Если **ни live endpoints, ни On-Request Reports не дают результата**:

1. В UI обновить текст ошибки — заменить «Not available via API for this account» на честную диагностику:
   ```
   Walmart Performance metrics — диагностика:
   • Token scopes: {список scopes из /v3/token/detail}
   • Tried 6 URL variants, all returned 404 (см. docs/WALMART_API_DIAGNOSTIC_RESULTS.md)
   • Tried 10 reportType values, none accepted (см. docs/WALMART_API_DIAGNOSTIC_RESULTS.md)
   
   Возможные причины:
   1. У токена недостаточный scope для `insights` или `reports`
   2. Endpoint требует Pro Seller статус или другую активацию
   3. Account doesn't have enough order history for performance data yet
   
   Действие: открыть тикет в Walmart Seller Support, приложить результаты диагностики
   ```
2. Создать заготовку тикета в `docs/WALMART_SUPPORT_TICKET_DRAFT.md` с текстом для копирования в Walmart Support (см. ЭТАП 5).

**Коммит:** `feat(walmart): rewrite seller-performance with correct endpoints` (Сценарий A) или `feat(walmart): add On-Request Reports fallback for performance` (Сценарий B) или `feat(walmart): improve performance API error diagnostics` (Сценарий C).

---

## ЭТАП 4: UI улучшения

В `src/components/account-health/WalmartHealthTab.tsx`:

### 4.1. Заменить плейсхолдер «Not available»

Если **данные есть** — показать обычные карточки (Сценарий A или B после первого успешного sync).

Если **данных ещё нет, но запрос в процессе** (Сценарий B):
```
┌────────────────────────────────────────┐
│ ⏳ Performance metrics                  │
│                                         │
│ Walmart готовит отчёт (15-45 минут).    │
│ Status: REPORT REQUESTED                │
│ Запрошено: 14:23 · обновится автоматич. │
│                                         │
│ [Refresh status] · [View diagnostic]    │
└────────────────────────────────────────┘
```

Если **данных нет и не получается** (Сценарий C):
```
┌────────────────────────────────────────┐
│ ⚠️ Performance metrics недоступны        │
│                                         │
│ Walmart API возвращает 404 на все       │
│ варианты endpoints. Это означает что    │
│ либо scope недостаточен, либо account   │
│ требует активации.                      │
│                                         │
│ Что мы попробовали:                     │
│ • 6 URL вариантов для summary endpoints │
│ • 10 типов On-Request Reports           │
│ • Token scopes: {из диагностики}        │
│                                         │
│ Действие: открыть тикет в Walmart Sup-  │
│ port (черновик в docs/WALMART_SUPPORT_  │
│ TICKET_DRAFT.md)                        │
│                                         │
│ [View full diagnostic]                  │
└────────────────────────────────────────┘
```

### 4.2. Добавить кнопку "View diagnostic"

Открывает Sheet/Dialog с содержимым `docs/WALMART_API_DIAGNOSTIC_RESULTS.md` (читать через API endpoint, не хардкодить).

**Коммит:** `feat(ui): improve Walmart performance error messaging with diagnostic`

---

## ЭТАП 5: Заготовка тикета в Walmart Support (только если Сценарий C)

Создать `docs/WALMART_SUPPORT_TICKET_DRAFT.md`:

```markdown
# Walmart Marketplace Support Ticket

**Subject:** Seller Performance API endpoints returning 404 — clarify correct paths

**Account:** Sirius Trading International LLC
**Seller ID:** 10001624309
**Client ID:** 0595b090-82f9-4f56-9216-5aa68a5d3cc5 (direct seller key, not Veeqo)

---

Hello Walmart Seller Support team,

We are integrating Walmart Marketplace API into our internal operations dashboard. Orders API, Items API, and Returns API all work correctly. However, Seller Performance API endpoints return `404 CONTENT_NOT_FOUND` consistently.

We've tried multiple URL patterns based on documentation at https://developer.walmart.com/us-marketplace/docs/seller-performance-api-overview:

1. `GET /v3/sellerPerformance/onTimeDelivery/summary?windowDays=30` → 404
2. `GET /v3/insights/sellerPerformance/onTimeDelivery?windowDays=30` → 404
3. `GET /v3/insights/onTimeDelivery/summary?windowDays=30` → 404
4. `GET /v3/getOtd?windowDays=30` → 404
5. `GET /v3/sellerPerformance/getOtd?windowDays=30` → 404
6. `GET /v3/sellerPerformanceStandards/onTimeDelivery?windowDays=30` → 404

We also tried On-Request Reports API with these reportType values: CANCELLATION, DELIVERY_DEFECT, ITEM_PERFORMANCE, SELLER_PERFORMANCE, ON_TIME_DELIVERY, VALID_TRACKING, NEGATIVE_FEEDBACK, RETURNS, ITEM_NOT_RECEIVED — all return 404.

Our token has the following scopes (from `/v3/token/detail`):
{вставить ответ из ЭТАПА 2}

**Questions:**
1. What are the exact production URLs for the 11 Seller Performance summary endpoints listed in your documentation (getotd, getvtr, getsrr, getrefunds, getcancel, getnegativefeedback, getreturns, getinr, getsfla, getots, getcma)?
2. Is our account eligible for Seller Performance API access, or does it require Pro Seller status / additional activation?
3. Same data displays correctly in Seller Center → Performance page, so the data exists. How do we access it via API?

Our use case: real-time monitoring dashboard for 5 Amazon accounts + 1 Walmart account (Sirius Trading) with automated alerts when metrics breach thresholds. We need this data to operate effectively.

Thank you,
Vladimir Kuznetsov
Sirius Trading International LLC
```

Vladimir сможет открыть тикет через Seller Center → Help → Contact Support и скопировать этот текст.

**Коммит:** `docs(walmart): add support ticket draft for performance API` (только Сценарий C)

---

## ЭТАП 6: Wiki + документация

### 6.1. Обновить `docs/wiki/walmart-api.md`

Добавить секцию:

```markdown
## Seller Performance API — текущий статус

Last diagnosed: YYYY-MM-DD

**Working approach:** {выбранный сценарий A/B/C}

**Working endpoints:**
- ...

**Known issues:**
- ...

**Polling schedule:** {частота sync}

**See also:** `docs/WALMART_API_DIAGNOSTIC_RESULTS.md`
```

### 6.2. Обновить `docs/wiki/account-health-v2.md`

В секции "Walmart" пометить статус Performance metrics: ✅ Working / ⏳ Reports-based / ❌ Pending support ticket.

### 6.3. Обновить `docs/wiki/index.md` и `docs/wiki/CONNECTIONS.md`

Добавить ссылку на `WALMART_API_DIAGNOSTIC_RESULTS.md` и (если есть) `WALMART_SUPPORT_TICKET_DRAFT.md`.

**Коммит:** `docs(wiki): document Walmart performance API findings`

---

## ✅ ПРОВЕРКА ГОТОВНОСТИ

После всех этапов:

1. `npm run build` без ошибок
2. `npx tsx scripts/walmart-diagnose-api.ts` — отрабатывает, создаёт `docs/WALMART_API_DIAGNOSTIC_RESULTS.md`
3. `/account-health` → Walmart tab:
   - Если данные подтянулись (Сценарий A/B) — все 8 метрик отображаются с правильными %
   - Если данных нет (Сценарий C) — показывается понятная диагностика, НЕ generic «Not available»
4. POST `/api/account-health/walmart/sync` — отрабатывает, в логах виден точный URL и status каждого вызванного endpoint
5. В Telegram приходят alerts если порог превышен (например Late Shipment > 5%)

---

## 📁 Файлы для чтения перед началом

- `src/lib/walmart/client.ts`
- `src/lib/walmart/seller-performance.ts`
- `src/lib/walmart/items.ts`
- `src/app/api/account-health/walmart/sync/route.ts`
- `src/components/account-health/WalmartHealthTab.tsx`
- `docs/CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md` — Этап 5 (старая версия Seller Performance API)
- `docs/CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md` — Этап 3
- `prisma/schema.prisma` — модель `WalmartPerformanceSnapshot`

## ⛔ Что НЕ делать

- НЕ заполнять данные mock-значениями для "красоты". Лучше честная ошибка чем фейк.
- НЕ удалять диагностический скрипт после первого запуска — он понадобится повторно.
- НЕ трогать Veeqo delegated key (`c479b706-...`). Только наш собственный `WALMART_CLIENT_ID_STORE1`.
- НЕ менять Amazon-часть Account Health — это отдельный модуль.
- НЕ хардкодить рабочий URL в коде сразу. Сначала диагностический скрипт показывает что работает, потом записываем в код с комментарием "verified working on YYYY-MM-DD".
- НЕ забывать `Promise.allSettled` (не `Promise.all`) при параллельных запросах — иначе одна неудачная метрика обрушит весь sync.
- НЕ ставить throttle ниже 1 req/sec до диагностики rate limits.

---

## 🎯 Финальный результат

Один из трёх исходов:

**A (best case):** Performance metrics работают через прямые API вызовы → 8 метрик отображаются в UI → Telegram alerts при breach. Время на реализацию: ~2 часа.

**B (good):** Performance metrics работают через On-Request Reports (асинхронно) → данные обновляются раз в час через cron → UI показывает «Last synced 23 min ago». Время на реализацию: ~4 часа.

**C (need support ticket):** Diagnostic показывает что endpoints недоступны для нашего scope → в UI понятная диагностика → готов draft тикета для Walmart Support → Vladimir отправляет тикет → ждём ответа от Walmart. Время на реализацию: ~3 часа на код + ожидание Walmart support (обычно 2-5 рабочих дней).

В любом из исходов Item Compliance (тот блок что уже работает с 158 listings) НЕ должен пострадать.
