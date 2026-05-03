# CLAUDE CODE PROMPT — Walmart Marketplace API Integration v1.0

> **Target repo:** `kuzyvladimir-maker/ss-control-center`
> **Date:** 2026-04-18
> **Prepared by:** Vladimir (via research in Claude chat)
> **Execution mode:** поэтапно, commit после каждого этапа

---

## 🎯 КОНТЕКСТ

Мы получили **прямой API доступ к Walmart Marketplace** для аккаунта **SIRIUS TRADING INTERNATIONAL LLC** (Seller ID: `10001624309`, статус Active). Это снимает ключевое ограничение: раньше вся работа с Walmart велась через скриншоты (Customer Hub) и только через Veeqo (Shipping). Теперь можно автоматизировать Walmart по той же модели, что Amazon через SP-API — по всем релевантным модулям.

### ⚠️ ВАЖНО про два ключа в Walmart Developer Portal

В `https://developer.walmart.com/account` на вкладке **Production Keys** у Vladimir видны две секции:

1. **Veeqo** (ClientId: `c479b706-cb19-4f72-bc96-ca15b4b20e4f`) — delegated access, выданный для Veeqo. **НЕ ТРОГАТЬ**. Через него Veeqo покупает shipping labels и синхронизирует orders. Если его сбросить — сломается весь Shipping Labels модуль.
2. **My API Key** (ClientId: `0595b090-82f9-4f56-9216-5aa68a5d3cc5`) — НАШ ключ для direct integration SS Control Center. Используется только нами, только в этом проекте.

Никогда не путать эти две пары.

### ⚠️ Принципы проекта (не нарушать)

- Никаких manual CSV imports для Walmart там, где есть API (только fallback)
- Field names в Prisma — **camelCase**; все snake_case ответы Walmart API мапим через конвертер
- Все даты Walmart возвращает в UTC как Unix timestamps (ms) → конвертировать в UTC-7 (America/Los_Angeles) перед UI / сравнением
- `WM_QOS.CORRELATION_ID` — новый UUID на **каждый** запрос (включая token refresh)
- Rate-limit aware клиент обязателен — читать `x-current-token-count`, ждать если < 2

---

## 📚 ЧТО ДАЁТ WALMART API (справочная матрица)

### Authentication (OAuth 2.0 Client Credentials)

```
POST https://marketplace.walmartapis.com/v3/token
Headers:
  Authorization: Basic {Base64(ClientID:ClientSecret)}
  WM_QOS.CORRELATION_ID: {uuid}
  WM_SVC.NAME: Walmart Marketplace
  Content-Type: application/x-www-form-urlencoded
  Accept: application/json
Body: grant_type=client_credentials

Response: { access_token, token_type: "Bearer", expires_in: 900 }
```

Token живёт ~15 минут. Кешировать в памяти + refresh когда осталось < 60 сек.

### Required Headers на ВСЕХ API вызовах

```
Authorization: Bearer {access_token}
WM_SEC.ACCESS_TOKEN: {access_token}          ← дубль, требуется некоторыми endpoints
WM_QOS.CORRELATION_ID: {new uuid per request}
WM_SVC.NAME: Walmart Marketplace
Accept: application/json
```

### Rate Limits (token bucket)

- Per-seller throttling, разные лимиты per endpoint
- Response headers:
  - `x-current-token-count` — сколько осталось
  - `x-next-replenish-time` — когда пополнится
- 429 `Too Many Requests` → **exponential backoff с jitter** (start 1s, max 60s)
- Если `x-current-token-count` < 2 → sleep до `x-next-replenish-time` перед следующим запросом

### Endpoints по модулям SS Control Center

#### 🛒 Orders API

| Endpoint | Метод | Назначение | Используется в |
|---|---|---|---|
| `/v3/orders` | GET | Все заказы (включая WFS при `shipNodeType=WFSFulfilled`) | Customer Hub, Shipment Monitor, Dashboard |
| `/v3/orders/released` | GET | Заказы в статусе Created — готовы к shipping | Shipping Labels (верификация) |
| `/v3/orders/{purchaseOrderId}` | GET | Детали одного заказа | Customer Hub (контекст), Shipment Monitor |
| `/v3/orders/{purchaseOrderId}/acknowledge` | POST | Подтвердить получение заказа | Customer Hub |
| `/v3/orders/{purchaseOrderId}/cancel` | POST | Отменить line items | Customer Hub |
| `/v3/orders/{purchaseOrderId}/shipping` | POST | Отметить shipped + tracking | (Veeqo делает это — резерв) |
| `/v3/orders/{purchaseOrderId}/refund` | POST | Refund на отгруженный заказ | Customer Hub |

