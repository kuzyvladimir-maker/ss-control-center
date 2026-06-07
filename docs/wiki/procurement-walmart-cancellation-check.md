# 🚨 Procurement — Walmart cancellation check & one-click cancel

## Суть
На странице **/procurement** при каждой загрузке/refresh-е параллельно с
ассортиментом подтягивается **live-статус «buyer requested cancellation»**
для всех Walmart-заказов в списке. Если у заказа поднят флаг
`intentToCancel` (красный восклицательный знак в Seller Center) —
вокруг карточки заказа рисуется красная рамка + баннер сверху, и
появляется кнопка **"Cancel on Walmart"**. Один клик → Walmart API
cancelOrderLines с reason **`CUSTOMER_CHANGED_MIND`**.

Зачем: до 2026-06-07 Vladimir мог по инерции закупить инвентарь под заказ,
который кастомер уже попросил отменить. Watchdog cron ловил такие
запросы, но **только если label НЕ был куплен** (см.
[walmart-cancellation-watchdog](walmart-cancellation-watchdog.md));
procurement-стадия — это до закупки и тем более до label, и именно
здесь Vladimir принимает решение «закупаем или отменяем». Теперь
сигнал виден up-front.

## Связано с
- [Procurement Module](procurement-module.md) — родительский модуль
- [Walmart API](walmart-api.md) — клиент + endpoints
- `src/app/api/procurement/walmart-cancellations/route.ts` — POST
  endpoint, сканит Walmart `/v3/orders?status=Acknowledged` один раз,
  индексирует по `customerOrderId`, возвращает map
  `{ orderNumber: { intentToCancel, isCancelled, cancellationReason, purchaseOrderId, status } }`
- `src/app/api/procurement/walmart-cancel-order/route.ts` — POST
  endpoint, выполняет cancellation с `CUSTOMER_CHANGED_MIND`
- `src/app/procurement/components/ProcurementList.tsx` — CancellationBanner
  компонент + красная рамка вокруг order-group
- `src/app/procurement/page.tsx` — state `cancellationFlags`, вызов
  внутри `load()`, handler `handleCancelWalmartOrder`
- `src/lib/walmart/orders.ts:cancelOrderLines` — обертка Walmart API

---

## 🔁 Flow

### 1. Загрузка страницы / Refresh
```
[ProcurementPage.load()]
       │
       ├─→ GET /api/procurement/items         (Veeqo, основной)
       ├─→ GET /api/procurement/sku-stores    (фоном, store priorities)
       └─→ POST /api/procurement/walmart-cancellations
                 body: { orderNumbers: [<все Walmart customerOrderId>] }
                 │
                 ▼
           [walmart-cancellations route]
              1. Берёт WalmartOrder cache: matches customerOrderId →
                 purchaseOrderId + status.
              2. Уже Cancelled (из cache) → возвращает isCancelled=true
                 без API-вызова.
              3. Acknowledged/Created → нужен live intentToCancel:
                 пагинированный скан /v3/orders?status=Acknowledged
                 (1 страница покрывает наш типичный объём).
              4. Возвращает map.
       │
       ▼
   setCancellationFlags({ ... }) → ProcurementList → CancellationBanner
```

### 2. Cancellation banner (визуально)
| Состояние | Внешний вид |
|-----------|------------|
| `intentToCancel: true` | Красная рамка вокруг order-group, ring-2 danger/30, баннер сверху `bg-danger-tint` с иконкой AlertOctagon + кнопкой **"Cancel on Walmart"** |
| `isCancelled: true`    | Карточка с `opacity-60`, серый баннер `bg-bg-elev` с иконкой XCircle, надпись "Cancelled on Walmart · reason: ... · PO ..." (кнопки нет) |
| Нет флага              | Обычная карточка (`border-rule`) |

