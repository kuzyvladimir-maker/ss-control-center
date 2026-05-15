# CLAUDE CODE PROMPT — Account Health v2.0 (Amazon + Walmart) + Critical Alerts

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-05-12
> **Prepared by:** Vladimir (via Claude chat)
> **Branch:** `feature/account-health-v2`
> **Execution mode:** строго поэтапно, коммит после каждого этапа

---

## 🎯 КОНТЕКСТ И ЦЕЛЬ

Текущая страница `/account-health` показывает только базовые метрики Customer Service + Shipping Performance для 2 настроенных Amazon магазинов. Этого недостаточно — мы теряем огромный пласт информации:

1. **Account Health Rating (AHR)** — агрегированный score Amazon 0-1000 (на скрине у Vladimir 196 = At Risk)
2. **Policy Compliance breakdown** — 10+ категорий нарушений (IP, Food Safety, Listing Policy, Restricted Products и т.д.) с drill-down до конкретных листингов
3. **Walmart Performance** — 8 метрик performance + Late Shipment (NEW upcoming) + Carriers/Regional + Item Compliance, сейчас вообще отсутствуют
4. **Critical Alerts engine** — при пересечении критических порогов нужны мгновенные алерты в Telegram + UI push

### ⚠️ Принципы (не нарушать)

- **Дизайн-система Salutem v1.0** — соблюдать `docs/CLAUDE_CODE_PROMPT_DESIGN_SYSTEM.md` (никакого чисто чёрного текста — `--ink: #15201B`; на зелёном фоне только `--green-cream: #F0E8D0`, никогда белый; `tabular-nums` на числах; Inter Tight + JetBrains Mono; радиусы 6/10/14px).
- **shadcn/ui компоненты** — Tabs, Dialog, Sheet, Progress, Badge, Accordion, ScrollArea.
- **camelCase Prisma fields** — всегда. После schema changes: `npx prisma generate` → `npx prisma migrate dev` ДО рестарта dev сервера.
- **Все данные — через API**. Никаких ручных импортов. Amazon → SP-API (роль `Selling Partner Insights` уже зарегистрирована). Walmart → Marketplace API (Client ID и Seller ID есть в `.env`).
- **Walmart API integration частично пересекается с `CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md` Этап 7.5** — НЕ дублировать работу. Если что-то уже сделано там — переиспользовать. Если нет — делаем здесь.
- **Store filter context** — страница реагирует на глобальный `useStoreFilter()` из `src/lib/store-filter/StoreFilterContext` (создан в `feature/dashboard-store-selector`). Если выбраны не все магазины — показывать только выбранные.

---

## 📐 АРХИТЕКТУРА РЕШЕНИЯ

### Структура страницы

```
/account-health
├── Header
│   ├── Title "Account Health"
│   ├── Sync status pill ("Synced 2m ago" / "Syncing…")
│   ├── Meta line: "5 of 5 Amazon + 1 Walmart · SP-API · 4H POLL"
│   └── Actions: [Refresh all] [90-day view] [Action plan]
│
├── TABS (shadcn/ui Tabs)
│   ├── [Amazon] — active by default
│   └── [Walmart]
│
├── === AMAZON TAB ===
│   ├── Hero row (3 KPI cards)
│   │   ├── Overall Health (green hero) — status + summary
│   │   ├── Worst ODR snapshot
│   │   └── LSR / VTR snapshot
│   ├── Account Health Rating section
│   │   └── Per-store: progress bar 0-1000 + AHR value + zone (At Risk Of Deactivation / At Risk / Good)
│   ├── Policy Compliance section
│   │   └── Per-store: 10 categories table, click → drill-down panel with listings
│   ├── Per-store Performance snapshots (grid)
│   │   ├── Customer Service (60d): ODR + breakdown (Negative FB / A-to-Z / CB), separated Seller Fulfilled vs FBA
│   │   └── Shipping Performance: LSR 10d/30d, Cancel 7d, VTR 30d, OTDR 14d — with progress bars + threshold markers
│   └── Alerts band (SP-API Notifications + Gmail listing-compliance)
│
└── === WALMART TAB ===
    ├── Hero row (3 KPI cards)
    │   ├── Walmart Overall Health
    │   ├── Urgent issues card (Late Shipment 24.2% etc.)
    │   └── Item Compliance summary
    ├── Performance Standards (8 metrics, 30d/60d)
    ├── Upcoming Standards (Late Shipment)
    ├── Other Metrics (Carriers / Regional / Ratings)
    └── Health and Compliance (Item compliance drill-down + restricted categories)
```

### Data flow

```
┌──────────────────────────────────────────────────────────────┐
│  CRON (4h Amazon, 24h Walmart)                                │
│         │                                                      │
│         ▼                                                      │
│  sync routes (per-store)                                       │
│     ├── Amazon SP-API:                                         │
│     │      ├── Account Health Rating API → AHR + status        │
│     │      ├── Policy Compliance API     → 10 categories       │
│     │      ├── Listings Issues API        → per-listing details │
│     │      └── Account Health API         → ODR/LSR/VTR/OTDR   │
│     └── Walmart Marketplace API:                               │
│            ├── Seller Performance API     → 8 metrics          │
│            └── Items API (lifecycleStatus) → compliance issues │
│         │                                                      │
│         ▼                                                      │
│  Prisma write (snapshots, violations, alerts)                  │
│         │                                                      │
│         ▼                                                      │
│  Critical Alerts engine:                                       │
│     - Сравнить новые значения с порогами                       │
│     - Если breach → создать CriticalAlert                      │
│     - Если ещё не отправлен → Telegram + UI push notification  │
│         │                                                      │
│         ▼                                                      │
│  UI (live polling каждые 60 сек на странице) → отображает      │
│  актуальные данные                                             │
└──────────────────────────────────────────────────────────────┘
```

---

