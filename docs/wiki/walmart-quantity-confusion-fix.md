# Walmart Quantity-Confusion Fix — Multipack Listing Remediation

> **Статус:** Wave 1 отработала (июнь), **аудит выявил 82/765 (10.7%) брака** —
> selector брал не то фото. Селектор перестроен и **задеплоен 2026-06-30/07-01**;
> идёт перечинка браков. См. свежий блок ниже.

## 🆕 СЕССИЯ 2026-06-30/07-01 — перестройка селектора + генерация vs вырезание

**Диагноз (аудит 765 опубликованных главных фото строгим vision):** 683 ок, **82 брака** —
33 «сервировка» (тарелка супа вместо банки, как Progresso), 49 «прочее» (оборот/nutrition/
инфографика). Композит всегда тайлит ровно N, поэтому ошибок количества — 0.

**Корень (подтверждён Владимиром на примерах):** прошлый picker (`pickFrontRanked`, Haiku)
**не различал** у мягких упаковок (хлеб) настоящий вертикальный ФРОНТ от лежачего торца/среза
и от оборота-с-баркодом → тайлил торец/оборот/nutrition/инфографику/сервировку.

**Решение генерация vs вырезание (head-to-head, 8 SKU):** генерация gpt-image-2 ~192с/шт
(vs ~0.7с композит, ~270×) + таймауты на параллели → **композит остаётся основным движком,
генерация = ручной опциональный рычаг** (для «нет фото»). Память: `feedback_walmart_multipack_generation_vs_cutout`.

**Что задеплоено (main):**
- `src/lib/sourcing/vision.ts` — `classifyProductPhoto` (Sonnet `claude-sonnet-4-6` + явные
  правила «баркод=оборот», «лежит=не годится»), `pickBestFront` (лучший вертикальный
  одиночный фронт), `mainImageAcceptable` (keep/replace: лежачее/оборот/сервировка НЕ ок),
  усиленный `verifyMainImage` (бракует лежачее/сервировку + сверяет счёт). Commit `eab7f41`.
- `src/lib/walmart/multipack/remediate.ts` — использует `pickBestFront` + **keep/replace**
  (не churn-им хорошее, чиним только плохое); пул расширен на ВСЕ источники RetailPrice.
- `src/lib/sourcing/enrich.ts` — **Шаг 3: мультиритейлер-фолбэк** BlueCart→Target→Sam's→Costco
  (Unwrangle) при промахе; `storeOffers` хранит retailer/sourceApi. Commit `46af9d9`.

**Правила от Владимира (память `feedback_walmart_donor_photo_selection`):** брать ТОЛЬКО
вертикальный фронт с этикеткой; хард-реджект back/nutrition/инфографика/лайфстайл/лежачий торец;
«уже хорошее» не трогать; в первую очередь чинить не-фронтовые.

**Задеплоено дополнительно (эта сессия, всё verified):** flavor-match + whiteBg в селекторе
(`pickBestFront(urls,{listingTitle})` — Nissin брал Teriyaki на оранжевом → теперь Korean Spicy
Beef на белом); first-party-only в `ensureDonorImage` (резал наш STARFIT self-ref); `forceImage`
(на перечинке всегда меняем фото — keep/replace держал старый пре-фикс тайл); ручной gen-рычаг
(кнопка + `/generate-image` + `/apply-generated`).

**A-to-Z ПРОВЕРЕНО работает:** full-scope прогон дал 6 фото галереи + 7 буллетов + описание
~1300 симв. (Nissin/3489/3780). Правило (память `feedback_walmart_remediation_a_to_z`): каждый
листинг чинить A-to-Z за один проход, НИКОГДА image-only.

**⚠️ ГЛАВНЫЙ УРОК / что НЕ доделано:** прямой bulk-submit из скрипта ловит **Walmart 429
(REQUEST_THRESHOLD_VIOLATED)** — фиды надо слать МЕДЛЕННО через штатный воркер (крон, 3/tick,
INTER_SKU_MS), а не пачкой. Из 12 A-to-Z прошло 3, остальные 429. Реальный масштаб проблемы —
**~1857 непочиненных мультипаков** (не 82; 82 = брак среди уже-починенных). 

**СЛЕДУЮЩАЯ СЕССИЯ:** (1) перегнать 82 → потом 1857 A-to-Z через ВОРКЕР с `forceImage` (без 429);
(2) **QC-консоль** в Walmart Grow (просмотр было/стало + комментарий + «на переделку» + кнопка
запуска волн — Владимир рулит); (3) слой АТРИБУТОВ в payload (Walmart-рекоменд., Шаг 4, пересекается
с параллельной сессией по KB); (4) DonorProduct write-through + vision-identify.

---

> **Статус (истор., июнь):** Движок изображений РЕАЛИЗОВАН и утверждён Владимиром визуально
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

---

## Сессия 2026-07-01 — самопроверяющийся пакетный движок + починка 82 брака A-до-Я

