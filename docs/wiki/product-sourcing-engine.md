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
  ▼  [1] IDENTIFY — Product Resolution (НЕТ UPC, листинг = бандл)
     getListing (SP-API / Walmart) → image + title + description
     → LLM-агент раскладывает бандл на КОМПОНЕНТЫ + количество:
       [{brand, product, size, flavor, qty}, ...]   (напр. 4×Campbell's + 2×…)
     матчинг каждого компонента — по названию/бренду/размеру (+картинка через Lens)
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

## ⚠️ Важно: НЕТ UPC, продаём БАНДЛАМИ

Владимир (подтверждено многократно 2026-06-07): **UPC-кодов у нас нет** и на них
ориентироваться нельзя. Мы **всегда продаём наборами / бандлами / сетами / по
несколько штук** в одном листинге — single-юнитов почти не бывает (только если
изначально большая коробка). Значит:

- У **нашего листинга** единого UPC нет — но его **компоненты** (напр. «8 Oscar Mayer
  Franks», «4 Campbell's × 2») — реальные розничные товары. Движок **раскладывает
  листинг на компоненты + количество**, ищет каждый компонент в рознице **по
  названию/бренду/размеру** (а не по штрихкоду), цена × кол-во = COGS бандла.
- Ключ матчинга = **название/бренд/размер (+ картинка)**, НЕ UPC.

## 🔓 КАК искать цену в магазинах — сервисы (ресерч Jackie + Claude, 2026-06-07)

Платные managed-API/скрейп-сервисы (антибот держат сами). Полный ресерч Jackie:
`/root/.openclaw/workspace/memory/retail-pricing-apis-research.md`.

| Ритейлер | Лучший вариант | Поиск | Цена |
|----------|----------------|-------|------|
| **Walmart** (№1) | Traject Data **BlueCart** (managed) | name/UPC/SKU | от $15/мес |
| **Target** | Traject Data **RedCircle** (managed) | name/UPC | от $15/мес |
| **Sam's Club** | **Unwrangle** | name/keyword | от $10/10k запросов |
| **Costco** | **Unwrangle** | name/keyword | (тот же) |
| **BJ's** | ❌ нет dedicated API | — | кастом-скрейп |
| **Publix** | ❌ нет dedicated API | — | кастом-скрейп |
| **ALDI** | ❌ нет dedicated API | — | кастом-скрейп |

- **Картинка → товар:** ни один товарный API не матчит по фото напрямую. Резолв
  фото → название через **SerpApi Google Lens/Shopping**, дальше цену тянем товарным API.
- **Дыра в покрытии: BJ's / Publix / ALDI** — чистого API нет. Здесь либо кастом-скрейп
  (Bright Data ~$2.5/1k, лучший антибот ~98%; Oxylabs ~$9.4/GB), либо **агентный браузер
  OpenClaw** ([[reference_openclaw_mcp_tools]]), либо ручной ввод. Закладываем явно.
- Универсальный fallback на любой сайт: **Bright Data / Oxylabs / Apify** (кастом-скрейп).

**Human-in-the-loop:** низкая уверенность матча → человек подтверждает → ground truth
(самообучение БЕЗ ML). **Sellerboard COGS = «ответы для сверки»**: где есть и найденная
нами цена, и Sellerboard — сравниваем; совпало → доверяем движку.

## ⚠️ Какой Walmart API (важное уточнение)

Тот Walmart API, что у нас УЖЕ есть — это **Marketplace / Seller Central API** (наши
листинги, заказы, инвентарь — сторона ПРОДАЖИ). Он **НЕ отдаёт розничные цены
Walmart.com** (сторона ПОКУПКИ). Для цен закупки нужен отдельный сервис — **BlueCart**
(Traject Data), это НЕ наш текущий Walmart API.

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

## 🗄️ Модель данных — БОЛЬШИНСТВО УЖЕ ЕСТЬ (от Bundle Factory)

Не строим с нуля — переиспользуем существующие модели (`prisma/schema.prisma`):

- **`StoreRegistry`** ✅ — реестр магазинов (Walmart/Target/Publix/BJ's/Sam's/Costco/ALDI,
  с гео/приоритетом). Seed: `prisma/seed/store-registry.ts`, 37 магазинов из SOURCING_MAP.
- **`ResearchPool`** ✅ — товар + варианты (flavors, pack_sizes, weight) + **цена/источник**
  (avg_price_cents, source_store, source_url, last_seen_in_stock). ≈ канонический товар.
- **`ProductSourceFallback`** ✅ — primary + fallback магазины по приоритету = «где покупать».
- **`StockCheckLog`** ✅ — цена по магазину (price_cents, in_stock, source_url,
  **check_method: "scraper"|"api"|"manual"**). Сюда пишет BlueCart/Unwrangle (api) и скрейп.
- **`SKUStorePriority`** ✅ — приоритет магазинов по конкретному SKU.

**Чего НЕ хватает — дозалить:**
- **`SkuCost`** (дата) — productCost / packagingCost / iceCost / totalCost / costPerUnit,
  effectiveDate (= Sellerboard `CostPeriodStartDate`), source, includesPackaging, needsReview.
- Линк нашего продающего SKU (`SkuShippingData`) → товар в `ResearchPool` (много SKU→1 товар).

⚠️ Скрейпер/`StockCheckLog` пока **только в схеме, в коде не используется** — наполнение
идёт лишь через Perplexity-ресерч Bundle Factory. То есть реального движка цен ещё нет.

## 🚦 С чего начать (crawl → walk → run)

**Фаза 1 — фундамент (быстрая польза, низкий риск):**
каталог-модель + ингест Sellerboard как seed + answer key. Сразу даёт реальную COGS для
2 837 SKU (особенно dry) → репрайсер и net-profit в `/analytics` получают настоящие цифры уже сейчас.

**Фаза 2 — движок:**
[1] Identify — LLM раскладывает листинг-бандл на компоненты+количество (по названию,
не по UPC).
[2] Source сначала ОДИН магазин — **Walmart.com** (приоритет №1) через **BlueCart**
($15/мес trial) → сверка против Sellerboard answer key. Заработало → добавляем Target
(RedCircle), Sam's/Costco (Unwrangle); BJ's/Publix — кастом-скрейп/OpenClaw/ручной ввод.

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
