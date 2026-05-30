# 🛒 Ship with Walmart — покупка этикеток для Walmart-заказов

## Суть
Walmart-заказы в модуле **Shipping Labels** покупают этикетки **напрямую через Walmart** (Ship with Walmart / SWW API), а не через Veeqo. Ключевое преимущество: покупка этикетки через Walmart **не ставит заказу статус Shipped** — он остаётся Acknowledged, и отметка «Shipped» делается отдельно (ночным кроном по факту движения посылки, либо вручную). У Veeqo так нельзя — он шлёт fulfillment в Walmart сразу при покупке.

**Amazon-заказы не тронуты** — они по-прежнему идут через Veeqo. Разделение по флагу `isWalmart`.

## Как заказ определяется как Walmart
Walmart-заказы приходят в Veeqo под именем магазина **«SIRIUS TRADING INTERNATIONAL LLC»** (НЕ «Walmart») — поэтому по названию канала определять нельзя. Вместо этого dashboard (`src/app/api/shipping/dashboard/route.ts`) сопоставляет Veeqo `order.number` (= Walmart **customerOrderId**) с таблицей `WalmartOrder` → получает **`walmartPurchaseOrderId`** и ставит флаг **`isWalmart`** на заказ.

## Поток в UI (`src/app/shipping/page.tsx`)
1. `load()` для каждого ready Walmart-заказа дёргает `POST /api/shipping/walmart/rates` и:
   - синтезирует PlanItem (тариф, цена, EDD, package) → строка рендерится тем же кодом, что Amazon;
   - сохраняет `walmartBuyInfo` (PO + carrier/service + dims) для покупки;
   - сохраняет `walmartStatus` (куплено/отгружено/трек).
2. **Кнопка Buy** для Walmart-строки → `POST /api/shipping/walmart/buy` (один клик; PDF → Google Drive; заказ остаётся Acknowledged).
3. **Ручной выбор тарифа** (клик по Carrier) → `WalmartPickRateDialog`: показывает тарифы **Walmart** + поле **ship date** (смена даты пере-котирует), выбор обновляет и показ, и то, что купится.
4. **После покупки** строка показывает «Label bought — <carrier> <tracking> · not yet marked shipped» + кнопку **Mark as Shipped** (`POST /api/shipping/walmart/mark-shipped`). Если заказ уже Shipped — «Shipped ✓».

## Габариты/вес — по «SKU + количество»
Тарифы требуют габариты. Резолвятся **тем же правилом, что Veeqo-план**:
- много товаров ИЛИ один SKU × количество>1 → **`PackingProfile`** по подписи `«SKU:qty»` (`buildPackingSignature`) — поэтому 7-пак ×1 и ×2 помнят **разные** коробки;
- один SKU × 1 → **`SkuShippingData`** (по SKU).
- `boxSize` (пресет «M»/«7×7×6» или «LxWxH») → числовые L/W/H через `src/lib/shipping/box-presets.ts` (`resolveBoxDimensions`).

Редактирование габаритов (Edit package → Save) пишет в ту же базу → в будущем подставляется автоматически для того же товара того же количества. Для Walmart `edit-package` **не дёргает Veeqo** (нет allocation — это не ошибка).

## Эндпоинты и код
| Путь | Назначение |
|------|-----------|
| `POST /api/shipping/walmart/rates` | тарифы Walmart + выбор алгоритмом; принимает `shipByDate`; возвращает `existingLabel`/`orderStatus` если уже куплено/отгружено |
| `POST /api/shipping/walmart/buy` | покупка (не ставит Shipped); PDF→Drive (full title); серверная защита от двойной покупки |
| `POST /api/shipping/walmart/mark-shipped` | ручная отметка Shipped по треку купленного лейбла |
| lib `src/lib/walmart/shipping.ts` | `estimateShippingRates`, `buyShippingLabel`, `getSwwCarriers`, `downloadLabelPdf`, `discardShippingLabel` |
| lib `src/lib/shipping/walmart-rate-selection.ts` | `selectBestWalmartRate` (дешёвый, попадающий в срок) |
| cron `src/app/api/cron/walmart-ship-confirm` | авто Mark-as-Shipped в **22:00 ET** когда посылка реально едет (по умолчанию **dry-run**) |

См. также: [Walmart API](walmart-api.md) (полная схема SWW), [Carrier Tracking APIs](carrier-tracking-apis.md), [Vercel deploy](../README) (деплой; аккаунт на Pro).

## Что подтверждено вживую (2026-05-30)
- Покупка этикетки через Walmart API — реальный выкуп прошёл, заказ остался Acknowledged; PDF = сырой %PDF (~187 КБ); discard работает.
- В UI Walmart-строки показывают тарифы Walmart (USPS Ground Advantage $10.53, FedEx Ground Economy $8.97 и т.п.), package по SKU+qty, EDD, маржу.

## Что осталось / на заметку
- Реальный «боевой» тест кнопок Buy/Mark-as-Shipped/ручного выбора тарифа в UI ещё не прокликан владельцем (код собран, `next build` проходит).
- Cron ship-confirm — в dry-run; владелец включит боевой режим (`?dryRun=false`), когда будет готов.
- Bulk «Buy selected» для Walmart — пока только построчная кнопка (Amazon-bulk без изменений).
- ⚠️ **Hobby-ловушка кронов:** sub-daily крон (`*/30`) на Hobby-плане Vercel отвергает ВЕСЬ деплой. Аккаунт переведён на **Pro** 2026-05-30 — теперь можно. См. [[project_vercel_deploy]].
