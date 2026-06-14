# 🌱 Amazon Growth — стратегия, правила, дизайн рейтинга (живой документ)

Канонический документ по росту продаж Amazon. Будущий модуль `/amazon-growth`
(зеркало Walmart Grow: Action Center + Listing Health + Buy Box + Optimizer).
Сессия 2026-06-14. Связан с памятью: `project_walmart_growth_levers`,
`reference_walmart_ranking_criteria`, `project_fulfillment_model`,
`project_cogs_pricing_parallel`, `project_product_sourcing_engine`.

Категорийные правила листинга: см. `docs/marketplace-rules/amazon/` (23 файла —
title/description/bullets policy, browse-nodes-grocery, gift-set, image-requirements,
prohibited-keywords + category-frozen-grocery / category-refrigerated / category-pet-food /
category-cheese-charcuterie / category-candy / category-coffee-tea / category-shelf-stable).

---

## ⚠️ ГЛАВНОЕ ОТЛИЧИЕ ОТ WALMART (определяет всю архитектуру)

**У Amazon НЕТ нативного Listing Quality Score.** Walmart Insights отдаёт готовый
0–100 с 6 компонентами одним вызовом. Amazon — нет. Значит «рейтинг каждого
листинга» **мы проектируем и считаем сами** из нескольких реальных источников.
Это не минус: наши сигналы (issues + suppression + конверсия + buy-box + наш
compliance-gate) дают более точный и actionable рейтинг, чем чужая чёрная коробка.

---

## ✅ ИСТОЧНИКИ ДАННЫХ — подтверждено LIVE (diag-amazon-growth.ts, 2026-06-14)

Прогон против store1 (Salutem) и store3 (AMZ Commerce):

| # | Источник | Что даёт | Статус | Цифры |
|---|----------|----------|--------|-------|
| 1 | **Listings Items API** `GET /listings/2021-08-01/items/{sellerId}` с `includedData=summaries,issues,offers` | Per-SKU: `status[]` (BUYABLE/DISCOVERABLE), `issues[]` (code, message, severity, attributeNames, categories), offers/buy-box | ✅ **спина модуля** | store1 = **1454** листинга, store3 = **553**. Issues приходят прямо в списочном вызове → один sweep покрывает status+issues+buybox, без N+1 |
| 2 | **`GET_MERCHANTS_LISTINGS_FYP_REPORT`** (Fix Your Products / suppressed) | Bulk: Status, Reason, SKU, ASIN, Product name, Condition, Status Change Date, Issue Description | ✅ | store1 имеет реально **search-suppressed** листинги: напр. Dog Chicken Treats подавлен — `[unit_count] is required but missing` |
| 3 | **`GET_SALES_AND_TRAFFIC_REPORT`** (JSON) | Per-ASIN: sessions, browser/mobile pageViews, buyBoxPercentage, unitsOrdered, orderedProductSales, **unitSessionPercentage (конверсия)** | ✅ **без Brand Registry** | store1 = **1192** ASIN, store3 = 438. Масса трафика с нулевой конверсией |
| 4 | **`GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`** | Поисковая видимость по запросам (impressions/clicks/purchases share) | ⚠️ роль выдана (НЕ 403), но генерится **>5 мин** | Обрабатывать как медленный async (state machine), вторичный сигнал. Brand Registry **есть** (подтвердил Vladimir) |
| 5 | **Catalog Items API** `GET /catalog/2022-04-01/items/{asin}` `includedData=attributes,images,productTypes,summaries` | Полнота контента: productType, кол-во images, attribute keys, summaries | ✅ | productType= **POULTRY** для franks/turkey; 27 image-вариантов; 27–29 attribute keys |
| 6 | **Наш Compliance Gate / risk-scorer** (`src/lib/bundle-factory/compliance/`, `audit/risk-scorer.ts`) | Бренд-риск, PDP 99300, эмодзи/promo, disclaimer | ✅ готов | переиспользуем как качественный сигнал |

**Вывод по объёму:** ~2000 живых листингов на двух аккаунтах. Sweep дешёвый
(5 req/s, pageSize 20 → ~100 страниц), issues встроены в список. Reports (FYP, S&T,
BA) — async, ложатся в state-machine паттерн как у Walmart reports cron.

**Находка по работе:** почти КАЖДЫЙ листинг имеет ERROR-issues (на странице store1 —
40 ERROR + 1 WARNING на 20 товаров). Реальные и чинибельные. Самые частые:
- `99016` — дубль атрибута (Generic Keyword встречается 2 раза, разрешён 1).
- missing `unit_count` → **search suppression** (полная потеря видимости).
Это и есть «мясо» Amazon Grow: backlog issues, прямо роняющий выдачу и продажи.

---

## 📊 LISTING HEALTH SCORE — дизайн рейтинга (0–100)

Считаем сами. 6 компонентов, веса — стартовая гипотеза (калибруем на реальных данных):

