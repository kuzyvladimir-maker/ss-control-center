# 🚚 Carrier Tracking APIs

## Суть

Прямая интеграция с tracking API перевозчиков (UPS сейчас; FedEx и USPS в
планах) — чтобы получать **реальный carrier-sourced ETA** и полную ленту
событий. Без этого Customer Hub вынужден использовать Amazon's
`LatestDeliveryDate` (замороженный в момент покупки) или не иметь даты
вообще.

## Зачем это нужно

**Реальный кейс Deborah (T21, 2026-04-11).** Клиент купил Next Day
shipping, мы отправили UPS Ground. Amazon's `LatestDeliveryDate` = 2026-04-11.
UPS сайт показывает новую дату = 2026-04-15. Veeqo `/shipments/:id`
дату **не возвращает**. Без прямого UPS API наш AI-ответ цитировал
неправильную дату (11 апреля), и это видно клиенту.

С UPS Tracking API: enricher теперь дёргает `GET /api/track/v1/details/{tracking_number}`,
получает `deliveryDate[{type: "RDD"}]` = 2026-04-15, кладёт в
`carrierEstimatedDelivery`, и T21 template подставляет корректную дату.

## UPS

### Регистрация
1. developer.ups.com → создать app «SS Control Center»
2. Billing Account: WE1301
3. Products: **Tracking** + **Authorization (OAuth)**
4. Callback URL: пустой (используем server-to-server client_credentials)

### .env
```
UPS_CLIENT_ID=...
UPS_CLIENT_SECRET=...
UPS_ENV=production   # → onlinetools.ups.com
```

### Auth flow
OAuth 2.0 `client_credentials` grant:
- `POST /security/v1/oauth/token` с `Authorization: Basic <base64(client_id:client_secret)>`
- Body: `grant_type=client_credentials`
- Возвращает `access_token` на ~1 час

Кэшируем токен in-process на 55 минут в
[ups-tracking.ts](../../ss-control-center/src/lib/carriers/ups-tracking.ts)
через `getUpsAccessToken()`.

### Tracking endpoint
`GET /api/track/v1/details/{trackingNumber}`

Headers: `Authorization: Bearer <token>`, `transId` (уникальный per-request),
`transactionSrc: ssccenter`.

### Полезные поля ответа
```
trackResponse.shipment[0].package[0]
  .currentStatus.description       → "In Transit", "Delivered", etc.
  .deliveryDate[]
     { type: "RDD", date: "20260415" }    ← Rescheduled (самая свежая)
     { type: "SDD", date: "20260411" }    ← Scheduled (оригинал)
     { type: "DEL", date: "20260415" }    ← фактическая (когда delivered)
  .activity[]
     { date, time, status{type,description}, location{address{city,...}} }
```

Приоритет для `carrierEstimatedDelivery`:
1. RDD (Rescheduled — самая свежая carrier-promised)
2. SDD (Scheduled)
3. `null` если ни того ни другого

### Что кладётся в DB
- `BuyerMessage.carrierEstimatedDelivery` — ISO date (YYYY-MM-DD)
- `BuyerMessage.actualDelivery` — если UPS сказал delivered
- `BuyerMessage.trackingStatus` — "delivered" | "in_transit" | "exception"
- `BuyerMessage.trackingEvents` — JSON массив всех событий (earliest first)

### Как это используется в prompt
[message-analyzer.ts](../../ss-control-center/src/lib/customer-hub/message-analyzer.ts)
`buildContextMessage` рендерит `trackingEvents` как отдельный блок:

```
CARRIER TRACKING EVENTS (direct from carrier API — chronological):
  - 2026-04-03 09:15: Origin Scan @ Tampa, FL
  - 2026-04-04 14:30: Departed Facility @ Orlando, FL
  - 2026-04-12 06:20: Out For Delivery Today @ Fort Lauderdale, FL
  ...
```

