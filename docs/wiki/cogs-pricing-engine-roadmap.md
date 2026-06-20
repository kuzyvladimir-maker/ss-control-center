# 🗺️ Roadmap: Каталог → Себестоимость → Динамическое ценообразование

Стратегическая цель (со слов Vladimir 2026-06-16): **единый каталог всех SKU**
(на маркетплейсах + закупаемые товары) с **реальной себестоимостью** с ретейлеров,
чтобы **точно лавировать ценами и растить продажи**, держа оптимальную продажную цену,
следя за Buy Box и автоматически репрайся через ChannelMAX + Amazon.

> ⚠️ Пересекается с параллельным COGS-чатом ([[project_cogs_pricing_parallel]]) —
> **синхронизировать, не дублировать**. Этот roadmap объединяет COGS-определение с уже
> построенным ценообразованием (Pricing-модуль + ChannelMAX). Связано:
> [[uncrustables-pricing-model]], [[pricing-module]], [[channelmax-guide]],
> [[product-sourcing-engine]] (project_product_sourcing_engine), [[sku-unit-economics]].

## Фаза 0 — Ценовой фундамент ✅ СДЕЛАНО (2026-06-15/16)
- Cost-модель Uncrustables (валидирована на реальных продажах Veeqo).
- Pricing-вкладка в Amazon/Walmart Growth (guardrails + reprice).
- ChannelMAX как реальный рычаг: flat-file (Min/Max/PurchaseCost), KB изучена,
  конфиг salutem разобран (модель «never sold», floor задран, cost не задан).
- Синхронизация Amazon `minimum_seller_allowed_price` ↔ ChannelMAX floor (57 store1).

## Фаза 1 — Единый каталог (Catalog)
Единый источник правды по каждому SKU: все Amazon-аккаунты (5 venues) + Walmart,
**плюс** закупаемые товары-компоненты.
- Сидировать из того, что уже есть: **ChannelMAX inventory export** (4688 SKU: SKU,
  ASIN, title, model, folder, price, qty-намёки) + Amazon Merchant reports + Veeqo sales.
- Поля: SKU, ASIN/UPC, title, account/venue, channel, **pack qty (штук в листинге)**,
  status, current price, RepricingModel/Folder.
- Хранить в БД (новая модель CatalogItem) или сначала структурный файл.
- Инструмент: `scripts/cmax-inventory-analysis.ts` (уже умеет читать export).

## Фаза 2 — Обогащение каталога (Enrichment)
- Парсить каждый листинг → определить **какой товар(ы) внутри + количество**
  (напр. «Uncrustables … total 24» → product=Uncrustables, qty=24; миксы из N flavors).
- Извлечь UPC / brand / pack-size. Инструменты: ProductTitleCache /
  ProductPackSizeCache, BlueCart, Unwrangle, OpenClaw browser.

## Фаза 3 — Движок себестоимости / сорсинга (COGS) — параллельный чат
- Для каждого товара-компонента найти **розничную цену в источниках**: Walmart, Target,
  Publix, Sam's Club, Costco, BJ's. Хранить cost per product + per retailer (минимум).
- Frozen vs dry costs — раздельно. Инструменты: UPC-API, BlueCart/Unwrangle, OpenClaw
  browser (reference_openclaw_mcp_tools), Walmart API.

## Фаза 4 — Сопоставление SKU ↔ источник + landed cost (Matching)
- Сматчить каждый marketplace-SKU с товаром(ами)-источником × количество →
  **true landed cost = Σ(cost компонента × qty) + упаковка + доставка** (наша cost-модель
  per cooler). Обобщить Uncrustables-модель на все товары.

## Фаза 5 — Динамический ценовой движок (Pricing Engine)
- Per-SKU: target + floor/ceiling из true landed cost + margin-политика.
- Кормить ChannelMAX (авто-генерация flat-file) + синхронить Amazon allowed-prices.
- Мониторить движение цены, Buy Box, sales velocity → корректировать. **Сегментация по
  продажам** (продаётся/нет → разные модели CMax). Pricing-модуль = кокпит.

## Фаза 6 — Автоматизация / мониторинг
- Cron: обновление каталога, COGS, reprice-файлов; алерты на дрейф/Inactive/margin/Buy Box.
- **Jackie agent** грузит ChannelMAX-файлы через браузер (полуавтомат → автомат).

## Инструменты (что есть)
- Парсинг/сорсинг: BlueCart, Unwrangle, UPC-API, OpenClaw browser.
- Данные каталога: ChannelMAX export, Amazon Merchant reports + SP-API, Walmart API, Veeqo.
- Ценообразование: `src/lib/pricing/cost-model.ts`, ChannelMAX flat-file, SP-API allowed-price sync.
- Реальный рычаг цены: **ChannelMAX** (не SP-API напрямую — его перебивает CMax).

## Последовательность
Каталог (Ф1) → Обогащение (Ф2) → COGS (Ф3, парал.) → Matching (Ф4) → Pricing Engine (Ф5)
→ Автоматизация (Ф6). Ф1/Ф2 можно начинать сразу из имеющихся данных.

## История
- 2026-06-16: roadmap создан по запросу Vladimir; Фаза 0 завершена.

## Связано с
- [Pricing module](pricing-module.md) — ценовой кокпит фазы 5
- [Product sourcing engine](product-sourcing-engine.md) — движок COGS/сорсинга фазы 3