**Лимиты:** 10,000 заказов max за запрос, только последние 180 дней, пагинация через `meta.nextCursor`.

**Статусы заказа:** Created → Acknowledged → Shipped → Delivered / Cancelled.

#### ↩️ Returns API

| Endpoint | Метод | Назначение | Используется в |
|---|---|---|---|
| `/v3/returns` | GET | Все возвраты (для WFS + `isWFSEnabled=Y`) | Customer Hub |
| `/v3/returns/{returnOrderId}/refund` | POST | Issue refund по возврату | Customer Hub |

Returns содержат `eventTag` внутри `returnTrackingDetail` — даёт детальный жизненный цикл возврата.

#### 📊 Reports API (Reconciliation)

| Endpoint | Метод | Назначение | Используется в |
|---|---|---|---|
| `/v3/report/reconreport/availableReconFiles` | GET | Список доступных дат recon reports | Adjustments |
| `/v3/report/reconreport/reconFile?reportDate=YYYY-MM-DD` | GET | Скачать recon report (JSON с пагинацией через `pageNo` и `limit`) | Adjustments |

**Content:** Sales (shipment confirmation), Refunds (return/refund invoiced), Adjustments (chargebacks, fees, corrections). Колонка `transaction_posted_timestamp` — ключевая для сортировки.

#### 📈 Seller Performance API

Две ветви эндпойнтов (метрики Account Health):
1. **Summary endpoints** (JSON) — агрегированные проценты
2. **Report endpoints** (Excel .xlsx) — детализированные заказы для root-cause analysis

**Окна:** 14, 30, 60, 90 дней
**Метрики:**
- On-time delivery rate
- Valid tracking rate
- Response rate (к Walmart/customer contacts)
- Refund rate (post-fulfillment)
- Cancellation rate (pre-fulfillment)
- Carrier method accuracy
- On-time shipment rate
- Ship-from location accuracy

Плюс отдельный `Simplified Shipping Settings` endpoint — насколько фактические отгрузки соответствуют настройкам.

#### 📦 Inventory API (для будущих фаз — сейчас не трогаем)

`GET /v3/inventory?sku={sku}` / `PUT /v3/inventory` — для Phase 2 модулей (Product Listings, Buy Box).

#### 💰 Price API (для будущих фаз)

`PUT /v3/price` — для Phase 2.

#### ❌ Чего у Walmart НЕТ (в отличие от Amazon SP-API)

- **Нет Messaging API** как у Amazon. Клиент-селлер коммуникация у Walmart проходит через сами cancel/refund/return workflows и через Walmart Contact Us form. Всё "сообщения клиентов" в Customer Hub для Walmart — это метаданные order/return, а не отдельные chat threads.
- **Нет отдельного Chargebacks API** — chargebacks попадают в reconciliation report как adjustments.
- **Нет отдельного Feedback API** для seller ratings — данные доступны только через Performance dashboard (частично через Seller Performance API).

---

## 🏗️ АРХИТЕКТУРА ИНТЕГРАЦИИ

```
lib/walmart/
├── client.ts            ← OAuth token manager + rate-limit aware fetch
├── types.ts             ← TypeScript типы (Order, Return, ReconTx, Performance)
├── orders.ts            ← Orders API wrapper
├── returns.ts           ← Returns API wrapper
├── reports.ts           ← Reconciliation reports
├── seller-performance.ts ← Performance metrics
├── mappers.ts           ← snake_case Walmart → camelCase Prisma
└── README.md            ← краткое описание, как пользоваться

app/api/customer-hub/walmart/
├── orders/sync/route.ts    ← POST: синхронизация заказов в BuyerMessage
├── returns/sync/route.ts   ← POST: синхронизация возвратов
├── orders/[id]/cancel/route.ts  ← POST: отменить заказ
├── orders/[id]/refund/route.ts  ← POST: refund
└── returns/[id]/refund/route.ts ← POST: issue return refund

app/api/shipment-monitor/walmart/
└── sync/route.ts          ← POST: pull order statuses для мониторинга

app/api/adjustments/walmart/
└── sync/route.ts          ← POST: pull reconciliation report за дату

app/api/account-health/walmart/
└── sync/route.ts          ← POST: pull performance summary + reports

app/api/shipping-labels/walmart/
└── verify/[orderId]/route.ts  ← GET: проверка статуса заказа перед покупкой
```