Модель видит всю историю, а не только финальное «in_transit» поле.

## FedEx

### Регистрация
1. developer.fedex.com → создать project «SS Command Center»
2. APIs: **Tracking API** (Basic Integrated Visibility, бесплатно)
3. Production Key получаешь сразу, дневной лимит 100,000 запросов

### .env
```
FEDEX_CLIENT_ID=...
FEDEX_CLIENT_SECRET=...
FEDEX_ENV=production   # → apis.fedex.com
```

### Auth flow
OAuth 2.0 `client_credentials` (отличается от UPS — credentials передаются
в body, а не Basic header):
- `POST /oauth/token`
- Body: `grant_type=client_credentials&client_id=...&client_secret=...`
- Header: `Content-Type: application/x-www-form-urlencoded`
- Возвращает `access_token` на ~1 час, scope = `CXS-TP`

Кэш токена в [fedex-tracking.ts](../../ss-control-center/src/lib/carriers/fedex-tracking.ts)
`getFedexAccessToken()`, TTL 55 минут.

### Tracking endpoint
`POST /track/v1/trackingnumbers`

Headers: `Authorization: Bearer <token>`, `X-locale: en_US`,
`Content-Type: application/json`.

Body:
```json
{
  "includeDetailedScans": true,
  "trackingInfo": [
    {"trackingNumberInfo": {"trackingNumber": "..."}}
  ]
}
```

### Полезные поля ответа
```
output.completeTrackResults[0].trackResults[0]
  .latestStatusDetail.description       → "In transit", "Delivered"
  .latestStatusDetail.code              → "IT", "DL", "PU", ...
  .estimatedDeliveryTimeWindow.window   → {begins, ends}  ← самый свежий ETA
  .standardTransitTimeWindow.window     → fallback
  .dateAndTimes[]                       → [{type, dateTime}]
     type: "ACTUAL_DELIVERY", "ESTIMATED_DELIVERY", "ACTUAL_PICKUP", ...
  .scanEvents[]                         → [{date, eventDescription, scanLocation, eventType}]
```

Приоритет для `carrierEstimatedDelivery`:
1. `estimatedDeliveryTimeWindow.window.ends` (самый свежий)
2. `dateAndTimes[].type === "ESTIMATED_DELIVERY"`
3. `standardTransitTimeWindow.window.ends`

### Объединение в enricher

Секция 5c в `message-enricher.ts` теперь обрабатывает оба карьера через
один блок:
```ts
let carrierLookup: "ups" | "fedex" | null = null;
if (carrierBlob.includes("UPS")) carrierLookup = "ups";
else if (carrierBlob.includes("FEDEX")) carrierLookup = "fedex";

const info = carrierLookup === "ups"
  ? await getUpsTracking(...)
  : await getFedexTracking(...);
```

Оба клиента возвращают одинаковую форму (`TrackingInfo`), так что enricher
обрабатывает результат единообразно.

## USPS

### Регистрация
1. developer.usps.com → Apps → создать app для **Tracking API v3**
2. Получаешь Consumer Key (Client ID) + Consumer Secret

### .env
```
USPS_CLIENT_ID=...
USPS_CLIENT_SECRET=...
USPS_ENV=production
```

### Auth flow
OAuth 2.0 `client_credentials`, как у FedEx (credentials в body):
- `POST /oauth2/v3/token`
- Body: `grant_type=client_credentials&client_id=...&client_secret=...`
- Возвращает `access_token` (~1 час), кэш в
  [usps-tracking.ts](../../ss-control-center/src/lib/carriers/usps-tracking.ts)
  `getUspsAccessToken()`

### Tracking endpoint
`GET /tracking/v3/tracking/{trackingNumber}?expand=DETAIL`

`expand=DETAIL` возвращает полную ленту scan events, без него — только
последний summary. Header: `Authorization: Bearer <token>`.