## ЭТАП 1: Prisma changes

**Файл:** `prisma/schema.prisma`

### 1.1. Расширить `AccountHealthSnapshot`

Добавить новые поля (если ещё нет):

```prisma
model AccountHealthSnapshot {
  // ... существующие поля ...
  
  // ── Account Health Rating (новое) ──────────────
  accountHealthRating       Int?       // 0-1000
  accountHealthRatingStatus String?    // "AT_RISK_OF_DEACTIVATION" | "AT_RISK" | "GOOD"
  
  // ── ODR breakdown по fulfillment типу (новое) ──
  odrSellerFulfilled        Float?
  odrSellerFulfilledOrders  Int?
  odrFulfilledByAmazon      Float?
  odrFulfilledByAmazonOrders Int?
  
  // ── Negative feedback breakdown ────────────────
  negativeFeedbackSF        Float?
  negativeFeedbackFBA       Float?
  
  // ── A-to-Z breakdown ───────────────────────────
  atozClaimsRateSF          Float?
  atozClaimsRateFBA         Float?
  
  // ── Chargebacks breakdown ──────────────────────
  chargebackRateSF          Float?
  chargebackRateFBA         Float?
}
```

### 1.2. Новая модель `PolicyViolationCategory`

```prisma
model PolicyViolationCategory {
  id                String   @id @default(cuid())
  snapshotId        String
  snapshot          AccountHealthSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
  
  category          String   // "SUSPECTED_IP" | "RECEIVED_IP_COMPLAINTS" | "PRODUCT_AUTHENTICITY" | "PRODUCT_CONDITION" | "FOOD_SAFETY" | "LISTING_POLICY" | "RESTRICTED_PRODUCT" | "CUSTOMER_REVIEWS_POLICY" | "OTHER_POLICY" | "REGULATORY_COMPLIANCE"
  displayName       String   // "Suspected Intellectual Property Violations"
  count             Int      @default(0)
  status            String   // "OK" | "WARNING" | "CRITICAL"
  
  details           PolicyViolationDetail[]
  detectedAt        DateTime @default(now())
  
  @@index([snapshotId])
  @@index([category])
}
```

### 1.3. Новая модель `PolicyViolationDetail`

```prisma
model PolicyViolationDetail {
  id                String   @id @default(cuid())
  categoryId        String
  category          PolicyViolationCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  
  asin              String?
  sku               String?
  listingTitle      String?
  violationType     String   // "RESTRICTED_KEYWORD" | "INVALID_IMAGE" | "MISSING_COMPLIANCE_DOC" | etc.
  severity          String   // "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  message           String   // raw text from Amazon
  reportedAt        DateTime
  resolvedAt        DateTime?
  status            String   @default("OPEN")  // "OPEN" | "RESOLVED" | "IN_REVIEW"
  amazonReferenceId String?  // Amazon internal ID если есть
  
  @@index([categoryId])
  @@index([asin])
  @@index([status])
}
```

### 1.4. Новая модель `WalmartPerformanceSnapshot`

```prisma
model WalmartPerformanceSnapshot {
  id                       String   @id @default(cuid())
  storeId                  String   // FK to Store
  store                    Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  
  // ── 8 основных метрик ─────────────────────────
  onTimeDelivery30d        Float?
  cancellations30d         Float?
  validTracking30d         Float?
  sellerResponse30d        Float?
  negativeFeedback60d      Float?
  returns60d               Float?
  itemNotReceived60d       Float?
  
  // ── Upcoming standards ─────────────────────────
  lateShipment30d          Float?   // NEW upcoming, порог 5%
  
  // ── Other metrics ──────────────────────────────
  carriersBelowStandard    Int?     // "2 of 3"
  totalCarriers            Int?
  statesBelowStandard      Int?     // "9 states"
  totalStates              Int?
  ratingsAverage           Float?
  ratingsCount             Int?
  
  // ── Compliance summary ─────────────────────────
  itemComplianceIssuesCount Int     @default(0)
  accountComplianceStatus   String  @default("OK") // "OK" | "ACTION_REQUIRED"
  restrictedCategoriesAvailable Int @default(0)
  
  syncedAt                 DateTime @default(now())
  
  itemCompliance           WalmartItemCompliance[]
  
  @@index([storeId])
  @@index([syncedAt])
}
```

### 1.5. Новая модель `WalmartItemCompliance`

```prisma
model WalmartItemCompliance {
  id                String   @id @default(cuid())
  snapshotId        String
  snapshot          WalmartPerformanceSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
  
  itemId            String   // Walmart Item ID
  sku               String?
  title             String?
  issueType         String   // "TROUBLED_LISTING" | "BLOCKED" | "PUBLISHED_WITH_ERRORS" | "STAGE" | etc.
  issueDetails      String?
  severity          String   // "URGENT" | "MONITOR" | "INFO"
  status            String   @default("OPEN")
  reportedAt        DateTime
  resolvedAt        DateTime?
  
  @@index([snapshotId])
  @@index([itemId])
  @@index([status])
}
```

### 1.6. Новая модель `CriticalAlert`

```prisma
model CriticalAlert {
  id                String   @id @default(cuid())
  storeId           String
  store             Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  
  channel           String   // "Amazon" | "Walmart"
  alertType         String   // "POLICY_VIOLATION" | "PERFORMANCE_METRIC" | "ITEM_COMPLIANCE" | "AHR_DROP" | "ODR_BREACH" | "LSR_BREACH" | etc.
  severity          String   // "CRITICAL" | "HIGH" | "WARNING"
  
  metricName        String   // e.g. "Late Shipment Rate (30d)"
  metricValue       String   // e.g. "24.2%"
  metricThreshold   String   // e.g. "≤ 5%"
  
  title             String   // for Telegram/UI display
  message           String   // for Telegram/UI display
  actionUrl         String?  // deeplink в наш UI
  
  detectedAt        DateTime @default(now())
  
  // Telegram delivery
  telegramSent      Boolean  @default(false)
  telegramSentAt    DateTime?
  telegramMessageId String?
  
  // UI acknowledgment
  acknowledged      Boolean  @default(false)
  acknowledgedAt    DateTime?
  acknowledgedBy    String?
  
  // Resolution
  resolvedAt        DateTime?
  
  @@index([storeId])
  @@index([acknowledged])
  @@index([detectedAt])
  @@index([severity])
}
```