---

## 🔧 ETAPS (выполнять по порядку)

### ЭТАП 1: ENV и базовый клиент

#### 1.1. Обновить `.env` и `.env.example`

Vladimir добавит вручную в `.env` (в `.env.example` — пустые значения):

```env
# Walmart Marketplace API — Store 1: SIRIUS TRADING INTERNATIONAL LLC
WALMART_CLIENT_ID_STORE1=0595b090-82f9-4f56-9216-5aa68a5d3cc5
WALMART_CLIENT_SECRET_STORE1=<ВСТАВИТЬ из Developer Portal, нажать "глаз" чтобы показать>
WALMART_STORE1_NAME="SIRIUS TRADING INTERNATIONAL LLC"
WALMART_STORE1_SELLER_ID=10001624309

# Shared
WALMART_API_BASE_URL=https://marketplace.walmartapis.com
WALMART_API_VERSION=v3
```

**Почему `STORE1` pattern:** Vladimir использует эту схему для 5 Amazon аккаунтов. Сейчас Walmart один, но закладываемся на расширение.

#### 1.2. Создать `lib/walmart/client.ts`

Требования к классу `WalmartClient`:

**Конструктор:**
- Принимает `storeIndex: number` (default: 1)
- Читает `WALMART_CLIENT_ID_STORE{N}`, `WALMART_CLIENT_SECRET_STORE{N}`, `WALMART_STORE{N}_NAME`, `WALMART_STORE{N}_SELLER_ID` из env
- Бросает ошибку если любой из required env отсутствует

**Token management:**
- Приватный `_token: { accessToken: string, expiresAt: Date } | null`
- Метод `getAccessToken()`: 
  - Если `_token` есть и `expiresAt` > сейчас + 60 сек → return cached
  - Иначе: POST `/v3/token` с `grant_type=client_credentials`, Basic Auth header
  - Сохранить в `_token` с `expiresAt = now + (expires_in - 60) * 1000`
  - На 401 → повторить один раз, потом throw

**Fetch wrapper `request(method, path, options)`:**
- Автоматически добавляет все required headers (Authorization, WM_SEC.ACCESS_TOKEN, WM_QOS.CORRELATION_ID [новый uuid per call!], WM_SVC.NAME, Accept)
- На 429 или 5xx: exponential backoff с jitter (base 1000ms, factor 2, max retries 4, max delay 60s)
- Читает `x-current-token-count` и `x-next-replenish-time` из response headers
- Если `x-current-token-count` < 2 → `console.warn` + автоматически sleep до `x-next-replenish-time` ПЕРЕД следующим запросом (реализовать через shared state внутри клиента)
- Логирует каждый запрос на уровне DEBUG: `[WALMART][STORE1] GET /v3/orders → 200 (tokens: 15/20, rt: 1234ms)`
- На не-2xx возвращает структурированную `WalmartApiError` с полями `status`, `path`, `correlationId`, `errorBody`

**Пример использования (то, что должны писать другие файлы):**

```typescript
import { WalmartClient } from "@/lib/walmart/client";

const client = new WalmartClient(1);
const data = await client.request("GET", "/orders", {
  params: { createdStartDate: "2026-04-10", limit: 100 }
});
```

#### 1.3. Создать `lib/walmart/types.ts`

Описать TypeScript интерфейсы для всех response shapes, которые мы используем. **Не генерировать "на всякий случай" — только то, что нужно для наших вызовов.** Минимум:

- `WalmartOrder`, `WalmartOrderLine`, `WalmartShippingInfo`, `WalmartCharge`
- `WalmartReturn`, `WalmartReturnLine`, `WalmartReturnTrackingDetail`
- `WalmartReconTransaction`, `WalmartReconReportMeta`
- `WalmartPerformanceSummary` (+ под-метрики)
- `WalmartApiError`

Все поля — `camelCase` (мы мапим при парсинге).

#### 1.4. Создать `lib/walmart/mappers.ts`

Функции:
- `mapOrder(raw: unknown): WalmartOrder`
- `mapReturn(raw: unknown): WalmartReturn`
- `mapReconTx(raw: unknown): WalmartReconTransaction`
- `epochMsToDate(ms: number): Date` — Walmart возвращает orderDate, estimatedDeliveryDate и т.д. как Unix ms

