# CLAUDE CODE PROMPT — Walmart Performance API Fix (v2 — точные endpoints)

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-15
> **Prepared by:** Vladimir (via Claude chat)
> **Branch:** `fix/walmart-performance-api`
> **Execution mode:** поэтапно, коммит после каждого этапа
> **Связано с:** `CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md` (Этап 3)
>
> **⚠️ Эта версия промпта (v2) полностью заменяет предыдущую версию.** В v1 был диагностический скрипт-перебор URL — он больше не нужен. Точные пути endpoints получены из официальной документации Walmart (developer.walmart.com → Insights → Seller Performance API). Все 3 проверенных endpoints используют одинаковый паттерн.

---

## 🎯 КОНТЕКСТ И ЦЕЛЬ

На странице `/account-health` → таб **Walmart** секция Performance metrics показывает «Not available via API for this account». Item compliance таблица при этом работает корректно (158 listings).

**Текущая ошибка:** код вызывает `/v3/sellerPerformance/*` с параметром `windowDays` → получает `404 CONTENT_NOT_FOUND`.

**Причина:** Walmart реструктурировал Seller Performance API. Старая схема `/v3/sellerPerformance/summary` больше не существует. Endpoint полностью переехал в категорию **Insights**, и каждая метрика теперь — отдельный URL.

**Цель:** заменить вызовы на правильные endpoints, чтобы все 8 метрик из Walmart Seller Center (скриншот Vladimir) отображались в нашем UI.

---

## ✅ ПОДТВЕРЖДЁННАЯ СТРУКТУРА

Базовый паттерн (verified на 3 endpoints — OTD, Cancellations, VTR):

```
GET https://marketplace.walmartapis.com/v3/insights/performance/{metric}/summary
    ?reportDuration={14|30|60|90}
    [&shippingMethod=ALL_METHODS|TwoDay|OneDay]
```

### Critical fixes от текущей реализации

| Было (не работало) | Стало (правильно) |
|---|---|
| `/v3/sellerPerformance/...` | `/v3/insights/performance/{metric}/summary` |
| Параметр `windowDays` | Параметр `reportDuration` |
| Один общий endpoint за всё | 11 отдельных endpoints — по одному на метрику |
| 404 = "недоступно" | 404 = неправильный URL. **Нет данных = HTTP 204**, не 404 |

### Точная таблица 11 endpoints

| Metric | Path segment | Verification | Standard threshold | Maps to UI label |
|---|---|---|---|---|
| On-time delivery | `otd` | ✅ verified | ≥ 90% | "On-time delivery" |
| Order cancellations | `cancellations` | ✅ verified | ≤ 2% | "Cancellations" |
| Valid tracking rate | `vtr` | ✅ verified | ≥ 99% | "Valid tracking" |
| Seller response rate | `srr` | inferred from reference ID `getsrr` | ≥ 95% | "Seller response" |
| Negative feedback | `negativeFeedback` | inferred from reference ID `getnegativefeedback` | watch trend | "Negative feedback" |
| Returns | `returns` | inferred from reference ID `getreturns` | watch trend | "Returns" |
| Item not received | `inr` | inferred from reference ID `getinr` | watch trend | "Item not received" |
| Ship-from location accuracy | `sfla` | inferred from reference ID `getsfla` | trend monitoring | "Ship-from accuracy" |
| On-time shipment | `ots` | inferred from reference ID `getots` | ≥ 99% | "On-time shipment" / "Late shipment" |
| Carrier method accuracy | `cma` | inferred from reference ID `getcma` | trend monitoring | "Carrier method" |
| Order refunds **(DEPRECATED)** | `refunds` | inferred | — | **не использовать** |

Reference URLs для проверки (на developer.walmart.com):
- https://developer.walmart.com/us-marketplace/docs/retrieve-on-time-delivery-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-order-cancellations-summary
- https://developer.walmart.com/us-marketplace/docs/valid-tracking-rate-summaries
- https://developer.walmart.com/us-marketplace/docs/retrieve-seller-response-rate-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-negative-feedback-performance-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-returns-performance-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-item-not-received-performance-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-ship-from-location-accuracy-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-on-time-shipment-summary
- https://developer.walmart.com/us-marketplace/docs/retrieve-carrier-method-accuracy-summary

