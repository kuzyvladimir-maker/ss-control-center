# Создание НОВОГО товара в Walmart (MP_ITEM 5.0) — что на самом деле требуется

> **Зачем:** 2026-08-03 выяснилось, что через API мы **ни разу не создавали новый
> товар** — только редактировали существующие. Сборщик payload в Bundle Factory
> писался под редактирование и против требований создания не проверялся никогда.
> Этот документ — авторитетный набор требований, снятый с живой схемы Walmart.
>
> Связано: [[walmart-api]], [[walmart-ideal-listing-spec]],
> [[walmart-bundle-factory-repair-2026-08-02]], [[walmart-quantity-confusion-fix]],
> `docs/marketplace-rules/walmart/mp-item-food-attributes.md`.

---

## 1. Главное различие: создание ≠ редактирование

Это корень всей путаницы, и он не описан ни в одном нашем прежнем документе.

| | Редактирование существующего | Создание нового |
|---|---|---|
| Что шлём | только изменяемые поля | **полный обязательный набор** |
| Обязательные поля | не проверяются (товар уже заведён) | проверяются все |
| Пример принятого payload | `Orderable{sku, productIdentifiers}` + `Visible{productName, shortDescription, keyFeatures}` | см. §3 |

Реальный принятый Walmart payload от 2026-07-30
(`data/audits/walmart-listing-full-surface/…/payload-item-text-FaisalX-1433.json`)
содержит **три** текстовых поля и ничего больше. Именно поэтому весь наш
накопленный опыт («closed-list enum отбиваются → не шлём их») **не переносится**
на создание: там их не слать нельзя.

## 2. Источник истины — живая схема, а не документация

Официальная документация Walmart сама отсылает к схеме:

> «Based on the product type selected, the seller will complete the relevant
> attributes as identified in the feed file schema provided.»
> — [Item setup schema key points](https://developer.walmart.com/us-marketplace/docs/item-setup-schema-key-points)

Схема запрашивается `POST /v3/items/spec` с `feedType=MP_ITEM`, точной версией и
`productTypes:[…]`. Требования **зависят от productType** — набор для
«Prepared & Packaged Soups» не равен набору для другой категории.

В коде: `fetchWalmartItemSpecSchemaCached` (`walmart-item-spec.ts`).
Дамп требований: `scripts/_spec_enums.ts <productType>`.

## 3. Обязательный набор для «Prepared & Packaged Soups»

Снято с живой схемы `5.0.20260608-18_15_07-api` (2026-08-03).

### MPItemFeedHeader — ровно три поля

```json
{ "businessUnit": "WALMART_US", "locale": "en", "version": "5.0.…-api" }
```

Любое лишнее поле → `should NOT have additional properties`. Проверено боем:
именно такой заголовок Walmart принимал 30 июля.

### Orderable — обязательно

| Поле | Тип / ограничение |
|---|---|
| `sku` | строка, ≤ 50 |
| `productIdentifiers` | объект `{productId ≤14, productIdType: EAN\|GTIN\|ISBN\|UPC}` |
| `price` | число, кратно 0.01 |
| `ShippingWeight` | число, **кратно 0.001** |
| `country_of_origin_substantial_transformation` | enum из **250 названий стран** (не кодов!) |

⚠️ Имя поля — **snake_case**. Разрешённый список Orderable не содержит
`countryOfOriginSubstantialTransformation` и `productPackageDimensionsAndWeight`
в верблюжьем регистре — правильные имена `country_of_origin_substantial_transformation`
и `product_package_dimensions_and_weight`.

### Visible / Prepared & Packaged Soups — обязательно

| Поле | Значение |
|---|---|
| `productName` | ≤ 199 |
| `brand` | ≤ 60 |
| `condition` | enum(1) — **только `New`** |
| `shortDescription` | ≤ 100000 |
| `keyFeatures` | массив строк |
| `mainImageUrl` | ≤ 2500 |
| `countPerPack` | целое ≥ 0 |
| `isProp65WarningRequired` | enum — `No` \| `Yes` |
| `container_material` | **массив свободных строк** (≤50), НЕ закрытый список |
| `food_condition` | массив, enum(4): `Frozen` \| `Raw` \| `Refrigerated` \| `Shelf-Stable` |
| `ingredientListImage` | строка-URL ≤ 2500 — **фото списка ингредиентов** |
| `netContent` | объект `{productNetContentUnit, productNetContentMeasure}` |

`productNetContentUnit` enum(14): Centiliter, Count, Each, Fluid Ounces, Gallon,
Gram, Kilogram, Liter, Milliliter, **Ounce**, Pint, Pound, Quart, Quart Dry.
`productNetContentMeasure` — число, кратно 0.001.

Важно: `container_material` оказался **свободным**, а не enum — прежняя запись в
[[walmart-quantity-confusion-fix]] о том, что он отбивается по enum, относилась к
другому режиму/версии. Перепроверять по схеме, а не по памяти.

## 4. Чего не хватает нашему payload (состояние на 2026-08-03)

Проверено запуском настоящей публикации: 17 замечаний, 11 уникальных.

| Группа | Проблема |
|---|---|
| Заголовок | шлём 7 полей вместо 3; нет `businessUnit` |
| Orderable | верблюжьи имена вместо snake_case; `ShippingWeight` не кратен 0.001 |
| Visible | нет шести обязательных: `condition`, `isProp65WarningRequired`, `container_material`, `food_condition`, `netContent`, `ingredientListImage` |

Откуда брать значения:

- `condition` = `New` (константа);
- `isProp65WarningRequired` = `No` для консервированного супа;
- `container_material` = материал тары из товара (банка → Metal);
- `food_condition` = `Shelf-Stable` для консервов; заморозка/охлаждёнка — свои
  значения, но на Walmart они у нас запрещены ([[frozen-restrictions]]);
- `netContent` = из Product Truth (`sizeBaseAmount`/`sizeBaseUnit`), единица
  приводится к enum;
- `ingredientListImage` — см. ниже.

## 5. `ingredientListImage` — единственное, чего у нас нет готовым

Walmart требует **изображение** списка ингредиентов, не текст. Текст состава у нас
есть (`BundleComponent.ingredients`), и у донора обычно 5–7 фотографий, среди
которых стандартные вторичные снимки Walmart с панелью состава/пищевой ценности.

Значит задача — **выбрать нужный кадр**, а не создать его. Это тот же класс, что
уже решался для доноров ([[feedback_walmart_donor_photo_selection]] в памяти):
классифицировать донорские фото и взять то, где панель состава.

Родственное поле `nutritionFactsLabel` (панель пищевой ценности) в схеме тоже
есть и не обязательно — но заполняется тем же механизмом и улучшает карточку.

## 6. Как проверять БЕЗ отправки

`submitToWalmart({ dryRun: true, validateLiveSpec: true })` проходит контракт,
payload и **живую схему Walmart**, не делая ни одной записи.

⚠️ Ловушка: без `validateLiveSpec: true` сухой прогон возвращает
`DRY_RUN_LOCAL_ONLY` и `ok: true`, **не проверив схему**. Прежние записи «сухой
прогон ok: true» ничего не говорили о соответствии схеме — это стоило нам
полудня.

Готовые инструменты: `scripts/_spec_diff.ts <SKU>` (что не так с нашим payload),
`scripts/_spec_enums.ts <productType>` (что требует Walmart).