Все мапперы должны переводить `snake_case → camelCase` и `epoch ms → Date`.

---

### ЭТАП 2: Orders API

Создать `lib/walmart/orders.ts`:

```typescript
export class WalmartOrdersApi {
  constructor(private client: WalmartClient) {}

  async getAllOrders(params: {
    createdStartDate?: string;     // ISO date
    createdEndDate?: string;
    status?: "Created" | "Acknowledged" | "Shipped" | "Delivered" | "Cancelled";
    shipNodeType?: "SellerFulfilled" | "WFSFulfilled" | "3PLFulfilled";
    purchaseOrderId?: string;
    customerOrderId?: string;
    sku?: string;
    limit?: number;                // default 100, max 200
    nextCursor?: string;           // для пагинации
    productInfo?: boolean;
  }): Promise<{ orders: WalmartOrder[]; nextCursor?: string; totalCount: number }>;

  async getReleasedOrders(params: { ... }): Promise<...>;   // аналогично
  async getOrderById(purchaseOrderId: string): Promise<WalmartOrder>;
  async acknowledgeOrder(purchaseOrderId: string): Promise<WalmartOrder>;
  async cancelOrderLine(purchaseOrderId: string, body: WalmartCancelBody): Promise<WalmartOrder>;
  async shipOrderLine(purchaseOrderId: string, body: WalmartShipBody): Promise<WalmartOrder>;
  async refundOrderLine(purchaseOrderId: string, body: WalmartRefundBody): Promise<WalmartOrder>;
}
```

**Важно:**
- Пагинация: пока `nextCursor` не пустой — продолжать. Вспомогательный метод `getAllOrdersPaginated(params)` — async generator.
- Все ответы проходят через `mapOrder()`.
- Для `cancelOrderLine` — body формат:
  ```json
  {
    "orderCancellation": {
      "orderLines": {
        "orderLine": [{
          "lineNumber": "1",
          "orderLineStatuses": {
            "orderLineStatus": [{
              "status": "Cancelled",
              "cancellationReason": "CUSTOMER_REQUESTED_SELLER_TO_CANCEL",
              "statusQuantity": { "unitOfMeasurement": "EACH", "amount": "1" }
            }]
          }
        }]
      }
    }
  }
  ```

---

### ЭТАП 3: Returns API

Создать `lib/walmart/returns.ts`:

```typescript
export class WalmartReturnsApi {
  constructor(private client: WalmartClient) {}

  async getAllReturns(params: {
    returnCreationStartDate?: string;
    returnCreationEndDate?: string;
    returnType?: "RETURN" | "REFUND";
    status?: "INITIATED" | "DELIVERED" | "COMPLETED";
    returnOrderId?: string;
    customerOrderId?: string;
    limit?: number;
    nextCursor?: string;
    isWFSEnabled?: boolean;
  }): Promise<{ returns: WalmartReturn[]; nextCursor?: string; totalCount: number }>;

  async issueReturnRefund(returnOrderId: string, body: { ... }): Promise<WalmartReturn>;
}
```

---

### ЭТАП 4: Reports API (Reconciliation)

Создать `lib/walmart/reports.ts`:

```typescript
export class WalmartReportsApi {
  constructor(private client: WalmartClient) {}

  async getAvailableReconReportDates(): Promise<string[]>;  // массив ISO дат

  async getReconReport(params: {
    reportDate: string;    // YYYY-MM-DD
    pageNo?: number;       // default 1
    limit?: number;        // default 1000, max 2000
  }): Promise<{
    meta: { fileSize: number; totalRows: number; totalPages: number; rowsOnThisPage: number; pageNo: number };
    transactions: WalmartReconTransaction[];
  }>;

  /**
   * Удобная обёртка: прокручивает все страницы и возвращает весь recon report за дату.
   */
  async getFullReconReport(reportDate: string): Promise<WalmartReconTransaction[]>;
}
```

---

### ЭТАП 5: Seller Performance API

Создать `lib/walmart/seller-performance.ts`:

