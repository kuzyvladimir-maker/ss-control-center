# Account Health v2.0

Расширенная версия модуля Account Health, охватывающая Amazon + Walmart + Critical Alerts engine.

⇔ `design/account_health_salutem.html` ⇔ `docs/CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md`

---

## Структура

Страница `/account-health` теперь состоит из **2 табов**:

### Amazon tab
- **Hero row (3 KPI cards):** Overall Health · Worst ODR · LSR/VTR snapshot
- **Account Health Rating section** — прогресс-бар 0-1000 для каждого магазина, зоны:
  - 0-200 At Risk Of Deactivation (красный)
  - 200-400 At Risk (жёлтый)
  - 400-1000 Good (зелёный)
- **Policy Compliance section** — таблица 10 категорий нарушений с drill-down до конкретных листингов:
  - Suspected IP, IP Complaints, Product Authenticity, Product Condition
  - **Food Safety** (критично для frozen food)
  - Listing Policy, Restricted Products, Customer Reviews, Other Policy, Regulatory Compliance
- **Per-store Performance grid** — Customer Service (60d) с разделением Seller Fulfilled vs FBA, Shipping Performance с полосками-индикаторами и маркерами порогов
- **Alerts band** — SP-API Notifications + Gmail listing-compliance алерты

### Walmart tab
- **Hero row:** Walmart Overall · Listings needing review · Performance metrics state (live / no-data-yet)
- **Performance — 30-day window** — 5 карточек:
  - On-time delivery (≥ 90%)
  - Cancellations (≤ 2%)
  - Valid tracking (≥ 99%)
  - Seller response (≥ 95%)
  - Late shipment (≤ 1%) — derived as `100 − onTimeShipment.overallRate` (Walmart API returns on-time; UI shows the inverse)
- **Performance — 60-day window** — 3 карточки:
  - Negative feedback (≤ 2%)
  - Returns (≤ 6%)
  - Item not received (≤ 2%)
- Каждая карточка: значение + trend-стрелка (Walmart `GREEN_UP/DOWN`, `RED_UP/DOWN`, `NEUTRAL`; для late shipment цвет инвертирован), Walmart-овая риск-метка (`Good/Monitor/Urgent`), updated-timestamp relative
- **NO_DATA state** — 204 от Walmart → карточка "No data yet" с пояснением "Walmart hasn't accumulated enough orders for this window"
- **ERROR state** — 4xx/5xx → красная карточка с HTTP-кодом + Walmart error body
- **Item Compliance table** — drill-down по проблемным листингам (отдельный endpoint, `/v3/items`)

---

## Источники данных

### Amazon
| Что | SP-API endpoint | Роль |
|---|---|---|
| Account Health Rating (AHR 0-1000) | Selling Partner Insights API → `getAccountHealthRating` или Report `GET_V2_SELLER_PERFORMANCE_REPORT` | Selling Partner Insights ✅ |
| Policy Compliance breakdown | Reports API `GET_V2_SELLER_PERFORMANCE_REPORT` | Selling Partner Insights ✅ |
| Per-listing issues | `GET /listings/2021-08-01/items/{sellerId}/{sku}?issueLocale=en_US` | Product Listing ✅ |
| ODR / LSR / VTR / OTDR | Account Health API | Selling Partner Insights ✅ |

### Walmart
| Что | Walmart endpoint | Статус |
|---|---|---|
| 10 performance метрик (показываем 8) | `GET /v3/insights/performance/{metric}/summary?reportDuration={N}` — paths: `otd`, `cancellations`, `vtr`, `srr`, `ots`, `negativeFeedback`, `returns`, `inr`, `sfla`, `cma` | ✅ Live (v2 — 2026-05-15) |
| Item Compliance | `GET /v3/items?lifecycleStatus=TROUBLED` / `PUBLISHED_WITH_ERRORS` | ✅ Live |

---

## Polling

| Источник | Частота |
|---|---|
| Amazon SP-API | каждые 4 часа |
| Walmart Marketplace API | каждые 24 часа |
| UI auto-refresh | 60 сек |
| Critical Alerts polling (топбар) | 30 сек |

---

## Связи

- ⇔ [Critical Alerts](critical-alerts.md)
- ⇔ [Dashboard](dashboard.md) (показывает счётчик алертов)
- ← [Amazon SP-API](amazon-sp-api.md)
- ← [Walmart API](walmart-api.md)
- ← [Telegram Notifications](telegram-notifications.md)
- ⊂ [Database Schema](database-schema.md) — модели `PolicyViolationCategory`, `PolicyViolationDetail`, `WalmartPerformanceSnapshot`, `WalmartItemCompliance`

---

## Implementation status (2026-05-12)

Backend и UI собраны и в проде. Текущее состояние по компонентам:

| Компонент | Статус |
|---|---|
| Prisma модели (`PolicyViolationCategory/Detail`, `WalmartItemCompliance`, `CriticalAlert`; AccountHealthSnapshot v2 fields) | ✅ Live (Turso prod мигрирован) |
| `/account-health` UI: тэбы Amazon/Walmart, hero KPI, Policy матрица, drill-down Sheet | ✅ Live |
| `CriticalAlertsBell` в Header, polling 30s | ✅ Live |
| API: `/api/account-health/{amazon,walmart}` + `/sync` + `/violations/.../...` + `/api/alerts/*` | ✅ Live |
| Critical Alerts engine + Telegram client | ✅ Live (fallback на `TELEGRAM_CHAT_ID` пока нет `TELEGRAM_ALERT_CHAT_ID`) |
| Cron: `/api/cron/account-health-amazon` (4h), `/api/cron/account-health-walmart` (24h) | ✅ Зарегистрированы в `vercel.json` |
| Walmart Items API + per-metric snapshot + alerts | ✅ Live |
| Walmart Seller Performance v2 (Insights API, 10 endpoints) | ✅ Live (2026-05-15) — `/v3/insights/performance/{metric}/summary`. Late shipment derived in UI from on-time-shipment. См. [walmart-api.md](walmart-api.md) §Seller Performance |
| Amazon AHR (real-time endpoint) | ⏳ Stub — возвращает `null` пока не одобрена роль SP-API "Selling Partner Insights" |
| Amazon Policy Compliance (real categories с count > 0 и drill-down details) | ⏳ Stub — 10 категорий рендерятся с count = 0, реальный путь готов (`fetchPolicyComplianceLive`), включается флагом `USE_LIVE` |
| Существующий ODR / LSR / VTR / OTDR sync | ✅ Live (не трогали — расширили существующий `account-health-sync.ts`) |

Когда роль SP-API будет одобрена: 1) flip `USE_LIVE = true` в `policy-compliance.ts`, 2) проверить shape ответа AHR endpoint в `account-health-rating.ts` (либо включить `USE_REPORTS_FALLBACK`). Никаких UI или БД изменений не требуется — данные просто начнут приходить.

---

Последнее обновление: 2026-05-15 — Walmart Seller Performance переехал на v2 Insights API (10 endpoints, support для 204 = "No data yet", late shipment вычисляется в UI). Промпт — `docs/CLAUDE_CODE_PROMPT_WALMART_PERFORMANCE_FIX.md`.