### Headers (обязательны на каждом запросе)

```
WM_SEC.ACCESS_TOKEN: <ACCESS_TOKEN>
WM_QOS.CORRELATION_ID: <UUID, уникальный per request>
WM_SVC.NAME: Walmart Marketplace
Accept: application/json
```

`Authorization: Basic <BASE64(clientId:clientSecret)>` нужен только для refresh token, не для самих API вызовов (если у нас уже есть валидный access_token).

### HTTP статус коды

| Status | Meaning | Action |
|---|---|---|
| **200 OK** | Данные есть | Парсим `payload`, сохраняем |
| **204 No Content** | Нет данных за период (новый аккаунт, нет orders) | Показать "No data yet" в UI, не пытаться парсить тело |
| **400 Bad Request** | Параметры неверные | Залогировать тело ошибки, проверить `reportDuration` |
| **401 Unauthorized** | Токен невалиден | Refresh token и retry |
| **403 Forbidden** | Нет scope для insights | Проверить `/v3/token/detail` (см. ниже) |
| **404 Not Found** | Неправильный URL | Не должно случаться при использовании путей из таблицы. Если случается — открыть тикет |
| **429 Too Many Requests** | Rate limit | Exponential backoff с jitter |

### Response structure

Два варианта структуры в `payload` (зависит от метрики):

**Вариант A — overall-style (OTD, OTS, sfla, cma, srr):**
```json
{
  "payload": {
    "reportDuration": 30,
    "updatedTimestamp": "2025-02-02T19:49:56Z",
    "shippingMethod": "ALL_METHODS",
    "overallRate": 89,
    "overallTrend": "RED_DOWN",
    "sellerAccountableRate": 96,
    "sellerAccountableTrend": "GREEN_UP",
    "impactedCustomerCount": 4,
    "impactedCustomerTrend": "GREEN_UP",
    "standard": "above 90%",
    "performanceStandard": "90% or above",
    "riskLevel": "Monitor",
    "performanceRiskLevel": "Monitor",
    "sellerAccountableDrivers": { ... },
    "nonAccountableDrivers": { ... },
    "recommendations": [ { "recommendation": "...", "moreInfoLink": "..." } ]
  },
  "status": "OK"
}
```

**Вариант B — cumulative-style (cancellations, vtr, returns, inr, negativeFeedback):**
```json
{
  "payload": {
    "reportDuration": 30,
    "updatedTimestamp": "...",
    "cumulativeRate": 2,
    "cumulativeRateTrend": "GREEN_UP",
    "gmvLoss": 822.51,
    "ordersImpacted": 4,
    "ordersImpactedTrend": "GREEN_UP",
    "standard": "below 2%",
    "performanceStandard": "2% or below",
    "riskLevel": "MEETS STANDARD",
    "performanceRiskLevel": "Good",
    "sellerAccountableDrivers": { ... },
    "nonAccountableDrivers": { ... },
    "recommendations": [ ... ]
  },
  "status": "OK"
}
```

Унифицированный парсер должен брать **`overallRate` или `cumulativeRate`** в зависимости от того что есть.

### Trend values (общие для всех endpoints)

- `GREEN_UP` / `GREEN_DOWN` — улучшение
- `NEUTRAL` — без изменений
- `RED_UP` / `RED_DOWN` — ухудшение

### Окна `reportDuration`

| Metric | Supported windows |
|---|---|
| OTD, OTS, cancellations, srr, sfla, cma | 14, 30, 60, 90 |
| VTR | 14, 30, 90 (НЕ 60) |
| Returns, INR, Negative feedback | обычно 30, 60, 90 |

Стратегия: запросить **30 дней по умолчанию**, при ошибке fall back на 90.

---

