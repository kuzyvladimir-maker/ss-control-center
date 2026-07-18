# HANDOFF — Sourcing Engine: COGS (себестоимость) + Donor/Reference Catalog Enrichment

**Для:** Codex (передаётся владельцем Владимиром)
**От:** COGS-чат (Claude), сессия 2026-07-08 … 2026-07-13
**Дата:** 2026-07-18
**Репозиторий:** `ss-control-center` (ветка `main`, деплой Vercel из main). Рантайм-БД = **Turso** (libsql), НЕ локальный dev.db.

---

## 0. Одной фразой

Один общий движок «**identify product → find it at real retailers → build a donor record → roll up its cost**» даёт ТРИ выхода:
1. **COST (себестоимость / COGS)** — истинная закупочная цена каждого SKU нашего живого каталога.
2. **CONTENT (обогащение донорского каталога)** — товар-центричная база с полным контентом: фото/галерея, описание, состав, пищевая ценность, UPC, атрибуты, **ссылки на источник**.
3. **WHERE-TO-BUY** — по каким ретейлерам и почём товар реально покупается (для закупки).

> **Владимир, твоё понимание верное, но это ПОЛОВИНА.** «Справочный донорский каталог с наименованиями, полной инфо, фото и ссылками» — это выход №2 (CONTENT). Но ТОТ ЖЕ движок одновременно считает и №1 (COST/себестоимость). Их нельзя разделять: чтобы узнать себестоимость, надо найти товар у ретейлера — а раз нашли, забираем ВЕСЬ контент за тот же платный запрос («не жечь кредит зря»). Поэтому этот чат про **и каталог, и себестоимость** сразу.

---

## 1. Архитектура (конвейер)

```
SKU (наш листинг Amazon/Walmart)
  │
  ├─(1) IDENTIFY — по фото листинга + тайтлу понять, ЧТО это за товар (бренд/линия/вкус/размер/упаковка)
  │         src/lib/sourcing/identify.ts  → askVisionJson() (vision.ts, роутер по подпискам)
  │
  ├─(2) RETAIL SEARCH — найти этот товар у реальных ретейлеров (Walmart/Target/Sam's/Costco/Publix)
  │         src/lib/sourcing/donor-catalog.ts :: enrichTarget()
  │         src/lib/sourcing/retail-fetch.ts  (scoreOffer, extractPackSize, 3P-seller detection)
  │
  ├─(3) HARVEST DETAIL — забрать ПОЛНЫЙ контент донора (галерея ≥5 фото, описание, состав,
  │         пищевая ценность, UPC, атрибуты) + бесплатно дообогатить нутриенты из Open Food Facts
  │         src/lib/sourcing/donor-catalog.ts :: harvestDonorDetail()
  │
  ├─(4) COST ROLL-UP — построить «рецепт» SKU (bill-of-materials) и посчитать себестоимость по лестнице тиров
  │         src/lib/sourcing/cogs-engine.ts :: costOneSku(), cheapestCostForTarget()
  │
  └─ выходы пишутся в Turso (см. §3)
```

### Ключевые файлы

