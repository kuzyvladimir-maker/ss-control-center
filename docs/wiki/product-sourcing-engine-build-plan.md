# 🛠️ Build Plan — Product Sourcing Engine (наш каталог-мозг)

> **Создан:** 2026-06-07. Мастер-план реализации step-by-step.
> Архитектура: [product-sourcing-engine.md](product-sourcing-engine.md).
> Потребители: [COGS](cogs-true-cost-agent.md) · [Procurement](procurement-module.md) ·
> [Bundle Factory](bundle-factory.md) · [Walmart Listing Quality](walmart-growth-listing-quality.md).

## 🎯 Цель

Построить движок, который автоматически **формирует нашу собственную полную базу-каталог**
по каждому товару: личность (бренд/продукт/размер/вкус) + **UPC** + **контент** (title,
описание, bullets, атрибуты) + **картинки** (главная, ingredients, **nutrition label**,
инфографика) + **себестоимость** (с датой, раздельно товар/упаковка/лёд) + **где покупать**
(список магазинов по приоритету-цене). Один сбор → кормит 4 потребителей: COGS/репрайсер,
закуп, создание листингов, Walmart content-fix.

## 👥 Разделение труда

| Зона | Кто |
|------|-----|
| Seller-API (Amazon SP-API, Walmart) — UPC/контент из НАШИХ листингов | **Claude/SS-CC** (токены уже здесь) |
| Схема БД, матчинг, оркестрация в приложении, подключение потребителей | **Claude/SS-CC** |
| Платные сервисы цен (BlueCart/Unwrangle/ScrapeHero/Decodo/SerpApi) + n8n | **Jackie** (внешний бокс) |
| Возврат собранных цен/контента в нашу БД | Jackie отдаёт → SS-CC принимает (Jackie MCP / API) |

Правило: **SS-CC владеет всем, что трогает наши seller-аккаунты и нашу БД; Jackie владеет
внешними платными сервисами.** Не дублируем (флаг в памяти `project_cogs_pricing_parallel`).

## 🧰 Стек сервисов (ресерч Jackie 2026-06-07)

| Ритейлер | Сервис | Поиск |
|----------|--------|-------|
| Walmart | **BlueCart** (Traject Data, ~$15/мес) | UPC→товар |
| Target / Costco / Sam's | **Unwrangle** (~$10/10k) | name/keyword |
| BJ's / Publix / ALDI | **ScrapeHero Marketplace** (+ Instacart запас) | по zip/магазину |
| фото → товар | **SerpApi** Google Lens | картинка |
| универсальный fallback | **Decodo** (ex-Smartproxy, ~$0.25–0.50/1k) | любой сайт |

💰 Разовый сбор COGS по каталогу: **$400–900**; еженедельное обновление **$250–450/мес**.
Экономия: только реальные zip закупок (Флорида); маппинг товара кэшируем навсегда;
ходовые — раз/нед, остальное — раз/мес; **обогащаем проданное (~1100 SKU), не все 15k листингов.**

## 📦 Объём (что обогащаем)

- `SkuShippingData` (наш cost-каталог, реально отгружали): **1109** (Amazon 594 / Walmart 514 / TikTok 1).
- `WalmartCatalogItem` (все Walmart-листинги): 4004. Все Amazon-листинги по 5 акк → ~15k суммарно.
- **Решение:** старт с актив­но-продаваемого (~1109 / проданное за 6 мес), дальше demand-driven
  (новый SKU в заказе без свежей цены → ставим в очередь, как `ProcurementSyncQueue`).

---

## 🪜 ЭТАПЫ (step-by-step)

### ✅ Stage 0 — ВЫПОЛНЕН 2026-06-07/08 (SS-CC, бесплатно)
- **0a** ✅ Миграция `20260607220000_cogs_sku_cost` (dev + прод Turso): таблица `SkuCost`
  (раздельно product/packaging/ice, идемпотентна по sku+source+effectiveDate) + колонки
  `upc`/`upcSource` в `SkuShippingData`.
- **0b** ✅ UPC из наших листингов (`scripts/cogs-extract-upc.ts`): **Walmart 514/514 (100%)**
  (из `GET /items/{sku}` — отдаёт upc+gtin, список не отдаёт), **Amazon 404/594 (68%)**
  (отчёт `GET_MERCHANT_LISTINGS_ALL_DATA`, колонка product-id; store1 1462/store3 559/store5 383;
  store2 → 403 нет доступа). **Итого 918/1109 ≈ 83%.** Грузить env через dotenv, НЕ shell
  (Amazon refresh-токены содержат `|`).
- **0c** ✅ `scripts/cogs-seed-sellerboard.ts`: 217 Amazon-costs в `SkuCost` (127 dry / 90 frozen).
- ⚠️ **UPC-ЛОВУШКА (Jackie, 2026-06-08):** Walmart-UPC оказались **seller-assigned мультипак-кодами**,
  а не штрихкодами производителя (684611… на Cheetos/Arnold/Chef Boyardee — у разных производителей
  один префикс невозможен; настоящий Cheetos = 028400). Они резолвятся, но в НАШИ ЖЕ мультипак-листинги
  (Cheetos «Pack of 3» $20.99) → COGS завышен в 3–4× и циклический. ⇒ **Walmart матчим ПО НАЗВАНИЮ к
  базовой единице, не по UPC.** «Walmart 514/514» — заполнено, но не тем типом идентификатора.
