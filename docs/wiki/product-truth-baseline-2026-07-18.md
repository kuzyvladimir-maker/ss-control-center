# Product Truth Platform — provisional baseline 2026-07-18

> **Статус:** read-only снимок, не авторитетный Phase 1 manifest.
>
> **Канон:** [[product-catalog-architecture]]. **Исполнение:** [[donor-catalog-execution-roadmap]].
>
> Этот документ фиксирует baseline contract `product-truth-baseline/v2` из Turso на `2026-07-18T22:33:53.913Z`. Он не подтверждает полноту продаваемого ассортимента, потому что оба marketplace-источника имеют известные ограничения, описанные ниже.

> **Post-baseline note 2026-07-19:** no-spend Product Truth code, migrations,
> migration planner и regression tests развиваются локально, но эти изменения не
> применялись к Turso и не являются backfill. Поэтому все числа ниже остаются
> историческим pre-migration снимком, а перечисленные authoritative-scope blockers
> остаются открытыми до нового воспроизводимого manifest.

## Зачем нужен этот baseline

Phase 1 должен охватить **весь текущий продаваемый ассортимент Amazon и Walmart**, а не удобную выборку из локальных зеркал. Поэтому число SKU считается авторитетным только после того, как канал предоставляет свежий полный report, report сохраняется вместе с provenance, а итоговый manifest воспроизводимо сверяется с каталогом.

Этот снимок нужен для трёх вещей:

1. не принять частичное зеркало за полный live scope;
2. измерить текущее покрытие COGS/рецептов/доноров без новых платных запросов;
3. зафиксировать integrity-дефекты до исправлений, чтобы последующий прогресс можно было доказать повторным запуском.

## Как воспроизвести

Из `ss-control-center`:

```bash
node --import tsx scripts/product-truth-baseline.ts
```

Скрипт:

- читает только существующие таблицы Turso;
- программно разрешает только `SELECT`, `WITH` и `PRAGMA`;
- не вызывает Amazon, Walmart, retailer, vision или enrichment API;
- не изменяет данные.

## Канонический grain

Одна строка scope означает один листинг:

```text
(channel, storeIndex, raw SKU)
listingKey = channel + ":" + storeIndex + ":" + raw SKU
```

Сначала считаются листинги, затем отдельный SKU rollup. Нельзя объединять по голой строке SKU: она не является гарантированно глобальным идентификатором между каналами или аккаунтами. В текущем provisional-кеше collisions не найдены, но это не отменяет контракт.

## Предварительный Phase 1 scope

| Канал | Временное правило | Live listings | Уникальных raw SKU | Почему ещё не авторитетно |
|---|---|---:|---:|---|
| Amazon | `AmazonListingHealthItem.isBuyable = 1` | 1 490 | 1 490 | Store 1 останавливается ровно на 1 000 строках — известный предел Listings Items enumeration. Нужен свежий `GET_MERCHANT_LISTINGS_ALL_DATA` report с store identity. |
| Walmart | `WalmartCatalogItem.publishedStatus = PUBLISHED` | 2 840 | 2 840 | В `WalmartReport` нет ни одного `ITEM_CATALOG` report. Текущее зеркало могло быть заполнено неполным `/v3/items` fallback. |
| **Итого, provisional** | объединение двух правил | **4 330** | **4 330** | Нельзя использовать как финальный denominator Phase 1. |

Пересечения SKU между каналами в текущем зеркале нет. Это наблюдение, а не доказательство отсутствия общего ассортимента: SKU являются channel-specific идентификаторами и должны связываться через каноническую product identity/recipe, а не строковым равенством.

В Amazon найдены 4 ASIN, каждому из которых соответствуют по 2 live SKU. Поэтому `revenue30d`/`units30d` из health-кеша нельзя суммировать построчно по SKU. Дедуплицированный ASIN-level снимок: store 1 — 999 ASIN / `$8,902.70` / 149 units; store 3 — 515 ASIN / `$3,933.96` / 84 units.

## Состояние источников marketplace

### Walmart store 1

- зеркало: 3 830 строк;
- `PUBLISHED + ACTIVE`: 2 840;
- `SYSTEM_PROBLEM + ACTIVE`: 528;
- `UNPUBLISHED + ACTIVE`: 356;
- последний `syncedAt`: `2026-07-18T06:00:03.704Z`;
- записей `WalmartReport(reportType='ITEM_CATALOG')`: **0**.

Следствие: 2 840 нельзя объявлять полным количеством продаваемых Walmart SKU до успешного ITEM report и reconciliation.

### Amazon

| Store | Строк зеркала | Buyable | Discoverable | Suppressed | Последний full sweep |
|---|---:|---:|---:|---:|---|
| 1 | 1 000 | 979 | 997 | 3 | `2026-07-18T18:36:11.181Z` |
| 3 | 519 | 511 | 519 | 0 | `2026-07-18T18:36:44.241Z` |