| Компонент | Вес | Источник | Логика 0–100 |
|-----------|-----|----------|--------------|
| **Buyability / Status** | 25 | Listings `status[]` + FYP | Suppressed/inactive = **0** (самый дорогой провал). BUYABLE+DISCOVERABLE = 100. Только BUYABLE без DISCOVERABLE (search-suppressed) = ~30 |
| **Issues / Defects** | 20 | Listings `issues[]` + FYP Issue Description | Старт 100, минус за каждый issue: ERROR −15, WARNING −5 (пол 0). Категоризуем по `categories[]` (INVALID_ATTRIBUTE, MISSING_ATTRIBUTE, …) |
| **Content Completeness** | 20 | Catalog Items + Listings attributes | Чек-лист по категории (см. ниже): title в норме, 5 bullets, ≥4 изображения, заполнены ОБЯЗАТЕЛЬНЫЕ атрибуты категории. % выполнения |
| **Compliance** | 15 | наш gate + risk-scorer | Бренд-риск, 99300, эмодзи/promo, disclaimer на месте. BLOCKED=0, WARNING~50, COMPLIANT=100 |
| **Featured Offer / Buy Box** | 10 | Listings offers / Pricing API | Выигрываем buy-box = 100; есть offer но не выигрываем = ~50; нет offer = 0. + ценовой разрыв как метрика |
| **Conversion / Visibility** | 10 | Sales & Traffic (+ BA SQP когда придёт) | unitSessionPercentage vs медиана категории; «трафик есть, конверсии нет» = красный флаг. Если у листинга 0 sessions — компонент N/A, вес перераспределяется |

**Headline score** = взвешенная сумма доступных компонентов (N/A исключается,
веса нормируются — как у Walmart distillItem). Per-SKU + seller-level snapshot
(история, чтобы видеть тренд после правок — как `WalmartListingQualitySnapshot`).

**Top-fix компонент** — как у Walmart: берём компонент с наибольшим (вес × недобор),
показываем оператору одной строкой «что чинить первым».

---

## 🥩 КАТЕГОРИЙНЫЕ ПРАВИЛА (что обязательно в карточке)

Зашиваем в Content Completeness + Compliance как машинно-проверяемые чек-листы.
Источник истины — `docs/marketplace-rules/amazon/category-*.md`. Наши товары
маппятся на Amazon productType (подтверждено: franks/turkey → **POULTRY**).

**Frozen / Refrigerated** (`category-frozen-grocery.md`, `category-refrigerated.md`):
- Обязательно: storage/handling instructions (cold-chain), net weight/`unit_count`,
  ingredients, allergens. Description — **plain text** (Amazon strict-валидирует HTML
  для food). Без food-safety/health claims.
- Это наш основной риск: missing `unit_count` уже даёт search suppression.

**Grocery / Shelf-stable / Candy / Coffee** (`category-shelf-stable.md`, `category-candy.md`, `category-coffee-tea.md`):
- ingredients + allergens + net weight обязательны; nutrition при необходимости.
- prohibited-keywords: «organic», «gluten-free» и т.п. — только с сертификацией.

**Pet food** (`category-pet-food.md`):
- НЕТ human-health claims; guaranteed analysis / intended species; net weight.
- У нас уже suppressed dog-treats листинг — приоритетный кандидат на фикс.

**Gift sets / bundles** (`gift-set-policy.md`, `bundle-policy.md`): Gift Basket
Exception, disclaimer Salutem Solutions LLC (verified wording, PDP 99300),
бренды только factually, browse node из whitelist. Уже покрыто compliance-gate.

**Title / Bullets / Description / Images** — `title-policy.md` (200 char, no foreign
brands под Salutem Vita/Starfit), `bullet-points-policy.md` (5×80, disclaimer ≥1),
`description-policy.md` (plain text для food), `image-requirements.md` (1000+px, no logos).

См. также BRAND VOICE в корневом CLAUDE.md (no emoji, no promo-adjectives) — это
часть Compliance-компонента.

---

## 🏗️ АРХИТЕКТУРА (зеркало Walmart Grow)

**Schema (Prisma):**
- `AmazonListingHealthSnapshot` — seller-level история (score + 6 компонентов + counts).
- `AmazonListingHealthItem` — per-SKU (sku, asin, storeIndex, productType, status,
  healthScore + componentScores, issuesSummary JSON, topFixComponent, conversion-поля
  из S&T, buyBox-поля, syncedAt). `@@unique([storeIndex, sku])`.
- `AmazonLqSyncState` — resumable cursor sweep (pageToken, budget) — как Walmart.
- `AmazonGrowthReport` — state machine для FYP / Sales&Traffic / BrandAnalytics
  (reportType, reportId, status, requestedAt…) — как `WalmartReport`.

