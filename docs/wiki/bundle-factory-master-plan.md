# Bundle Factory — Master Plan (весь модуль)

> Полный форвард-план модуля (owner 2026-07-01). НЕ тонуть в одной ячейке —
> строим всю матрицу. Связано: [[bundle-factory-listing-studio]],
> [[bundle-factory-pricing-and-images]], [[bundle-factory-rebuild-plan]].
> Память: `project_bundle_factory_vision`, `project_bf_pricing_image_capacity`.

## Видение (одной фразой)
ОДИН промт-движок: «сделай N листингов [бренд/тема] на [канал+аккаунт] с [маржой]» → движок сам **находит товары → собирает → ценит → рисует → пишет → публикует → доводит до LIVE**. Оператор только **одобряет пачкой**.

## Матрица — что модуль ДОЛЖЕН уметь
- **Режимы:** A) **Own-brand exception** (Uncrustables/Smucker's — листим под их брендом, count-accurate картинки). B) **Gift-set** (всё остальное — под Salutem Vita, «Gift Set» на кулере).
- **Категории** (гонят упаковку/цену/картинки/публикацию): **Frozen** | **Refrigerated** (= frozen: кулер+лёд) | **Dry/shelf-stable** (обычная коробка, ambient).
- **Каналы** (у каждого свой листинг-путь): **Amazon** (frozen \| dry) | **Walmart** (МУЛЬТИПАК-логика, не gift-set) | **eBay** | **Shopify** (свой сайт — дубль).

Каждая ячейка (режим × категория × канал) = свои правила цены/картинок/контента/публикации, но ОДИН общий движок.

## Конвейер (на один листинг)
`source (каталог) → compose (по вместимости кулера / фасовке) → price (per-category, derived-margin, shipping отдельным template) → content (per channel/mode/category) → images (per rules) → compliance/validate → publish → self-heal → LIVE`. Оператор одобряет пачкой (nothing publishes без approve).

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
Uncrustables-frozen-Amazon — это ОДНА ячейка. Всё, что отладили на ней (cooler-by-count, shipping-template, derived-margin, count-accurate images), **обобщается**: dry просто меняет упаковку/шиппинг, Walmart/eBay/Shopify — публикационный адаптер, Mode B — «Gift Set» брендинг. Не переписываем — параметризуем.