| Файл | Что делает |
|---|---|
| `src/lib/sourcing/cogs-engine.ts` | Ядро костинга: `costOneSku`, `cheapestCostForTarget`, `nextUncostedWalmartSkus`, `enrichPrioritySkus`, `amazonSkus`. Лестница тиров (см. §4). `brandTokens()`, `FORM_MARKERS`. |
| `src/lib/sourcing/donor-catalog.ts` | `enrichTarget` (эскалация Walmart→Target→Publix→клубы), `harvestDonorDetail` (детейл + `fetchOpenFoodFacts`), `strictHit()` (строгий предикат совпадения), `cleanupOrphans`, `dedupeOffersPerRetailer`. |
| `src/lib/sourcing/identify.ts` | `runIdentify` — распознавание товара по фото/тайтлу через единый vision-роутер. |
| `src/lib/sourcing/vision.ts` | Общий vision-роутер (сосед-чат тоже им пользуется): взвешенные линии Gemini/Codex/Claude, балансировка, circuit-breaker, `askVisionJson()`. **Только ПОДПИСКИ, не платный API.** |
| `src/lib/sourcing/retail-fetch.ts` | `scoreOffer`, `extractPackSize` (Units/NxM/Lot of N/2x/Set of N), детект 3P-продавца по каждому ретейлеру (`SELF_SELLER`). |
| `src/app/api/cron/reference-enrichment-worker/route.ts` | Vercel-крон (*/2 мин): дренирует очередь `EnrichmentJob` — по одному таргету зовёт `enrichTarget` + харвест свежесозданных. Простаивает, когда очередь пуста. |
| `src/app/api/cron/reference-harvest-worker/route.ts` | Vercel-крон **СЕЙЧАС ОТКЛЮЧЁН** (убран из `vercel.json`) — дообогащал галереи/описания. Причина отключения — утечка кредитов, см. §6. |
| `scripts/cogs-sweep-cooperative.ts` | Локальный/фоновый sweep по Walmart-каталогу (кредит-флор, skip-list, backoff). **Сейчас намеренно погашен.** |
| `scripts/cogs-sweep-amazon.ts` | То же для Amazon (SP-API enumeration store1/store3). |

---

## 2. Источники данных (и что почём)

| Источник | Что даёт | Стоимость | Примечание |
|---|---|---|---|
| **Unwrangle** | Walmart (`walmart_search`/`walmart_detail` 2.5cr), Target (1cr), Sam's/Costco (10cr) | **ПЛАТНО, кредиты = ДЕНЬГИ** | Баланс ~16 300. Флажить истощение ГРОМКО. Сейчас основной ретейл-источник (BlueCart мёртв навсегда). |
| **Oxylabs** | Walmart/Amazon/Google structured (Amazon COMPLETE вкл. UPC+состав) | flat-rate (оплачено) | Частично gated. |
| **OpenClaw browser** (бокс 104.219.53.204) | Publix/BJ's/Aldi через Instacart (единственный путь к frozen/in-store) | подписка/бокс | **BJ's ОТКЛЮЧЁН** (Akamai заблокировал после наших свипов — не включать без rate-limit и ОК Владимира). |
| **Open Food Facts (OFF)** | Пищевая ценность + состав по UPC | **бесплатно** | ~40% покрытие US-бакалеи, rate-limit ~100/мин, ретрай на 429/5xx. Уже интегрирован в `harvestDonorDetail`. |
| **Vision** (Gemini/Codex/Claude) | Распознавание товара по фото | **$0, ПОДПИСКИ** | Через `askVisionJson`. НИКОГДА не платный API — кредиты выжжены. |

---

## 3. Таблицы Turso (модель данных)

| Таблица | Роль |
|---|---|
| `DonorProduct` | Карточка донора (товар-вариант): brand, productLine, flavor, containerType, size/unitMeasure/unitAmount, category, **upc/gtin**, title, **description, bullets, attributes, nutritionFacts, ingredients**, **mainImageUrl, imageUrls (галерея)**, bestPrice, bestRetailer, pricePerMeasure, identityKey, confidence, needsReview. **ЭТО и есть «справочный каталог».** |
| `DonorOffer` | Оффер донора у конкретного ретейлера: retailer, productUrl, price, inStock, isMarketplaceItem (3P-флаг). |
| `SkuComponent` | «Рецепт» SKU (bill-of-materials): sku → DonorProduct(вариант) × qty. |
| `SkuCost` | Роллап себестоимости на SKU: totalCost, source=`retail:batch`, needsReview, effectiveDate. **`totalCost IS NULL` = unsourceable-маркер.** Одна строка на SKU. |
| `EnrichmentJob` | Очередь задач для enrichment-worker (status: queued/running/done/error). |
| `Setting.enrich_priority_skus` | JSON-массив SKU-приоритетов — **межчатовая очередь**: сосед-чат (картинки) кладёт сюда SKU, которым нужен чистый донор; COGS-чат их прогоняет. Сейчас **1458**. |
| `EnrichedReadySku` (VIEW) | Витрина «готовых» SKU (есть рецепт + донор с галереей + костом). Сосед читает её. **5805**. |

