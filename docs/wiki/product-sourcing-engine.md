# 🧠 Product Resolution & Retail Sourcing Engine — общий мозг для 3 модулей

> **Статус:** проектирование (2026-06-07). Фундаментальная задача.
> Захват стратегического замысла Владимира. Связан с
> [COGS / True-Cost Agent](cogs-true-cost-agent.md),
> [Procurement Module](procurement-module.md), [Bundle Factory](bundle-factory.md).

## 🎯 Главный инсайт: три модуля — один движок

У Владимира три отдельные идеи, но **процесс у всех один и тот же**:

| Модуль | Что делает | Что ему нужно от движка |
|--------|-----------|------------------------|
| **A. COGS / True-Cost** | себестоимость перепродаваемых товаров | распознать товар → найти цену в рознице |
| **B. Procurement (закуп)** | помогать закупать товар на перепродажу | распознать товар → где дешевле купить → купить / в корзину |
| **C. Listing Creation** | создавать новые листинги | распознать товар → взять данные/фото/описание → собрать листинг |

Все трое делают **одно ядро**: взять листинг (наш SKU/ASIN) → понять, **что это за реальный физический товар** → найти его в онлайн-магазинах, где мы закупаемся → цена + где покупать.

➡️ **Вывод: строим этот движок ОДИН раз, а три модуля — его потребители.** Это и есть «умный агент», о котором говорит Владимир.

## 🏪 Магазины-источники (приоритет Владимира)

Цена закупки ищется в этих рознич. магазинах, по приоритету «как часто закупаюсь»:

1. **Walmart.com** (бизнес-аккаунт) — главный
2. **BJ's**
3. **Target**
4. **Publix**
5. **Sam's Club** (реже)

В базе для каждого товара храним **список «где покупать» по приоритету = по цене**: priority 1 = где на момент аудита себестоимость самая выгодная, дальше — дороже.

## ⚙️ Как работает движок (4 стадии)

```
наш SKU/ASIN
  │
  ▼  [1] IDENTIFY — Product Resolution
     getListing (SP-API / Walmart) → image + title + description (+ UPC/GTIN)
     → каноническая личность товара: {brand, product, size, packSize, flavor, UPC}
     • UPC/GTIN есть → точный матч (детерминированно, дёшево)  ← лёгкий путь
     • грязный листинг без UPC → LLM-агент (vision+text) извлекает поля
  │
  ▼  [2] SOURCE — Retail Price Discovery
     по каждому магазину из приоритета ищем этот товар → текущая цена
     → ранжируем по цене (priority 1 = дешевле всего)
  │
  ▼  [3] PERSIST — запись в каталог
     ProductIdentity + RetailSource[] (где/почём/URL/дата) + SkuCost (дата)
  │
  ▼  [4] ACT — каждый модуль своё
     A. COGS  → дешёвая валидная цена = bare product cost → репрайсер/аналитика
     B. Buy   → показать список «где купить» / в корзину / купить по priority 1
     C. List  → взять title/фото/описание → черновик нового листинга
```

## 🔓 Самое сложное (нерешённое): КАК искать товар в магазинах

Владимир: «у меня ещё нет решения, как агент ищет товар в этих маркетплейсах».
Реалистичные механизмы, по надёжности:

1. **UPC/GTIN через API** (где есть):
   - **Walmart.com** — Walmart Affiliate / IO API (товар по UPC/item → цена). Самый чистый путь для магазина №1.
   - У BJ's / Publix / Target / Sam's публичных product-API по сути нет.
2. **Агентный браузер (OpenClaw)** — у Владимира уже есть OpenClaw-сервер с браузером
   ([reference_openclaw_mcp_tools]). Агент заходит на сайт магазина, ищет по UPC/названию,
   читает цену с карточки. Это ровно то, что Владимир делает руками — годится для
   BJ's / Publix / Target / Sam's, где нет API.
3. **Сторонние агрегаторы цен по UPC** (коммерческие API) — опционально.

**Human-in-the-loop:** низкая уверенность матча → человек подтверждает → это становится
ground truth (самообучение БЕЗ ML). **Sellerboard COGS = «ответы для сверки»**: где есть
и наша найденная цена, и Sellerboard — сравниваем; совпало → доверяем движку.

## ❄️ Frozen: храним стоимости РАЗДЕЛЬНО (решение)

Вопрос Владимира: использовать ли для frozen цифру Sellerboard, если там товар+упаковка+лёд
слиты в одно число? **Решение — хранить раздельно** (это НЕ сложно, всего 3 колонки):

```
totalCost = productCost (bare, из розницы) + packagingCost (кулер) + iceCost (лёд)
```

- Розничный движок и так даёт **bare product cost** (магазин продаёт голый товар, не наш
  замороженный бокс) → это естественный источник раздельных цифр.
- `packagingCost` = cooler_cost(size по весу) ; `iceCost` = 0.8 × вес_продукта × $0.10.
- Тогда видно, **где улучшать** (напр. кулер $7–16 доминирует → давить на поставщика кулеров).
- **Sellerboard frozen-число = только сверка** (bare + упаковка ≈ Sellerboard total?), а не
  хранимая COGS. Для **dry** Sellerboard cost ≈ bare product cost → можно сидить напрямую.

## 🗄️ Модель данных (расширяем каталог)

- **`ProductIdentity`** — канонический товар: brand, productName, size, variant/flavor,
  upc/gtin, category(Frozen/Dry), bareWeightLb (для расчёта льда). 1 на физ. товар.
- **`SkuShippingData`** (есть) → линк на ProductIdentity (много SKU → один товар; pack 2/4/8).
- **`RetailSource`** — где покупать: productId, retailer, url/retailerSku, unitPrice,
  packSizeAtRetailer, asOfDate, priority, inStock, confidence. Много на товар.
- **`SkuCost`** (дата) — productCost / packagingCost / iceCost / totalCost / costPerUnit,
  effectiveDate (= Sellerboard `CostPeriodStartDate`), source, includesPackaging, needsReview.

## 🚦 С чего начать (crawl → walk → run)

**Фаза 1 — фундамент (быстрая польза, низкий риск):**
каталог-модель + ингест Sellerboard как seed + answer key. Сразу даёт реальную COGS для
2 837 SKU (особенно dry) → репрайсер и net-profit в `/analytics` получают настоящие цифры уже сейчас.

**Фаза 2 — движок:**
[1] Identify сначала по UPC (точные матчи — лёгкие победы), потом LLM для грязных.
[2] Source сначала ОДИН магазин — **Walmart.com** (приоритет №1, есть бизнес-аккаунт,
у нас уже есть Walmart API/инфра) → сверка против Sellerboard answer key. Потом добавляем
BJ's / Target / Publix / Sam's через OpenClaw-браузер.

**Фаза 3 — потребители:** COGS→репрайсер, Procurement (buy/cart), Listing Creation —
поверх общего движка.

## 🔗 Связи
- **Питает:** [COGS / True-Cost Agent](cogs-true-cost-agent.md), [Procurement](procurement-module.md),
  [Bundle Factory](bundle-factory.md) / создание листингов, Repricer (`reprice-engine.ts`)
- **Переиспользует:** procurement-машинерию + Bundle-Factory retail-lookup, OpenClaw браузер
- **Калибруется:** Sellerboard COGS (answer key), [SKU Database](sku-database-migration.md)

## История
- 2026-06-07: Статья создана. Захват стратегии «один движок — три модуля» + решение
  по раздельному хранению frozen-стоимостей + механизмы поиска цены (UPC-API / OpenClaw).