## ⚠️ Принципы

- **Параллельность через `Promise.allSettled`** — одна неудачная метрика не должна обрушить весь sync.
- **Унификация парсинга** — общая функция `parseMetricResponse(metricKey, data)` которая знает что у одних метрик `overallRate`, у других `cumulativeRate`.
- **204 ≠ ошибка** — это валидное "no data yet", показать соответственно в UI.
- **Никаких mock data** — лучше "no data yet" чем фейк.
- **Не трогать Veeqo delegated key** — только `WALMART_CLIENT_ID_STORE1`.
- **Логирование на максимум** на первом sync — точный URL, status, response body для каждого вызова. После того как всё заработает — снизить verbosity.
- **Salutem Design System v1.0** в UI (никакого чёрного текста, `tabular-nums` на числах).

---

## ЭТАП 1: Изучить текущий код

Прочитать (без изменений):
- `src/lib/walmart/client.ts` — текущий fetch и auth
- `src/lib/walmart/seller-performance.ts` — что именно вызывается сейчас
- `src/app/api/account-health/walmart/sync/route.ts` — sync handler
- `src/components/account-health/WalmartHealthTab.tsx` — UI компонент
- `prisma/schema.prisma` — модель `WalmartPerformanceSnapshot`

Зафиксировать в комментарии PR:
- Какой именно URL вызывался (для документации в commit message)
- Какой был параметр и что мы меняем

**Без коммита.**

---

## ЭТАП 2: Опциональная диагностика scopes (можно пропустить, если время дорого)

Создать `scripts/walmart-check-scopes.ts`:

```typescript
// Получить токен через client_credentials
// Вызвать GET /v3/token/detail
// Залогировать scopes object
// Особенно проверить наличие "insights" и/или "reports"
// Записать ответ в docs/WALMART_API_SCOPES.md для записи
```

Запустить: `npx tsx scripts/walmart-check-scopes.ts`

Direct seller credentials (наш случай — `WALMART_CLIENT_ID_STORE1` с My API Key page) **должны** иметь full access по умолчанию. Если в ответе видим `insights: no_access` или `reports: no_access` — это уже сигнал что нужно идти в Developer Portal и активировать.

**Коммит:** `chore(walmart): add scopes diagnostic script` (если делали)

---

## ЭТАП 3: Переписать `seller-performance.ts`

Это главный этап. Полностью заменить файл `src/lib/walmart/seller-performance.ts` на новую реализацию:

