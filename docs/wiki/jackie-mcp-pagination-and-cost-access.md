# Jackie MCP: пагинация, чтение цены Walmart и доступ к себестоимости

Дата: 2026-08-08. Полоса: `infra`. Автор: Claude Code.

Джеки (агент OpenClaw) ходит в SSCC только через `/api/mcp`. До этой работы у неё
были клампы без пагинации: ограничитель поставили, а дверь рядом — нет. Плюс
не было чтения цены Walmart и доступа к себестоимости.

## 1. Главная находка: курсор `/v3/orders` был сломан

`meta.nextCursor` у Walmart — **не** непрозрачный токен, а готовая строка
запроса:

```
?limit=200&hasMoreElements=true&soIndex=3016&cursor=QW9K…&poIndex=200&createdStartDate=…
```

Её надо **дописывать к пути**. Мы же отправляли её значением параметра —
`GET /v3/orders?nextCursor=%3Flimit%3D200…`. Walmart отвечает **200 OK** и при
этом курсор молча игнорирует: отдаёт заново первую страницу.

Замер 08.08.2026 на живом аккаунте:

| способ | строк | пересечение со страницей 1 | следующий курсор |
|---|---|---|---|
| `?nextCursor=<urlencoded>` (было) | 76 | **100 %** | `null` |
| курсор дописан в путь (стало) | 100 | **0 %** | `poIndex=200` |

Поэтому «глубже 200 заказов не уйти»: обход обрывался на второй странице, и та
была дублем первой. Ломались не только MCP-тулы — тем же курсором крутятся
`/api/procurement/inquire-quantity` и `/api/procurement/walmart-cancellations`.

Исправлено в `src/lib/walmart/orders.ts` (`cursorPath()`); регрессионный тест —
`src/lib/walmart/__tests__/orders-cursor.test.ts`.

**После починки:** обход с `created_start_date=2026-01-01` даёт **16 страниц,
3 016 заказов**, самый ранний — **2026-02-09T17:39:46Z**.

## 2. Второе ограничение: горизонт Walmart ≈ 180 дней

Заказы с 1 января **недостижимы в принципе**, и это не наша ошибка. Walmart
молча переписывает `createdStartDate` старше ~180 дней: попросили `2026-01-01`,
а в возвращённом курсоре стоит `createdStartDate=2026-02-09`. Явное окно тоже не
помогает:

```
2026-01-01 .. 2026-02-01 → totalCount=0
2026-02-01 .. 2026-03-01 → totalCount=312 (самый ранний 2026-02-16)
2025-11-01 .. 2025-12-01 → totalCount=0
```

Вывод: январь 2026 из Marketplace API не поднять. Единственный источник за
пределами горизонта — наша собственная таблица `WalmartOrder` и отчёты.

## 3. Единый контракт пагинации

Все страничные read-тулы отвечают одинаково: `{ …, total, offset, next_offset }`
либо `{ …, total, next_cursor }`. Кламп размера страницы остаётся (ответ не
должен взрывать контекст модели) — реку открывает `offset`/`cursor`.

| тул | вход | выход |
|---|---|---|
| `walmart_orders_list` | `cursor`, `created_start_date`, `created_end_date` | `total`, `next_cursor` |
| `drafts_list` | `offset` | `total`, `next_offset` |
| `listings_search` | `offset`, `query` теперь **необязателен** | `total`, `next_offset` |
| `research_pool_search` | `offset` | `total`, `next_offset` |

Сортировка везде добита уникальным ключом (`id`, `sku`, `identityKey`), иначе
страницы теряют и дублируют строки на одинаковых `updated_at`.

`listings_search`: пустой `query` = «весь канал». Кламп поднят 100 → 200.
Проверено: WALMART отдаёт `total=10`, AMAZON_SALUTEM — `total=189`,
сумма страниц равна `total`.

## 4. `walmart_price_get` — чтение цены

`GET /v3/price` **не существует**: проверено живьём, 404
`CONTENT_NOT_FOUND.GMP_GATEWAY_API` («No static resource v3/price») —
`/v3/price` только на запись. Читаемый эндпоинт — каталожный:

```
GET /v3/items/{sku} → ItemResponse[0].price = { currency, amount }
```

Тул отдаёт `current_price`, `currency`, `effective_date`, `published_status`,
`lifecycle_status`, `availability`, `wpid`, `upc`, `product_name`. Принимает
`sku` или `skus` (до 100, пул из 4 параллельных GET). Ошибка по одному SKU не
роняет пачку.