**Контекст:** re-run 82 «бракованных» (уже чиненых, но с плохим фото/пустым текстом) выявил два системных изъяна и потребовал зашить в движок самопроверку.

**Найдено и починено:**
1. **Walmart 429 (`REQUEST_THRESHOLD_VIOLATED`)** — отправка по одному feed на SKU (даже с паузой 28с) теряла 2/3 отправок. Фикс: `buildAndSubmitMany()` пакует много SKU в ОДИН MP_MAINTENANCE feed (MPItem — массив) + повтор feed-а при throttle с backoff. Результат: 82 → 6 feed-ов, **79 submitted / 0 failed** (было 8/12 fail).
2. **Голые листинги** — половина выходила без буллетов/описания, т.к. polish был за гейтом «донор дал контент». Фикс: `buildAndSubmitOne` теперь ВСЕГДА полирует, когда контент в scope (title-only копия если донор тонкий); `polishListingCopy` повторяет 3× — один сбой Anthropic не оставит пустой листинг. `polish.ts` разрешает фактическую title-only копию.
3. **Самопроверка прогона (запрос Владимира)** — `buildAndSubmitMany` гоняет **canary** на первых N (по умолч. 6) и **прерывает весь прогон**, если движок не отдаёт контент (порог 50% text-health), НЕ трогая остальные — чтобы прогон на 1000-2000 SKU не спалил лимиты/квоту на брак. Canary судит по text-health (не по идеалу), чтобы пара сложных SKU без фото не завалила здоровый прогон. `assessRemediation()` = `{full, textOk, imageOk}`.

**Ключевые функции** (в `src/lib/walmart/multipack/remediate.ts`):
- `buildAndSubmitMany(db, client, skus, opts)` — единая точка входа для мульти-SKU (CLI, sweep, кнопка «Запустить» в модуле). buildOnly → батч-submit → лог.
- `buildAndSubmitOne(..., {buildOnly})` — собирает MPItem без отправки (для батчинга).
- `submitFeedBatch(client, mpItems)` — ОДИН feed на много MPItem, retry-on-throttle (export для worker).
- `assessRemediation(meta)` — грейд полноты (canary/лог/галерея).

**Результат 82:** 75 полностью A-до-Я (фото+текст) · 3 «текст готов, нужно фото» (нет донор-фото лицом, только композит не того размера) · 1 на переделку (polish 3× fail) · 3 SKIP (нет донора). Превью-галерея (фото+галерея+буллеты+описание, без Walmart-лага) собирается `_gallery82.ts` → R2 `walmart-review/`.

**Состояние модуля Walmart Grow (важно — цель Владимира):** движок фиксов уже ЖИВЁТ в модуле — фоновый рабочий `/api/cron/walmart-remediation-worker` вызывает те же `buildAndSubmitOne`/`polish`, значит no-BARE + retry **уже задеплоены в модуле** (`e79b2ff`). Каркас UI (`ListingOptimizer.tsx`): worklist + фильтры + кнопка «Запустить» (в очередь) + прогресс + before/after цифрами — ЕСТЬ.

**Осталось доделать модуль (не rebuild — доработка):**
1. **QC-экран в модуле** — кликнул листинг → фото ДО/ПОСЛЕ + сгенерированный текст → комментарий → кнопка «на переделку». Сейчас only цифры. Галерея `_gallery82` = прототип этого экрана. Требует персиста сгенерированного контента (title/bullets/desc/gallery) в `WalmartListingRemediation` (сейчас хранятся counts + mainImageUrl, не текст).
2. **Батчинг рабочего** — worker шлёт 1 feed/SKU; переключить на `submitFeedBatch`. БЛОКЕР: нужен per-item finalize feed-статуса (checkFeed читает только `[0]`), т.к. ~половина карточек QARTH-locked → смешанный feed нельзя финализировать по агрегату.
3. **Живой прогресс списком** + ATTRIBUTES-слой (Walmart-recommended) в payload.

**Правила в память:** [[feedback_self_verify_long_runs]] (canary+health guard), [[feedback_walmart_remediation_a_to_z]] (всегда A-до-Я).

---

## Сессия 2026-07-01 (часть 2) — исправления галереи + СЛОЙ АТРИБУТОВ

**Владимир поймал в галерее 82 два изъяна (починены, `f90279a`):**
1. Плашка «A-to-Z ✓» врала при отсутствующем ГЛАВНОМ фото (считалось «фото есть», если есть галерея). `assessRemediation` теперь требует `mainImageUrl` конкретно; `full = main + gallery(≥2) + text`; добавлен `galleryOk`.
2. Галерея пустая при тонком доноре. Пул фото строится ОДИН раз, галерея тянется из ПОЛНОГО пула (все собранные фото), а не только donor.images → Campbell's 0→6 фото. Тонкие доноры честно помечаются «мало фото».
- Осталось: ~8-12 листингов реально без чистого фронт-фото у Walmart (только композит/сервировка) → нужна генерация gpt-image-2.