---

## 4. Лестница тиров себестоимости (правило «truth over coverage»)

Считаем по убыванию достоверности; estimate НИКОГДА не маскируется под факт:

1. **own-brand** — ручная себестоимость наших товаров (у них нет ретейл-донора). См. `reference_own_brand_costs`.
2. **exact-strict 1P** — тот же товар, тот же размер ±10%, first-party (не 3P) → **факт (clean)**.
3. **cross-size** — тот же товар другого размера, пересчёт по $/мере (окно 0.25×–4×) → **оценка (flagged)**.
4. **line-price sibling** — брат по бренду+линии+размеру → **оценка (flagged)**.
5. **TIER-4 size-unknown** — донор без размера (Publix часто) → **оценка**.
6. **UNSOURCEABLE** — ни один first-party магазин в зоне закупки не даёт цену → `totalCost = NULL`, `needsReview=1`.

**НЕТ Google-тира и НЕТ 3P-резельеров как источника цены** (это НЕ наша закупочная себестоимость; там и наш собственный STARFITSTORE вылезал). Правило: **first-party-or-UNSOURCEABLE.**

Зона закупки: **Clearwater FL, ZIP 33765.** Приоритет магазинов: Walmart → Publix/BJ's → Target → Sam's → Costco (+edge Amazon/Whole Foods/Aldi). Frozen покупается в магазине (Publix), не онлайн.

---

## 5. ЧТО СДЕЛАНО (состояние на 2026-07-18)

### Себестоимость (COST) — цель ДОСТИГНУТА
- **Посчитан весь живой каталог: 5 428 SKU** (Walmart ~2 889 published + Amazon store1/store3).
  - **clean (факт, first-party): 2 732** (50%)
  - **flagged (честная оценка, needsReview=1): 1 853** (34%)
  - **unsourceable (нельзя купить локально, totalCost NULL): 843** (16%)

### Справочный каталог (CONTENT) — собран
- **8 544 донора** в `DonorProduct`. Офферов `DonorOffer`: **9 287**.
- **Галерея (imageUrls): 8 543 (~100%)** — фото есть почти у всех.
- **UPC: 4 641** (54%) · **Пищевая ценность: 3 717** (43%) · **Состав: 3 559** (42%) · **Описание: 4 638** (54%).
  - Остальное — то, чего просто НЕТ в открытых источниках (OFF ~40% покрытие; Target-детейл вообще не отдаёт описание/UPC).
- **Рецепты (SkuComponent): 6 872.** **EnrichedReadySku VIEW: 5 805.**

### Инцидент решён: утечка кредитов Unwrangle (см. §6)

---

## 6. ЧТО НЕ УДАЛОСЬ / УРОКИ / ГРАБЛИ (чтобы Codex не наступил)

1. **FROZEN-баг (мой худший).** Я добавил «frozen»/«refrigerated» в `FORM_MARKERS` «для безопасности» → движок отвергал КАЖДОГО замороженного донора (а frozen есть только у Publix). Плюс тиры требовали размер донора (Publix его не отдаёт). Итог: frozen массово падал в unsourceable. **Фикс (4 слоя): убрал frozen из FORM_MARKERS, TIER-4 для доноров без размера, эскалацию не останавливать на loose-match.** Amazon unsourceable 69%→20%, 509 ложных оживлено. **Урок: storage-word (frozen/refrigerated) ≠ другой товар.**