```typescript
export type PerformanceMetric =
  | "onTimeDelivery" | "validTrackingRate" | "responseRate"
  | "refundRate" | "cancellationRate" | "carrierMethodAccuracy"
  | "onTimeShipment" | "shipFromLocationAccuracy";

export type PerformanceWindow = 14 | 30 | 60 | 90;

export class WalmartSellerPerformanceApi {
  constructor(private client: WalmartClient) {}

  async getSummary(windowDays: PerformanceWindow, orderTypes?: string[]): Promise<WalmartPerformanceSummary>;

  async getMetricReport(
    metric: PerformanceMetric,
    windowDays: PerformanceWindow,
    orderTypes?: string[]
  ): Promise<Buffer>;   // XLSX file, сохранить в /tmp/ для последующей обработки

  async getSimplifiedShippingSettingsReport(): Promise<WalmartPerformanceSummary>;
}
```

**Где посмотреть точные пути endpoints:** `https://developer.walmart.com/doc/us/mp/us-mp-seller-performance/`. На момент написания этого промпта пути вида `/v3/sellerPerformance/summary?windowDays=30`. Если путь не работает — свериться с актуальной документацией.

---

### ЭТАП 6: Prisma Schema updates

Добавить в `prisma/schema.prisma`:

```prisma
// Добавить к BuyerMessage (если ещё нет):
model BuyerMessage {
  // ...existing fields...
  marketplace      String   @default("AMAZON")  // AMAZON | WALMART
  walmartOrderId   String?  @unique              // для Walmart = purchaseOrderId
  walmartReturnId  String?  @unique              // для Walmart returns
  // ...
}

// Новая модель для Walmart-specific данных (если нужна):
model WalmartOrder {
  id                String   @id @default(cuid())
  purchaseOrderId   String   @unique
  customerOrderId   String
  customerEmailId   String?
  orderDate         DateTime
  status            String                        // Created | Acknowledged | Shipped | Delivered | Cancelled
  orderTotal        Float?
  shipNodeType      String?                       // SellerFulfilled | WFSFulfilled
  estimatedShipDate DateTime?
  estimatedDeliveryDate DateTime?
  rawData           String                        // JSON dump на случай непредвиденных полей
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  storeId           Int      @default(1)
  
  @@index([status])
  @@index([orderDate])
}

model WalmartReconTransaction {
  id                        String   @id @default(cuid())
  transactionPostedTimestamp DateTime
  transactionType           String                 // Sales | Refunds | Adjustments | Fees
  purchaseOrderId           String?
  customerOrderId           String?
  sku                       String?
  productName               String?
  quantity                  Int?
  amount                    Float
  feeType                   String?
  reportDate                DateTime               // дата отчёта, из которого взята транзакция
  rawData                   String
  createdAt                 DateTime @default(now())
  storeId                   Int      @default(1)

  @@unique([transactionPostedTimestamp, purchaseOrderId, transactionType, amount])
  @@index([reportDate])
  @@index([transactionType])
}

model WalmartPerformanceSnapshot {
  id              String   @id @default(cuid())
  capturedAt      DateTime @default(now())
  windowDays      Int                              // 14 | 30 | 60 | 90
  metric          String                           // onTimeDelivery | ...
  value           Float                            // процент/коэффициент
  threshold       Float?                           // порог Walmart для этой метрики
  isHealthy       Boolean
  rawData         String
  storeId         Int      @default(1)
  
  @@index([metric, capturedAt])
}
```

После изменений:
```bash
npx prisma generate
npx prisma migrate dev --name add-walmart-models
```

Перезапустить dev server.

---

### ЭТАП 7: Интеграция в модули

#### 7.1. Customer Hub — убрать screenshot-only схему для Walmart, сделать как Amazon

**Существующая схема (из `CUSTOMER_HUB_ALGORITHM_v2.1.md`, раздел "WALMART CUSTOMER SERVICE"):** screenshot → AI analyze → copy-paste. Это был **workaround** пока не было API. Теперь API есть.

**Новая логика:**

1. В `app/api/customer-hub/walmart/orders/sync/route.ts`:
   - Pull orders за последние 30 дней со статусом `Created`, `Acknowledged`, `Shipped`
   - Для каждого проверять: есть ли соответствующий `BuyerMessage` (по `walmartOrderId`)
   - Если нет и заказ требует внимания (см. триггеры ниже) — создать `BuyerMessage` с `marketplace: "WALMART"` и снэпшотом order data в `imageData` (как JSON, не base64)

   **Триггеры для создания BuyerMessage:**
   - Статус `Cancelled` (не нами) — клиент отменил
   - Order старше `estimatedDeliveryDate` + 1 день и всё ещё `Shipped` — возможно проблема доставки
   - Есть связанный `Return` (пришёл через Returns API) — возврат инициирован
   - Заказ был refunded (есть `refunds` в order data)