```typescript
// src/lib/walmart/seller-performance.ts

import { walmartFetch } from './client';

export type PerformanceWindow = 14 | 30 | 60 | 90;
export type ShippingMethod = 'ALL_METHODS' | 'TwoDay' | 'OneDay';

/**
 * 11 endpoints из Walmart Insights API → Seller Performance.
 * Все vereified либо напрямую через docs, либо inferred from reference IDs.
 * Base URL: https://marketplace.walmartapis.com/v3/insights/performance/{path}/summary
 */
export const PERFORMANCE_METRICS = {
  onTimeDelivery:    { path: 'otd',              window: 30, hasShippingMethod: true,  rateKey: 'overallRate' },
  cancellations:     { path: 'cancellations',    window: 30, hasShippingMethod: false, rateKey: 'cumulativeRate' },
  validTracking:     { path: 'vtr',              window: 30, hasShippingMethod: true,  rateKey: 'cumulativeRate' },
  sellerResponse:    { path: 'srr',              window: 30, hasShippingMethod: false, rateKey: 'overallRate' },
  negativeFeedback:  { path: 'negativeFeedback', window: 60, hasShippingMethod: false, rateKey: 'cumulativeRate' },
  returns:           { path: 'returns',          window: 60, hasShippingMethod: false, rateKey: 'cumulativeRate' },
  itemNotReceived:   { path: 'inr',              window: 60, hasShippingMethod: false, rateKey: 'cumulativeRate' },
  shipFromAccuracy:  { path: 'sfla',             window: 30, hasShippingMethod: false, rateKey: 'overallRate' },
  onTimeShipment:    { path: 'ots',              window: 30, hasShippingMethod: true,  rateKey: 'overallRate' },
  carrierAccuracy:   { path: 'cma',              window: 30, hasShippingMethod: false, rateKey: 'overallRate' },
  // refunds — DEPRECATED, не использовать
} as const;

export type MetricKey = keyof typeof PERFORMANCE_METRICS;

export interface PerformanceMetricResult {
  metric: MetricKey;
  status: 'OK' | 'NO_DATA' | 'ERROR';
  rate?: number;          // 0-100, проценты
  trend?: 'GREEN_UP' | 'GREEN_DOWN' | 'NEUTRAL' | 'RED_UP' | 'RED_DOWN';
  sellerAccountableRate?: number;
  impactedCustomerCount?: number;
  ordersImpacted?: number;
  gmvLoss?: number;
  riskLevel?: string;
  performanceRiskLevel?: string;
  standard?: string;
  reportDuration?: number;
  updatedTimestamp?: string;
  drivers?: any;
  recommendations?: Array<{ recommendation: string; moreInfoLink: string }>;
  errorMessage?: string;  // только если status=ERROR
  httpStatus?: number;    // для debugging
}

export interface WalmartPerformanceData {
  syncedAt: string;
  metrics: Record<MetricKey, PerformanceMetricResult>;
}

/**
 * Главный метод — синхронизирует все 10 метрик параллельно.
 */
export async function fetchAllPerformanceMetrics(): Promise<WalmartPerformanceData> {
  const entries = Object.entries(PERFORMANCE_METRICS) as Array<[MetricKey, typeof PERFORMANCE_METRICS[MetricKey]]>;
  
  const results = await Promise.allSettled(
    entries.map(([key, config]) => fetchSingleMetric(key, config))
  );
  
  const metrics: Record<string, PerformanceMetricResult> = {};
  for (let i = 0; i < entries.length; i++) {
    const [key] = entries[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      metrics[key] = result.value;
    } else {
      metrics[key] = {
        metric: key,
        status: 'ERROR',
        errorMessage: result.reason?.message || 'Unknown error',
      };
    }
  }
  
  return {
    syncedAt: new Date().toISOString(),
    metrics: metrics as Record<MetricKey, PerformanceMetricResult>,
  };
}

async function fetchSingleMetric(
  key: MetricKey,
  config: typeof PERFORMANCE_METRICS[MetricKey]
): Promise<PerformanceMetricResult> {
  const params = new URLSearchParams({ reportDuration: String(config.window) });
  if (config.hasShippingMethod) {
    params.set('shippingMethod', 'ALL_METHODS');
  }
  
  const path = `/v3/insights/performance/${config.path}/summary?${params.toString()}`;
  
  try {
    const { status, body, headers } = await walmartFetch(path, { method: 'GET' });
    
    // Подробное логирование на старте — потом можно убрать
    console.log(`[walmart-perf] ${key} → ${path} → HTTP ${status}`);
    
    if (status === 204) {
      return { metric: key, status: 'NO_DATA', httpStatus: 204 };
    }
    
    if (status !== 200) {
      console.error(`[walmart-perf] ${key} failed: HTTP ${status}`, body);
      return {
        metric: key,
        status: 'ERROR',
        httpStatus: status,
        errorMessage: typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500),
      };
    }
    
    const payload = body.payload ?? body;
    const rate = payload[config.rateKey];
    
    return {
      metric: key,
      status: 'OK',
      rate: typeof rate === 'number' ? rate : undefined,
      trend: payload.overallTrend ?? payload.cumulativeRateTrend,
      sellerAccountableRate: payload.sellerAccountableRate,
      impactedCustomerCount: payload.impactedCustomerCount,
      ordersImpacted: payload.ordersImpacted,
      gmvLoss: payload.gmvLoss,
      riskLevel: payload.riskLevel,
      performanceRiskLevel: payload.performanceRiskLevel,
      standard: payload.standard,
      reportDuration: payload.reportDuration,
      updatedTimestamp: payload.updatedTimestamp,
      drivers: {
        accountable: payload.sellerAccountableDrivers,
        nonAccountable: payload.nonAccountableDrivers,
      },
      recommendations: payload.recommendations,
      httpStatus: 200,
    };
  } catch (err: any) {
    console.error(`[walmart-perf] ${key} exception:`, err);
    return {
      metric: key,
      status: 'ERROR',
      errorMessage: err.message || String(err),
    };
  }
}
```

