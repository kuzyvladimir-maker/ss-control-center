# 💰 COGS / True-Cost Agent — справедливая себестоимость по всем SKU

> **Статус:** проектирование (2026-06-07). Phase 2 модуля Sales Overview.
> **Владелец идеи:** Владимир. Этот документ — первичный захват замысла из чата
> «Check Amazon API shipping template modification» (обвалился из-за вставки CSV),
> восстановленного с диска + голосового описания Владимира.

## 🎯 Зачем

Сейчас у проекта **нет источника настоящей себестоимости (COGS)** по товарам,
которые мы перепродаём. Из-за этого:

- **Репрайсер** ([reprice-engine.ts](../../ss-control-center/src/lib/reprice/reprice-engine.ts))
  работает с заглушкой — жёсткий floor $1.00, комментарий в коде дословно:
  *«Safety rails (v1, before the full COGS margin module exists)»*. Без COGS он
  не может безопасно держать Buy Box на марже.
- **Sales Overview** (`/analytics`) показывает выручку, но не **чистую прибыль** —
  COGS-колонка осознанно отложена во Phase 2 (нужен источник SKU → cost).
- Нельзя считать **экономику проекта** и **эффективность каждого ASIN**.

Цель — **справедливая, настоящая себестоимость по всем ASIN/SKU**, хотя бы за
последние ~6 месяцев (2026 год), доступная детерминированно по ключу.

## 🧩 Что такое «настоящая себестоимость» (полная COGS)

Не цена закупки товара, а **полностью загруженная стоимость единицы**:

```
COGS = цена закупки товара
     + упаковка
     + лёд / кулер (только для Frozen)
```

Ключевые нюансы:

1. **Кол-во единиц / пак.** Один и тот же товар продаётся в разных листингах:
   pack of 2 / 4 / 8, в составе бандлов. Себестоимость за единицу = cost / packSize.
   Без правильного разбора пака число бессмысленно.
2. **Бандлы по вкусам.** Один продукт, разные вкусы (напр. суп Campbell's / Chunky —
   4 вкуса × 2 или 3 шт). Нужно раскладывать состав.
3. **Дата.** Цены растут — себестоимость хранится **с привязкой к дате** (cost-period),
   а не одним числом. Для продажи берётся cost, действовавший на дату продажи.
4. **Frozen.** Лёд/кулер входят в COGS. Цифры упаковки (от Владимира):
   - Кулеры (Publix): **Small $7 / Medium $9 / Large $13 / XL $16**.
   - Гелевый лёд (Китай): ~**$0.10/шт ≈ $0.10/lb**.
   - Правило льда: **80% от веса ПРОДУКТА** (10 lb товара → 8 lb льда).
   - `packaging_cost = cooler_cost(size) + 0.8 × product_weight_lb × $0.10`.
     Кулер доминирует; лёд почти бесплатен. Размер кулера — по порогам веса
     продукта (таблица порогов где-то в repo/docs — найти).
   ⚠️ **Двойной счёт:** в Sellerboard И ChannelMax COGS **уже включает упаковку
   (кулер+лёд).** Поэтому к их cost упаковку НЕ добавлять. Формула выше нужна
   только для (а) сверки и (б) товаров, которых нет в Sellerboard.

## 🗄️ Где это живёт — расширяем существующую базу, не плодим новую

У нас уже есть каталог товаров — таблица **`SkuShippingData`**
([sku-database-migration](sku-database-migration.md)): `sku → productTitle,
marketplace, category (Frozen/Dry), length/width/height, weight, weightFedex`.
COGS пишем **рядом** (отдельная связанная таблица cost-периодов, ключ — sku/asin),
чтобы в одном месте были и габариты/вес/тип, и себестоимость.

## 🌱 Источник для обучения / seed — экспорт Sellerboard

`docs/Summary_Cost_of_Goods_Sold_*.csv` (Sellerboard, разделитель `;`):
колонки `ASIN; SKU; Title; Labels; CostPeriodStartDate; Cost;
ShippingCostPerOrder; ...; Marketplace`.

- Привязка по **SKU**, для Amazon — по **ASIN**.
- В Sellerboard `Cost` для Frozen **уже включает упаковку и лёд** (со слов Владимира) —
  значит для seed-товаров полная COGS уже есть, кулер-прайс-лист не нужен.
- Факты по выгрузке (прогон `scripts/cogs-product-structure.ts`, 2026-06-07):
  - 10 077 строк; **Cost заполнен только у 2 837 (28%)** — у остальных 72% пусто
    (слепые зоны, которые агент дозаполняет в рантайме).
  - Колонка Marketplace почти пустая (12 строк). Не критично: себестоимость
    физического товара одинакова на Amazon и Walmart — **одна база кормит оба канала**.
  - Пак распознаётся эвристикой у ~53%; бандлы-вкусы — слабо (нужен Claude-проход).

## 🧠 Часть общего движка (важно)