- **Stage 1 (Jackie)** ⛔ ждёт: Джеки НЕ видит прямого сообщения Владимира → трату с карты
  держит. Владимиру нужно написать Джеки в КАНАЛ, который Джеки реально получает.

### Stage 0 — Фундамент: схема + UPC из наших листингов  ·  SS-CC · бесплатно · СЕЙЧАС
- **0a. Схема БД.** Расширяем каталог: колонка `upc/gtin`; новая дат-таблица `SkuCost`
  (`productCost / packagingCost / iceCost / totalCost / costPerUnit / effectiveDate /
  source / includesPackaging / confidence / needsReview`); поля harvest-контента + ссылки
  на картинки (R2). Переиспользуем `StoreRegistry / ResearchPool / ProductSourceFallback /
  StockCheckLog / SKUStorePriority`. Миграция на Turso — после показа дизайна Владимиру.
- **0b. UPC-обогащение.** Тянем product identifiers из НАШИХ Amazon-листингов (SP-API
  Catalog Items) + Walmart-айтемов → заполняем `upc/gtin`. Отчёт покрытия: резейл-с-настоящим-UPC
  (лёгкий путь) vs наши бандлы (разбор по компонентам).
- **0c. Seed.** Заливаем 217 Amazon-себестоимостей из Sellerboard в `SkuCost` (dry — напрямую,
  frozen — пометка «нужна голая цена»). Репрайсер/`/analytics` Amazon сразу получают цифры.
- **Выход:** каталог с UPC + 217 реальных costs + % покрытия UPC.

### Stage 1 — Аккаунты сервисов (trials)  ·  Jackie · параллельно · оплата только с «ок»
- Jackie заводит аккаунты (где есть — пробные): BlueCart, Unwrangle, ScrapeHero, SerpApi, Decodo.
- Докладывает: лимиты триалов, что требует карту, реальные цены под наш объём.
- Согласуем **контракт записи**: как Jackie возвращает цену+контент в нашу БД (Jackie MCP-тул
  `cogs_ingest` / API + схема payload).
- ⛔ Платные подписки — только после явного «ок» Владимира.

### Stage 2 — Матчинг  ·  SS-CC
Для каждого актив­но-продаваемого SKU:
- есть настоящий UPC → ключ точного поиска;
- наш бандл → LLM раскладывает на компоненты+кол-во (title/desc/image);
- низкая уверенность → очередь ручного подтверждения → ground truth (самообучение, без ML).

### Stage 3 — Ядро: сбор цены + контента + картинок  ·  SS-CC оркеструет, сервисы Jackie исполняют
- По приоритету магазина (Walmart→BlueCart, Target/Costco/Sam's→Unwrangle, BJ's/Publix/ALDI→
  ScrapeHero) за ОДИН проход: цена + контент + картинки.
- Пишем: `ProductSourceFallback`/`SKUStorePriority` (где покупать, по цене), `StockCheckLog`
  (история цен), harvest-контент + картинки → R2.
- Fallback-цепочка (Decodo) при сбое основного.
- Frozen: считаем упаковку+лёд отдельно, храним раздельно.
- Валидация против Sellerboard answer key (Amazon), где есть.

### Stage 4 — Подключаем потребителей  ·  SS-CC
- **COGS** → `SkuCost` → репрайсер (margin floor вместо $1) + `/analytics` net profit.
- **Procurement** → список «где купить» / корзина / покупка.
- **Listing Creation / Bundle Factory** → harvest-контент + картинки.
- **Walmart content-fix** → заполняем недостающие атрибуты/картинки из harvest (включая
  nutrition label) → авто-починка контента становится БЕЗОПАСНОЙ (заполняем реальными данными).

### Stage 5 — Автоматизация и обновление  ·  Jackie (n8n) + SS-CC
- Demand-driven refresh на синке заказов; ходовые раз/нед, остальное раз/мес; только FL zip.
- Мониторинг стоимости, свежести (`staleAfter`), алерты.

---

## ⏱️ Порядок и зависимости

```
Stage 0 (SS-CC, free) ──┐
                        ├─► Stage 2 (матчинг) ─► Stage 3 (сбор) ─► Stage 4 (потребители) ─► Stage 5 (авто)
Stage 1 (Jackie trials)─┘
```
Stage 0 и Stage 1 идут **параллельно**. Stage 3 требует обоих (UPC из 0 + сервисы из 1).

## 📌 Открытые решения для Владимира
1. Запускать Stage 0 сейчас (бесплатно, наша сторона)? Объём = проданное (~1109) или всё (~15k)?
2. Делегировать Jackie Stage 1 (создать trial-аккаунты, без оплаты)?
3. Бюджет на платные сервисы — потолок/мес, чтобы Jackie действовал в рамках.

## История
- 2026-06-07: Мастер-план создан на основе ресерча (Jackie+Claude), join-аудита покрытия
  (`cogs-coverage.json`) и стратегии «один движок — три модуля».
