# BUNDLE FACTORY — Concept v1.0

> **Date:** 2026-05-17
> **Repo:** `kuzyvladimir-maker/ss-control-center`
> **Owner:** Vladimir
> **Status:** Concept finalized, ready for KB Phase 0
> **Replaces placeholder:** Phase 2 "Product Listings"

---

## 🎯 ЦЕЛЬ МОДУЛЯ

Bundle Factory — фабрика по массовому созданию gift set / bundle / multipack листингов для marketplace-каналов Salutem Solutions. Заменяет ручной workflow с Excel flat files (которым раньше пользовался Дима) на конвейер с AI-research, генерацией контента и автоматической публикацией через API + flat file.

**Три главные боли, которые модуль решает:**

1. **Каждый листинг руками — это часы работы.** Дима за полтора года вручную создал 2000+ листингов через Excel flat files. На каждый листинг — фото из веба, обработка в Figma, ручное заполнение 100 колонок, загрузка в Seller Central, ловля ошибок в processing report, ручные правки. На объёме 1000 листингов/месяц это уже не масштабируется.

2. **Variation family ломается из-за мелочей.** Неверный variation theme, inconsistent count, missing storage_temperature, неправильный browse node — и часть листингов уходит в Error status. Без error feedback loop их месяцами никто не починит.

3. **Multi-channel = N×работы.** Один и тот же gift set должен попасть на 5 Amazon accounts, Walmart, eBay, TikTok — каждый со своими лимитами на title, требованиями к фото, схемой атрибутов. Делать это руками для каждого канала — самоубийство.

**В перспективе** Bundle Factory становится главным production-движком каталога Salutem Solutions: 1000+ новых ASIN в месяц, синхронизированных между 9 каналами продаж, под двумя зарегистрированными брендами (Salutem Vita / Starfit).

---

## 🏛️ КОНТЕКСТ И СВЯЗИ