### 1.7. Обновить `Store`

Добавить relation поля:

```prisma
model Store {
  // ... существующие поля ...
  
  walmartPerformanceSnapshots WalmartPerformanceSnapshot[]
  criticalAlerts              CriticalAlert[]
}
```

### 1.8. Применить migration

```bash
npx prisma format
npx prisma generate
npx prisma migrate dev --name account_health_v2
```

**Коммит:** `feat(prisma): add Account Health v2 models (policy violations, Walmart performance, critical alerts)`

---

## ЭТАП 2: SP-API extensions (Amazon)

### 2.1. Account Health Rating API

**Файл:** `src/lib/amazon-sp-api/account-health-rating.ts`

```typescript
import { getAccessToken } from './auth';
import type { Store } from '@prisma/client';

export interface AccountHealthRating {
  rating: number;              // 0-1000
  status: 'AT_RISK_OF_DEACTIVATION' | 'AT_RISK' | 'GOOD';
  lastUpdated: string;
}

/**
 * Возвращает агрегированный Account Health Rating
 * 
 * Точное имя endpoint'а проверить в актуальной документации SP-API:
 * https://developer-docs.amazon.com/sp-api/docs
 * 
 * Альтернатива — Reports API GET_V2_SELLER_PERFORMANCE_REPORT (JSON отчёт содержит AHR)
 */
export async function fetchAccountHealthRating(store: Store): Promise<AccountHealthRating> {
  const token = await getAccessToken(store);
  // ... fetch + parse
  // ВАЖНО: если endpoint не существует или роль не даёт доступ — fallback на Report
}
```

> ⚠️ Точные эндпоинты SP-API для AHR могут отличаться. **Сверить с https://developer-docs.amazon.com/sp-api/docs/selling-partner-insights-api перед реализацией.** Если real-time endpoint недоступен — использовать Reports API `GET_V2_SELLER_PERFORMANCE_REPORT`.

### 2.2. Policy Compliance API

**Файл:** `src/lib/amazon-sp-api/policy-compliance.ts`

```typescript
export interface PolicyComplianceData {
  rating: number;
  status: string;
  categories: {
    category: string;
    displayName: string;
    count: number;
    issues: PolicyIssue[];
  }[];
}

export interface PolicyIssue {
  asin?: string;
  sku?: string;
  title?: string;
  violationType: string;
  severity: string;
  message: string;
  reportedAt: string;
  amazonReferenceId?: string;
}

export async function fetchPolicyCompliance(store: Store): Promise<PolicyComplianceData> {
  // 1. Запросить Report: GET_V2_SELLER_PERFORMANCE_REPORT
  //    или, если доступен — getAccountIssues endpoint
  // 2. Распарсить JSON
  // 3. Сгруппировать по 10 категориям:
  //    - SUSPECTED_IP
  //    - RECEIVED_IP_COMPLAINTS
  //    - PRODUCT_AUTHENTICITY
  //    - PRODUCT_CONDITION
  //    - FOOD_SAFETY              ← критично для Salutem (frozen food)
  //    - LISTING_POLICY
  //    - RESTRICTED_PRODUCT
  //    - CUSTOMER_REVIEWS_POLICY
  //    - OTHER_POLICY
  //    - REGULATORY_COMPLIANCE
  // 4. Для каждой категории — массив issues с деталями (ASIN, SKU, title, severity, message)
}
```

### 2.3. Listings Issues API (для drill-down)

**Файл:** `src/lib/amazon-sp-api/listings-issues.ts`

```typescript
/**
 * GET /listings/2021-08-01/items/{sellerId}/{sku}?issueLocale=en_US
 * Возвращает список issues для конкретного листинга.
 * 
 * Используется для drill-down — клик на категорию в Policy Compliance таблице.
 */
export async function fetchListingIssues(store: Store, sku: string): Promise<PolicyIssue[]> {
  // ...
}
```

### 2.4. Расширить существующий account-health-sync

**Файл:** `src/lib/amazon-sp-api/account-health-sync.ts`

В функцию `syncStoreAccountHealth(storeId)`:

1. После расчёта ODR/LSR/VTR/OTDR — вызвать `fetchAccountHealthRating()` и сохранить в snapshot
2. Вызвать `fetchPolicyCompliance()` и сохранить в `PolicyViolationCategory` + `PolicyViolationDetail`
3. После сохранения — вызвать `evaluateCriticalAlerts(snapshot, prevSnapshot)` (см. Этап 4)

**Коммит:** `feat(amazon): add AHR + Policy Compliance fetching to SP-API client`

---

## ЭТАП 3: Walmart Performance + Items API

> ⚠️ **Проверить:** если `CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md` Этап 7.5 уже реализован — переиспользовать. Если нет — реализовать здесь полноценно.

### 3.1. Walmart Seller Performance API

**Файл:** `src/lib/walmart/seller-performance.ts`