2. **VARIANT_MISMATCH (открытый долг).** Матчер берёт донора по SUBSET токенов, а надо СТРОГОЕ равенство значимых токенов — иначе подбирает соседний вариант (Snyder's Seasoned→Dipping, Cheetos→XXTRA, Pink Lemonade→Zero-Sugar). Это и есть страшный «неправильный товар на картинке». Я уже починил это в `scripts/target-fronts.ts` (предикат `sameVariant()` = равенство множества значимых токенов), но в ядро `cheapestCostForTarget` ещё НЕ зашил. **~386 VARIANT_MISMATCH ждут этого фикса** (сосед их гейтит перед публикацией).

3. **Утечка кредитов Unwrangle (~500 кр/час, съела ~84k за дни) — НЕ там, где все думали.**
   - Оба чата 3 дня винили боксовую Claude-сессию `a8b87d87` (форк `b61fe92a`). **Оказалось — зомби:** её транскрипт 264 байта, не менялся с 23 июня, нашего кода на боксе нет. Она НЕ жгла.
   - Мой мониторинг «утечка 166/10мин» был **сломанным запросом**: `updatedAt` в ISO (`...T..Z`) сравнивался с `datetime('now')` (формат с пробелом), `T`>пробел → матчил мусор. **Урок: для окон по `updatedAt` брать ISO-порог: `strftime('%Y-%m-%dT%H:%M:%SZ','now','-N minutes')`, НЕ `datetime('now')`.**
   - **Настоящий бёрнер: Vercel-крон `reference-harvest-worker` (*/5мин).** Он пере-качивал доноров без описания; **~1 185 Target-only доноров описания не получают в принципе** → 1-часовой тайм-гейт лишь откладывал, они пере-харвестились вечно по 2.5cr. **Фикс: убрал крон из `vercel.json` (commit `bbb8925`).** Роут жив для разового прогона, но в комментарии-шапке записано условие пере-включения (см. TODO-1). Подтверждено замером: 500/час → ~0.
   - Память: `project_unwrangle_leak_harvest_cron.md`.

4. **Никогда не диагностировать по одному сэмплу.** Отдельная история: 54-часовой «простой» Walmart оказался отравленной канарейкой (один битый SKU FaisalX-2045), а не заморозкой аккаунта.

---

## 7. ЧТО ОСТАЛОСЬ СДЕЛАТЬ (TODO для Codex, по приоритету)

### TODO-1 (за мной→Codex, БЕСПЛАТНО, код): постоянный фикс harvest-крона
Прежде чем ВООБЩЕ включать `reference-harvest-worker` обратно — исключить «незавершаемых» доноров, чтобы не было вечного пере-харвеста:
- В eligibility-запросе исключить доноров, у которых единственный оффер — Target и описание уже пробовали (Target структурно не отдаёт description/UPC), **ЛИБО** добавить счётчик `harvestAttempts` и кап (например ≤2).
- Файл: `src/app/api/cron/reference-harvest-worker/route.ts` (в шапке уже записано условие).

### TODO-2 (за мной→Codex, БЕСПЛАТНО, код): матчер token-set equality
- Зашить в `cheapestCostForTarget` (`cogs-engine.ts`) строгое равенство значимых токенов (портировать `sameVariant()` из `scripts/target-fronts.ts`), сверяя с модификаторами `WalmartCatalogItem.title`. Закроет ~386 VARIANT_MISMATCH.

### TODO-3 (ПЛАТНО, ~4-6k кредитов, ЖДЁТ ОК ВЛАДИМИРА): прогнать очередь 1458
- `Setting.enrich_priority_skus` = **1458** SKU (сосед-чат накопил: TILE_FAIL 431 · VARIANT_MISMATCH 386 · DONOR_FAIL 367 + прочее). Это плитки, где донор битый/вариант неверный/донора нет.
- **Порядок: сперва TODO-2 (матчер), потом прогон** (иначе наплодит кривые варианты).
- Прогон = ретейл-поиск + харвест через Unwrangle. **Оценка ~4-6k кредитов из ~16.3k.** Владимир должен дать бюджет-ОК (после кредит-утечки такой расход в одиночку не запускаем).
- Механизм прогона: `enrichPrioritySkus` в `cogs-engine.ts` / enrichment-worker дренирует `EnrichmentJob`. Для больших батчей — фоновый sweep с кредит-флором.

### TODO-4 (решение Владимира): 843 unsourceable
- Подготовить список на СНЯТИЕ с причинами. Правило Владимира: «не могу купить локально → нахуя листить». Кандидаты на делист.

### TODO-5 (решение Владимира → вход в ценообразование): восстановить Amazon min/max
- Полосы min/max цены на Amazon когда-то стёрло. Восстановить из настоящей COGS. Это уже мост в фазу «деньги» (ценообразование от себестоимости, маржа ≥20%). Ценовой канон — см. запись IMAGES 13:22 на доске и `docs/wiki/pricing-launch-sop.md` (item = landed×1.5, выручка ≈ landed×2.0, ~70% net ROI).

### TODO-6 (опционально, ПЛАТНО): live-verify 1 853 flagged
- До-проверить оценки вживую (~2.5cr за SKU) → перевести часть из flagged в clean. Не срочно.

### Прочее (гигиена, НЕ про деньги): боксовый зомби `a8b87d87` можно погасить на 104.219.53.204 (`kill 1890650 1890620 1890607`) — но только с ОК Владимира, на кредиты не влияет.

---

## 8. ЖЁСТКИЕ ПРАВИЛА (не нарушать)

1. **Vision — только ПОДПИСКИ ($0), НИКОГДА платный API** (кредиты выжжены). Через `askVisionJson`.
2. **Unwrangle-кредиты = ДЕНЬГИ.** Большой прогон — только с ОК Владимира. Истощение флажить ГРОМКО и проактивно. Каждый платный запрос забирает ВЕСЬ контент (галерея+UPC+описание+атрибуты+нутриенты), не только цену.
3. **first-party-or-UNSOURCEABLE.** Никаких Google/3P-резельеров как цены. Оценка НИКОГДА не маскируется под факт (`needsReview` / `totalCost NULL`).
4. **Не включать `reference-harvest-worker` без фикса TODO-1.**
5. **BJ's отключён** (Akamai). Не включать без rate-limit + ОК Владимира.
6. **Enrichment — работа ТОЛЬКО COGS-чата, раз на SKU** (контракт `docs/wiki/enrichment-division-of-labor.md`). Сосед-чат (картинки) кладёт SKU в `enrich_priority_skus` и читает `EnrichedReadySku`; сам ретейл-харвест не гоняет.
7. **Runtime DB = Turso, не dev.db.** Прод-деплой = push в `main` (Vercel). Скрипты `scripts/_*.ts` — scratch, исключены из type-check; сломанный `_*.ts` может заморозить прод-деплой (`project_scratch_scripts_freeze_deploys`).
8. **Brand voice** для любого генерируемого контента листингов: без emoji, без промо-прилагательных, без sale/shipping-заявлений (Amazon 99300). См. CLAUDE.md.

---

## 9. Как проверить состояние (полезные команды)

```bash
cd ss-control-center
# счётчики костинга + каталога (через .env.local/.env, Turso):
#   clean/flagged/unsourceable из SkuCost (source='retail:batch')
#   donors/gallery/upc/nutrition из DonorProduct
#   размер очереди из Setting.enrich_priority_skus
# баланс Unwrangle: GET https://data.unwrangle.com/api/getter/?platform=account_credits&api_key=...
# ВАЖНО: окна по updatedAt — ISO-порог strftime('%Y-%m-%dT%H:%M:%SZ','now','-N minutes'), НЕ datetime('now')
```

Координация чатов: `docs/wiki/CHAT-SYNC.md` (доска), контракт: `docs/wiki/enrichment-division-of-labor.md`.

---

**Итог для Codex:** ядро (движок + костинг всего каталога + справочник ~8.5k доноров) СДЕЛАНО и работает. Осталось: (TODO-1) обезопасить harvest-крон, (TODO-2) ужесточить матчер, (TODO-3) с бюджет-ОК прогнать очередь 1458 через исправленный матчер, (TODO-4/5) решения Владимира по делисту 843 и восстановлению Amazon min/max. Главные грабли — frozen-as-form-marker, ISO-vs-datetime запрос, harvest-крон-вечный-цикл, subset-vs-strict матчинг вариантов.
