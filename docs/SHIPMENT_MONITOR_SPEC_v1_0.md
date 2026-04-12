# 📦 Shipment Monitor — Salutem Solutions Control Center
## Version 1.0 — 2026-04-11
## Спецификация модуля (для реализации после Phase 1)

---

## 🎯 ЗАДАЧА МОДУЛЯ

Автоматически отслеживать все отправки, выявлять проблемные доставки и подготавливать данные для подачи претензий (claims) перевозчикам.

**Бизнес-цель:** Снижение потерь от потерянных/задержанных посылок через систематический мониторинг и подготовку claims.

---

## 🏗️ АРХИТЕКТУРА

### Место в проекте

```
Sidebar: 📦 Shipment Monitor  (между Shipping Labels и Customer Service)
Путь:    /shipment-monitor
API:     /api/shipment-monitor/*
External:/api/external/shipment-monitor/*
```

### Двухуровневая стратегия данных

**Уровень 1 (MVP) — Veeqo Tracking Events**
- Endpoint: `GET /shipments/{shipment_id}/tracking_events`
- Данные: timestamp, description, status, location
- Статусы: awaiting_collection, in_transit, out_for_delivery, delivered
- Ограничение: работает только для labels, купленных через Veeqo
- Стоимость: бесплатно, уже есть API ключ

**Уровень 2 (после MVP) — Carrier API**
- UPS Tracking API, FedEx Track API, USPS Web Tools
- Детальные exception reasons, точные timestamps, GPS-координаты
- Подключать только когда MVP покажет, что данных Veeqo недостаточно

### Связь с другими модулями

```
Shipping Labels (существующий)
  └── shipping_labels таблица → tracking_number, carrier, service, ship_date, promised_edd
        └── Shipment Monitor берёт эти данные как стартовую точку

Frozen Analytics (FROZEN_ANALYTICS_v1_0.md)
  └── Когда CS фиксирует thawed complaint → Shipment Monitor предоставляет delivery timeline
  
Customer Service (существующий)
  └── CS кейсы с категорией "delivery issue" → автоматически линкуются к shipment issues
```

---

## 📊 ИСТОЧНИКИ ДАННЫХ

### Из Veeqo API (основной)

```typescript
// 1. Заказы — уже используется в проекте (src/lib/veeqo.ts)
GET /orders?status=shipped&page_size=100&page={n}

// Из каждого order берём:
// - order.id, order.number
// - order.channel.name (Amazon/Walmart/Shopify/etc)
// - order.deliver_by (= Ship By из Veeqo, конвертировать UTC-7!)
// - order.due_date (= Deliver By дедлайн)
// - order.allocations[].shipment (shipment данные)

// 2. Tracking Events — НОВЫЙ endpoint
GET /shipments/{shipment_id}/tracking_events

// Response:
[
  {
    "timestamp": "2024-12-26T15:57:20+00:00",
    "description": "Awaiting collection",
    "detail": null,
    "location": null,
    "status": "awaiting_collection"
  },
  {
    "timestamp": "2024-12-27T00:37:00+00:00",
    "description": "In transit",
    "detail": null,
    "location": "Doraville, GA, US",
    "status": "in_transit"
  },
  // ...
]
```

### Из внутренней БД (shipping_labels таблица)

Если Shipping Labels модуль уже реализован, в БД есть:
- tracking_number
- carrier (UPS / FedEx / USPS)
- service (Ground, 2nd Day Air, etc.)
- ship_date
- promised_edd
- label_cost
- carrier_badge (Claims Protected, etc.)

### Из Carrier API (Уровень 2, позже)

```typescript
// UPS Tracking API
GET https://onlinetools.ups.com/api/track/v1/details/{trackingNumber}

// FedEx Track API  
POST https://apis.fedex.com/track/v1/trackingnumbers

// USPS Web Tools
GET https://secure.shippingapis.com/ShippingAPI.dll?API=TrackV2&XML=...
```

---

## 🧱 БАЗА ДАННЫХ (Prisma Schema)