Поиск себестоимости — это не отдельная задача COGS, а стадии [1] Identify + [2] Source
общего **[Product Resolution & Retail Sourcing Engine](product-sourcing-engine.md)**,
который кормит ещё два модуля (закуп + создание листингов). COGS-агент — его потребитель №1.

**Frozen — храним стоимости РАЗДЕЛЬНО** (решение 2026-06-07): не брать слитую цифру
Sellerboard, а `totalCost = productCost (bare из розницы) + packagingCost (кулер) + iceCost`.
Так видно, где улучшать. Sellerboard frozen-число = только сверка. Dry → Sellerboard cost
≈ bare, можно сидить напрямую. Детали — в [движке](product-sourcing-engine.md#❄️-frozen).

## 📊 Step 0 — джойн каталога × Sellerboard (2026-06-07)

`scripts/cogs-join-catalog.ts` → `docs/cogs-coverage.json`. Наш каталог
`SkuShippingData` (прод Turso = **1109 SKU**: Dry 809 / Frozen 300) × полный Sellerboard:

- **Совпало 580 (52.3%)**; **с себестоимостью — только 217 (19.6%)** (Dry 127 / Frozen 90);
  363 совпали, но cost пустой; **529 (47.7%) не совпали** — нужен движок.
- ⭐ **КРИТИЧНО: все 217 готовых — AMAZON, по Walmart НОЛЬ.** Sellerboard = только Amazon.
  Наши Walmart-SKU (`FaisalX-`/`RizwanX-`) там отсутствуют → **Walmart COGS только через
  розничный движок, без seed-шортката.**
- Дат-история бедная: только 6 SKU имеют >1 cost-период.

## ⚙️ Как работает рантайм (на новую продажу)

```
новая продажа (SKU/ASIN)
   ├─ есть в базе на дату продажи?  → подставить сохранённую COGS  ✅ дёшево, детерминированно
   └─ нет?                          → запустить агент: найти себестоимость
                                       → разобрать пак/вкусы → +упаковка (+лёд для Frozen)
                                       → записать в базу с датой  (обучение накапливается)
```

## 🏗️ Архитектура (3 слоя)

1. **Данные.** Таблица cost-периодов (sku/asin → cost, packSize, costPerUnit,
   isVariety/flavors, effectiveDate, source) + таблица ручных правок (overrides,
   чтобы исправления не слетали при ре-импорте). Ингест из Sellerboard CSV.
2. **Обогащение.** Названия без пака и бандлы → прогон через Claude пачками →
   `{units, packs, flavors[], perFlavorQty}`. Это и есть «обучение» агента.
3. **Тул запроса.** `cogs_lookup(sku|asin|title, date)` для агента/Jackie
   ([jackie-mcp](../../ss-control-center/src/lib/jackie-mcp/)) + `cogs_margin(price, ship)`.
   Подключение в `/analytics` (чистая прибыль) и в reprice-engine (margin floor).

## 🚀 Зачем это (downstream)

- **Репрайсер** — держать Buy Box на Amazon И Walmart с маржой ≥20% (а не floor $1).
- **Sales Overview / экономика проекта** — настоящая чистая прибыль.
- **Эффективность ASIN** — какие листинги выгодны, какие нет.
- **Новые листинги** — закладывать COGS фундаментально с самого создания.

## 🔗 Связи

- **Расширяет:** [SKU Database](sku-database-migration.md)
- **Кормит:** Repricer (`reprice-engine.ts`, `RepriceLog`), Sales Overview (`/analytics`),
  [Bundle Factory](bundle-factory.md) (уже имеет cost→price→margin в `variation-matrix.ts`)
- **Связан с:** [Frozen/Dry классификация](frozen-dry-classification.md),
  [Frozen shipping rules](frozen-shipping-rules.md), [Database Schema](database-schema.md)
- **Источник seed:** `docs/Summary_Cost_of_Goods_Sold_*.csv`,
  парсер `scripts/cogs-product-structure.ts` → `docs/cogs-product-structure.json`

## 📌 Открытые вопросы

1. **Таблица порогов вес→размер кулера** (S/M/L/XL) — цены кулеров известны
   ($7/9/13/16), но пороги веса лежат где-то в repo/docs — найти.
2. Чем сорсить себестоимость для отсутствующих SKU (72% выгрузки пусты) —
   дизайн уже есть: demand-driven агент читает image+title+desc листинга →
   определяет товар → ретейлер (Walmart/Sam's/Publix/BJ's) → текущая цена = COGS;
   переиспользует procurement / Bundle-Factory машинерию; Sellerboard COGS =
   answer key + seed. UPC/GTIN-SKU = точный матч (лёгкий путь). Детали —
   в памяти проекта `project_sku_unit_economics`.

## История

- 2026-06-07: Статья создана. Захват замысла COGS/True-Cost агента из
  восстановленного чата + описания Владимира. Парсер-прототип
  (`scripts/cogs-product-structure.ts`) написан и прогнан на выгрузке.