2. В `app/api/customer-hub/walmart/returns/sync/route.ts`:
   - Pull returns за последние 30 дней
   - Для каждого: создать/обновить `BuyerMessage` с `walmartReturnId`, категорией на основе `eventTag`

3. **Decision Engine для Walmart** — оставить существующий (жёсткие правила из v2.1: refund/replacement/cancel, no discussions, 4-step format). Но теперь actions привязаны к реальным API вызовам:
   - "Cancel order" → `POST /v3/orders/{id}/cancel` через наш клиент
   - "Issue refund" → `POST /v3/orders/{id}/refund` или `POST /v3/returns/{id}/refund`
   - Нет `"copy to clipboard"` — автоматическое выполнение после approval Vladimir

4. Screenshot-upload схему **оставить как fallback** для редких кейсов, где API не покрывает (например, спорные ситуации где требуется ручной ответ в Walmart Seller Center).

5. **UI изменения в Customer Hub:**
   - Убрать текст "Walmart Case (manual)" с акцентом на screenshots
   - Добавить стандартный список Walmart messages (как у Amazon)
   - Кнопка `[📸 Upload Screenshot]` остаётся, но теперь рядом с `[🔄 Sync Walmart]`

6. **Cron job для Customer Hub Walmart sync:** каждые 8-12ч (как Amazon).

#### 7.2. Shipping Labels — verification endpoint

Shipping Labels продолжает работать через Veeqo (это не меняется). Добавить только дополнительную проверку:

**`app/api/shipping-labels/walmart/verify/[orderId]/route.ts`** (GET):
- Принять Walmart `purchaseOrderId`
- Вызвать `GET /v3/orders/{id}`
- Вернуть `{ status, isSafeToShip: boolean, reason?: string }`
  - `isSafeToShip = true` если `status === "Acknowledged"` и нет `Cancelled` line items
  - `isSafeToShip = false` если `status === "Cancelled"` или hard refund
- В UI Shipping Labels: перед кнопкой `[✅ Buy All Labels]` — для каждой Walmart строки вызвать `/verify/{orderId}`; если `isSafeToShip === false` — пометить строку жёлтым/красным

**Не менять:** бизнес-логику выбора тарифов, алгоритм Frozen/Dry, работу с Veeqo.

#### 7.3. Shipment Monitor — Walmart tracking

В `SHIPMENT_MONITOR_SPEC_v1_0.md` MVP использует Veeqo tracking events как primary. Walmart API — **Level 1.5** дополнительный слой:

**`app/api/shipment-monitor/walmart/sync/route.ts`** (POST):
- Pull orders за последние 7 дней со статусом `Shipped`
- Для каждого: вытащить `trackingInfo` из response, обновить наш `ShipmentMonitor` record с актуальным статусом от Walmart
- Если Walmart показывает `Delivered`, а Veeqo — ещё `In Transit` → flag для ручной проверки

#### 7.4. Adjustments — автозагрузка reconciliation reports

Из `ADJUSTMENTS_ALGORITHM_v1_0.md`: Primary для Amazon — SP-API Finances API. **Для Walmart теперь primary — Reports API (recon reports).**

**`app/api/adjustments/walmart/sync/route.ts`** (POST):
- Вызвать `getAvailableReconReportDates()` → список дат
- Для каждой даты, которой ещё нет в `WalmartReconTransaction` по `reportDate`:
  - `getFullReconReport(date)` (с пагинацией)
  - Для каждой транзакции: upsert в `WalmartReconTransaction` (по `@@unique([transactionPostedTimestamp, purchaseOrderId, transactionType, amount])`)
- Маппинг transaction types Walmart → категории Adjustments:
  - `Sales` → Amazon категория "Shipment"
  - `Refunds` → "Refund"
  - `Adjustments` → "Adjustment"
  - `Fees` (если появится) → "Fee"

**Cron:** 24ч (ночью).

**UI Adjustments:** добавить переключатель store (Amazon Store 1 / Store 2 / ... / Walmart) + фильтр по marketplace.

#### 7.5. Account Health — Walmart Performance

Новая секция в Account Health UI: `Walmart Performance`. Рядом с Amazon.