### Заметки реализации

1. **`walmartFetch` уже существует** в `src/lib/walmart/client.ts` — он добавляет нужные headers (WM_SEC.ACCESS_TOKEN, WM_QOS.CORRELATION_ID, WM_SVC.NAME). Если signature не совпадает (ожидает другие аргументы или возвращает `body` напрямую без `status`) — адаптировать под текущий контракт, но НЕ создавать новый клиент.

2. **`WM_QOS.CORRELATION_ID` должен быть уникальным per request** — это критично для Walmart, если использовать один и тот же UUID для всех 10 параллельных запросов, можем получить дедупликацию. Использовать `crypto.randomUUID()` внутри `walmartFetch` для каждого вызова.

3. **`onTimeShipment` (ots)** в Walmart Seller Center показывается как "Late shipment rate" — это инвертированная метрика. В response придёт `overallRate` = on-time %, чтобы получить "late %" вычислить `100 - overallRate`. Делать это в UI слое, не в data слое.

4. **Окна разные для разных метрик** — например VTR не поддерживает 60 дней. Конфиг в `PERFORMANCE_METRICS` отражает это: на скриншоте Vladimir одни метрики за 30, другие за 60 дней. Можно потом сделать параметризацию.

---

## ЭТАП 4: Обновить sync route

Файл `src/app/api/account-health/walmart/sync/route.ts`:

```typescript
import { fetchAllPerformanceMetrics } from '@/lib/walmart/seller-performance';
import { prisma } from '@/lib/prisma';

export async function POST() {
  try {
    const data = await fetchAllPerformanceMetrics();
    
    // Сохранить snapshot в WalmartPerformanceSnapshot
    await prisma.walmartPerformanceSnapshot.create({
      data: {
        storeId: 1, // Sirius Trading International
        syncedAt: new Date(data.syncedAt),
        rawData: JSON.stringify(data.metrics),
        
        // Денормализованные поля для быстрого querying:
        onTimeDeliveryRate: data.metrics.onTimeDelivery.rate,
        cancellationRate:   data.metrics.cancellations.rate,
        validTrackingRate:  data.metrics.validTracking.rate,
        sellerResponseRate: data.metrics.sellerResponse.rate,
        onTimeShipmentRate: data.metrics.onTimeShipment.rate,
        negativeFeedbackRate: data.metrics.negativeFeedback.rate,
        returnsRate:        data.metrics.returns.rate,
        itemNotReceivedRate: data.metrics.itemNotReceived.rate,
      },
    });
    
    // Evaluate Critical Alerts (см. ALERT_RULES из v1 промпта)
    await evaluateWalmartAlerts(data.metrics);
    
    return Response.json({ ok: true, data });
  } catch (err: any) {
    console.error('[walmart-sync] failed:', err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
```

Если в `prisma/schema.prisma` уже есть `WalmartPerformanceSnapshot` модель — использовать её. Если каких-то полей нет (например `validTrackingRate`) — добавить migration.

---

## ЭТАП 5: Обновить UI компонент

В `src/components/account-health/WalmartHealthTab.tsx`:

### 5.1. Заменить placeholder «Not available» на нормальные метрики

8 карточек по образцу скриншота Vladimir:

```tsx
<MetricCard
  label="On-time delivery"
  value={data.metrics.onTimeDelivery.rate}
  unit="%"
  window="30d"
  threshold="≥ 90%"
  status={data.metrics.onTimeDelivery.performanceRiskLevel}
  trend={data.metrics.onTimeDelivery.trend}
/>
```