```prisma
// Добавить в prisma/schema.prisma

// ═══════════════════════════════════════════
// SHIPMENT MONITOR
// ═══════════════════════════════════════════

model Shipment {
  id              String   @id @default(cuid())
  veeqoOrderId    Int
  veeqoShipmentId Int?
  orderNumber     String
  channel         String
  storeName       String?
  carrier         String
  service         String?
  trackingNumber  String   @unique
  shipDate        DateTime
  promisedEdd     DateTime?
  deliverBy       DateTime?
  actualDelivery  DateTime?
  currentStatus   String     @default("unknown")
  lastStatusAt    DateTime?
  labelCost       Float?
  orderValue      Float?
  carrierBadge    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  lastSyncAt      DateTime?
  trackingEvents  TrackingEvent[]
  issues          ShipmentIssue[]
  claimCandidate  ClaimCandidate?
  @@index([channel])
  @@index([carrier])
  @@index([currentStatus])
  @@index([shipDate])
}

model TrackingEvent {
  id          String   @id @default(cuid())
  shipmentId  String
  shipment    Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  timestamp   DateTime
  status      String
  description String
  detail      String?
  location    String?
  source      String    @default("veeqo")
  rawPayload  String?
  createdAt   DateTime  @default(now())
  @@index([shipmentId])
  @@index([timestamp])
}

model ShipmentIssue {
  id          String   @id @default(cuid())
  shipmentId  String
  shipment    Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  issueType   String
  severity    String
  description String
  detectedAt  DateTime  @default(now())
  ruleTriggered String
  ruleDetails   String?
  resolved    Boolean   @default(false)
  resolvedAt  DateTime?
  createdAt   DateTime  @default(now())
  @@index([shipmentId])
  @@index([issueType])
  @@index([severity])
}

model ClaimCandidate {
  id          String   @id @default(cuid())
  shipmentId  String   @unique
  shipment    Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  channel         String
  carrier         String
  trackingNumber  String
  issueType       String
  issueDescription String
  shipDate        DateTime
  promisedEdd     DateTime?
  deliverBy       DateTime?
  actualDelivery  DateTime?
  daysLate        Int?
  confidenceScore Float
  orderValue      Float?
  labelCost       Float?
  estimatedRefund Float?
  status      String   @default("new")
  notes       String?
  reviewedAt  DateTime?
  filedAt     DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([status])
  @@index([issueType])
  @@index([carrier])
  @@index([confidenceScore])
}

model ShipmentScanLog {
  id              String   @id @default(cuid())
  scanType        String
  startedAt       DateTime @default(now())
  completedAt     DateTime?
  shipmentsScanned Int     @default(0)
  trackingUpdated  Int     @default(0)
  issuesFound      Int     @default(0)
  claimsCreated    Int     @default(0)
  errors           Int     @default(0)
  errorDetails     String?
  status           String   @default("running")
}
```

---

## 🚨 КАТЕГОРИИ ПРОБЛЕМ

| Тип | Описание | Severity |
|-----|----------|----------|
| DELIVERED_LATE | Доставлено позже promised EDD | medium-high |
| DELIVERED_AFTER_DEADLINE | Доставлено позже Amazon/Walmart дедлайна | high |
| NO_MOVEMENT | Нет движения > 48ч | medium-high |
| STUCK_PRE_TRANSIT | Label создан, нет scan > 24ч | medium |
| POSSIBLE_LOST | Нет движения > 7 дней | critical |
| EXCEPTION | Carrier exception | medium |
| SERVICE_FAILURE | SLA нарушен (2-Day → 5-Day) | high |
| ADDRESS_ISSUE | Проблема с адресом | low-medium |
| WEATHER_DELAY | Погодная задержка | low |
| RETURNED_TO_SENDER | Возврат отправителю | high |

---

## ⚙️ ПОРОГИ ДЕТЕКЦИИ (настраиваемые)

```typescript
DEFAULT_THRESHOLDS = {
  noMovementHours: 48,
  stuckPreTransitHours: 24,
  possibleLostDays: 7,
  lateDeliveryMinDays: 1,
  serviceFailureExtraDays: 2,
  minOrderValueForClaim: 15.00,
  scanLookbackDays: 30,
  maxClaimWindowDays: 60,
}
```