**АТРИБУТЫ WALMART — спека получена, слой построен.**
- Спека: Seller Center → Add Items → Bulk Item Setup → Download Spec (**MP_ITEM 5.0**). API `/items/spec` = 404 (Walmart через API её не отдаёт); работает `/items/taxonomy` (только категории). Владимир скачал template (Food + 15 подкатегорий), дал 3 CSV. Дистилляция → `docs/marketplace-rules/walmart/mp-item-food-attributes.md`.
- **Ключ — quantity trio:** `multipackQuantity`=N, `countPerPack`=1, `count`(Total Count)=N. Системный (не только визуальный) фикс путаницы «заказал 1 — пришло N». Для наших бандлов = «6-pack labeled for individual sale».
- Модуль `src/lib/walmart/multipack/attributes.ts` (`buildFoodAttributes`): quantity trio из packCount + ВСЁ из донор-specs (значения донора взяты с Walmart → валидны). SAFE (free-text) vs CLOSED (enum, `includeClosed:false` чтобы снять при отказе).
- Проверено build-only: Hunt's tomato paste → 12 атрибутов, POWERADE → 10 (ingredients, manufacturer=Coca-Cola, flavor, containerType, netContent). Живой feed-тест на приёмку closed-list — в процессе.
- Подключено в payload за `scope.attributes`; `attributesCount` в meta. **ALL_SCOPE.attributes пока false — включить в default ПОСЛЕ подтверждения приёмки Walmart.**
- Философия Владимира: чем больше атрибутов, тем лучше индексация/поиск → заполнять максимум из донора.
- `brand` НЕ шлём (QARTH `ERR_EXT_DATA_0101119`). `pieceCount` только для баскетов из РАЗНЫХ предметов, не наши.

**Цель сессии (Владимир, ушёл спать):** «добивай основную цель до конца» = доделать модуль Walmart Grow автономно. Порядок: атрибуты (тест+deploy) → QC-экран в модуле → no-main генерация → батчинг worker → полный каталог.

### Итог автономной сессии (ночь 2026-07-01)

**Атрибуты — протестированы на живых feed-ах, включены (`3647bd8`).**
- Per-item feed-тесты (`checkFeedItems` — новая функция, читает ВСЕ items, не только `[0]`) выявили точную причину отказов:
  - **CLOSED-list** значения enum-отбиваются per productType (`containerType`, `foodForm`, `food_condition`, `container_material`, `texture`) — даже те, что в спеке помечены «Alphanumeric». → в CLOSED_MAP, по умолчанию НЕ шлём.
  - `productNetContentUnit`/`Measure` → «not a valid field» для MP_MAINTENANCE → удалены.
  - `productLine` → нужен JSONArray (не строка) → удалён (добавить array-handling позже).
  - `QARTH` (compliance review) — отдельная блокировка item-а, НЕ связана с атрибутами (Campbell's).
- **SAFE-набор (подтверждён — не в списке ошибок):** quantity trio (`multipackQuantity`/`countPerPack`/`count`) + `ingredients`, `manufacturer`, `flavor`, `size`, `netContentStatement`, `foodAllergenStatements`, `manufacturerPartNumber`. `ALL_SCOPE.attributes=true`.
- Правило: значения донора = с Walmart, но CLOSED-list всё равно отбиваются (донор даёт DISPLAY-имя/значение, а feed хочет точный enum). Только free-text SAFE.

**QC-экран в модуле готов (`b34384f`).** ListingOptimizer → раскрыть листинг → «Review fix»:
- показывает сгенерированный результат из persisted-контента (persist в batch-driver И worker): фото ДО/ПОСЛЕ + галерея + title + буллеты + описание + чипы атрибутов, БЕЗ Walmart-лага.
- поле заметки + «Send back for re-do» → `POST /api/walmart/growth/remediation/review` re-enqueue full A-to-Z + `forceImage` + заметка; worker теперь читает `result.forceImage`.

**KB из гайда Walmart (`b34384f`)** — 3 агента изучили marketplacelearn + developer docs → `docs/marketplace-rules/walmart/kb/`: item-setup-and-integration (OAuth, feeds, MP_MAINTENANCE, **rate limit ~10 feeds/час** — подтверждает батчинг), content-and-listing-quality (LQ score, image/title specs, variants), feeds-maintenance-and-errors (lifecycle, per-item статусы, error-каталог). QARTH = наш внутренний алиас для compliance-lock, не官 Walmart-термин.

**82 re-run с атрибутами** — запущен (`b1lxpitpd`). После завершения: poll feed-ов на приёмку атрибутов + пересбор галереи.

**НА ПАУЗЕ (ждёт Владимира):** полный каталог ~1857 — НЕ запускать автономно, он хотел сначала оценить 82. No-main генерация (~12 SKU без чистого фронт-фото) — ручной рычаг «Generate AI image» в модуле, НЕ авто (по правилу [[feedback_walmart_multipack_generation_vs_cutout]]).