### 3. Клик "Cancel on Walmart"
```
[CancellationBanner button]
       │ onClick: handleCancelWalmartOrder(orderNumber)
       ▼
POST /api/procurement/walmart-cancel-order
     body: { orderNumber }   // accepts customerOrderId OR purchaseOrderId
       │
       ▼
[walmart-cancel-order route]
   1. prisma.walmartOrder.findFirst({ OR: [customerOrderId, purchaseOrderId] })
   2. Idempotent: если уже Cancelled → возвращает ok:true alreadyCancelled
   3. api.getOrderById(purchaseOrderId) — нужны live lineNumber + qty
   4. Фильтрует open lines (status in {Created, Acknowledged}); если 0 →
      обновляет cache + возвращает noOpenLines:true (нечего отменять)
   5. api.cancelOrderLines(po, lines, reason: "CUSTOMER_CHANGED_MIND")
   6. Apsert в WalmartCancellationRequest (action: AUTO_CANCELLED)
   7. WalmartOrder.status → "Cancelled" в cache
       │
       ▼
[Page side effects on success]
   • Карточки этого orderNumber удаляются из локального cards state
   • flag.isCancelled → true (banner перекрашивается серым на момент анимации)
```

---

## 🤔 Почему reason `CUSTOMER_CHANGED_MIND`?

Walmart's `orderLineStatus.cancellationReason` принимает несколько кодов:
- `CUSTOMER_REQUESTED_SELLER_TO_CANCEL` — формальный запрос кастомера через
  customer-facing site (это и есть intentToCancel).
- `CUSTOMER_CHANGED_MIND` — кастомер передумал.
- `OUT_OF_STOCK` — у нас нет товара (вредит метрике cancellation-rate
  сильнее).
- `CANCEL_BY_SELLER` — другая seller-side причина.

Vladimir выбрал `CUSTOMER_CHANGED_MIND` для всех procurement-стадия
отмен. Reasoning: до того как мы потратили деньги на label, любую
отмену проще обосновать как buyer-side (даже если кастомер этого
официально не запросил — но если intentToCancel: true то фактически
запросил, просто другим кодом). `CUSTOMER_CHANGED_MIND` минимизирует
урон по cancellation-rate seller-метрике.

**Контраст с watchdog cron:** `walmart-cancellation-watchdog` (auto-cancel
когда нет label) использует `CUSTOMER_REQUESTED_SELLER_TO_CANCEL` — там
сценарий чистый, кастомер реально нажал «Request cancellation».
Procurement-flow ручной и используется в т.ч. для proactive отмен.

---

## 🎯 Производительность
- Single Walmart `/v3/orders?status=Acknowledged&limit=200` call покрывает
  наш типичный объём в одной странице.
- `WalmartOrder` DB-cache (refreshed orders-walmart-light cron каждые 2h)
  даёт мгновенный сигнал для уже-Cancelled заказов без API-вызова.
- Все 3 параллельных fetch'а в `load()` стартуют одновременно — UI красится
  как только items приходят, банеры появляются спустя ~1-2с.
- MAX_PAGES = 10 защитный лимит (никогда не упирались в реальности).

---

## 📌 Что НЕ обрабатывается
- **Created status**: orders в Created очень редко, ack-cron акает их в
  течение минут. Если orderNumber есть в нашем cache, но не в Acknowledged
  сейчас — возвращается flag с `intentToCancel: false`. На следующем
  refresh обычно уже подтянется как Acknowledged.
- **Multi-store**: STORE_INDEX = 1 хардкод (другие Walmart store_index'ы
  не используются — у нас только один Walmart account).
- **Cancellation-уровень line, а не order**: если у заказа несколько lines
  и кастомер отменил только одну — мы всё равно отменяем весь заказ.
  Walmart API позволяет line-level cancel, но Vladimir сказал «всё или
  ничего» для procurement.

---

## 📝 История
- **2026-06-07** — Vladimir's запрос: "перед тем, как мне закупать
  товар, мне нужно понимать, есть ли какие-то отмены, ну отмененные
  заказы клиентов". Реализация: 2 endpoint + банер. Reason
  `CUSTOMER_CHANGED_MIND` выбрано self-explicitly:
  «выбрать опцию, что клиент поменял свое мнение... Кастомер change mind,
  по-моему официально называется».