---

## 🔄 SYNC PIPELINE (ежедневно ~6:00 AM ET)

```
1. SYNC SHIPMENTS     → Veeqo shipped orders → upsert Shipment
2. UPDATE TRACKING    → Veeqo tracking events → upsert TrackingEvent
3. DETECT ISSUES      → Rule engine → create ShipmentIssue
4. GENERATE CLAIMS    → High severity + min value → ClaimCandidate
5. NOTIFY             → Telegram daily report
6. LOG                → ShipmentScanLog
```

---

## 🔧 CONFIDENCE SCORE

| Фактор | Score |
|--------|-------|
| POSSIBLE_LOST | +0.9 |
| SERVICE_FAILURE | +0.7 |
| DELIVERED_AFTER_DEADLINE | +0.6 |
| DELIVERED_LATE | +0.5 |
| Claims Protected badge | +0.1 |
| 3+ tracking events | +0.05 |
| Label cost > $20 | +0.05 |
| WEATHER_DELAY | -0.3 |
| ADDRESS_ISSUE | -0.4 |

Результат: clamp 0.0 — 1.0

---

## 📁 ФАЙЛОВАЯ СТРУКТУРА

```
src/
├── app/
│   ├── shipment-monitor/
│   │   ├── page.tsx
│   │   └── [id]/page.tsx
│   └── api/
│       ├── shipment-monitor/
│       │   ├── sync/route.ts
│       │   ├── shipments/route.ts
│       │   ├── shipments/[id]/route.ts
│       │   ├── issues/route.ts
│       │   ├── claims/route.ts
│       │   ├── claims/[id]/route.ts
│       │   └── stats/route.ts
│       ├── cron/shipment-monitor/route.ts
│       └── external/shipment-monitor/
├── components/shipment-monitor/
│   ├── SummaryCards.tsx
│   ├── ShipmentFilters.tsx
│   ├── ShipmentTable.tsx
│   ├── IssuesList.tsx
│   ├── ClaimCandidatesTable.tsx
│   ├── ShipmentDetail.tsx
│   ├── TrackingTimeline.tsx
│   └── ClaimActions.tsx
└── lib/shipment-monitor/
    ├── sync.ts
    ├── veeqo-tracking.ts
    ├── rules.ts
    ├── claim-generator.ts
    ├── confidence.ts
    └── types.ts
```

---

## 📌 ПЛАН РЕАЛИЗАЦИИ (7 промптов для Claude Code)

1. **Database Schema** — Prisma models + migrate
2. **Veeqo Tracking Client** — расширить veeqo.ts
3. **Sync Pipeline + Rule Engine** — backend логика
4. **API Routes** — internal + external + cron
5. **UI: Summary + Table** — главная страница
6. **UI: Detail View + Claims** — детальный просмотр
7. **Sidebar + Telegram + Polish** — интеграция

---

## ⚠️ ВАЖНЫЕ ЗАМЕЧАНИЯ

1. Timezone: конвертация UTC-7 как в MASTER_PROMPT_v3.1.md
2. Пагинация Veeqo: page_size=100, все страницы
3. Rate limits: пауза 1 сек между запросами Veeqo
4. Claims Protected badge повышает шанс claim
5. Frozen товары: строже сроки, любая задержка = claim
6. Связь с Frozen Analytics: предоставляет delivery timeline

---

## .ENV ADDITIONS

```env
SHIPMENT_MONITOR_ENABLED=true
SHIPMENT_MONITOR_LOOKBACK_DAYS=30
SHIPMENT_MONITOR_CLAIM_WINDOW_DAYS=60
SHIPMENT_MONITOR_MIN_ORDER_VALUE=15.00
UPS_CLIENT_ID=
UPS_CLIENT_SECRET=
UPS_ACCOUNT_NUMBER=
FEDEX_API_KEY=
FEDEX_SECRET_KEY=
FEDEX_ACCOUNT_NUMBER=
USPS_USERID=
CRON_SECRET=
```