**`app/api/account-health/walmart/sync/route.ts`** (POST):
- Вызвать `getSummary(30)` и `getSummary(90)`
- Для каждой метрики: создать `WalmartPerformanceSnapshot`
- Пороги Walmart (из их Seller Performance Standards — актуальные на 2026 год, проверить в документации):
  - On-time delivery: ≥ 95%
  - Valid tracking: ≥ 99%
  - Response rate: ≥ 95%
  - Cancellation rate: ≤ 2%
  - Refund rate: (watch trend, нет жёсткого порога)

**UI:** карточки с цветовой индикацией (зелёный если healthy, жёлтый если близко к порогу, красный если violated).

**Cron:** 24ч.

#### 7.6. Dashboard — Walmart цифры

В главном Dashboard widget добавить:

```
┌─────────────────────────────────────┐
│  🟦 Walmart                          │
│  Orders today: 8                     │
│  Returns pending: 2                  │
│  Refunds this week: $247             │
│  Account Health: ✅ Healthy           │
└─────────────────────────────────────┘
```

Данные — через существующие API routes (не дублировать логику).

#### 7.7. Frozen Analytics — легкое касание

Walmart не продаёт frozen. Но в Frozen Analytics концепции можно добавить:
- Общий counter "Non-frozen complaints" от Walmart как base rate для сравнения с Amazon frozen
- Никаких frozen-specific walmart полей

---

### ЭТАП 8: Wiki + документация (ОБЯЗАТЕЛЬНО — по правилу проекта)

#### 8.1. Создать `docs/wiki/walmart-api.md`

См. отдельную wiki-статью, созданную рядом с этим промптом (уже готова).

#### 8.2. Обновить `docs/wiki/CONNECTIONS.md`

Добавить раздел Walmart API с указанием связей со всеми модулями (orders-sync → BuyerMessage, recon-sync → Adjustments, performance-sync → Account Health, verify → Shipping Labels).

#### 8.3. Обновить `docs/wiki/index.md`

Добавить в раздел "🔌 Интеграции" ссылку на walmart-api.md.

#### 8.4. Обновить `docs/wiki/walmart-restrictions.md`

Удалить устаревшую строку "Walmart API ключ — пока отсутствует". Добавить ссылку на новую walmart-api.md.

#### 8.5. Создать `docs/WALMART_API_INTEGRATION_SPEC_v1_0.md`

Reference-level spec на основе этого промпта — с полными таблицами endpoints, error codes, examples requests/responses, шаблонами для каждого типа API вызова. Этот файл — source of truth для дальнейших итераций (v1.1, v2.0 будут редактировать его).

---

### ЭТАП 9: Тестирование (perform AFTER implementation)

#### 9.1. Smoke tests

Создать `scripts/walmart-smoke-test.ts`:

```typescript
// Минимальный прогон — запускается через: npx tsx scripts/walmart-smoke-test.ts
import { WalmartClient } from "@/lib/walmart/client";
import { WalmartOrdersApi } from "@/lib/walmart/orders";
import { WalmartReturnsApi } from "@/lib/walmart/returns";
import { WalmartReportsApi } from "@/lib/walmart/reports";

async function main() {
  const client = new WalmartClient(1);

  // Test 1: Authentication
  console.log("Test 1: Get access token...");
  const token = await client.getAccessToken();
  console.log("✅ Token obtained, expires at:", token.expiresAt);

  // Test 2: Orders API
  console.log("\nTest 2: Fetch 10 latest orders...");
  const orders = new WalmartOrdersApi(client);
  const { orders: orderList, totalCount } = await orders.getAllOrders({ limit: 10 });
  console.log(`✅ Got ${orderList.length} orders (total: ${totalCount})`);
  orderList.forEach((o) => console.log(`  - ${o.purchaseOrderId}: ${o.status}`));

  // Test 3: Returns API
  console.log("\nTest 3: Fetch returns...");
  const returns = new WalmartReturnsApi(client);
  const { returns: returnList } = await returns.getAllReturns({ limit: 5 });
  console.log(`✅ Got ${returnList.length} returns`);

  // Test 4: Reports API
  console.log("\nTest 4: Available recon report dates...");
  const reports = new WalmartReportsApi(client);
  const dates = await reports.getAvailableReconReportDates();
  console.log(`✅ Got ${dates.length} available dates`);
  if (dates.length > 0) {
    console.log(`  Latest: ${dates[0]}`);
    const recon = await reports.getReconReport({ reportDate: dates[0], pageNo: 1, limit: 10 });
    console.log(`  ✅ First page: ${recon.transactions.length} tx, total rows: ${recon.meta.totalRows}`);
  }

  console.log("\n🎉 All smoke tests passed");
}

main().catch(console.error);
```