```typescript
import { walmartFetch } from './client';

export interface WalmartPerformance {
  onTimeDelivery: { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  cancellations:  { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  validTracking:  { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  sellerResponse: { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  negativeFeedback: { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  returns:        { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  itemNotReceived:{ value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  lateShipment:   { value: number; status: 'GOOD' | 'MONITOR' | 'URGENT'; standard: string };
  carriers:       { below: number; total: number };
  regions:        { below: number; total: number };
  ratings:        { average: number; count: number };
}

export async function fetchWalmartPerformance(): Promise<WalmartPerformance> {
  // GET https://marketplace.walmartapis.com/v3/insights/performance
  // или /v3/sellerperformance/seller-performance-metrics
  // (уточнить актуальный endpoint в Walmart Developer Portal)
  
  // ВАЖНО: получить и 30-day, и 60-day метрики разными запросами,
  // как показано в скрине (Negative feedback / Returns / Item not received = 60d, остальное = 30d)
}
```

### 3.2. Walmart Items API (compliance)

**Файл:** `src/lib/walmart/items.ts`

```typescript
export interface WalmartItemIssue {
  itemId: string;
  sku?: string;
  title?: string;
  lifecycleStatus: string;
  publishedStatus: string;
  stage: string;
  issueDetails: string;
  severity: 'URGENT' | 'MONITOR' | 'INFO';
}

export async function fetchWalmartItemCompliance(): Promise<WalmartItemIssue[]> {
  // GET /v3/items?lifecycleStatus=TROUBLED или PUBLISHED_WITH_ERRORS
  // (нужно несколько запросов с разными статусами)
  
  // Маппинг lifecycle/publishedStatus → severity:
  // - BLOCKED → URGENT
  // - TROUBLED_LISTING → URGENT
  // - PUBLISHED_WITH_ERRORS → MONITOR
  // - SYSTEM_PROBLEM → MONITOR
}
```

### 3.3. Walmart sync route

**Файл:** `src/app/api/account-health/walmart/sync/route.ts`

```typescript
// POST /api/account-health/walmart/sync
//
// 1. fetchWalmartPerformance()
// 2. fetchWalmartItemCompliance()
// 3. Создать WalmartPerformanceSnapshot
// 4. Создать WalmartItemCompliance records (linked to snapshot)
// 5. evaluateCriticalAlerts() — см. Этап 4
// 6. Return { snapshotId, alerts: [...] }
```

**Коммит:** `feat(walmart): integrate Seller Performance + Items API for Account Health`

---

## ЭТАП 4: Critical Alerts engine

### 4.1. Правила (thresholds)

**Файл:** `src/lib/account-health/alert-rules.ts`

