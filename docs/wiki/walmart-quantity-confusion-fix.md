# Walmart Quantity-Confusion Fix — Multipack Listing Remediation

> **Статус:** ПЛАН утверждён Владимиром (2026-06-12). Код ещё НЕ написан.
> Следующий шаг — пилот на 2 листингах → визуальная проверка Владимиром → весь каталог.

## Проблема (диагноз Владимира + жалобы клиентов)

Существенная доля возвратов на канале **Walmart** вызвана **quantity confusion** на
multipack-листингах. Наше главное фото визуально идентично штучному каталожному снимку
Walmart (напр. одна булка Nature's Own, одна пачка крекеров). Покупатель, которому нужно
3 пачки, ставит **quantity 3** — но у нас `quantity 1 = весь набор из N штук`, поэтому он
получает `3 × N` и оформляет возврат.

Корень: **нигде явно не написана формула «1 заказ = N пачек»** — ни на фото, ни в title,
ни в quantity-селекторе.

## Политика Walmart по изображениям (проверено 2026-06-12)

Источник: официальный Walmart Marketplace Learn (Image guidelines & requirements) + гайды 2026.

- **Главное (primary) фото:** ТОЛЬКО продукт на чистом белом фоне (RGB 255,255,255).
  **ЗАПРЕЩЕНЫ** любые text overlays, бейджи, графика, оверлеи, водяные знаки, логотипы,
  promo-формулировки. Нарушение → листинг снимают с публикации (unpublished) + удар по
  Content/Polaris score (completeness = 40% ранжирования). Единственное исключение —
  «pack bugs» для одежды (к еде не относится).
- **Дополнительные фото (позиции 2–10):** text overlays и инфографика **РАЗРЕШЕНЫ**.

⇒ Бейдж «N-PACK» на главном фото невозможен. Переезжает на фото #2.

## Утверждённое решение — 3 слоя (все compliant)

| # | Слой | Что делаем | Где |
|---|------|-----------|-----|
| 1 | **Главное фото** | Авто-композиция: из ОДНОГО чистого фото пачки программно собираем N копий на белом фоне (grid/кластер). Без единой надписи — честно показан реальный объём. Видно в поиске как thumbnail — там, где клиент сейчас обманывается. | primary image |
| 2 | **Фото #2 (инфографик-бейдж)** | Ярко подсвеченный бейдж: `N PACKS INCLUDED` + `1 order = N packages, not 1`. Текст здесь разрешён. | secondary image |
| 3 | **Title + bullets** | Явная формула количества: `… N-Pack (N packages per order)` в title; первый bullet: `Each order contains N packages. Quantity 1 ships all N.` Соблюдать brand voice (без promo-прилагательных и emoji — CLAUDE.md). | content |

**Выбор Владимира по слою 1:** авто-композиция из 1 фото (не искать официальные multipack-снимки).

## Источники данных в коде (ss-control-center/)

| Нужно | Где |
|-------|-----|
| Pack count (N) | `SkuShippingData.unitsInListing` (prisma) или `SkuCost.packSize` |
| Title / bullets / description / main_image_url | model `ChannelSKU` |
| Walmart itemId / published-статус | model `WalmartCatalogItem` |
| Текущее фото по SKU | `src/lib/veeqo/product-image.ts` → `fetchVeeqoImageBySku(sku)` |
| Walmart API клиент | `src/lib/walmart/client.ts` → `class WalmartClient(storeIndex)` |
| Публикация контента/фото | `src/lib/bundle-factory/distribution/walmart-publish.ts` → `submitToWalmart()` (feed `MP_ITEM_4.7`; сейчас шлёт пустой `productSecondaryImageURL[]` — сюда зайдёт бейдж) |
| Генерация контента (есть поле `pack_count`) | `src/lib/bundle-factory/content-generation.ts` |
| Хранилище картинок | R2 (Cloudflare), bucket `salutem-bundle-factory`, паттерн `prod/{slug}/...` |

## План реализации

1. **Добавить `sharp`** в `ss-control-center/package.json` (в зависимостях НЕТ; sharp — лёгкий, без проблем на Vercel). Для compositing/тайлинга и текстового оверлея бейджа.
2. **`src/lib/walmart/multipack/composite.ts`**
   - `composeTiledMainImage(singlePackUrl, packCount) → Buffer` — N копий на белом 2000×2000, ≥50% заполнения кадра, white RGB 255,255,255.
   - `renderBadgeImage(packCount) → Buffer` — фото #2, яркий бейдж `N PACKS INCLUDED` + формула.
   - Заливка результатов в R2, возврат public URL.
3. **`src/lib/walmart/multipack/content.ts`**
   - `rewriteMultipackContent(sku, packCount) → {title, bullets, description}` — форсит формулу количества, соблюдает brand voice + лимиты Walmart (title ≤75, bullet ≤500, 4–9 bullets).
4. **`scripts/diag-walmart-multipack-fixer.ts`** — пилот: 2 SKU, dry-run, генерит превью (главное фото + бейдж + новые тексты) в R2/локально для визуальной проверки Владимиром. БЕЗ публикации.
5. **После апрува Владимира** — прогон по всему multipack-каталогу Walmart через `submitToWalmart()`.

## Процесс (установил Владимир)

1. Разработать дизайн бейджа (#2) + макет собранного главного фото.
2. Экспериментально на **2 листингах** — показать визуально картинки И новые тексты.
3. **Только после визуального утверждения** — весь каталог. НЕ массово-обновлять до sign-off.

## Открытые вопросы к следующей сессии

- Выбрать 2 пилотных SKU (брать с самым высоким числом возвратов, если есть данные по returns по SKU).
- Дизайн бейджа: цвет/контраст, размещение (угол vs нижняя лента), точная формулировка.
- Проверить, что `submitToWalmart()` корректно принимает непустой `productSecondaryImageURL[]` и обновление главного фото без пересоздания листинга (MP_ITEM как upsert по SKU).
