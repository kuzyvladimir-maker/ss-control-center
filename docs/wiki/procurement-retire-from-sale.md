# 🚫 Procurement — «Снять с продажи» (Walmart)

## Суть
На странице **/procurement** напротив каждого товара есть кебаб-меню (`⋮`).
В нём — пункт **«Снять с продажи (Walmart)»**. Открывает модалку, которая
ищет в каталоге Walmart **все SKU**, относящиеся к этому продукту
(Pack of 2, Pack of 4, Pack of 8, бандлы и т.д.), и позволяет одним кликом
обнулить инвентори по каждому или сразу по всем.

Зачем: когда поставщик перестал поставлять / прайс улетел / товар нельзя
больше закупить — нужно перестать его продавать на **всех** листингах,
а не только на том SKU, который пришёл в текущем заказе.

## Связано с
- [Procurement Module](procurement-module.md) — родительский модуль (если есть)
- `src/app/procurement/components/RetireFromSaleModal.tsx` — UI модалка
- `src/app/procurement/components/ProcurementCard.tsx` — кебаб-меню `⋮`
- `src/app/api/walmart/retire-listing/search/route.ts` — поиск по каталогу
- `src/app/api/walmart/retire-listing/execute/route.ts` — обнуление + audit
- `src/lib/procurement/clean-product-query.ts` — smart query cleaner
- [Walmart Catalog Cache](walmart-catalog-cache.md) — источник данных для поиска
- Jackie-инструменты `walmart_items_search` + `walmart_inventory_update` —
  тот же стек под капотом

---

## 🔁 Полный flow

```
[Procurement card]
       │ Vladimir жмёт ⋮ → «Снять с продажи»
       ▼
[RetireFromSaleModal opens]
   • Поле "Поиск в каталоге Walmart" — pre-filled cleaned query
       (cleanProductQuery() стрипает Pack/oz/lb/ct)
   • Автоматически запускается первый поиск
       ▼
[POST /api/walmart/retire-listing/search]
   • searchWalmartCatalogCache(query) — sub-second из WalmartCatalogItem
   • LEFT-JOIN на WalmartListingRetirement (только open rows) →
     alreadyRetired flag для каждой строки
       ▼
[Results list]
   • Per-row "Снять" button (disabled если alreadyRetired)
   • Footer "Снять все найденные (N)" с подтверждением
       ▼
[POST /api/walmart/retire-listing/execute]  (per SKU loop)
   • Walmart PUT /v3/inventory amount=0 (default ship node)
   • INSERT WalmartListingRetirement row (sku, title, reason,
     triggeredFrom=procurement:{PO}, searchQuery, retiredAt)
   • Per-SKU success/failure возвращается независимо
       ▼
[UI updates]
   • Успешные строки серятся, badge "Снят {date}"
   • Failed — красный inline error
```

---

## 🧠 Smart query cleaner

`cleanProductQuery(title)` стрипает шум, чтобы один title поймал все pack-варианты:

| Вход | Выход |
|---|---|
| `Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)` | `Stur Drinks Black Cherry, Liquid Water Enhancer` |
| `Maruchan Ramen Noodle Pork Flavor Soup, 3 oz Shelf Stable Package (Pack of 8)` | `Maruchan Ramen Noodle Pork Flavor Soup, Shelf Stable Package` |
| `Del Monte Peaches Sliced 8.5 oz (Pack of 6)` | `Del Monte Peaches Sliced` |
| `1UP Freeze Dried Sour Worms, 2.0 oz Resealable Bag (Pack of 4)` | `1UP Freeze Dried Sour Worms, Resealable Bag` |

Покрытые паттерны:
- `(Pack of N)`, `Pack of N`, `Set of N`, `Bundle of N`, `N-Pack`, `N Pack`, `N ct`, `N count`
- Sizes: `\d+(.\d+)?\s*(fl)?oz|lb|lbs|g|kg|ml|l`
- Cross-pack: `N x M oz`

Поле в модалке остаётся **редактируемым** — Vladimir может довести запрос
руками, если cleanup срезал что-то полезное или не срезал лишнее.

---

## 🎯 Умный фильтр каталога (rarity-weighted, two-tier)

> Введён 2026-06-30. До этого поиск матчил товар, если он содержал **любое**
> слово из запроса (`OR` по токенам) → generic-слова еды («snacks», «crackers»,
> «cheese», «baked») вытаскивали **100** плюс-минус похожих товаров разных
> брендов, и «Снять все найденные» грозило обнулить их все. Теперь —
> `searchWalmartCatalogCache` в `src/lib/walmart/catalog-cache.ts`.

**Как считается релевантность:**

1. **Rarity-веса (IDF).** Для каждого слова запроса считаем, в скольких
   товарах каталога оно встречается. Редкое слово (бренд `cheez`, вкус
   `cheddar`) → высокий вес и рулит матчем; частое filler-слово (`snacks`,
   `crackers`) → вес ≈ 0 и больше не создаёт ложных совпадений.
2. **Brand anchor = первое слово запроса.** Тайтлы всегда начинаются с бренда
   (`Cheez-It …`, `Nature's Own …`), поэтому `token[0]` надёжно = бренд.
   Все чужие бренды отсекаются.
3. **Signature = самое редкое НЕ-брендовое слово** (`puffed`, `butterbread`,
   `nacho`, `golden`). Именно оно отличает *настоящую вариацию* от
   соседа-однобрендовца, который отличается только этим словом
   (`Cheez-It Puff'd White Cheddar` vs просто `Cheez-It White Cheddar Crackers`;
   `Butterbread` vs `WhiteWheat`). Coverage сам по себе так не умеет — потеря
   1 слова из многих даёт лишь мелкую просадку.