- **Источники данных (input):**
  - **User Brief** — основные параметры (бренд для research, ценовой диапазон, количество, типы наборов)
  - **Perplexity API** — поиск по интернету (walmart.com, target.com, brand-sites, Sam's Club, Costco)
  - **Direct scraping** — детальные данные по продуктам (фото, attributes, ингредиенты, allergens)
  - **OpenAI API** — генерация title, bullets, description, search terms
  - **GPT-Image / DALL-E 3 / Higgsfield** — генерация main image (с фирменной коробкой Salutem Solutions)
  - **GS1 GEPIR** — валидация UPC из существующего пула

- **БД проекта (Turso/Prisma):** хранит `MasterBundle`, `ChannelSKU`, `BundleComponent`, `StoreRegistry`, `UPCPool`, `GenerationJob`, `MarketplaceRule` (KB), `ListingLifecycleLog`. Полная схема — в отдельном спеке.

- **Целевые каналы (output):**
  - **Amazon SP-API** (Listings Items API v2021-08-01, JSON-based) — для 4 из 5 аккаунтов
  - **Walmart Marketplace API** — для 1 активного аккаунта (Frozen категория пока недоступна)
  - **Flat File export** (.tsv) — резервный путь для тестирования и ручной загрузки
  - **eBay Trading API** — Phase 2 (OAuth setup ещё не завершён)
  - **TikTok Shop Open API** — Phase 2 (требует approval ~2-3 месяца)

- **Связь с Procurement Module:** когда Bundle Factory публикует новый ASIN, она автоматически создаёт записи в `SKUStorePriority` с дефолтным порядком магазинов (Walmart → BJ's → Target → Publix). После первого ордера Procurement помечает реальные магазины, в которых был успешный закуп.

- **Связь с Customer Hub:** прямой связи нет. Order ID от gift set уходит в Customer Hub стандартным flow через Amazon/Walmart API.

- **Связь с Shipping Labels:** прямой связи нет. После создания листинга и получения ордера — обычный shipping flow.

- **Связь с Frozen Analytics:** новый Frozen gift set автоматически попадает в risk profiling. Frozen Analytics получает SKU при первом ордере через Veeqo sync.

---

## 💎 БИЗНЕС-МОДЕЛЬ (фундамент)

Понимание бизнес-модели критично — она определяет архитектуру каждого подмодуля.

### Online Arbitrage + Private Label Gift Sets

Мы не производитель и не дистрибьютор. Мы **rebrand-оператор**: берём известные mass-market продукты (Uncrustables, Jimmy Dean, Lunchables, Freshpet, Campbell's, Hormel), формируем из них **gift set** под собственным брендом (Salutem Vita), упаковываем в фирменную коробку с надписью "GIFT SET N COUNT" + Salutem Solutions logo, и продаём как новый ASIN/SKU.

**Юридический фундамент** — Amazon Gift Basket Exception (Product Bundling Policy от 14 октября 2024). Эта политика разрешает gift sets в категории "Food Assortments & Variety Gifts" (и related browse nodes) содержать продукты от разных производителей, если они physically bundled together for gifting purposes. Это окно открылось ровно в тот момент, когда Vladimir и Дима восстановили заблокированные аккаунты после Amazon's August 2024 sweep. Стратегическая удача — мы оказались на правильной стороне политики.

### Гипотеза "Sticky Products"

Топовые grocery-бренды (Uncrustables, Jimmy Dean, Freshpet) **всегда есть в стоке** в наших target stores. Если они там сегодня — с 95% вероятностью будут через месяц, 90% через полгода, 80% через год. Это меняет архитектуру sourcing:

- **One-shot Research** — заходим в магазин (через web), фиксируем что есть, складываем в БД как "verified source"
- **Pre-publication re-check** — последняя проверка наличия за минуту до публикации
- **Reactive sunset** — если в реальной операции товар физически нельзя купить, оператор ставит Out of Stock → система помечает bundle как "sourcing issue"
- **НЕТ continuous monitoring** — не делаем daily polling 100+ магазинов, это лишняя инфраструктура

### JIT Inventory (Just-in-Time)

**Мы не держим склад продукции.** Никакого warehouse_inventory tracking. Цикл:

```
Customer places order on marketplace
   ↓ 2 business days handling time
Operator (Vladimir / жена / будущий сотрудник) видит alert "Need to source: bundle X"
   ↓ покупка через Walmart+ / BJ's / Target / на машине в магазин
Доставка на склад (1162 Kapp Dr, Clearwater FL 33765)
   ↓
Упаковка в фирменную коробку с cooler + gel packs (для frozen)
   ↓
Отправка через Veeqo (shipping label + carrier pickup)
```

Bundle Factory модуль ничего не знает про физический склад. Он создаёт листинги, регистрирует sourcing-метаданные (откуда покупать) и передаёт эстафету Procurement и Shipping Labels.

### Logistics Arbitrage (не Retail Arbitrage)

Мы покупаем в Walmart и одновременно продаём на Walmart Marketplace. Это **не конкуренция** с Walmart, а 3PL-shipping для small businesses по всей Америке. Walmart Marketplace позволяет покупателям заказывать **delivery** в радиусе нескольких миль от store. Vladimir предоставляет **shipping** через UPS/FedEx/USPS по всей стране. Это разные сервисы для разных клиентов.

На Walmart Marketplace у Vladimir 4000+ опубликованных листингов и проходящие revievs — эмпирическое доказательство, что модель работает.

### Multi-Channel Distribution из единого каталога

Один Master Bundle → spawn ChannelSKU на каждый канал, на котором мы хотим продаваться. Каждый канал получает свою адаптированную версию (title, bullets, attributes), но **рецепт bundle и cost одни и те же**.

| Канал | Доступ через | Что листим |
|---|---|---|
| Amazon — Personal (Vladimir) | SP-API | Salutem Vita gift sets (authorized seller) |
| Amazon — Salutem Solutions | SP-API + Brand Registry | Salutem Vita (brand owner) |
| Amazon — AMZ Commerce | SP-API | Salutem Vita (authorized seller) |
| Amazon — Sirius International | SP-API + Brand Registry | Starfit (brand owner) |
| Amazon — Retailer Distributor | SP-API ⏳ pending | Salutem Vita (authorized seller) |
| Walmart | Walmart Marketplace API | Dry/grocery multipacks (Frozen пока недоступен) |
| eBay | Phase 2 | Multipack listings |
| TikTok Shop #1 | Phase 2 | Top performers |
| TikTok Shop #2 | Phase 2 | Top performers |

---

## 🧠 АРХИТЕКТУРА PIPELINE — 7 стадий

```
Stage 1: Brief         (user input → request payload)
   ↓
Stage 2: Research      (AI agent → product DB → research pool)
   ↓
Stage 3: Variation     (research pool → bundle matrix → user selection)
   ↓
Stage 4: AI Content    (selected bundles → titles/bullets/descriptions)
   ↓
Stage 5: Images        (AI main + donor secondary → CDN URLs)
   ↓
Stage 6: Validation    (compliance checks → user approval)
   ↓
Stage 7: Distribution  (API push + Flat File export → live listings)
```

Каждая стадия — отдельный экран в UI и отдельный sub-module в коде. Подробнее в `BUNDLE_FACTORY_DATA_MODEL.md` (создаётся отдельно).

### Stage 1 — Brief

Пользователь заполняет короткую форму:

- **Brand seed** — например, "Jimmy Dean" / "Lean Cuisine" / "Freshpet"
- **# of listings** — например, 15
- **Price range** — $24.99–$54.99
- **Bundle types** — checkbox: single-flavor packs / mixed-flavor / use-case bundles
- **Use cases** — checkbox: school lunch / road trip / party / gift / freezer stock
- **Target channels** — checkbox: 5 Amazon accounts + Walmart + eBay + TikTok
- **Category hint** — Frozen / Refrigerated / Shelf-stable / Pet Food

Output: `BriefRequest` запись в БД, статус `pending_research`.

### Stage 2 — Research

AI-agent (Perplexity + OpenAI o3 / Claude Opus) идёт в интернет с задачей: "Найди все SKU бренда {brand} которые есть в Walmart / Target / BJ's / Publix в radius 15 miles from 1162 Kapp Dr, Clearwater FL". Источники:

- walmart.com (поиск по zip 33765)
- target.com (через RedSky API)
- bjs.com (поиск по club 0221 = Clearwater)
- publix.com / instacart.com
- brand-website (для аналитики каталога)
- amazon.com (как референс конкурентов, **не для копирования контента**)

Output: `ResearchPool` записи в БД. Каждый продукт:
- product_name, brand, manufacturer
- flavors / variants
- pack sizes / unit counts
- weights / dimensions
- ingredients, allergens, nutrition
- storage_temperature, expiration_days
- reference_images[] (donor pool)
- avg_price (для cost estimation)
- last_seen_in_stock (timestamp)
- source_stores[] (где видели)

### Stage 3 — Variation Matrix Generator

На основе Research Pool строится матрица возможных bundle-конфигураций. Алгоритм:

```python
for product in research_pool:
    for pack_count in [4, 6, 8, 12]:
        for use_case in selected_use_cases:
            # Single-flavor variant
            yield Bundle(
                primary_product=product,
                pack_count=pack_count,
                composition_type='single_flavor',
                use_case=use_case
            )
        if product.has_flavors and len(product.flavors) >= 3:
            # Mixed-flavor variant
            for combo in combinations(product.flavors, k=3):
                yield Bundle(
                    primary_product=product,
                    pack_count=pack_count,
                    composition_type='mixed_flavor',
                    flavor_combo=combo
                )
```

Пользователь видит матрицу в UI (например, для Uncrustables — таблица 7 вкусов × 4 размера = 28 потенциальных bundles), отмечает галочками N штук для генерации, нажимает Generate.

Output: `BundleDraft` записи в БД, статус `selected_for_generation`.

### Stage 4 — AI Content Generation

Для каждого selected bundle:

**Title pattern (Amazon):**
```
Salutem Vita – {Product Description}, {Pack Count} Count, {Total Weight}, Gift Set – Pack of {N}
```

Например: `Salutem Vita – Jimmy Dean Breakfast Sandwich Gift Set, 4.9 oz, Pack of 12 with Cooler & Ice Packs for Freezer Delivery`

**Critical rules:**
- Title NEVER contains brand names of components (Uncrustables, Jimmy Dean) as primary brand. Они могут быть упомянуты как описание содержимого, но не как brand.
- Title ≤ 200 символов (Amazon), ≤ 75 (Walmart), ≤ 80 (eBay), ≤ 100 (TikTok)
- AI получает в system prompt применимые правила из Marketplace Rules KB

**Bullet pattern:**
- 5 буллетов
- Каждый начинается с эмодзи (как у Vladimir сейчас: 🍕✅📦🎉🛡️)
- Финальный buллет: "Makes a delightful gift set for {audience}"
- Длина каждого ≤ 500 символов (Amazon), короче для других каналов

**Description:**
- HTML-структура для Amazon A+ (Vladimir имеет Brand Registry → A+ access)
- Plain text для Walmart / eBay / TikTok
- Включает list of components ("What's in the box")
- Storage instructions для frozen
- Use case scenarios

**Backend keywords:**
- 250 байт search terms
- Long-tail keywords из Research Pool
- Без повторов слов из title

Output: `GeneratedContent` записи в БД.

### Stage 5 — Image Generation

**Main image (AI-generated):**

Prompt template:
```
A professional product photo of a brown cardboard gift set box on white background.
The box has bold green text "GIFT SET {N} COUNT" on the front.
Below the text is the Salutem Solutions logo (green leaves icon + "OUR BEST SOLUTIONS FOR YOU" tagline).
Inside the box stacked vertically are {pack_count} units of {product_description}.
In the bottom-left corner of the image: a small white styrofoam cooler with two blue gel ice packs.
A green badge "100% FRESHNESS GUARANTEED" overlaid in bottom-right.
Photorealistic, studio lighting, e-commerce style, 1000x1000 pixels.
```

Engine: GPT-Image 2.0 / DALL-E 3 / Higgsfield (выбор через A/B testing на этапе MVP).

Стоимость: ~$0.05-0.08 за image.

**Secondary images (3-5 штук, donor sources):**

- Скачиваем из Research Pool reference_images[]
- Light editing через OpenAI image editing API: убрать watermarks, обрезать до 1:1, white background harmonize
- Не используем как main (это нарушает copyright оригинального бренда), а как secondary scroll-down
- Стоимость editing: ~$0.02 за image

**Storage:** Cloudflare R2 (или AWS S3) с публичными CDN URLs. Amazon не принимает Google Drive / Dropbox ссылки.

Output: `BundleImages` записи в БД с CDN URLs.

### Stage 6 — Validation & Approval

Перед публикацией система проверяет:

- **Title length** на каждый канал
- **Banned words check** по правилам каждого канала
- **Required attributes** для категории (storage_temperature для Frozen, allergen для Grocery)
- **UPC validity** через GS1 GEPIR (только для существующего pool)
- **GTIN exemption status** для Salutem Vita brand (одобрено? для какой категории?)
- **Duplicate detection** — не создаём bundle с теми же components как существующий
- **Image compliance** — main image на белом фоне, 85%+ product coverage
- **Cost & margin sanity check** — итоговая цена попадает в Price Range из Brief?

UI показывает preview карточку как она будет выглядеть на Amazon / Walmart. Пользователь редактирует если нужно, нажимает Approve.

Output: `BundleDraft` переходит в статус `approved_queued`.

### Stage 7 — Distribution

Для каждого approved bundle и каждого выбранного канала:

**Flat File path:**
- Генерация .tsv в формате Amazon Inventory Template для категории
- Загрузка в `/home/claude/exports/` для скачивания пользователем
- Опционально — автоматическая загрузка через Amazon SP-API Feeds API (POST_FLAT_FILE_LISTINGS_DATA)

**API path:**
- Amazon: `putListingsItem` через SP-API Listings Items API
- Walmart: `POST /v3/feeds?feedType=MP_ITEM` через Walmart Marketplace API
- eBay: Phase 2
- TikTok: Phase 2

Для каждого канала трекаем:
- Submission timestamp
- Processing status (Amazon: ACCEPTED / FAILED / IN_PROGRESS)
- Errors[] (если есть)
- live_url (после публикации)

Output: `ChannelSKU` записи в БД, статусы обновляются от `submitted` → `processing` → `live` (или `error`).

---

## 📦 SOURCING MODULE (подмодуль внутри Bundle Factory)

### Warehouse Location

- **Адрес:** 1162 Kapp Dr, Clearwater, FL 33765
- **Sourcing radius:** 10 miles (default), max 15 miles

### Store Registry (priority order)

| Priority | Сеть | API Status | Delivery Cost | Notes |
|---|---|---|---|---|
| 1 | Walmart | Web (zip-based stock checker) | $0 (WP+) | Главный source, ежедневный run |
| 2 | BJ's | Web scraping (требует выбор club) | $0 same-day over $50 | Хорошо для bulk multipacks |
| 3 | Target | Unofficial RedSky API | $0 (Circle 360) / $9.99 | Frozen и refrigerated |
| 4 | Publix | Через Instacart API (availability) | InstaCart fees | Specialty items |
| 5 | Sam's Club | Web scraping (требует логин) | Membership fees | Только bulk |
| 6 | Costco | Жёсткая bot detection — manual fallback | Membership fees | Резерв |
| 7+ | Aldi / Winn-Dixie / Trader Joe's | TBD | TBD | Edge cases |

### Конкретные магазины в radius (15 miles от 1162 Kapp Dr)

По данным Vladimir (по памяти): 12 Walmart, 3-4 Target, 1 BJ's, 6-7 Publix, 1 Sam's Club, 1 Costco. Перепроверим в `BUNDLE_FACTORY_SOURCING_MAP.md` через places_search с точным адресом.

Известные ключевые:
- **Walmart Supercenter US-19** (23106 US Hwy 19 N, Clearwater FL 33765) — главный, в 5 минутах от склада
- **BJ's Wholesale Club** (26996 US Hwy 19 N, Clearwater FL 33761) — рядом с Walmart
- **Target Gulf to Bay** (2747 Gulf to Bay Blvd, Clearwater FL 33759)
- **Sam's Club** (2575 Gulf to Bay Blvd, Clearwater FL 33765)
- **Costco** (2655 Gulf to Bay Blvd, Clearwater FL 33759)

### Sourcing Workflow

```
1. Stage 2 Research → product found at Walmart US-19 → save to ResearchPool with source_store_id
2. Stage 6 Validation → pre-publication re-check stock availability (last 24 hours)
3. After bundle goes live → Procurement Module gets default store priority from Sourcing
4. Operator buys via store → marks "Placed" in Procurement
5. If physical sourcing fails → operator marks Out of Stock → bundle status changes to `sourcing_issue`
```

### Substitute Logic

Когда Walmart US-19 выпал из стока для конкретного SKU:
- Try BJ's
- Try Target
- Try Publix
- If none have it → operator decision

Substitute graph — в БД как `ProductSourceFallback` со связями.

### Manual Inventory Override

Если Vladimir в перспективе будет закупать палеты через distributors (Restaurant Depot, food wholesalers) — он сможет добавить manual inventory entry с приоритетом выше всех stores. Bundle Factory тогда выберет этот источник для расчёта cost. Это **on the roadmap, не на MVP**.

---

## 🏷️ BRAND STRATEGY

### Salutem Vita (main brand)

- **Brand Registry:** зарегистрирован на Amazon Brand Registry
- **Owner account:** Salutem Solutions
- **Authorized sellers:** Vladimir Personal, AMZ Commerce, Retailer Distributor
- **Категории:** Frozen Grocery, Refrigerated, Shelf-stable / Dry, Pet Food
- **Current catalog:** ~1255 listings на Salutem Solutions account, ~1028 из них помечены "Gift Set"

### Starfit (parallel brand)

- **Brand Registry:** зарегистрирован
- **Owner account:** Sirius International
- **Authorized sellers:** все остальные Vladimir's accounts
- **Категории:** TBD (видимо тоже grocery, ~312 listings)

### Brand Benefits Vladimir уже использует

- A+ Content
- Brand Story
- Sponsored Brand Ads
- Stores на Amazon
- Brand Registry protection (блокирует чужих продавцов)

### Cross-account Authorized Sellers

Все 5 Amazon accounts являются authorized sellers друг для друга. Это значит:

- Bundle Factory может публиковать новый ASIN на одном аккаунте → автоматически распространять как offer на другие 4 аккаунта
- Альтернативно: создавать уникальные SKU/UPC под каждый аккаунт (Vladimir's preference — чтобы не конкурировать)
- В архитектуре: **разные ChannelSKU под одним Master Bundle**, по одному ChannelSKU на каждый аккаунт

### Box Template (визуальный фундамент)

Существующий дизайн коробки для gift sets:
- Brown cardboard
- Bold text: "GIFT SET {N} COUNT" (green colour)
- Salutem Solutions logo (зелёные листья + "OUR BEST SOLUTIONS FOR YOU")
- Green badge: "100% FRESHNESS GUARANTEED" (для frozen)

AI Image Generation должен **точно воспроизводить** этот дизайн, меняя только Count и контент внутри.

---

## 💲 COST & MARGIN CALCULATOR

Для каждого Master Bundle система считает:

### Cost components

```
COST_OF_GOODS    = Σ(unit_price × qty) for each component product
PACKAGING_COST   = cooler ($X) + gel_packs (2 × $Y) + outer_box ($Z) + filler + label
SOURCING_COST    = delivery_fee (varies by store) + tip_estimate
TOTAL_COG        = COST_OF_GOODS + PACKAGING_COST + SOURCING_COST
```

### Marketplace fees (per channel, per category)

```
AMAZON_REFERRAL_FEE = % of (price + shipping) — varies by category (8-15%)
AMAZON_VARIABLE_FEE = fixed per item ($1-3)
WALMART_REFERRAL    = % varies (lower than Amazon, typically 6-15%)
EBAY_FINAL_VALUE    = % + insertion fee
TIKTOK_COMMISSION   = % varies
```

Эти fees собираются в KB (`docs/marketplace-rules/{platform}/fee-schedule.md`).

### Shipping cost (FBM)

Vladimir использует FBM (Fulfillment by Merchant) на Amazon. Shipping label через Veeqo.

```
ESTIMATED_SHIPPING = avg_label_cost_for_weight_zone (из исторических данных Veeqo)
INSULATED_PACKAGING = portion_of_cooler_amortization (для frozen — учитываем что 1 cooler можно использовать на N ордеров? Или одноразовый? — uncertainty)
```

### Margin formula

```
TARGET_PRICE = (TOTAL_COG + ESTIMATED_SHIPPING) / (1 - margin_target - referral_fee_pct - variable_fee_pct)
SUGGESTED_PRICE = max(TARGET_PRICE, brief.price_range_min)
ACTUAL_MARGIN = (SUGGESTED_PRICE - TOTAL_COG - SHIPPING - FEES) / SUGGESTED_PRICE × 100%
```

### Break-even price

```
BREAK_EVEN = TOTAL_COG + SHIPPING + (SUGGESTED_PRICE × referral_fee_pct) + variable_fee
```

UI показывает в Stage 6 (Validation): "Suggested price $X. Margin Y%. Break-even $Z."

---

## 🆔 UPC/SKU/GTIN MANAGEMENT

### UPC Pool

Vladimir покупал UPC оптом из SpeedyBarCode. Активные префиксы видны в текущем каталоге:

- `742259xxx`
- `789232xxx`
- `617261xxx`

**Действия для Bundle Factory:**

1. **Загрузка существующего pool в БД** — экспорт всех UPC из Active Listings Reports + статус (used / available)
2. **GEPIR validation** — прогон всех UPC через бесплатный публичный GS1 registry (https://gepir.gs1.org). Помечаем какие принадлежат Salutem Solutions GS1 prefix, какие невалидны
3. **Use only validated UPCs** — для новых bundles берём из validated pool
4. **Reserve buffer** — отслеживаем сколько UPC осталось, alert когда меньше 100

### GTIN Exemption Strategy

Для категорий, где Amazon требует **registered GTIN с matching brand owner** — у нас два варианта:

**A. GTIN Exemption через Brand Registry** (preferred)

Vladimir уже имеет Salutem Vita в Brand Registry. Exemption запрашивается per-category (Frozen Grocery, Refrigerated, etc.). После одобрения exemption — все новые bundles в этой категории под Salutem Vita brand не требуют GS1 UPC, можно использовать любой UPC из нашего pool.

**B. Дешёвые UPC (fallback)**

Если exemption не получено — продолжаем использовать UPC из SpeedyBarCode pool, но с **GS1 prefix validation warning**: Amazon может в будущем ужесточить проверку и rejected.

### GTIN Exemption Workflow (semi-auto)

Bundle Factory **готовит** документы для exemption application, но **не подаёт автоматически**:

1. Система генерирует PDF: pre-filled application form, screenshots of brand assets (logo, packaging design), proof of brand registration
2. UI открывает Amazon Brand Registry → Application for GTIN Exemption
3. Vladimir submit'ит вручную (5-10 минут на application)
4. Система трекает status через `gtin_exemption_status` поле на каждой категории
5. После approval — категория unlocked для unlimited Salutem Vita bundles

### SKU Pattern

```
{XX}-{XXXX}-{XXXX}
```

Где `X` = alphanumeric. Например: `0A-2DLV-8XJU`, `1F-S5FG-NLS2`.

Bundle Factory автоматически генерирует SKUs в этом формате, гарантируя uniqueness через random generation + БД check.

**Note:** SKU per-channel **разные** для каждого аккаунта. Один Master Bundle → 5 разных SKU (по одному на каждый Amazon account) + 1 SKU для Walmart + 1 для eBay + 2 для TikTok = до 9 SKU per bundle.

---

## 🖼️ IMAGE GENERATION STRATEGY

### Гибридная модель

| Image # | Source | Cost per bundle |
|---|---|---|
| Main (image 1) | AI-generated (GPT-Image / DALL-E 3) | $0.05-0.08 |
| Image 2-6 | Donor sources (Walmart / brand site) + light AI editing | $0.05-0.10 total |
| **Total per bundle** | | **$0.10-0.20** |

На 1000 bundles в месяц — ~$100-200. Это абсолютно подъёмно.

### Main Image Template

См. Stage 5 выше. Ключевые элементы:
- Фирменная картонная коробка
- Текст "GIFT SET {N} COUNT"
- Salutem Solutions logo
- "100% FRESHNESS GUARANTEED" badge
- Cooler + gel packs (для frozen)
- Продукт внутри коробки

### Image Storage Architecture

```
Cloudflare R2 bucket: bundle-factory-images
  /main/{master_bundle_id}.png
  /secondary/{master_bundle_id}/img{1..5}.png
  /backup/{master_bundle_id}/original-donor-{n}.png

Public CDN: https://images.salutemsolutions.info/main/{...}.png
```

Amazon listings ссылаются на public CDN URLs. Google Drive ссылки не работают (Amazon отклоняет).

### A/B Testing of AI Engines

В MVP проверим:
- GPT-Image 2.0 (OpenAI)
- DALL-E 3 (OpenAI)
- Higgsfield (Vladimir's connection)
- Imagen 3 (Google, если доступен)
- FLUX.1 (через replicate.com)

Через side-by-side сравнение качества и цены выберем primary engine.

### Video Generation (Phase 1.5)

Для top performers (high-sales gift sets) Bundle Factory будет генерировать short videos через Higgsfield. Применение:
- Amazon Brand Content video
- TikTok Shop product video
- Walmart product video (если поддерживает)

Video generation — не на MVP, добавляется когда base pipeline стабилен.

---

## 📊 MASTER BUNDLE ↔ CHANNEL SKU ARCHITECTURE

### MasterBundle (концептуальная единица)

```typescript
model MasterBundle {
  id                String   @id @default(cuid())
  name              String   // "Jimmy Dean Breakfast Sandwich Gift Set, Pack of 12"
  description       String   // master description
  brand             String   // "Salutem Vita" | "Starfit"
  category          String   // "Frozen Grocery" | "Refrigerated" | "Shelf-stable" | "Pet Food"

  // Composition
  components        BundleComponent[]
  packaging         Json     // { cooler_size, gel_packs_qty, outer_box, filler }

  // Cost
  cost_breakdown    Json     // { goods, packaging, sourcing_overhead }
  estimated_cost    Decimal

  // Pricing per marketplace
  amazon_price      Decimal
  walmart_price     Decimal?
  ebay_price        Decimal?
  tiktok_price      Decimal?

  // Images
  main_image_url    String   // CDN URL of AI-generated main
  secondary_images  String[] // CDN URLs

  // Status
  lifecycle_status  String   // DRAFT | RESEARCHED | GENERATED | APPROVED | LIVE | SUSPENDED | ARCHIVED

  // Relations
  channel_skus      ChannelSKU[]
  research_pool_id  String?

  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt
}

model BundleComponent {
  id                String       @id @default(cuid())
  master_bundle     MasterBundle @relation(...)
  product_name     String        // "Jimmy Dean Breakfast Sandwich, 4.9 oz"
  brand            String        // "Jimmy Dean"
  qty              Int           // 12
  unit_price       Decimal       // $4.99 from Walmart
  source_store     String        // "Walmart Supercenter US-19"
}
```

### ChannelSKU (artifact для конкретного канала)

```typescript
model ChannelSKU {
  id                String       @id @default(cuid())
  master_bundle     MasterBundle @relation(...)
  channel           String       // "amazon_salutem" | "amazon_personal" | "walmart_1" | ...

  // Identity
  sku               String       @unique  // XX-XXXX-XXXX
  upc               String       @unique
  asin              String?      // populated after publication
  channel_product_id String?     // Walmart item ID, eBay item ID, etc.

  // Content (adapted to channel)
  title             String       // adapted to channel char limit
  bullets           String[]     // adapted
  description       String       // HTML for Amazon, plain for others
  search_terms      String[]
  attributes        Json         // channel-specific schema

  // Status
  status            String       // DRAFT | QUEUED | SUBMITTED | PROCESSING | LIVE | ERROR | SUSPENDED

  // Publication tracking
  submitted_at      DateTime?
  live_at           DateTime?
  live_url          String?
  errors            Json?

  // Lifecycle
  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt
}
```

### Sync Logic

- **Price update on MasterBundle** → автоматически sync на все ChannelSKU (через `amazon_price` / `walmart_price` / etc.). При sync — отправляется через SP-API Pricing API / Walmart Pricing API.
- **Image update** → re-sync всем ChannelSKU
- **Title/description** — изначально генерируется одна версия + адаптация под channels. После approval — каждый ChannelSKU имеет свою frozen версию (изменения через manual edit).

---

## 📂 MARKETPLACE RULES KB (knowledge base)

Это **самый первый sub-project** Bundle Factory, который запускается ДО написания UI/builder кода.

### Структура

```
docs/marketplace-rules/
├── README.md
├── amazon/
│   ├── gift-set-policy.md         ← главное, Oct 2024 update + Gift Basket Exception
│   ├── title-policy.md
│   ├── bullet-points-policy.md
│   ├── description-policy.md
│   ├── image-requirements.md
│   ├── browse-nodes-grocery.md    ← Food Assortments & Variety Gifts + others
│   ├── category-frozen-grocery.md ← storage_temp, allergens, expiration
│   ├── category-refrigerated.md
│   ├── category-shelf-stable.md
│   ├── category-pet-food.md
│   ├── bundle-policy.md
│   ├── gtin-exemption-process.md
│   ├── restricted-products.md
│   ├── compliance-grocery.md      ← FDA, allergen handling
│   ├── brand-registry-benefits.md
│   └── fee-schedule.md
├── walmart/
│   ├── title-policy.md
│   ├── multipack-policy.md
│   ├── images.md
│   ├── category-grocery.md
│   ├── prohibited-items.md
│   ├── frozen-restrictions.md     ← у Vladimir не открыта, объяснить как
│   └── fee-schedule.md
├── ebay/
│   ├── basics.md                  ← на старте только основы
│   └── fee-schedule.md
└── tiktok-shop/
    ├── basics.md
    └── approval-process.md
```

### Workflow создания KB

1. Запускаем research-агента через Claude Code (отдельный промпт)
2. Каждый источник — официальная документация:
   - Amazon Seller Central Help (https://sellercentral.amazon.com/help)
   - Walmart Marketplace Seller Help
   - eBay Seller Center
   - TikTok Shop Seller University
3. Output — 30-50 markdown файлов
4. Каждый файл содержит:
   - Source URL + дата сбора
   - Краткое summary
   - Ключевые правила в bullet form
   - Concrete examples с примерами правильных / неправильных listings
   - Edge cases
5. Quarterly re-validation (правила меняются)

### Использование KB в pipeline

В Stage 4 (AI Content Generation) AI получает в system prompt **только применимые правила** для конкретной категории и канала:

```python
def get_kb_context(category: str, channel: str) -> str:
    rules = []
    rules.append(read_md(f"marketplace-rules/{channel}/title-policy.md"))
    rules.append(read_md(f"marketplace-rules/{channel}/bullet-points-policy.md"))
    rules.append(read_md(f"marketplace-rules/{channel}/category-{category}.md"))
    if channel == "amazon":
        rules.append(read_md("marketplace-rules/amazon/gift-set-policy.md"))
        rules.append(read_md("marketplace-rules/amazon/bundle-policy.md"))
    return "\n\n---\n\n".join(rules)
```

AI генерит контент **внутри правил**, не выходя за рамки.

---

## 🚨 ERROR FEEDBACK LOOP

Когда Amazon / Walmart / eBay возвращают processing report с errors:

1. **Parser** — распарсить response, извлечь error codes и messages
2. **Classifier** — каждая ошибка категоризируется:
   - `missing_required_attribute` (например, storage_temperature)
   - `title_length_exceeded`
   - `banned_word`
   - `image_url_inaccessible`
   - `duplicate_gtin`
   - `invalid_browse_node`
   - `policy_violation_brand`
3. **Auto-fixer** — для каждой category есть стратегия:
   - `missing_required_attribute` → AI достаёт значение из Research Pool, добавляет → resubmit
   - `title_length_exceeded` → AI сокращает title, сохраняя ключевую информацию → resubmit
   - `image_url_inaccessible` → re-upload в R2, обновить URL → resubmit
   - `duplicate_gtin` → next UPC from pool → resubmit
   - И т.д.
4. **Escalation** — если auto-fix невозможен (например, fundamental policy violation), bundle помечается `manual_review_required` и Vladimir получает Telegram alert
5. **Learning loop** — каждая ошибка и её fix записываются в `ErrorPattern` таблицу. Это позволяет в будущем **проактивно избегать** повторных ошибок на этапе Stage 6 (Validation).

---

## 🔌 TECH STACK & RESOURCES NEEDED

### Уже есть у Vladimir

- ✅ Amazon SP-API (4 из 5 аккаунтов; 5-й pending)
- ✅ Walmart Marketplace API (1 активный аккаунт)
- ✅ Anthropic API (Claude — для AI content)
- ✅ Veeqo API (для shipping post-publication)
- ✅ Sellbrite trial (опционально для cross-channel inventory)
- ✅ Higgsfield (для image / video generation)
- ✅ Telegram (alerts)
- ✅ Google Drive (storage, но не для bundle images)
- ✅ n8n (workflows)
- ✅ Brand Registry: Salutem Vita + Starfit

### Нужно добавить

| Сервис | Назначение | Стоимость |
|---|---|---|
| **OpenAI API** | GPT-Image / DALL-E 3 для main images, GPT-4o для backup content generation, vision для donor analysis | Pay-as-you-go, ~$50-150/мес |
| **Perplexity API** | Research стадия (web search) | $5/мес base + per-query, ~$20-50/мес |
| **Cloudflare R2** | Public CDN-storage для bundle images (Amazon-compliant URLs) | $5-15/мес (~5GB storage) |
| **Web Scraping** | walmart.com / target.com / publix.com для Research stage | $50-100/мес (Bright Data / Apify) или self-hosted на iMac |

### Total monthly OpEx estimate

```
OpenAI:          $100/мес
Perplexity:      $30/мес
Cloudflare R2:   $10/мес
Scraping:        $75/мес
Higgsfield:      already paid
───────────────────────
Total:           ~$215/мес
```

На 1000 bundles в месяц это $0.22 per bundle. Минимальная маржа в одной gift set уже покрывает все эти costs.

---

## 🎬 LIFECYCLE STATES

```
DRAFT
   ↓ (после Stage 1 Brief)
RESEARCHED
   ↓ (после Stage 2 Research)
VARIATION_SELECTED
   ↓ (после Stage 3 Matrix)
GENERATED
   ↓ (после Stage 4-5 Content + Images)
APPROVED
   ↓ (после Stage 6 Validation + user approve)
QUEUED
   ↓ (Stage 7 starts)
SUBMITTED        — отправлено на marketplace, ждём processing
   ↓
PROCESSING       — marketplace обрабатывает (Amazon: до 15 минут, Walmart: до 24 часов)
   ↓
LIVE             — bundle опубликован, доступен покупателям
   ↓                              ↓
SUSPENDED        SUNSET_REQUEST
(нарушение         (sourcing issue или
 policy)            decision to discontinue)
   ↓                              ↓
        ARCHIVED
   ↑
ERROR (от любого state) — fixable через Error Feedback Loop
   ↓
QUEUED (после auto-fix)
```

Каждый transition записывается в `ListingLifecycleLog` для audit.

---

## 🚧 ФАЗИРОВАНИЕ РЕАЛИЗАЦИИ

| Фаза | Что | Промпт-файл (TBD) |
|---|---|---|
| **Phase 0** | Marketplace Rules KB (research через Claude Code) | `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_KB_PHASE_0.md` |
| **Phase 1** | Data model + Prisma migrations + базовый UI скелет | `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md` |
| **Phase 2** | Sourcing Module + Store Registry + warehouse settings | TBD |
| **Phase 3** | Stage 1-2: Brief + Research Pipeline (Perplexity integration) | TBD |
| **Phase 4** | Stage 3: Variation Matrix Generator + UI | TBD |
| **Phase 5** | Stage 4: AI Content Generation (titles/bullets/descriptions) | TBD |
| **Phase 6** | Stage 5: Image Generation Pipeline (AI main + donor secondary) | TBD |
| **Phase 7** | Stage 6: Validation Layer + Cost/Margin Calculator | TBD |
| **Phase 8** | Stage 7a: Flat File Export | TBD |
| **Phase 9** | Stage 7b: SP-API Push (Amazon) | TBD |
| **Phase 10** | Stage 7c: Walmart API Push | TBD |
| **Phase 11** | Error Feedback Loop (auto-fixer + escalation) | TBD |
| **Phase 12** | UPC Pool management + GTIN Exemption automation | TBD |
| **Phase 13** | Multi-account orchestration (5 Amazon accounts spawn) | TBD |
| **Phase 14+** | eBay integration, TikTok Shop integration, Video generation | TBD |

**MVP boundary:** Phase 0-7 — это видимо рабочий builder, который генерирует флэт-файл, и оператор вручную загружает. После этого все остальные phases — это автоматизация и multi-channel расширение.

---

## 🔗 СВЯЗИ

```
Bundle Factory
    ↑ Perplexity API (research)
    ↑ OpenAI API (text + image generation)
    ↑ Higgsfield (image + video alternative)
    ↑ Cloudflare R2 (image CDN storage)
    ↑ GS1 GEPIR (UPC validation)
    ↑ Amazon SP-API (Listings Items API, Brand Registry)
    ↑ Walmart Marketplace API (Listings)
    ↓ → Procurement Module (default SKUStorePriority on new bundle)
    ↓ → Dashboard (Bundle Factory analytics card в Phase 2)
    ⊂ Marketplace Rules KB (docs/marketplace-rules/)
    ⊂ SS Control Center (auth, design system, Turso БД)
    ⇔ Customer Hub (Order ID coupling после first order)
    ⇔ Frozen Analytics (новый Frozen bundle входит в risk profiling)
```

---

## ❌ ЧТО НЕ ВХОДИТ В МОДУЛЬ (вне рамок)

- ❌ **Customer service для gift set buyers** — это область Customer Hub
- ❌ **Inventory tracking** — мы JIT-модель, склад не tracking
- ❌ **Pricing repricer / dynamic pricing** — отдельный модуль на будущее
- ❌ **Returns management** — это A-to-Z & Chargeback модуль
- ❌ **Order fulfillment** — Procurement + Shipping Labels
- ❌ **Analytics по продажам** — это Sales Cards on Dashboard + будущий Sales Analytics модуль
- ❌ **Account health monitoring** — Account Health v2.0
- ❌ **Multi-user / роли** — будет когда подключим систему ролей в SS Control Center целиком

---

## 🎯 SUCCESS METRICS (KPI Bundle Factory)

После MVP запуска:

| Метрика | Target |
|---|---|
| Bundles created per month | 100 → 500 → 1000 |
| Time per bundle (operator effort) | 4 часа → 30 мин → 5 мин |
| Approval rate (Amazon) | >85% on first submit |
| Error auto-fix rate | >70% of errors fixed without human |
| Cost per bundle (excluding goods) | <$0.50 (AI + scraping + storage) |
| Channels covered per bundle | Amazon-Salutem only → +Walmart → +4 other Amazon → +eBay → +TikTok |

---

**End of concept v1.0** — 2026-05-17

> Next steps:
> 1. `BUNDLE_FACTORY_DATA_MODEL.md` — детальная Prisma schema
> 2. `BUNDLE_FACTORY_SOURCING_MAP.md` — карта магазинов с точными адресами и часами
> 3. `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_KB_PHASE_0.md` — первый промпт для Claude Code (KB research)
> 4. UI/UX design session — отдельная сессия