Store 1 дошёл до ровно 50 страниц / 1 000 items и потому не доказывает полноту. Авторитетный manifest должен строиться из merchant listings report отдельно по каждому store и сохранять `storeIndex` у каждой строки.

В `Store` присутствуют Amazon store 1–5, и все помечены `active`, но ни у одного нет связанного latest `AccountHealthSnapshot`. Кеш листингов существует только для store 1 и 3. Поэтому store 2, 4 и 5 должны получить явное owner disposition `INCLUDED`, `EXCLUDED` или `UNKNOWN`; поле `Store.active` само по себе не является доказательством включения. Walmart store в `Store` имеет `storeIndex=NULL`, тогда как операционные таблицы используют `storeIndex=1`; mapping должен быть зафиксирован явно.

## Покрытие provisional live scope

| Канал | Live SKU | Есть terminal COGS | Exact без review | Estimate/review | Unsourceable | Есть recipe | Все legacy component links | Есть unresolved component |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Amazon | 1 490 | 1 454 | 576 | 529 | 349 | 1 454 | 1 100 | 349 |
| Walmart | 2 840 | 2 767 | 1 493 | 935 | 339 | 2 711 | 2 367 | 339 |

Ограничения интерпретации:

- `exact` отражает legacy-флаги и ещё не доказывает строгую identity/variant/size/locality;
- `all legacy component links` не означает валидный content donor: текущая схема смешивает content truth и price evidence;
- `unsourceable` нельзя считать доказанным, пока не отличены исчерпанные разрешённые first-party источники от API error, budget stop и неполного retailer coverage.

## Донорский каталог и ценовые доказательства

### DonorProduct

| Метрика | Значение |
|---|---:|
| Donor products | 8 544 |
| С любым изображением | 8 543 |
| С 5+ изображениями | 5 133 |
| С UPC/GTIN | 4 641 |
| С description | 4 638 |
| С ingredients | 3 559 |
| С nutrition | 3 717 |
| `needsReview=1` | 3 |

### DonorOffer

| Метрика | Значение |
|---|---:|
| Offers | 9 287 |
| Помечены first-party | 9 287 |
| Имеют цену | 9 287 |
| Fresh first-party price за 7 дней | **0** |
| С ZIP | 9 246 |
| Availability unknown | 2 880 |
| Без source URL | 3 |
| Последний `fetchedAt` | `2026-07-11T14:48:38.079Z` |

Следствие: существующие офферы пригодны как историческое/матчинговое evidence, но **не готовы для автоматической закупки**. Procurement требует свежий локальный оффер, точный store/ZIP, `IN_STOCK`, verified first-party seller и неизменяемое время наблюдения.

## Очереди и целостность

- `EnrichmentJob`: 128 строк, все `done`, максимум 1 attempt;
- legacy `Setting.enrich_priority_skus`: **1 458 SKU**;
- `EnrichedReadySku`: 5 805 строк / 4 418 уникальных SKU;
- `SkuComponent`: 6 872 строки / 5 359 SKU;
- orphan `SkuComponent.donorProductId`: **151**;
- orphan `DonorOffer`: 0;
- retail `SkuCost`: 5 428 строк / 5 427 SKU;
- SKU с более чем одним cost period: **1**;
- effective dates: только 6 дат, от `2026-07-02` до `2026-07-11`.

История COGS фактически отсутствует: legacy recost удаляет предыдущие периоды почти для каждого SKU. До append-only evidence/history текущая таблица доказывает только последнее сохранённое состояние, не динамику цены.

## Baseline blockers

Phase 1 manifest нельзя заморозить, пока не выполнены все пункты:

1. Получен и сохранён свежий полный Walmart `ITEM_CATALOG` report; его строки reconciled с зеркалом и имеют report provenance.
2. Получен свежий Amazon `GET_MERCHANT_LISTINGS_ALL_DATA` report для каждого действующего store; каждая строка сохраняет `storeIndex`, report ID и время.
3. Для Amazon store 1–5 зафиксирован явный account disposition `INCLUDED/EXCLUDED/UNKNOWN`; `UNKNOWN` блокирует финальный manifest.
4. Определено каноническое правило live/sellable для каждого канала и отдельно сохранены исключённые/problem listings с reason code.
5. Marketplace rows связаны с canonical SKU/product identity без предположения, что channel SKU одинаковы.
6. Повторный baseline создаёт неизменяемый Phase 1 manifest и checksum, а denominator согласован с owner canon.

## Следующий безопасный порядок

1. Ввести общий default-deny guard на все metered provider calls и отключить расходующие synthetic probes.
2. Разделить content identity и price evidence; внедрить один строгий matcher и shadow replay по уже сохранённым данным.
3. Исправить append-only history, offer locality/freshness и orphan-safe merge/lifecycle.
4. Получить authoritative marketplace reports без retailer/AI enrichment и заморозить Phase 1 manifest.
5. Только после owner budget approval оценивать и запускать платное закрытие gap-ов canary/waves.