```typescript
export type AlertSeverity = 'CRITICAL' | 'HIGH' | 'WARNING';

export interface AlertRule {
  metric: string;
  channel: 'Amazon' | 'Walmart';
  threshold: { value: number; direction: 'gte' | 'lte' };
  severity: AlertSeverity;
  title: (value: number) => string;
  message: (value: number, storeName: string) => string;
}

export const ALERT_RULES: AlertRule[] = [
  // ─── AMAZON ────────────────────────────────────────────
  {
    metric: 'accountHealthRating',
    channel: 'Amazon',
    threshold: { value: 200, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon AHR dropped to ${v} (At Risk of Deactivation)`,
    message: (v, store) => `Account Health Rating для ${store} = ${v}. Зона риска деактивации (< 200). Срочно проверь Policy Compliance.`,
  },
  {
    metric: 'orderDefectRate',
    channel: 'Amazon',
    threshold: { value: 1.0, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon ODR breached: ${v.toFixed(2)}%`,
    message: (v, store) => `ODR = ${v.toFixed(2)}% превысил порог 1% на магазине ${store}.`,
  },
  {
    metric: 'lateShipmentRate30d',
    channel: 'Amazon',
    threshold: { value: 4.0, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon LSR(30d) breached: ${v.toFixed(2)}%`,
    message: (v, store) => `Late Shipment Rate (30 дней) = ${v.toFixed(2)}% превысил порог 4% на ${store}.`,
  },
  {
    metric: 'preCancelRate',
    channel: 'Amazon',
    threshold: { value: 2.5, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon Cancel Rate breached: ${v.toFixed(2)}%`,
    message: (v, store) => `Pre-fulfillment Cancel Rate = ${v.toFixed(2)}% > 2.5% на ${store}.`,
  },
  {
    metric: 'validTrackingRate',
    channel: 'Amazon',
    threshold: { value: 95.0, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon VTR dropped: ${v.toFixed(2)}%`,
    message: (v, store) => `Valid Tracking Rate = ${v.toFixed(2)}% упал ниже 95% на ${store}.`,
  },
  {
    metric: 'onTimeDeliveryRate',
    channel: 'Amazon',
    threshold: { value: 90.0, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Amazon OTDR dropped: ${v.toFixed(2)}%`,
    message: (v, store) => `On-Time Delivery Rate = ${v.toFixed(2)}% упал ниже 90% на ${store}.`,
  },
  // Policy violations
  {
    metric: 'newPolicyViolation_FOOD_SAFETY',
    channel: 'Amazon',
    threshold: { value: 1, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `New Food Safety violation${v > 1 ? 's' : ''}: ${v}`,
    message: (v, store) => `Обнаружено ${v} новых Food Safety нарушений на ${store}. Критично для frozen food бизнеса.`,
  },
  {
    metric: 'newPolicyViolation_SUSPECTED_IP',
    channel: 'Amazon',
    threshold: { value: 1, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `New IP violation${v > 1 ? 's' : ''}: ${v}`,
    message: (v, store) => `Обнаружено ${v} новых подозрений на IP-нарушения на ${store}.`,
  },
  {
    metric: 'newPolicyViolation_LISTING_POLICY',
    channel: 'Amazon',
    threshold: { value: 1, direction: 'gte' },
    severity: 'HIGH',
    title: (v) => `New Listing Policy violations: ${v}`,
    message: (v, store) => `Обнаружено ${v} новых нарушений Listing Policy на ${store}.`,
  },
  
  // ─── WALMART ───────────────────────────────────────────
  {
    metric: 'lateShipment30d',
    channel: 'Walmart',
    threshold: { value: 5.0, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `Walmart Late Shipment breached: ${v.toFixed(1)}%`,
    message: (v, store) => `Walmart Late Shipment Rate = ${v.toFixed(1)}% превысил порог 5% (Urgent).`,
  },
  {
    metric: 'cancellations30d',
    channel: 'Walmart',
    threshold: { value: 2.0, direction: 'gte' },
    severity: 'CRITICAL',
    title: (v) => `Walmart Cancellations breached: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Cancellations = ${v.toFixed(2)}% > 2%.`,
  },
  {
    metric: 'validTracking30d',
    channel: 'Walmart',
    threshold: { value: 99.0, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Walmart Valid Tracking dropped: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Valid Tracking = ${v.toFixed(2)}% упал ниже 99%.`,
  },
  {
    metric: 'onTimeDelivery30d',
    channel: 'Walmart',
    threshold: { value: 90.0, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Walmart On-Time Delivery dropped: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart On-Time Delivery = ${v.toFixed(2)}% упал ниже 90%.`,
  },
  {
    metric: 'sellerResponse30d',
    channel: 'Walmart',
    threshold: { value: 95.0, direction: 'lte' },
    severity: 'CRITICAL',
    title: (v) => `Walmart Seller Response dropped: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Seller Response = ${v.toFixed(2)}% упал ниже 95%.`,
  },
  {
    metric: 'negativeFeedback60d',
    channel: 'Walmart',
    threshold: { value: 2.0, direction: 'gte' },
    severity: 'HIGH',
    title: (v) => `Walmart Negative Feedback elevated: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Negative Feedback = ${v.toFixed(2)}% > 2%.`,
  },
  {
    metric: 'returns60d',
    channel: 'Walmart',
    threshold: { value: 6.0, direction: 'gte' },
    severity: 'HIGH',
    title: (v) => `Walmart Returns elevated: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Returns = ${v.toFixed(2)}% > 6%.`,
  },
  {
    metric: 'itemNotReceived60d',
    channel: 'Walmart',
    threshold: { value: 2.0, direction: 'gte' },
    severity: 'HIGH',
    title: (v) => `Walmart Item Not Received elevated: ${v.toFixed(2)}%`,
    message: (v, store) => `Walmart Item Not Received = ${v.toFixed(2)}% > 2%.`,
  },
  {
    metric: 'newItemCompliance',
    channel: 'Walmart',
    threshold: { value: 1, direction: 'gte' },
    severity: 'HIGH',
    title: (v) => `New Walmart Item Compliance issues: ${v}`,
    message: (v, store) => `Обнаружено ${v} новых проблем с item compliance на Walmart.`,
  },
];
```

### 4.2. Evaluator

**Файл:** `src/lib/account-health/critical-alert-evaluator.ts`

```typescript
import { prisma } from '@/lib/prisma';
import { ALERT_RULES } from './alert-rules';
import { sendTelegramAlert } from '@/lib/telegram';

interface SnapshotComparison {
  current: any;
  previous: any | null;
  storeId: string;
  storeName: string;
  channel: 'Amazon' | 'Walmart';
}

export async function evaluateCriticalAlerts(comparison: SnapshotComparison): Promise<void> {
  const { current, storeId, storeName, channel } = comparison;
  const newAlerts = [];
  
  for (const rule of ALERT_RULES.filter(r => r.channel === channel)) {
    const value = current[rule.metric];
    if (value == null) continue;
    
    const breached = rule.threshold.direction === 'gte' 
      ? value >= rule.threshold.value
      : value <= rule.threshold.value;
    
    if (!breached) continue;
    
    // Не дублировать: если за последние 24ч уже был такой же — пропустить
    const recent = await prisma.criticalAlert.findFirst({
      where: {
        storeId,
        alertType: rule.metric,
        detectedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        resolvedAt: null,
      },
    });
    if (recent) continue;
    
    const alert = await prisma.criticalAlert.create({
      data: {
        storeId,
        channel: rule.channel,
        alertType: rule.metric,
        severity: rule.severity,
        metricName: rule.metric,
        metricValue: typeof value === 'number' ? value.toFixed(2) : String(value),
        metricThreshold: `${rule.threshold.direction === 'gte' ? '>' : '<'}= ${rule.threshold.value}`,
        title: rule.title(value),
        message: rule.message(value, storeName),
        actionUrl: `/account-health?tab=${channel.toLowerCase()}&store=${storeId}`,
      },
    });
    newAlerts.push(alert);
  }
  
  // Отправить в Telegram сразу
  for (const alert of newAlerts) {
    if (alert.severity === 'CRITICAL' || alert.severity === 'HIGH') {
      try {
        const telegramMessage = formatTelegramAlert(alert);
        const result = await sendTelegramAlert(telegramMessage);
        await prisma.criticalAlert.update({
          where: { id: alert.id },
          data: {
            telegramSent: true,
            telegramSentAt: new Date(),
            telegramMessageId: result.messageId,
          },
        });
      } catch (e) {
        console.error('Telegram alert failed:', e);
      }
    }
  }
}

function formatTelegramAlert(alert: any): string {
  const emoji = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'HIGH' ? '⚠️' : 'ℹ️';
  return `${emoji} *${alert.title}*\n\n${alert.message}\n\n📊 ${alert.metricName}: ${alert.metricValue} (порог: ${alert.metricThreshold})\n\n🔗 ${process.env.NEXT_PUBLIC_APP_URL}${alert.actionUrl}`;
}
```

### 4.3. Telegram client

**Файл:** `src/lib/telegram.ts` (расширить существующий)

```typescript
interface TelegramSendResult {
  messageId: string;
  ok: boolean;
}

export async function sendTelegramAlert(text: string): Promise<TelegramSendResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  
  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID not set');
  }
  
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    }),
  });
  
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram error: ${data.description}`);
  
  return { messageId: String(data.result.message_id), ok: true };
}
```

### 4.4. UI Push notifications

**Файл:** `src/components/critical-alerts/CriticalAlertsBell.tsx`

В топбар добавить иконку колокольчика с бейджем:
- Если есть unacknowledged critical alerts — показать число + красный дот
- Click → popover со списком последних 10 алертов
- Каждый алерт можно "Mark as acknowledged" (POST `/api/alerts/{id}/acknowledge`)

Polling: каждые 30 секунд `GET /api/alerts/unacknowledged`.

**Файл:** `src/components/critical-alerts/CriticalAlertToast.tsx`

При появлении нового алерта (через polling) — показать toast (`sonner`) с severity emoji + title + кнопкой "View" → переход на actionUrl.

**Коммит:** `feat(alerts): add Critical Alerts engine with Telegram + UI push`

---

## ЭТАП 5: API routes

### 5.1. Amazon sync

```
POST /api/account-health/amazon/sync
Body: { storeIds?: string[] }   // если не указано — все Amazon stores
Response: { results: [{ storeId, success, snapshotId, alertsCreated, error? }] }
```

### 5.2. Walmart sync

```
POST /api/account-health/walmart/sync
Response: { snapshotId, alertsCreated }
```

### 5.3. Получить состояние

```
GET /api/account-health/amazon?storeIds=...
Response: {
  stores: [{
    storeId, storeName, sellerId, configured, status,
    snapshot: {
      accountHealthRating, accountHealthRatingStatus,
      odrSF, odrFBA, negativeFB, atoz, chargebacks,
      lsr10d, lsr30d, cancelRate, vtr, otdr,
      raw numerators/denominators
    },
    policyCategories: [{ category, displayName, count, status }],
    lastSyncedAt
  }],
  summary: { worstAhr, worstAhrStore, ... }
}

GET /api/account-health/walmart
Response: {
  configured, status,
  snapshot: { 8 metrics + lateShipment + carriers + regions + ratings },
  itemCompliance: { totalIssues, urgent, monitor, items: [...] },
  lastSyncedAt
}
```

### 5.4. Drill-down

```
GET /api/account-health/amazon/violations/:storeId/:category
Response: { details: [{ asin, sku, title, violationType, severity, message, reportedAt, status }] }

GET /api/account-health/walmart/item-compliance
Response: { items: [{ itemId, sku, title, issueType, severity, status, reportedAt }] }
```

### 5.5. Critical Alerts

```
GET  /api/alerts/unacknowledged                    Response: { alerts: [...] }
GET  /api/alerts?storeId=&channel=&severity=       Response: { alerts: [...], total }
POST /api/alerts/:id/acknowledge                   Response: { acknowledgedAt }
POST /api/alerts/:id/resolve                       Response: { resolvedAt }
```

**Коммит:** `feat(api): add Account Health v2 routes + drill-down + alerts`

---

## ЭТАП 6: UI redesign

### 6.1. Главная страница

**Файл:** `src/app/account-health/page.tsx`

```tsx
"use client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useStoreFilter } from "@/lib/store-filter/StoreFilterContext";
import { AmazonHealthTab } from "@/components/account-health/AmazonHealthTab";
import { WalmartHealthTab } from "@/components/account-health/WalmartHealthTab";
import { HealthHeader } from "@/components/account-health/HealthHeader";

export default function AccountHealthPage() {
  const { selectedStoreIds, hasAmazon, hasWalmart } = useStoreFilter();
  
  return (
    <div className="space-y-6">
      <HealthHeader />
      
      <Tabs defaultValue={hasAmazon ? "amazon" : "walmart"} className="w-full">
        <TabsList>
          {hasAmazon && <TabsTrigger value="amazon">Amazon</TabsTrigger>}
          {hasWalmart && <TabsTrigger value="walmart">Walmart</TabsTrigger>}
        </TabsList>
        
        {hasAmazon && (
          <TabsContent value="amazon">
            <AmazonHealthTab storeIds={selectedStoreIds} />
          </TabsContent>
        )}
        
        {hasWalmart && (
          <TabsContent value="walmart">
            <WalmartHealthTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
```

### 6.2. AmazonHealthTab

**Структура:**

```tsx
<>
  <HeroRow>
    <OverallHealthCard data={summary} />
    <WorstOdrSnapshotCard data={summary} />
    <LsrVtrSnapshotCard data={summary} />
  </HeroRow>
  
  <AccountHealthRatingSection stores={stores} />
  
  <PolicyComplianceSection stores={stores} onDrillDown={(storeId, category) => setDrillDown({ storeId, category })} />
  
  <PerStorePerformanceGrid stores={stores} />
  
  <AlertsBand alerts={alerts} />
  
  {drillDown && (
    <Sheet open onOpenChange={() => setDrillDown(null)}>
      <SheetContent side="right" className="w-[600px]">
        <PolicyViolationDrillDown {...drillDown} />
      </SheetContent>
    </Sheet>
  )}
</>
```

#### 6.2.1. OverallHealthCard

Зелёный hero (`--green: #2C4A3E`, `--green-cream: #F0E8D0`):

```
┌─────────────────────────────────────┐
│ OVERALL HEALTH                       │
│                                      │
│ Critical / At Risk / Healthy         │  ← 32px Inter Tight, --green-cream
│                                      │
│ 2 stores breaching policy —          │
│ immediate action.                    │
│                                      │
│ ──────────────                       │
│ STORES AT RISK    HEALTHY STORES     │
│ 2 of 5            0                  │
│ 0 warn · 2 crit   all under limit    │
└─────────────────────────────────────┘
```

#### 6.2.2. WorstOdrSnapshotCard

```
┌─────────────────────────────┐
│ WORST ODR                    │
│                              │
│ 0.00%       ← 30px tabular   │
│ Store 1 (Salutem)            │
│                              │
│ Target < 1%                  │
│ ████░░░░░░ 0% / limit 1%     │
└─────────────────────────────┘
```

#### 6.2.3. LsrVtrSnapshotCard

```
┌─────────────────────────────┐
│ SHIPPING SNAPSHOT            │
│                              │
│ LSR 30d   21.48% ❌          │
│ VTR 30d   100%   ✅          │
│ OTDR 14d  51.61% ❌          │
│                              │
│ Worst: Store 1               │
└─────────────────────────────┘
```

#### 6.2.4. AccountHealthRatingSection

Для каждого магазина:

```
Store 1 — Salutem Solutions
AHR: 196 / 1000   ⚠️ At Risk
[████░░░░░░░░░░░░░░░░░░░░░░░░░░] 196
└─0───200───400───600───800───1000─┘
     At Risk    Good           
```

3 зоны:
- 0-200 — `--danger-tint` (At Risk Of Deactivation)
- 200-400 — `--warn-tint` (At Risk)
- 400-1000 — `--green-soft` (Good)

#### 6.2.5. PolicyComplianceSection

Таблица:

```
                      Store 1   Store 2   Store 3-5
Suspected IP           5 ⚠️      0         —
IP Complaints          0         0         —
Product Authenticity   0         0         —
Product Condition      0         0         —
Food Safety            4 ⚠️      0         —
Listing Policy         4 ⚠️      0         —
Restricted Products    0         0         —
Customer Reviews       0         0         —
Other Policy           3 ⚠️      0         —
Regulatory             0         0         —
```

Клик на ячейку с count > 0 → открыть drill-down Sheet с деталями.

#### 6.2.6. PerStorePerformanceGrid

```
┌─────────────────────────────────────────────────────────────┐
│ 🏪 Store 1 · Amazon.com                       ❌ CRITICAL    │
│ Salutem Solutions                                            │
│                                                              │
│ CUSTOMER SERVICE (60 days)                                   │
│                            SELLER FULFILLED   FBA            │
│ Order Defect Rate          0%            0%                  │
│   Negative Feedback        0%            0%                  │
│   A-to-Z Claims            0%            0%                  │
│   Chargebacks              0%            0%                  │
│                                                              │
│ SHIPPING PERFORMANCE                                         │
│ Late Shipment (10d)  16.97% ████████░░ ⚠ over <4%  (28/165) │
│ Late Shipment (30d)  21.48% █████████░ ⚠ over <4%  (110/512)│
│ Cancel Rate (7d)     4.96%  █████░░░░░ ⚠ over <2.5%(6/121)  │
│ Valid Tracking (30d) 100%   ██████████ ✅      >95%(487/487)│
│ On-Time Deliv (14d)  51.61% █████░░░░░ ⚠ over <90%(96/186)  │
│                                                              │
│ 4 issues · synced 12 min ago                  [🔄 Sync]      │
└─────────────────────────────────────────────────────────────┘
```

**Полоски-индикаторы:**
- Background — `--silver-tint`
- Fill — зависит от статуса (green/warn/danger)
- Маркер порога — вертикальная линия `--ink` с подписью
- Для "lower better" (LSR, ODR) — заполнение слева направо
- Для "higher better" (VTR, OTDR) — заполнение справа налево
- Использовать shadcn/ui `<Progress>` с custom CSS

#### 6.2.7. AlertsBand

Полоса под per-store grid:

```
┌─────────────────────────────────────────────────────────────┐
│ 📨 Listing compliance · Store 1 · 4 listings need attention  │
│ 📦 Listing closed · Store 2 · ASIN B08XYZ123                 │
│ ⚠️  Business update · Marketplace policy change · 2026-05-10 │
└─────────────────────────────────────────────────────────────┘
```

Источники: SP-API Notifications API + Gmail `listingIssues` query из `gmail-queries.ts`. Если ещё нет — заглушка с пометкой "Pending Gmail listing alerts integration".

### 6.3. WalmartHealthTab

```tsx
<>
  <HeroRow>
    <WalmartOverallHealthCard />
    <WalmartUrgentIssuesCard />  {/* подсвечивает Late Shipment 24.2% */}
    <WalmartItemComplianceCard />
  </HeroRow>
  
  <PerformanceStandardsGrid metrics={performance} />
  <UpcomingStandardsSection metric={lateShipment} />
  <OtherMetricsRow carriers regions ratings />
  <ItemComplianceTable items={complianceIssues} />
</>
```

#### PerformanceStandardsGrid

Grid 4x2 — 8 карточек:

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ On-time      │ │ Cancellations│ │ Valid track  │ │ Seller resp  │
│ delivery     │ │              │ │              │ │              │
│ 94.5% ✅     │ │ 2.1% ⚠ Mon   │ │ 97.9% ⚠ Mon  │ │ 97.5% ✅     │
│ ≥ 90%        │ │ ≤ 2%         │ │ ≥ 99%        │ │ ≥ 95%        │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Neg feedback │ │ Returns      │ │ Item not rcv │ │              │
│ (60d) 0.9% ✅│ │ (60d) 1.7% ✅│ │ (60d) 0.9% ✅│ │              │
│ ≤ 2%         │ │ ≤ 6%         │ │ ≤ 2%         │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

#### UpcomingStandardsSection

```
┌───────────────────────────────────────────────────┐
│ 🆕 UPCOMING STANDARD — LATE SHIPMENT               │
│                                                    │
│ 24.2%   🔴 URGENT                                  │
│                                                    │
│ Target ≤ 5% · превышение в 5 раз                   │
│ ██████████████████████░░░░░░░░ 24.2 / max 30      │
│                                                    │
│ This metric will become enforced standard soon.    │
│ [View details]                                     │
└───────────────────────────────────────────────────┘
```

#### OtherMetricsRow

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CARRIERS         │ │ REGIONS          │ │ RATINGS          │
│ 2 of 3           │ │ 9 states         │ │ 3.27 ★           │
│ below standard   │ │ below standard   │ │ Average all-time │
│ [View details]   │ │ [View details]   │ │                  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

#### ItemComplianceTable

```
ITEM COMPLIANCE                            Multiple items need attention

Item ID         SKU         Title              Issue Type         Severity   Action
WM-12345        SS-FROZEN-1 Frozen pack 16oz   PUBLISHED_W_ERRORS Monitor    [View]
WM-12346        SS-FROZEN-2 Frozen pack 32oz   TROUBLED_LISTING   Urgent     [Take action]
```

Клик → modal с деталями + ссылка на Walmart Seller Center.

**Коммит:** `feat(ui): redesign Account Health page with Amazon/Walmart tabs and drill-down`

---

## ЭТАП 7: Cron / Polling

### 7.1. Amazon cron — каждые 4 часа

**Файл:** `src/app/api/cron/account-health-amazon/route.ts`

```typescript
export async function GET(req: Request) {
  // Verify CRON_SECRET
  // For each Amazon Store: POST /api/account-health/amazon/sync internally
  // Log results
}
```

`vercel.json`:
```json
{ "crons": [{ "path": "/api/cron/account-health-amazon", "schedule": "0 */4 * * *" }] }
```

### 7.2. Walmart cron — каждые 24 часа

```json
{ "path": "/api/cron/account-health-walmart", "schedule": "0 3 * * *" }
```

### 7.3. UI polling

В `AmazonHealthTab` и `WalmartHealthTab` — SWR с `refreshInterval: 60_000`.
В `CriticalAlertsBell` — SWR с `refreshInterval: 30_000` для unacknowledged alerts.

**Коммит:** `feat(cron): add Amazon (4h) + Walmart (24h) Account Health polling`

---

## ЭТАП 8: Wiki + документация

### 8.1. Обновить `docs/wiki/account-health.md`

Добавить секции:
- v2.0 changes overview
- Policy Compliance categories list
- Walmart performance metrics + thresholds
- Critical Alerts rules table
- API endpoints reference

### 8.2. Создать `docs/wiki/critical-alerts.md`

Документация Critical Alerts engine:
- Список всех правил
- Логика evaluation
- Telegram integration
- UI push notifications

### 8.3. Обновить `docs/wiki/CONNECTIONS.md`

Добавить связи:
```
Account Health v2.0 ⇔ Telegram (для алертов)
Account Health v2.0 ← SP-API Selling Partner Insights role
Account Health v2.0 ← Walmart Seller Performance API
Account Health v2.0 ← Walmart Items API
Account Health v2.0 → Dashboard (показывает счётчик алертов)
Critical Alerts ⊂ Account Health v2.0
PolicyViolationDetail ⊂ PolicyViolationCategory ⊂ AccountHealthSnapshot
WalmartItemCompliance ⊂ WalmartPerformanceSnapshot
```

### 8.4. Обновить `docs/wiki/index.md`

Добавить ссылку на новую `critical-alerts.md`.

### 8.5. Обновить `docs/CLAUDE.md`

В разделе "БАЗА ДАННЫХ" добавить новые модели:
- PolicyViolationCategory
- PolicyViolationDetail
- WalmartPerformanceSnapshot
- WalmartItemCompliance
- CriticalAlert

**Коммит:** `docs(wiki): document Account Health v2 + Critical Alerts`

---

## ✅ ПРОВЕРКА ГОТОВНОСТИ

После всех этапов:

1. `npm run build` без ошибок
2. `npx prisma generate && npx prisma migrate dev` без ошибок
3. Open `/account-health` → видны 2 таба Amazon | Walmart
4. Amazon tab:
   - Hero row с 3 KPI cards (Overall / Worst ODR / LSR-VTR)
   - AHR прогресс-бар для каждого магазина
   - Policy Compliance таблица с 10 категориями
   - Per-store performance cards с полосками-индикаторами
   - Клик на цифру нарушений → открывается Sheet с деталями
5. Walmart tab:
   - 8 метрик performance в grid
   - Late Shipment urgent карточка
   - Carriers / Regions / Ratings
   - Item Compliance таблица
6. Topbar: иконка колокольчика с числом unacknowledged alerts
7. POST `/api/account-health/amazon/sync` — синхронизирует и создаёт alerts
8. POST `/api/account-health/walmart/sync` — синхронизирует и создаёт alerts
9. Telegram бот получает алерт при создании CRITICAL/HIGH alert
10. Cron-эндпоинты работают и доступны

**Только когда ВСЕ 10 пунктов пройдены** — делать merge в `main` и сказать Vladimir.

---

## 📁 Файлы для чтения перед началом

- `docs/CLAUDE.md` — общая структура проекта
- `docs/CLAUDE_CODE_PROMPT_DESIGN_SYSTEM.md` — design rules
- `docs/CLAUDE_CODE_PROMPT_WALMART_API_INTEGRATION.md` — особенно Этап 7.5
- `docs/CLAUDE_CODE_PROMPT_DASHBOARD_STORE_SELECTOR.md` — context для useStoreFilter
- `docs/AMAZON_NOTIFICATIONS_MAP.md` — для AlertsBand источников
- `prisma/schema.prisma` — текущая схема

## ⛔ Что НЕ делать

- НЕ дублировать Walmart integration если она уже частично сделана (Этап 7.5 промпта Walmart)
- НЕ ломать существующий sync ODR/LSR/VTR — только расширять
- НЕ убирать Store 3-5 "NOT SET UP" cards — они показывают что нужно для подключения
- НЕ хардкодить пороги в UI — все берутся из `alert-rules.ts`
- НЕ слать в Telegram алерты severity = WARNING — только CRITICAL и HIGH
- НЕ слать повторные алерты за тот же metric в течение 24 часов
- НЕ забывать `npx prisma generate` после schema changes
