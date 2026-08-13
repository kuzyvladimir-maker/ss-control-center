# ТЗ: восстановление денежных Uncrustables offer concepts на Amazon

> Версия 2026-08-13. Основание —
> [[uncrustables-historical-asin-forensics-2026-08-13]] и
> [[uncrustables-listing-rules-canon]].
>
> Это ТЗ на подготовку новых карточек и upload-ready payloads. Оно не разрешает
> публикацию, изменение остатков, массовый repricing или создание дублей живых
> ASIN. Финальный список SKU и объём пилота — отдельное решение владельца после
> проверки recipe, COGS и overlap.

## 1. Цель

Воссоздать исторически доказанные Uncrustables offer concepts, которые давали
оборот, но исчезли или были деактивированы, без переноса ошибок старых карточек.

Результат для каждого кандидата:

1. exact SKU recipe;
2. подтверждённая товарная идентичность каждого компонента;
3. title, five bullets, description, search terms и полный набор attributes;
4. MAIN и gallery brief с QA evidence;
5. Amazon validation draft и детерминированный upload payload;
6. preflight/overlap report и post-submit verification plan.

## 2. Предлагаемый scope

### Create candidates — первая очередь

| Concept | Исторический evidence | Target total | Решение по retail packs |
|---|---|---:|---|
| Strawberry | 140 units / $13 889,20 у двух апрельских ASIN | 30 | выбрать `10 ct × 3` или `15 ct × 2` по exact availability, COGS и ROI |
| Honey | 68 units / $6 910,38 | 28 | `4 ct × 7`, если exact 4-count variant подтверждён |
| Peanut Butter | 46 units / $4 649,28 | 28 | `4 ct × 7`, если exact 4-count variant подтверждён |
| Chocolate Hazelnut | 68 units / $6 669,93 у двух апрельских ASIN | 30 | выбрать `10 ct × 3` или `15 ct × 2` по exact availability, COGS и ROI |

### Overlap-gated candidates

- **Grape 30:** удалённый `10 ct × 3` дал 77 units / $7 393,44, но живой
  `15 ct × 2` уже дал 237 units / $23 837,21. Сначала определить, можно ли
  использовать/улучшить существующий ASIN. Новый ASIN запрещён, если он создаёт
  недифференцированный duplicate offer.
- **Variety 45:** исторически $10 740,57, но требуется заново доказать три точных
  variants, recipe, cooler fit и отсутствие активного эквивалента.
- **Whole Wheat Strawberry 72:** исторически $9 060,71; рассматривать как exact
  manufacturer-case listing, а не как произвольный gift bundle.

### Benchmark-only, не создавать заново

- mixed six-flavor 24 (`B0DQ92QQ56`);
- mixed six-flavor 48 (`B0DQ95N73D`);
- Raspberry 30 (`B0DQ2PWTDM`);
- Grape 30 (`B0DQ1FGVD2`), пока ASIN остаётся buyable/discoverable.

## 3. Gate 0 — запрет на дубли и выдуманный товар

До генерации контента система обязана для каждого candidate сформировать
`candidate-decision.json` со следующими полями:

- historical ASIN/SKU evidence;
- proposed exact recipe: canonical variant ID, retail pack ID, printed count,
  component quantity, total pieces;
- current Amazon exact-title/recipe overlap;
- GTIN/identifier strategy для bundle;
- current retail availability и observation timestamps;
- COGS + packaging, target price, ROI и cooler zone;
- outcome: `CREATE_NEW`, `USE_EXISTING`, `BLOCKED_DUPLICATE`,
  `BLOCKED_PRODUCT_TRUTH`, `BLOCKED_ECONOMICS`.

`CREATE_NEW` разрешён только при точной математике recipe, отсутствии
недифференцированного live duplicate и полной content/economics readiness.

## 4. Product Truth contract

Для каждого компонента обязательны:

- brand и product line;
- exact flavor/formula;
- exact retail packaging и printed count;
- UPC/GTIN retail pack;
- net weight, ingredients, allergens и nutrition panel;
- exact package-front reference;
- donor/source URL, observedAt, hash и confidence;
- current retailer offer отдельно от content truth.

Другая фасовка того же вкуса может быть price evidence, но не content donor.
Соседний flavor запрещён даже как временный image/text fallback. Bundle recipe
и content truth хранятся раздельно: retail UPC нельзя молча использовать как UPC
многокоробочного offer.

## 5. Контент листинга

Все customer-facing строки — на английском.

### 5.1. Title contract

Базовая формула:

`Smucker's Uncrustables [Exact Flavor] Frozen Sandwiches, [Retail Count] Count Each, Pack of [N], [Total] Sandwiches, Curated Gift Set`

Для mixed bundle:

`Smucker's Uncrustables Frozen Sandwich Variety, [Exact Flavor List], [Retail Count] Count Each, Pack of [N], [Total] Sandwiches, Curated Gift Set`

Обязательные свойства:

- exact brand/product line;
- flavor wording совпадает с package reference;
- `retail count × number of boxes = total sandwiches`;
- mixed title перечисляет только реально включённые flavors;
- title не содержит shipping promises, urgency, promo adjectives и
  неподтверждённых claims;
- punctuation и capitalization единообразны.

Финальный title строится детерминированно из recipe; ручное изменение count или
flavor после сборки запрещено.

### 5.2. Five-bullet contract

1. **Bundle contents:** точное количество retail packs и total individually
   wrapped sandwiches.
2. **Exact variant:** точный flavor/product form; для variety — количество
   коробок каждого вкуса.
3. **Storage:** `Keep frozen` и только подтверждённая package thawing instruction.
4. **Use:** factual crustless / individually wrapped / no-cooking wording, если
   оно доказано exact package source.
5. **Curator disclosure:** `Curated and assembled by Salutem Solutions LLC as a
   gift basket.`

Ни один bullet не должен описывать одну коробку так, будто она является всем
offer. Запрещены `ultimate`, `perfect`, `premium`, `best`, `amazing`, sales or
delivery promises и health/medical claims. Ingredient/nutrition claims включать
только при exact evidence для всех компонентов.

### 5.3. Description contract

Один короткий factual paragraph:

- состав bundle и total count;
- flavor list и retail-pack split;
- individually wrapped status, если доказан;
- `Keep frozen` и точная thawing instruction;
- curator disclaimer точной строкой.

Description не копирует manufacturer paragraph одной коробки и не говорит
`ships frozen`.

### 5.4. Search terms

Search terms формируются из exact identity:

- brand + product line;
- exact flavor synonyms, только если это синонимы, а не другой продукт;
- `frozen sandwich`, `crustless sandwich`;
- total count и pack count;
- `variety pack` только для mixed recipe.

Не дублировать title целиком, не добавлять competitor brands, misspellings,
promo/health claims или flavors, отсутствующие в recipe.

## 6. Attribute contract

| Attribute | Правило |
|---|---|
| `brand` | exact marketplace-accepted Smucker's/Uncrustables value |
| `item_name` | только детерминированный title |
| `flavor` | один exact flavor или полный exact flavor list |
| `specialty` | factual product/bundle descriptor, не дубль неверного flavor |
| `number_of_items` | число retail packs в recipe |
| `number_of_pieces` | total sandwiches |
| `unit_count` | полный net content offer с корректной unit type, не вес одной коробки |
| `item_form` | factual marketplace-supported value, например round sandwich |
| `ingredients` | exact per included variant; mixed recipe не теряет ни один flavor |
| allergens | union exact allergen statements всех компонентов |
| size | только marketplace-supported factual value; не произвольный S/M/XL |
| included components | exact retail packs/variants и quantities |
| identifier | approved bundle GTIN/UPC or documented exemption; retail UPC reuse запрещён |