`effective_date` всегда `null` — в item-ответе Walmart отметки времени цены нет.
Поле оставлено в контракте, чтобы форма не менялась, если Walmart её добавит.

Write-путь (`walmart_update_price`, `PUT /v3/price`, price-feed) не тронут —
крон `walmart-price-ramp-breadline` работает на прежнем контракте.

## 5. `research_pool_id` указывает не туда, куда написано

`draft_components[].research_pool_id` **не** ссылается на таблицу
`ResearchPool`. В `ResearchPool` лежат **3 смоук-строки** от 19.05.2026
(Lunchables, Capri Sun, cuid-идентификаторы, без UPC). А id из
`draft_components` (например `03eba512-c138-4942-bd34-177fae87c91b`)
резолвится в **`DonorProduct`**. Имя поля — легаси; данные живут в Product Truth.

Реальный пул на 08.08.2026:

| таблица | строк |
|---|---|
| `DonorProduct` | **8 544** (Dry 7 472 / Frozen 1 072; с ценой 8 541; с UPC 4 641) |
| `DonorOffer` | **9 287** (walmart 3 753, target 2 877, publix 2 191, costco 231, samsclub 185, bjs 42, aldi 8) |
| `RetailPrice` | 12 143 |
| `SkuCost` | 6 645 строк / **5 657 уникальных SKU** (FaisalX 2 772, RizwanX 2 043) |
| `ResearchPool` | 3 (смоук-тест, не использовать) |

`identityStatus`: `exact_confirmed` 450, `legacy_unverified` 8 094.

## 6. Покрытие себестоимости по проданным Walmart SKU

Обход всех 3 016 доступных заказов → **1 063 различных SKU** продано,
из них 519 продавались больше одного раза.

| | покрытие |
|---|---|
| есть строка в `SkuCost` | 950 / 1 063 = **89,4 %** |
| есть строка **с числом** | 827 / 1 063 = **77,8 %** |
| из «продавались >1 раза» — с числом | 410 / 519 = **79,0 %** |

То есть COGS по старому Walmart-каталогу **есть**, и аудит можно
пересчитать на настоящей себестоимости вместо оценок по рознице Publix.
Прогонять движок обогащения заново нужно только по остатку ~109 повторных SKU.

Отдано наружу двумя тулами:

- `research_pool_search` — пул как таковой: identity, `best_price`,
  `best_retailer`, `price_per_measure`, и по флагу `include_offers` — все
  офферы ретейлеров. Поиск по `id` / `upc` / `query` / `brand` / `category`.
  Поле `research_pool_id` продублировано в ответе, чтобы совпадало с
  `draft_components`.
- `sku_cost_get` — COGS по SKU (одиночно или пачкой до 100).

## 7. Ловушка `SkuCost`: свежая строка может быть пустой

У `FaisalX-1142` две наблюдения:

```
2026-07-29  retail:batch  UNSOURCEABLE  totalCost=null
2026-07-08  retail:batch  —             totalCost=9.56  ("bundle: 2×$4.78")
```

Свежая — это неудачная попытка переоценки (живого розничного оффера не нашли),
а не «цена обнулилась». Поэтому `sku_cost_get` отдаёт **два** поля: `cost` —
последнее наблюдение, где реально есть число, и `latest` — последнее любое,
плюс флаг `stale`. Брать `latest` как себестоимость — ошибка.

## Проверено на живых данных

```
walmart_orders_list   16 страниц, 3 016 заказов, минимум 2026-02-09
drafts_list           5 страниц, sum=234 = total=234, 234 уникальных id
listings_search       WALMART пустой query: sum=10 = total=10
walmart_price_get     FaisalX-1142 → $21.91 USD, PUBLISHED, ACTIVE, Out_of_stock
```

Сверка с витриной walmart.com из этой сети невозможна: публичный PDP
(`/ip/8412902252`, usItemId получен через `GET /v3/items/walmart/search?upc=`)
отдаёт капчу — датацентр-IP упирается в бот-стену, как и описано в
`walmart-catalog-cache`. Проверять витрину — только с бокса OpenClaw или
глазами владельца.

Связано: [[product-truth-operator-runbook]], [[donor-catalog-execution-roadmap]],
[[walmart-catalog-cache]].