**Два уровня (tier):**

| Tier | Условие | Показ в модалке |
|---|---|---|
| **primary** | phrase-match (тайтл содержит весь запрос) **ИЛИ** есть бренд + signature + coverage ≥ `PRIMARY_MIN` (0.5) | Список по умолчанию — «товар и вариации» (pack/multipack/бандлы) |
| **secondary** | есть бренд + coverage ≥ `SECONDARY_MIN` (0.25), но не primary | Свёрнуто за «Похожие товары этого бренда (N)» |
| dropped | остальное | Не показывается |

Пороги — константы `PRIMARY_MIN` / `SECONDARY_MIN` вверху `catalog-cache.ts`,
легко подкрутить (выше = уже primary-список).

**Проверено на реальном каталоге (3839 SKU, store1):**
- `Cheez-It Puff'd White Cheddar…` → primary = 3 pack-варианта (+ бандл),
  остальные 52 Cheez-It → secondary.
- `Nature's Own Butterbread…` → primary = 9 Butterbread, WhiteWheat/Keto → secondary.
- `Doritos Nacho Cheese…` / `OREO Golden…` → primary = только Nacho / только Golden.

**Безопасность массового действия:** «Снять все найденные» теперь бьёт **только
по primary-списку** — свёрнутые «похожие» в bulk не попадают. Пер-строчная
кнопка «Снять» работает на любой строке (в т.ч. в «похожих»).

Каждая строка primary/secondary несёт поле `tier` (`route.ts` прокидывает его
из кэша; live-путь помечает всё как `primary`, т.к. он и так строгий —
substring по всему запросу).

---

## 🛡️ Защиты от дублей и ошибок

| Защита | Где |
|---|---|
| **Already-retired greyed-out** | search endpoint джойнит WalmartListingRetirement WHERE rolledBackAt IS NULL; UI рендерит opacity-55 + badge «Снят» |
| **Bulk action requires confirm** | «Снять все найденные» → «Снять все N SKU? Да/Отмена» |
| **Per-SKU independent failure** | один 404 не блокирует остальные — UI красит только проблемную строку |
| **Audit row before action** | execute INSERT-ит до Walmart PUT? — **нет, после успешного PUT**, чтобы не залогать "сняли" если Walmart отверг |
| **Max 100 SKU per call** | hard cap в execute endpoint — защита от случайного «снять весь магазин» |
| **Search limit 100** | hard cap в search endpoint (primary + secondary суммарно) |
| **Bulk только по primary** | «Снять все найденные» targets только тесный primary-список; «похожие» (secondary) в bulk не входят — см. rarity-фильтр выше |

---

## 🗄️ Audit table: `WalmartListingRetirement`

```prisma
model WalmartListingRetirement {
  id            String   @id @default(cuid())
  sku           String
  storeIndex    Int      @default(1)
  itemId        String?
  productTitle  String?
  previousQty   Int?              // placeholder для rollback flow
  reason        String?           // free text от пользователя
  triggeredFrom String?           // "procurement:200014888886083"
  searchQuery   String?           // что было в поиске
  retiredAt     DateTime @default(now())
  rolledBackAt  DateTime?
  rolledBackBy  String?
  @@index([storeIndex, retiredAt])
  @@index([sku])
}
```

Зачем поля:
- **`searchQuery`** — чтобы потом понять «по какому запросу мы это поймали»; полезно если случайно зацепили не то
- **`triggeredFrom`** — связь с конкретным procurement заказом, который инициировал
- **`previousQty`** — оставлен `null` сейчас (Walmart не вернёт текущее qty в PUT-ответе), но поле есть для будущего: если построим rollback flow, можно перед PUT сделать GET /inventory и записать сюда старое значение
- **`rolledBackAt` / `rolledBackBy`** — для будущей кнопки «Вернуть в продажу»

---

## ⚠️ Известные ограничения

1. **Только default ship node.** Walmart PUT `/v3/inventory` без `shipNode`
   таргетит дефолтный node — у Vladimir Seller-Fulfilled (S2H) аккаунт с
   одним ship node, всё работает. Если когда-нибудь подключится WFS / 3PL
   или multi-warehouse — нужно будет loop-нуть по всем nodes из GET
   `/inventories`.
2. **Only Walmart.** Amazon Listings API patch для quantity=0 — отдельная
   история. Кебаб-меню скрывает пункт если `channel !== "Walmart"`.
3. **Catalog cache stale.** Поиск читает из `WalmartCatalogItem` который
   синхронизируется ночным кроном `/api/cron/walmart`. SKU созданный
   сегодня попадёт в поиск завтра. Workaround: Jackie умеет дёрнуть
   `walmart_catalog_refresh` руками.
4. **`previousQty` пока не пишется.** Чтобы записать — пришлось бы делать
   GET `/inventory` перед каждым PUT (ещё один API call). Решено: пока
   placeholder, добавим если/когда понадобится rollback.
5. **Нет rollback UI.** Поле в схеме готово, но кнопки «вернуть в продажу»
   ещё нет — добавим если возникнет реальный случай.

---

## 📝 Будущие улучшения (если зайдёт)

- **Rollback flow:** новая кнопка в audit log странице → «вернуть инвентори».
  Перед обнулением фиксировать previousQty через GET `/inventory`.
- **Audit log UI:** страница `/admin/walmart-retirements` со списком когда/что/почему.
- **Amazon parity:** аналогичный поток для Amazon листингов через
  Listings API `patchListingsItem` с `attributes.fulfillment_availability[].quantity = 0`.
- **Telegram уведомление в Walmart-чат** при каждой массовой операции
  (через `sendWalmartTelegram`) — для прозрачности команды.
