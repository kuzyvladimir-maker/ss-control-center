# 🌱 Walmart Growth — стратегия, решения, идеи (живой документ)

Канонический документ по росту продаж Walmart. Все идеи и решения с сессии
2026-06-07. Связан с модулем `/walmart-growth` (Action Center + Listing Quality
+ Buy Box). Память: `reference_walmart_ranking_criteria`, `project_walmart_growth_levers`,
`project_fulfillment_model`, `project_cogs_pricing_parallel`, `project_product_sourcing_engine`.

## Что уже построено и LIVE
- **Action Center** — «доктор»: сканит аккаунт, ранжирует проблемы простым языком, говорит что делать. (`growth-diagnosis.ts`)
- **Listing Quality** — score 53/100 + worklist по 4017 товарам с правками. (`listing-quality.ts`)
- **Buy Box** — 3761 товар, win-rate 60.4%, 1341 переоценён на $22.7k vs BB. (`reports-insights.ts`, отчёт приходит ZIP)

## Критерии Walmart (по важности) — см. `reference_walmart_ranking_criteria`
Buy Box: цена landed (#1) → скорость доставки (#2) → в наличии (гейт) → перформанс → …
Polaris (выдача): Полнота карточки 40% · Перформанс 30% · Цена 20% · Контент 10% + boost за 2-day/WFS.

## Ценообразование — ПРАВИЛО
Buy Box цена = **справочный сигнал, НЕ цель**. Победитель BB может быть производитель/Walmart ниже нашей себестоимости → матчить = минус. Наша цена = COGS + прямые затраты (комиссия + компенсация шиппинга + упаковка) + маржа 20-30%. **Репрайсер: пол = маржа, всегда.** Не дотягиваемся в марже — не режем (абсурдно дорогие позже удаляем). Зависит от COGS (параллельный движок).

## Скорость доставки — стратегия (2 оси)
Корень провала (shipping 14.9): шаблоны декларируют медленный transit; fast-тег нужен ≤2-3 дня. Модель fulfillment: buy-to-order, handling 1 день типично / 2 худший случай, ~99% меток через Walmart SWW. Две оси ускорения:

**Ось 1 — по географии (региональный темплейт).** Текущие 9 шаблонов — плоский «48 State» (Default: STANDARD 3 дня + VALUE 6 дней; остальные 3-4). Региональных зон нет. План: создать зону FL + соседние (GA, AL, SC, опц. TN/MS) с transit 1-2 дня → с handling 1 день клиент получает за ~2-3 дня → региональный fast-тег + чаще BB там. Схема API поддерживает state-level (`configurations[].regions[].subRegions[].states[]`, transitTime на configuration). Менять — только PUT после утверждения значений + тест на новом темплейте + readback (живое обещание доставки + влияет на OTD).

**Ось 2 — по SKU (fast-SKU темплейт).** Идея Vladimir: товары, которые легко/быстро покупаем и отправляем → отдельный темплейт с меньшим сроком. **Реализуемо: считаем per-SKU фактический handling из нашей истории заказов** (WalmartOrder.rawData: по каждой orderLine есть sku + orderDate + `orderLineStatuses[].trackingInfo.shipDateTime` (реальная отгрузка) + carrier). 1088 заказов. По SKU: avg(отгрузка − заказ) в раб. днях, кол-во заказов, on-time доля → классификация fast/medium/slow → fast-SKU на быстрый темплейт. (Walmart per-SKU OTD через API НЕ отдаёт — только account-level; наша история точнее.)

## Авто-фикс контента — БЕЗОПАСНО только с реальными данными
Walmart content-пробелы (830 товаров) = в основном missing СТРУКТУРНЫЕ атрибуты (nutrition label image, ingredient image, manufacturer, texture, material) — не текст. Угадывать = писать мусор в живые листинги. **Решение (идея Vladimir):** sourcing-агент при поиске товара у ритейлера в ОДИН проход собирает весь контент + картинки → БД → авто-фикс заполняет из РЕАЛЬНЫХ данных. Авто-фикс = потребитель harvest'а, ждёт его.

## Сбор данных о товаре (harvest) — общая гармония
ОДИН проход sourcing-движка собирает: COGS + title/desc/bullets/атрибуты + картинки (main, состав, nutrition, инфографика) → расширенные поля БД + картинки в R2 → кормит ТРИ модуля: (1) Walmart content-фикс, (2) Bundle Factory (новые бандлы), (3) COGS/репрайсер. Движок — параллельный чат (`project_product_sourcing_engine`); контракт полей БД — общий, согласуется.

## Очередь работ
1. ✅ Action Center + Listing Quality + Buy Box — LIVE.
2. ⏳ **A:** региональный FL-темплейт — дизайн на утверждение → создать новый темплейт → тест → раскатка.
3. ⏳ **B:** контракт расширения БД (поля контент+картинки) для harvest'а.
4. ⏳ Per-SKU fulfillment-speed анализ из истории заказов → fast/medium/slow → привязка к темплейтам.
5. ⏳ Контент авто-фикс (preview→apply) — после harvest'а реальных данных.
6. ⏳ Репрайсер (пол=маржа) — после COGS.
7. ⏳ Two-Day программа / WFS для подходящего набора (после замера реального transit).
