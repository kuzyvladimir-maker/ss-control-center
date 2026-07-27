# Bundle Factory — Master Plan (весь модуль)

> **Обязательная зависимость:** товарные варианты, изображения, факты, фасовки и
> закупочные цены берутся из [[product-catalog-architecture|Product Truth Platform]].
> Bundle Factory не строит собственный донорский каталог и не запускает параллельный
> retailer-harvest; пробелы заказывает через общий enrichment-контур.
>
> Полный форвард-план модуля (owner 2026-07-01). НЕ тонуть в одной ячейке —
> строим всю матрицу. Связано: [[bundle-factory-listing-studio]],
> [[bundle-factory-pricing-and-images]], [[bundle-factory-rebuild-plan]].
> Память: `project_bundle_factory_vision`, `project_bf_pricing_image_capacity`.
>
> **Owner clarification 2026-07-22:** «один движок» означает одну точку управления,
> общие Product Truth/job/draft/approval primitives и единый UI, а не один одинаковый
> listing pipeline. Amazon, Walmart и будущие каналы — независимые channel engines со
> своими content, attributes, images, compliance, payload, publish и verify lifecycle.

## Видение (одной фразой)
ОДНА точка управления: «сделай N листингов [бренд/тема] на [канал+аккаунт] с
[маржой]» → общий orchestrator выбирает соответствующий channel engine, а тот по своим
правилам **читает Product Truth → сверяет каталог наших listings → собирает → ценит →
рисует → пишет → проверяет → публикует → доводит до LIVE**. Массовое одобрение
разрешается только после доказанного channel-specific pilot и отдельного owner gate.

## Матрица — что модуль ДОЛЖЕН уметь
- **Режимы:** A) **Own-brand exception** (Uncrustables/Smucker's — листим под их брендом, count-accurate картинки). B) **Gift-set** (всё остальное — под Salutem Vita, «Gift Set» на кулере).
- **Категории** (гонят упаковку/цену/картинки/публикацию): **Frozen** | **Refrigerated** (= frozen: кулер+лёд) | **Dry/shelf-stable** (обычная коробка, ambient).
- **Каналы** (у каждого свой листинг-путь): **Amazon** (frozen \| dry) | **Walmart** (МУЛЬТИПАК-логика, не gift-set) | **eBay** | **Shopify** (свой сайт — дубль).

Каждая ячейка (режим × категория × канал) имеет свои правила цены, изображений,
контента, compliance, payload, публикации и проверки результата. Общими остаются
Product Truth, recipe semantics, job/draft/approval framework и точка управления.

## Конвейер (на один листинг)

```text
Product Truth / донорский каталог ─┐
                                   ├─ общий orchestrator ─┬─ Amazon channel engine
Наши channel listings / novelty ───┘                      ├─ Walmart channel engine
                                                          └─ будущий channel engine
```

Внутри выбранной ветки:
`compose → price → channel content → channel images → channel compliance/spec →
channel payload → publish → seller/buyer verify → LIVE`. Ничего не публикуется без
соответствующего owner approval.

## Где мы сейчас (2026-07-01)
- ✅ **Amazon · frozen · own-brand (Uncrustables):** E2E доказан — 3 ASIN BUYABLE. Цена/картинки/shipping-template — доводим (P0).
- ✅ Движок промт-режима (`studio-engine.tickBatch`), прогресс-бар, own-brand режим, compliance, Speedy UPC-пул — есть.
- ❌ Всё остальное в матрице — **расширяем тот же движок**.

## Roadmap (порядок — можно менять)
- **P0 — Correctness ячейки Amazon·frozen** *(доделываем)*: цена = derived-margin из бестселлеров + shipping через template + кулер по количеству; картинки = count-accurate (коробки 4/10/15 + индивидуальные по вкусу) + info-card слотом #1 + «Gift Set» на кулере (для gift-set).
- **P1 — Автономность:** cron `poll-pending` в расписание, UPC-reaper, atomic-claim, guard'ы (Anthropic-баланс, codex-воркер) → любой листинг САМ доходит до LIVE.
- **P2 — Масс-движок (вся матрица):** Mode A (вкусы×количества + миксы 2/3/4, с лимитами) + Mode B (gift-sets, напр. 500 Jimmy Dean); категории frozen + **dry**; вход = промт + маржа/ROI + маркетплейс + аккаунт → batch с прогрессом.
- **P3 — Каналы:** Amazon·dry → **Walmart** (мультипак-логика + quantity-confusion картинки) → **eBay** → **Shopify** (дубль всех листингов).
- **P4 — UI/UX:** переделать интерфейс (wizard → batch review/approve → управление), красиво/стильно/информативно; 2–3 макета на выбор.

## Принцип
Uncrustables-frozen-Amazon — это ОДНА ячейка. Переиспользуем только действительно
общие primitives: Product Truth, recipe, economics building blocks, job lifecycle,
approval и immutable evidence. Walmart не является заменой Amazon publication URL:
это отдельный channel engine с multipack semantics, Walmart taxonomy/policy/spec,
собственным payload, seller lifecycle и buyer-visible verification. Не переписываем
общую платформу, но и не сводим разные marketplaces к одному listing path.