Группы:
- **Group 1 (30 days):** On-time delivery, Cancellations, Valid tracking, Seller response, Late shipment (= 100 - onTimeShipmentRate)
- **Group 2 (60 days):** Negative feedback, Returns, Item not received

### 5.2. Обработка статусов

Per-metric отображение:
- `status === 'OK'` → показать карточку с числом и trend
- `status === 'NO_DATA'` (HTTP 204) → карточка с "No data yet" вместо числа. Объяснить: "Walmart не накопил достаточно данных за этот период — обычно нужно 14+ дней активных продаж"
- `status === 'ERROR'` → красная карточка с error message и `httpStatus`. Кнопка "View details" открывает Sheet с raw response

### 5.3. Глобальный статус (карточка вверху)

Заменить "Monitor / Not available" на агрегированную оценку:
- Если все метрики `Good` → "Healthy" (зелёный)
- Если хотя бы одна `Monitor` → "Monitor" (жёлтый)
- Если хотя бы одна `Urgent` или `URGENT REVIEW` → "At Risk" (красный)

### 5.4. Trend индикаторы

Иконка стрелки + цвет в зависимости от `trend`:
- `GREEN_UP` / `GREEN_DOWN` → ↑/↓ зелёные
- `NEUTRAL` → — серая
- `RED_UP` / `RED_DOWN` → ↑/↓ красные

### 5.5. Под каждой карточкой

Маленьким текстом: `Updated: {updatedTimestamp}` (relative format, типа "3 hours ago"). Это покажет насколько свежие данные.

---

## ЭТАП 6: Critical Alerts integration

В `src/lib/account-health/alert-evaluator.ts` (или где у нас сейчас ALERT_RULES) — обновить Walmart правила на использование новых rate fields:

```typescript
// Из v1 промпта ALERT_RULES — теперь все маппятся к новой структуре
const WALMART_RULES = [
  {
    id: 'wm-otd-low',
    metric: 'onTimeDelivery',
    threshold: 90,
    operator: 'below',
    severity: 'HIGH',
    title: 'Walmart On-time delivery dropped below 90%',
    notify: ['telegram', 'ui'],
  },
  {
    id: 'wm-cancel-high',
    metric: 'cancellations',
    threshold: 2,
    operator: 'above',
    severity: 'CRITICAL',
    title: 'Walmart cancellation rate exceeded 2%',
    notify: ['telegram', 'ui'],
  },
  {
    id: 'wm-vtr-low',
    metric: 'validTracking',
    threshold: 99,
    operator: 'below',
    severity: 'HIGH',
    title: 'Walmart valid tracking rate dropped below 99%',
    notify: ['telegram', 'ui'],
  },
  {
    id: 'wm-srr-low',
    metric: 'sellerResponse',
    threshold: 95,
    operator: 'below',
    severity: 'MEDIUM',
    title: 'Walmart seller response rate dropped below 95%',
    notify: ['ui'],
  },
  {
    id: 'wm-late-ship-high',
    metric: 'onTimeShipment',
    threshold: 99,
    operator: 'below',  // если on-time < 99%, late > 1%
    severity: 'HIGH',
    title: 'Walmart on-time shipment dropped below 99%',
    notify: ['telegram', 'ui'],
  },
];
```

Anti-spam: тот же alert не отправлять чаще раз в 24 часа (из v1).

---

## ЭТАП 7: Cron schedule

В `src/app/api/cron/account-health/route.ts` (или где у нас vercel cron / n8n schedule):

Walmart performance sync — **раз в 24 часа** (Walmart обновляет datasets раз в сутки, чаще нет смысла).

Если у нас n8n schedule — описать в `docs/wiki/account-health-v2.md` cron expression: `0 6 * * *` (6:00 UTC = 2:00 EST).

---

## ЭТАП 8: Wiki обновления

### 8.1. Обновить `docs/wiki/walmart-api.md`

Полностью заменить секцию "Seller Performance API" на:

