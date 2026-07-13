# Walmart write-тулы для Джеки (price + item content)

**Дата:** 2026-07-13 · **Статус:** shipped, dry_run проверен на живом API

## Что сделано

Три новых MCP-тула в `src/lib/jackie-mcp/tools/walmart-feeds.ts` + модуль цен
`src/lib/walmart/price.ts`. Регистрация — одна строка в `tools/index.ts`.

| Тул | write | Механизм |
|-----|-------|----------|
| `walmart_update_price` | ✅ | 1 SKU → синхронный `PUT /v3/price`; 2+ SKU → один bulk feed `POST /v3/feeds?feedType=price` (spec 1.7, до 1000 SKU за вызов) |
| `walmart_update_item` | ✅ | `MP_MAINTENANCE` partial feed (spec 5.0, тот же путь что multipack remediation). Меняет только переданные поля: title / description / key_features / attributes |
| `walmart_feed_status` | ❌ | `GET /v3/feeds/{feedId}?includeDetails=true` — статус + per-SKU ошибки ingestion |

## Ключевые факты (выяснено в этой сессии)

- **Креды:** Client ID + Client Secret (OAuth client_credentials, `POST /v3/token`),
  НЕ Consumer ID/Private Key. Env: `WALMART_CLIENT_ID_STORE1` / `WALMART_CLIENT_SECRET_STORE1`.
  Store1 = **SIRIUS TRADING INTERNATIONAL LLC** (sellerId 10001624309).
- **Тот же токен покрывает write:** `/v3/token/detail` показал full_access на
  `price`, `item`, `feeds`, `content`, `inventory` и всё остальное. Отдельный ключ НЕ нужен.
- Клиент (`src/lib/walmart/client.ts`) уже умеет всё нужное: headers, token refresh,
  429/5xx retry, rate-limit backoff.

## Guardrails (встроены в тулы)

- `dry_run=true` у обоих write-тулов — полный preview payload без вызова Walmart;
  у `walmart_update_item` в preview ещё и текущие live-значения (title/status/UPC/productType).
- Валидация цены: >0, ≤$10k, без дублей SKU; не прошло — ничего не уходит.
- **Brand-voice блок**: title/description/bullets прогоняются через
  `bundle-factory/compliance/banned-words.ts` (PROMOTIONAL + SALE_SHIPPING_CLAIM) + emoji-regex.
  Нарушения → отказ со списком, feed не отправляется. См. [[listing-quality-stack]].
- `walmart_update_item` никогда не трогает brand/price/UPC (brand → QARTH
  ERR_EXT_DATA_0101119; цена — только через price-тул). Ключи режутся на входе.
- QARTH-locked карточки: feed может «пройти успешно», но контент не изменится —
  сигнатура блокировки, см. [[walmart-quantity-confusion-fix]].
- Частичное применение фидов: `feedStatus` INPROGRESS не значит «ничего не легло» —
  см. [[walmart-feed-partial-settlement]].

## Проверено / не проверено

- ✅ tsc чистый; dry_run обоих тулов на живом SKU (RizwanX-815); live GET /items;
  brand-voice блок ловит emoji+promo+shipping-claim; валидация цены.
- ⚠️ Реальный (не-dry) PUT /v3/price ещё не выполнялся — первый боевой прогон
  сделать на 1 SKU с текущей ценой (no-op) или маленьким изменением, затем
  проверить в Seller Center.

## Как Джеки этим пользуется

1. `walmart_items_search` → найти SKU.
2. Write-тул с `dry_run=true` → показать оператору preview.
3. Тот же вызов с `dry_run=false` → применить.
4. Для feeds: `walmart_feed_status(feed_id)` через пару минут; для контента —
   ещё и глазами проверить живую карточку (QARTH).