**Lib (`src/lib/amazon/growth/`):**
- `listing-health.ts` — fetch + scoring (компоненты, веса, distill issues).
- `persist-listing-health.ts` — resumable sweep, throttle ~5 req/s.
- `reports.ts` (расширить существующий) — FYP / S&T / BA: request→poll→download→parse.
- `growth-diagnosis.ts` — Action Center brain: ранжирует проблемы (suppressed =
  CRITICAL, content-gaps = HIGH, и т.д.) → действия.

**Cron:** `/api/cron/amazon-listing-health` (пейджит sweep), `/api/cron/amazon-reports`
(двигает state machine FYP+S&T+BA). ⚠️ AGENTS.md: «This is NOT the Next.js you know» —
сверяться с `node_modules/next/dist/docs/` перед написанием route/page.

**API:** `/api/amazon/growth/{listing-health,diagnosis,reports,buybox}` + sync POST.

**UI:** `src/app/amazon-growth/page.tsx` + `AmazonGrowthTabs` (Action Center /
Listing Health / Buy Box / Optimizer). Переиспользуем компоненты Walmart как шаблон.

**Optimizer (Phase C):** ремедиация через готовые `content-scrub.ts` (эмодзи/promo),
`disclaimer-text.ts`, `claude-rewrite.ts` + PATCH через `listings.patchListing`
(уже LIVE, с VALIDATION_PREVIEW gate). Привязана к score (чиним низкий top-fix).

---

## 📋 ОЧЕРЕДЬ РАБОТ

1. ✅ `diag-amazon-growth.ts` — источники подтверждены live (store1/store3).
2. ✅ Этот документ — правила + дизайн рейтинга.
3. ✅ **Phase A LIVE (2026-06-14):** Prisma schema (4 модели) + миграция (dev.db + **Turso**)
   + scoring lib + resumable sweep + API + cron + read-only дашборд `/amazon-growth`.
   Первый прогон: **store1 health 92.8** (1000 листингов, 700 с ERROR-issues),
   **store3 health 94.3** (553 листинга, 526 с ERROR). Component-веса = стартовая гипотеза.
4. ✅ **Phase B LIVE (2026-06-14):** reports state-machine (`reports.ts`, cron `amazon-reports`)
   — FYP (authoritative suppression) + Sales&Traffic (per-ASIN conversion + buy-box %) →
   обогащают health items (conversion/buyBox компоненты, isSuppressed/reason) с пересчётом
   score. Action Center (`growth-diagnosis.ts` + UI) + Buy Box panel. Проверено: S&T
   обогатил 433 листинга store3 (buyBox=433, conversion=120), FYP store3=0 suppressed (корректно).
5. ✅ **Phase C LIVE (2026-06-14):** Optimizer (`optimizer.ts` + preview/apply routes + UI).
   Детерминированные безопасные фиксы: title brand-voice scrub (убирает promo/emoji) +
   dedupe дублей атрибутов (99016). preview→validate(dry-run VALIDATION_PREVIEW)→apply(PATCH).
   Проверено: dry-run вернул **VALID** на реальном листинге ("Premium Quality"→"Quality",
   дедуп generic_keyword); structural gaps (битое изображение 100581) → "needs-data" (harvest), не угадываем.
6. ⏳ Brand Analytics SQP — медленный async, добавить в reports state machine.
7. ⏳ Калибровка весов score на реальном распределении.
8. ⏳ Расширение на store2/store5 после стабилизации на store1/store3.

## ⚠️ НАХОДКИ Phase A (gotchas для следующих фаз)
- **Listings Items пагинация останавливается на ~1000** (store1: numberOfResults=1454,
  но cursor исчерпался на 1000). Похоже на лимит энумерации Listings API без узкого
  фильтра. Для полного охвата >1000 листингов, вероятно, надо шардить запрос (по
  productType / status). Пока охвачены первые 1000 — задокументировано, не блокер.
- **`isSuppressed` из status[] недосчитывает.** Phase A берёт search-suppression как
  `BUYABLE && !DISCOVERABLE` → даёт 0, хотя FYP report показывает реальные suppressed
  (напр. dog-treats, missing unit_count). **Авторитетный источник suppression — FYP
  report** (Phase B); тогда же выставляем `isSuppressed` + `suppressionReason` верно.
- **Runtime DB = Turso, не dev.db.** Миграции применять и в Turso
  (`scripts/apply-amazon-migration-turso.ts`), иначе runtime падает «no such table».
- **Snapshot пишется при завершении sweep** (не в начале — у Amazon нет seller-API
  score, считаем из items-агрегата). Mid-sweep падение не пишет snapshot и не прунит.

## ⚠️ Открытые вопросы / решения Vladimir
- Веса компонентов score — стартовая гипотеза, утвердить после первого прогона.
- Авто-фикс контента: как у Walmart, угадывать структурные атрибуты опасно →
  заполнять из harvest sourcing-движка (`project_product_sourcing_engine`), не выдумывать.
- store5 (US suspended 2026-05-17) — листинги мёртвые, не включать в первую волну.