```markdown
## Seller Performance API (Insights category)

**Status:** ✅ Working as of 2026-05-15
**Base URL:** `https://marketplace.walmartapis.com/v3/insights/performance/{metric}/summary`
**Parameters:** `reportDuration={14|30|60|90}`, optional `shippingMethod={ALL_METHODS|TwoDay|OneDay}`

### Metric paths
| Metric | URL segment | Window | Has shippingMethod |
|---|---|---|---|
| On-time delivery | `otd` | 30 | yes |
| Cancellations | `cancellations` | 30 | no |
| Valid tracking | `vtr` | 30 | yes |
| Seller response | `srr` | 30 | no |
| Negative feedback | `negativeFeedback` | 60 | no |
| Returns | `returns` | 60 | no |
| Item not received | `inr` | 60 | no |
| Ship-from accuracy | `sfla` | 30 | no |
| On-time shipment | `ots` | 30 | yes |
| Carrier method | `cma` | 30 | no |

### HTTP statuses
- 200 = data returned
- 204 = no data yet (new account, insufficient orders)
- 404 = wrong URL (should not happen with paths above)
- 429 = rate limit

### Reference
- Sample request: `GET /v3/insights/performance/otd/summary?reportDuration=30&shippingMethod=ALL_METHODS`
- Headers: `WM_SEC.ACCESS_TOKEN`, `WM_QOS.CORRELATION_ID` (unique UUID per request), `WM_SVC.NAME: Walmart Marketplace`, `Accept: application/json`
- Datasets refresh every 24h on Walmart side
- Code: `src/lib/walmart/seller-performance.ts`
```

### 8.2. Обновить `docs/wiki/account-health-v2.md`

В секции Walmart пометить Performance metrics: **✅ Working — v3/insights/performance**.

### 8.3. Обновить `docs/wiki/index.md` и `docs/wiki/CONNECTIONS.md`

Добавить cross-references.

---

## ✅ ПРОВЕРКА ГОТОВНОСТИ

После всех этапов:

1. `npm run build` без ошибок
2. POST `/api/account-health/walmart/sync` — отрабатывает за < 30 секунд, в логах виден HTTP 200 для всех 10 метрик (или 204 для тех где нет данных)
3. `/account-health` → Walmart tab:
   - 8 карточек с реальными процентами
   - Если у Walmart нет данных по метрике — карточка "No data yet" (HTTP 204), не ошибка
   - Trend стрелки работают
   - Updated timestamp у каждой карточки
4. В Telegram приходит alert если порог превышен (например cancellation > 2% или OTD < 90%)
5. `WalmartPerformanceSnapshot` в БД накапливает историю — можно потом строить график

---

## ⛔ Что НЕ делать

- НЕ возвращаться к старым путям `/v3/sellerPerformance/*` или `/v3/insights/*` (общие) — они не существуют
- НЕ использовать параметр `windowDays` (правильное имя — `reportDuration`)
- НЕ использовать `refunds` endpoint — он deprecated
- НЕ заполнять данные mock-значениями. Лучше "no data" чем фейк.
- НЕ трогать Veeqo delegated key
- НЕ использовать один `WM_QOS.CORRELATION_ID` для всех параллельных запросов — каждый должен иметь свой UUID
- НЕ забыть `Promise.allSettled` — одна неудача не должна валить весь sync
- НЕ конвертировать 204 в ошибку — это валидный "no data yet"

---

## 🎯 Финальный результат

UI на `/account-health` → Walmart tab показывает реальные значения 8 метрик из Walmart Seller Center:
- On-time delivery rate
- Late shipment rate (= 100 - on-time shipment)
- Cancellations
- Valid tracking
- Seller response
- Negative feedback (60d)
- Returns (60d)
- Item not received (60d)

С trend стрелками, статусом риска (Good/Monitor/Urgent), и Telegram alerts при breach.

Item Compliance (158 listings что уже работают) **НЕ должен пострадать** — это отдельный endpoint в той же UI.