### Полезные поля ответа
```
{
  trackingNumber,
  statusSummary,            → "Delivered", "In Transit"
  statusCategory,           → "Delivered", "Pre-Shipment", "In-Transit"
  expectedDeliveryDate,     → "2026-04-15"  ← carrier ETA
  expectedDeliveryTimeStart,
  expectedDeliveryTimeEnd,
  actualDeliveryDate,       → present once delivered
  trackingEvents: [
    {
      eventType,            → "DELIVERED", "ARRIVAL_AT_UNIT", "ACCEPT_OR_PICKUP"
      eventCode,
      eventTimestamp,       → "2026-04-15T14:32:00"
      eventCity, eventState, eventCountry,
      eventDescription
    }
  ]
}
```

### Обнаружение USPS в enricher
`message-enricher.ts` секция 5c определяет USPS по подстрокам в
`carrier` или `service`:
- `USPS`
- `PRIORITY MAIL`
- `FIRST CLASS`
- `GROUND ADVANTAGE`

Это покрывает все варианты Veeqo service_name.

## DHL (план)

- **DHL Shipment Tracking Unified API** — бесплатно до 250 запросов/день,
  через developer.dhl.com. Добавится по той же схеме когда понадобится
  (сейчас у нас почти нет DHL отгрузок).

## Связанные файлы

- [src/lib/carriers/ups-tracking.ts](../../ss-control-center/src/lib/carriers/ups-tracking.ts) — UPS клиент
- [src/lib/carriers/fedex-tracking.ts](../../ss-control-center/src/lib/carriers/fedex-tracking.ts) — FedEx клиент
- [src/lib/carriers/usps-tracking.ts](../../ss-control-center/src/lib/carriers/usps-tracking.ts) — USPS клиент
- [src/lib/customer-hub/message-enricher.ts](../../ss-control-center/src/lib/customer-hub/message-enricher.ts) — секция 5c
- [src/lib/customer-hub/message-analyzer.ts](../../ss-control-center/src/lib/customer-hub/message-analyzer.ts) — buildContextMessage
- [prisma/schema.prisma](../../ss-control-center/prisma/schema.prisma) — `BuyerMessage.trackingEvents`

## 🔗 Связи

- **Часть:** [Customer Hub Decision Engine](customer-hub-decision-engine.md)
- **Зависит от:** UPS / FedEx / USPS developer portals
- **Влияет на:** точность `carrierEstimatedDelivery` → точность T21/T1/T3 ответов

## История
- 2026-04-11: Статья создана. UPS Tracking API подключен — OAuth
  client_credentials, endpoint `/api/track/v1/details/`, кэш токена
  55 минут, карта `deliveryDate[].type` (RDD/SDD/DEL) → наш
  `carrierEstimatedDelivery`. Смоук-тест OAuth прошёл (HTTP 200).
- 2026-04-11: USPS Tracking API v3 подключен. OAuth client_credentials
  через `apis.usps.com/oauth2/v3/token`, endpoint
  `GET /tracking/v3/tracking/{number}?expand=DETAIL`. Смоук-тест прошёл
  (HTTP 200, JWT с entitlements OMAS+FAST). Enricher обнаруживает USPS
  по подстрокам `USPS / PRIORITY MAIL / FIRST CLASS / GROUND ADVANTAGE`.
- 2026-04-11: FedEx Tracking API подключен. OAuth client_credentials с
  credentials в body (отличается от UPS Basic auth), endpoint
  `POST /track/v1/trackingnumbers`, scope `CXS-TP`. Дневной лимит
  100,000 запросов. Смоук-тест прошёл (HTTP 200, scope подтверждён).
  Секция 5c enricher объединена: один блок выбирает UPS или FedEx
  по `carrier` строке. `FedexTrackingInfo`/`FedexTrackingEvent` =
  алиасы `UpsTrackingInfo`/`UpsTrackingEvent` чтобы enricher работал
  единообразно.
