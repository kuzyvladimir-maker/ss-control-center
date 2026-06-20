# Walmart Quantity-Confusion Fix — Multipack Listing Remediation

> **Статус:** Движок изображений РЕАЛИЗОВАН и утверждён Владимиром визуально
> (2026-06-12). Главное фото генерится. Заливка на Walmart + отбор hero-фото для
> полного каталога — ещё впереди. Следующий шаг: прогон 5-7 доп. товаров на
> проверку → потом весь каталог.

## ОБНОВЛЕНИЕ 2026-06-12 — что реализовано (Вариант А, утверждён)

Сравнили два пути генерации главного фото:
- **Вариант Б (GPT Image, image→image):** ОТКЛОНЁН. Коверкает текст этикеток
  («LYTE AREACED», «MANGO BARILS»), не держит число копий, ~$0.04/шт, врёт на
  реальном продукте. Годится только для товаров без мелкого текста.
- **Вариант А (детерминированный композитинг через `sharp`):** ПРИНЯТ. Бесплатно,
  точно, реальный продукт.

Движок (`src/lib/walmart/multipack/composite.ts`):
1. **Smart cutout** — flood-fill белого фона от краёв в прозрачность (внутренний
   белый — крышка/этикетка — сохраняется), затем **keep-largest connected
   component**: оставляем только самый большой связный объект, отсекая вшитые в
   исходник инфографики/плашки (напр. «5g protein» у Bush's).
2. **Чистая сетка** — 2 ряда (4=2+2, 6=3+3, 7=4+3, 8=2×4), БЕЗ нахлёста, заметный
   зазор по горизонтали И вертикали, продукты заполняют ~95% кадра.
3. **Высокое разрешение** — `highResImageUrl()` срезает thumbnail-параметры
   Walmart CDN (`?odnHeight=180...`) → тянем полноразмер (2200px+).
4. Контент-слой (`content.ts`) — формула количества в title/буллетах. Бейдж
   (`renderBadgeImage`, Walmart-синий) для фото #2 — опционально.

Параметры визуала, утверждённые Владимиром: НЕ в один ряд (всегда 2 ряда для ≥4);
зазор виден; без тени (тень делала хуже); заполнение ~95%.

Пилот-скрипт: `scripts/diag-walmart-multipack-fixer.ts` (dry-run, пишет превью в
`preview-multipack/`, ничего не публикует). Прогнан на 6 разных товарах — ОК.

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

## Связано с
- [Walmart quantity inquiry](walmart-quantity-inquiry.md) — клиентские вопросы про количество
- [Walmart restrictions](walmart-restrictions.md) — правила площадки по контенту и фото
