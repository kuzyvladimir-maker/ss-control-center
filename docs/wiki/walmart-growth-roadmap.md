# 🌱 Walmart Growth — стратегия, решения, идеи (живой документ)

Канонический документ по росту продаж Walmart. Все идеи и решения с сессии
2026-06-07. Связан с модулем `/walmart-growth` (Action Center + Listing Quality
+ Buy Box). Память: `reference_walmart_ranking_criteria`, `project_walmart_growth_levers`,
`project_fulfillment_model`, `project_cogs_pricing_parallel`, `project_product_sourcing_engine`.

> **Новое owner-решение, 2026-07-19:** постоянный контур проверки и исправления
> карточек размещается отдельной вкладкой **Listing Integrity** внутри Walmart
> Growth. Backend работает как resumable state machine и общий Product Truth
> consumer; Claude Code не является ежедневным runtime. Канон и честный статус:
> [[walmart-listing-integrity-platform]].
>
> **Evidence correction, 2026-07-26:** Walmart не публикует точный порядок или
> проценты secret ranking factors. Предыдущие shorthand weights ниже заменены
> официально доказанными факторами. Каноническая стратегия item price vs shipping:
> [[walmart-new-sku-shipping-price-strategy]].

## Что уже построено и LIVE
- **Action Center** — «доктор»: сканит аккаунт, ранжирует проблемы простым языком, говорит что делать. (`growth-diagnosis.ts`)
- **Listing Quality** — score 53/100 + worklist по 4017 товарам с правками. (`listing-quality.ts`)
- **Buy Box** — 3761 товар, win-rate 60.4%, 1341 переоценён на $22.7k vs BB. (`reports-insights.ts`, отчёт приходит ZIP)

## Официально подтверждённые факторы Walmart

Buy Box использует конкурентный landed price (`item + shipping`), shipping speed,
shipping cost, inventory, content и post-purchase experience. US Listing Quality
отдельно измеряет content, external price competitiveness, promised delivery speed
по ZIP, in-stock и ratings/reviews. Walmart не публикует стабильные веса или строгий
порядок этих факторов; внутренний selector не должен их выдумывать.

## Ценообразование — ПРАВИЛО

Buy Box landed price = **справочный сигнал, НЕ цель**. Победитель BB может быть
производитель/Walmart ниже нашей себестоимости → матчить = минус. Наша required
customer total покрывает COGS, packaging, реальную label cost, referral с
`item + shipping` и target margin. Затем total делится по exact template:
`item price = required total - customer shipping`.

При одинаковой скорости и landed total default — free shipping. Paid shipping не
получает price-algorithm advantage и разрешается только как controlled experiment,
реально более быстрый service либо экономически необходимое исключение.
**Репрайсер: пол = маржа, всегда.** Не дотягиваемся в марже — не режем.

**Реализовано для новых SKU в Bundle Factory (2026-07-26):** после выбора Walmart
владелец выбирает active shipping template именно выбранного аккаунта и может открыть
его exact настройки. Free template оставляет всю required total в item price; paid
template вычитается из item price. Frozen v25 подписывает item и
`SKU_TEMPLATE_MAP` payload и после публикации требует exact SKU→template/
fulfillment-center read-back. Текущие шесть pilot previews используют free shipping.

## Скорость доставки — стратегия (2 оси)
Корень провала (shipping 14.9): шаблоны декларируют медленный transit; fast-тег нужен ≤2-3 дня. Модель fulfillment: buy-to-order, handling 1 день типично / 2 худший случай, ~99% меток через Walmart SWW. Две оси ускорения:

**Ось 1 — по географии (региональный темплейт).** Текущие 9 шаблонов — плоский «48 State» (Default: STANDARD 3 дня + VALUE 6 дней; остальные 3-4). Региональных зон нет.
- ⚠️ **НАХОДКА (2026-06-07): метод STANDARD допускает transit только 3/4/5 дней. 2-day на STANDARD НЕЛЬЗЯ** → региональный FL 2-day требует **enrollment в TwoDay-программу Walmart** (действие в Seller Center, не чистый API) + реальной способности доставлять за 2 дня. Это бизнес-решение Vladimir.
- ⚠️ Walmart принимает **только свои предопределённые region/state коды** (кастомный regionCode → 400). Берём дерево из Default-темплейта и партиционируем по нему.
- ⚠️ Имя темплейта: без дефисов/спецсимволов (буквы/цифры/пробелы). «Fast SKU 3-Day» → 400; «Fast Three Day» → ОК.
- ✅ **СОЗДАН темплейт «Fast Three Day»** (id `202606999003090290`, STANDARD 3 дня, бесплатно, 49 штатов, **UNASSIGNED**) — достижимый выигрыш: 3 дня vs текущие 6 (VALUE). Привязка fast-SKU к нему — следующий шаг (нужно ок Vladimir + тест на 1 SKU). Скрипт: `scripts/walmart-create-fl-template.ts`. **Подтверждено: WRITE темплейтов через API работает** (`POST /v3/settings/shipping/templates`).

**Ось 1b — handling time.** Отдельно от transit. Поставить 1 день (большинство уезжает в день заказа) — сократит общий промис без изменения цены.

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

## Связано с
- [Amazon Growth roadmap](amazon-growth-roadmap.md) — зеркальный модуль роста на Amazon
- [Walmart Growth listing quality](walmart-growth-listing-quality.md) — компонент Listing Quality score