Cross-field validator обязан доказать:

```text
sum(component.printedCount × component.quantity) = number_of_pieces
number_of_items = sum(component.quantity)
title.totalCount = number_of_pieces
title.flavors = recipe.flavors = attributes.flavor
MAIN visible recipe = recipe components
```

## 7. Image brief

Старые изображения не переносятся и не используются как production template.

### MAIN

- frozen MAIN v2.0;
- approved Salutem cooler anchor;
- exact reviewed package-art reference каждого variant;
- все retail packs/variants визуально соответствуют recipe;
- четыре gel packs: два внутри, два снаружи;
- белый фон, без посторонних предметов;
- без выдуманного flavor, package text, printed count или logo;
- frozen QA: три голоса, fail-closed, sealed proof.

### Gallery

1. contents/count diagram;
2. один factual panel на каждый exact flavor;
3. individually wrapped/product-form evidence;
4. storage/thawing instruction;
5. ingredients/allergen/nutrition panels из exact sources;
6. curator/bundle composition panel без delivery claims.

Gallery не должна создавать впечатление, что в bundle входит больше коробок,
сэндвичей, flavors или аксессуаров, чем записано в recipe.

## 8. Economics gate

Каждый candidate обязан попасть в рациональную cooler zone:

- S: 24 / 28 / 30;
- M: 48–54;
- L: 60–66 только при доказанной экономике;
- XL: 90–135 только отдельным решением.

Базовая модель: `(COGS + packaging) × markup`, shipping отдельно. Расчёт обязан
показать price, invested cash, contribution после marketplace fees и ROI.
Исторический turnover не является разрешением создать SKU с плохой текущей
экономикой.

## 9. Amazon payload и публикационный workflow

### Draft stage

Для каждого `CREATE_NEW` candidate создать:

- immutable recipe manifest;
- content JSON;
- image manifest + QA proof;
- product-type-specific Listings Items payload;
- validation report;
- expected post-submit projection.

Payload не включает незапрошенное изменение inventory, repricing или coupons.

### Existing ASIN

Если overlap gate выбирает `USE_EXISTING`, разрешён только exact-attribute
surgical PATCH с pre-snapshot, validation preview, offer preservation и
post-read verification. Generic full PUT запрещён.

### New ASIN

- один SKU — один POST — ноль retry;
- неизвестный результат POST не повторять;
- после timeout/ambiguous выполнять только GET/reconciliation;
- canary — один owner-approved SKU;
- после accepted processing проверить Catalog, Listings status и buyer storefront;
- только доказанный canary может стать основанием для следующей owner-approved wave.

## 10. Acceptance criteria

Карточка готова к owner review, когда одновременно выполнено:

- [ ] historical concept и решение `CREATE_NEW/USE_EXISTING` документированы;
- [ ] exact recipe замкнут и математически согласован;
- [ ] Product Truth complete для каждого component;
- [ ] COGS/packaging/price/ROI рассчитаны на свежих observations;
- [ ] title, five bullets, description, search terms прошли brand-voice lint;
- [ ] все count/flavor/weight/ingredients/allergen attributes согласованы;
- [ ] MAIN и gallery соответствуют recipe и прошли frozen QA;
- [ ] duplicate/variation/identifier strategy проверена;
- [ ] Amazon validation не содержит blocking issues;
- [ ] upload payload и GET-only ambiguity recovery воспроизводимы;
- [ ] storefront verification checklist подготовлен.

## 11. Deliverable для решения владельца

Перед любым созданием ASIN предоставить одну компактную таблицу:

| Candidate | Historical turnover | Exact recipe | Current overlap | COGS | Target price | ROI | QA | Decision |
|---|---:|---|---|---:|---:|---:|---|---|

Владелец выбирает объём пилота и разрешает публикацию. До этого работа
заканчивается на verified upload-ready artifacts.