#### 9.2. Ручная проверка через UI

После implementation:
1. Dashboard → должна появиться карточка Walmart
2. Customer Hub → нажать `[🔄 Sync Walmart]` → должны появиться записи
3. Adjustments → выбрать Walmart в store selector → должны появиться транзакции
4. Account Health → вкладка Walmart Performance → должны быть метрики

---

## ✅ CHECKLIST (Vladimir, проверь перед запуском Claude Code)

Перед тем как скормить этот промпт Claude Code:

- [ ] Добавил `WALMART_CLIENT_SECRET_STORE1` в `.env` (нажать "глаз" рядом с полем в Developer Portal, скопировать)
- [ ] Убедился что в `.env` НЕТ опечаток в `WALMART_CLIENT_ID_STORE1` (должен быть `0595b090-82f9-4f56-9216-5aa68a5d3cc5`)
- [ ] Сделал `git pull` и находишься на чистой ветке (создать `feature/walmart-api-integration`)
- [ ] Claude Code видит все файлы: `CLAUDE.md`, `CUSTOMER_HUB_ALGORITHM_v2.1.md`, `ADJUSTMENTS_ALGORITHM_v1_0.md`, `SHIPMENT_MONITOR_SPEC_v1_0.md`

---

## 📋 КОММИТЫ (рекомендуемое разбиение)

1. `chore(walmart): add env vars and client skeleton` — этапы 1.1, 1.2
2. `feat(walmart): add types and mappers` — этапы 1.3, 1.4
3. `feat(walmart): Orders API wrapper` — этап 2
4. `feat(walmart): Returns API wrapper` — этап 3
5. `feat(walmart): Reports API for reconciliation` — этап 4
6. `feat(walmart): Seller Performance API` — этап 5
7. `feat(db): add Walmart Prisma models` — этап 6
8. `feat(customer-hub): Walmart orders + returns sync` — этап 7.1
9. `feat(shipping-labels): Walmart order verification` — этап 7.2
10. `feat(shipment-monitor): Walmart tracking layer` — этап 7.3
11. `feat(adjustments): Walmart recon reports auto-sync` — этап 7.4
12. `feat(account-health): Walmart Performance metrics` — этап 7.5
13. `feat(dashboard): add Walmart widget` — этап 7.6
14. `docs(wiki): Walmart API integration notes` — этап 8
15. `test(walmart): smoke tests` — этап 9

---

## ❓ ЕСЛИ ВОЗНИКНЕТ НЕОПРЕДЕЛЁННОСТЬ

Priority при сомнениях:
1. **Проверить актуальную документацию:** `https://developer.walmart.com/doc/us/mp/us-mp-orders/` (и аналогичные пути для returns, reports, seller-performance)
2. **Спросить Vladimir через комментарий в коде** (`// TODO(vladimir): нужно уточнить...`) — не гадать
3. **Rate limits unclear:** использовать консервативные defaults (1 req/sec) и логировать заголовки для последующей калибровки

**НЕ делать:**
- Не хардкодить access_token в код
- Не коммитить `.env`
- Не трогать Veeqo delegated key
- Не вызывать Amazon SP-API из Walmart модулей (и наоборот)
- Не использовать `Inventory API` / `Price API` / `Items API` — это Phase 2, не сейчас
- Не использовать старый `Consumer ID + Private Key` auth — только OAuth 2.0 Client Credentials
- Не парсить snake_case напрямую в Prisma — всегда через `mappers.ts`

---

## 🏁 FINISH CRITERIA

Этап считается завершённым когда:
1. Все смок-тесты из `scripts/walmart-smoke-test.ts` проходят
2. Dashboard показывает Walmart widget с реальными данными
3. Customer Hub → `[🔄 Sync Walmart]` создаёт `BuyerMessage` записи
4. Adjustments → Walmart store показывает реальные transactions за доступные даты
5. Account Health → Walmart Performance показывает актуальные метрики
6. Все 4 wiki-файла обновлены (`walmart-api.md`, `CONNECTIONS.md`, `index.md`, `walmart-restrictions.md`) + создан `WALMART_API_INTEGRATION_SPEC_v1_0.md`
7. `npm run build` без ошибок
8. `npx prisma generate && npx prisma migrate dev` без ошибок

После этого — сделать merge в main, обновить GitHub wiki если он отдельный, дать знать Vladimir.
