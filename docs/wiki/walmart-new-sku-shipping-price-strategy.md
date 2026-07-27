# Walmart New SKU — item price vs customer shipping

> **Evidence review и owner commercial decision, 2026-07-26.**
> Область: Walmart US Marketplace, seller-fulfilled новые SKU из Bundle Factory.
> Связано: [[walmart-new-sku-command-center]],
> [[walmart-new-sku-operator-runbook]], [[walmart-growth-roadmap]],
> [[product-catalog-architecture]].
>
> Этот документ определяет channel-specific коммерческую политику Walmart. Он не
> меняет Product Truth: донорский каталог по-прежнему хранит точный товар, офферы,
> фактические затраты и evidence, а не marketplace presentation strategy.

## Короткое решение

При одинаковой итоговой сумме и одинаковой честно достижимой скорости доставки
Bundle Factory выбирает **бесплатную доставку по умолчанию**.

Платный shipping не считается способом «обмануть алгоритм низкой ценой товара».
Walmart официально сравнивает landed price — `item price + shipping`; shipping cost
и speed также являются отдельными факторами Buy Box. Низкая headline price может
психологически привлечь часть покупателей, но отдельная доплата создаёт риск потери
Buy Box eligibility, доверия и conversion.

Платный shipping разрешён только:

1. как ограниченный измеримый эксперимент с неизменным landed total;
2. если он связан с реально более быстрым и операционно достижимым service level;
3. как экономически необходимое исключение для дорогой/переменной доставки, когда
   free-shipping модель не выдерживает worst-case geography.

До собственных результатов Walmart-аккаунта рабочий default:

```text
FAST_FREE
  > FREE_STANDARD
  > PAID_FAST_EXPERIMENT
  > PAID_STANDARD_EXCEPTION
```

Это не утверждение о закрытых весах Walmart ranking. Порядок означает нашу
консервативную бизнес-политику после hard gates, а не реконструкцию secret algorithm.

## Вопрос владельца

Если требуемая итоговая сумма равна `$33.13`, а существующий template берёт
`$11.99` shipping, можно показать:

```text
item price        $21.14
customer shipping $11.99
landed total      $33.13
```

Или ту же сумму как:

```text
item price        $33.13
customer shipping  $0.00
landed total      $33.13
```

Может ли низкая headline price дать больше кликов и продаж? Гипотеза
психологически правдоподобна, но Walmart-specific факты не поддерживают её как
безопасный default.

## Что доказано официальными источниками Walmart

### 1. Алгоритм цены видит landed total

Walmart определяет:

- Buy Box price как `item price + shipping`;
- external competitive price как `item price + shipping`;
- Buy Box eligibility может быть потеряна по причине `Ship price not satisfied`.

Следовательно, разбиение `$33.13` на `$21.14 + $11.99` само по себе не делает
offer дешевле для pricing competitiveness или Buy Box.

Источник: Walmart Marketplace Learn,
[Pricing Insights: Overview](https://marketplacelearn.walmart.com/guides/Listing%20optimization/Price/pricing-insights-overview),
обновлено 2026-06-19.

### 2. Shipping cost — самостоятельный риск Buy Box и publication

Walmart прямо указывает, что Buy Box учитывает competitive pricing, shipping speed,
shipping cost, inventory, content и post-purchase experience. Чрезмерный shipping
может сделать offer Buy Box-ineligible, привести к unpublish, rejected template
upload и account consequences. Публичного универсального dollar/percentage threshold
Walmart не публикует.

Источник: Walmart Marketplace Learn,
[Pricing rules](https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Product%20listings/Pricing-rules),
обновлено 2025-12-12.

Вывод: нельзя вводить выдуманный safe threshold вроде «shipping не больше 30%».
Движок обязан проверять фактический template, Walmart response и свежий pricing
status; неизвестное значение блокирует publication.

### 3. US Listing Quality отдельно измеряет delivery speed

Официальный US Listing Quality shipping component измеряет promised delivery speed
по ZIP codes. Walmart не публикует на этой странице ranking weights и не утверждает,
что одна только надпись `Free shipping` автоматически перекрывает все остальные
факторы.

Источник: Walmart Marketplace Learn,
[Listing Quality: Overview](https://marketplacelearn.walmart.com/guides/Listing%20optimization/Items%20and%20inventory/Listing-quality-and-rewards-dashboard?locale=en-US),
обновлено 2026-04-09.

### 4. Walmart рекомендует fast and free

Walmart связывает fast and free delivery с ростом Buy Box wins, более высоким
search/browse ranking через Listing Quality, повышением conversion и снижением cart
abandonment. Это directional first-party recommendation, а не гарантия конкретного
uplift для нашего dry-food каталога.

Источники:

- [Expedited Delivery](https://marketplace.walmart.com/expedited-delivery/);
- [Shipping & Fulfillment](https://marketplace.walmart.com/shipping-and-fulfillment/);
- [Shipping solutions](https://marketplace.walmart.com/shipping-solutions/) —
  содержит исторический Walmart first-party benchmark 2023 для expedited delivery;
- [Simplified Shipping Settings](https://marketplace.walmart.com/shipping-settings/) —
  допускает free shipping для привлечения покупателей и paid shipping для покрытия
  fulfillment costs.

### 5. Walmart отчётность позволяет измерять обе части цены

BUYBOX report содержит отдельно Seller Item Price, Seller Ship Price, BuyBox Item
Price и BuyBox Ship Price. Это позволяет оценивать split на собственных SKU, не
угадывая secret ranking.

Источник: Walmart Developer Portal,
[Request a Buy Box insights report](https://developer.walmart.com/us-marketplace/docs/request-a-buy-box-insights-report).

### 6. SKU должен быть связан с exact shipping template

Template не является устным допущением в economics. Candidate обязан нести exact
template ID и после публикации подтверждённую SKU association.

Источник: Walmart Developer Portal,
[Shipping & fulfillment](https://developer.walmart.com/us-marketplace/docs/shipping-fulfilment)
и [Get item associations](https://developer.walmart.com/us-marketplace/docs/get-item-associations).

## Что известно о поведении покупателей

### Высокая применимость: общая e-commerce UX

Baymard сообщает по данным 2025 года:

- 64% пользователей начинают думать о shipping costs уже на product page;
- 55% бросали заказ за последний квартал из-за слишком высоких дополнительных
  расходов, главным образом shipping.

Это не Walmart-only causal test, но сильное предупреждение против стратегии
«покупатель не заметит shipping».

Источник: Baymard Institute,
[Product Pages: “Free Shipping” Should Not Only Be in a Site-Wide Banner](https://baymard.com/blog/avoid-banners-only-free-shipping).

### Partitioned pricing: гипотеза владельца реальна

Исследования partitioned pricing действительно находят anchoring/inattention:
часть покупателей недостаточно корректирует низкую base price на менее заметный
shipping surcharge.

- Clark & Ward наблюдали этот эффект даже у опытных eBay bidders:
  [Consumer Behavior in Online Auctions](https://aquila.usm.edu/fac_pubs/20946/).
- Исследования online price partitioning находили снижение remembered total cost
  и иногда рост demand при разделении цены:
  [Price Partitioning on the Internet](https://doi.org/10.1002/dir.20017).

Ограничение: эти работы старые, значительная часть данных относится к eBay/auction
UX, а не к текущему Walmart US. Они подтверждают существование психологии, но не
доказывают рост Walmart GMV или contribution profit.

### Free shipping имеет отдельный zero-price effect

Field evidence на eBay находил более высокую вероятность продажи и valuation при
free shipping даже при контроле total price. Это подтверждает, что покупатель не
всегда воспринимает `$21.14 + $11.99` как эквивалент `$33.13 + free`.

Источник:
[The Value of Free — Evidence From Shipping Charges on eBay](https://ecommons.cornell.edu/bitstreams/efb61544-501e-414c-8a9b-da8ab4e7db0d/download).

### Free shipping может поднять продажи и всё равно снизить прибыль

Empirical retail research показывает высокую чувствительность к shipping fees:
free-shipping promotions могут увеличивать order incidence и basket size, но потеря
shipping revenue делает часть таких promotions неприбыльной. Поэтому conversion
нельзя использовать как единственную целевую метрику.

Источник: Lewis, Singh & Fay,
[Impact of Nonlinear Shipping and Handling Fees](https://pubsonline.informs.org/doi/10.1287/mksc.1050.0150).

### Разные стратегии привлекают разные сегменты

Исследование online retailers обнаружило, что продавцы с partitioned shipping
показывали более низкие item prices, но в выборке их total price в среднем был выше.
Free и partitioned pricing могут работать на разные buyer segments; универсального
победителя вне конкретной площадки и продукта нет.

Источник: Gumus, Li, Oh & Ray,
[Shipping Fees or Shipping Free?](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1731285).

## Что говорят продавцы Walmart

Seller discussions противоречивы:

- одни сообщают, что покупатели ожидают free shipping и separate charge ухудшает
  продажи;
- другие исторически наблюдали, что низкая item price получала клики или даже Buy
  Box до того, как shipping становился заметным;
- более новые обсуждения чаще утверждают, что Buy Box смотрит total price.

Примеры:

- [Free Shipping for Customers](https://www.reddit.com/r/WalmartSellers/comments/w7y6n0/free_shipping_for_customers/);
- [Buy Box Algorithm — Low Cost + High Shipping](https://www.reddit.com/r/WalmartSellers/comments/itdhdq);
- [New seller / free shipping](https://www.reddit.com/r/WalmartSellers/comments/1d4f5ea);
- [How to set mandatory shipping cost?](https://www.reddit.com/r/WalmartSellers/comments/1iola5q).

Уровень доказательности низкий: self-reported results, маленькие samples, разные годы,
категории и версии Walmart UI/algorithm. Форумы полезны для формулирования теста, но
не заменяют official contract или собственные account data.

## Итог по теории владельца

Теория **частично верна**:

- низкая item price может улучшить первое восприятие и CTR, если shipping показан
  менее заметно;
- часть покупателей действительно недооценивает surcharge.

Но как постоянная Walmart-стратегия теория недостаточна:

- price algorithm сравнивает landed total;
- shipping cost сам влияет на Buy Box eligibility;
- fast/free имеет подтверждённые Walmart visibility/conversion benefits;
- buyer может заметить `$11.99` позже и отказаться;
- UI меняется по ZIP, device, membership и fulfillment context, поэтому скрытость
  shipping нельзя считать стабильным бизнес-активом.

## Каноническая формула

Для каждого destination/service scenario `z`:

```text
P         = item price
S(z)      = customer shipping charge из exact Walmart template
T(z)      = P + S(z)                       # landed total до sales tax
L(z)      = наша фактическая shipping-label cost
G         = goods cost
K         = packaging cost
r         = exact Walmart referral rate
F(z)      = referral fee с T(z)
profit(z) = T(z) - G - K - L(z) - F(z)
margin(z) = profit(z) / T(z)
```

Hard gate:

```text
margin(z) >= 30% для каждого разрешённого scenario z
```

Для flat `$11.99` template и одного фиксированного cost scenario:

```text
required landed total T* = $33.13
customer shipping S      = $11.99
item price P             = T* - S = $21.14
```

Нельзя оставить `P=$33.13` и добавить `$11.99`: shipping будет учтён дважды.

Для variable-rate template единая item price должна выдерживать worst case:

```text
Pmin = max по z [
  required_total_for_costs(G, K, L(z), r, 30%) - S(z)
]
```

После cents rounding каждый scenario пересчитывается точно; algebraic estimate сам
по себе не является certification.

## Алгоритм выбора template

### Hard gates до сравнения

Каждый template candidate обязан иметь:

1. exact active template ID и immutable rate snapshot;
2. полное покрытие разрешённых regions/services;
3. честно достижимые handling + transit promises;
4. точные `S(z)` и label-cost model `L(z)`;
5. category-correct referral fee, начисленную на `P + S(z)`;
6. worst-case contribution margin не ниже 30%;
7. отсутствие Pricing Rule, Egregious Shipping Cost и Buy Box eligibility blockers;
8. preview с item price, shipping, landed total, ETA и margin scenarios;
9. post-publish verification exact SKU→template association.

Если хотя бы один пункт неизвестен, состояние `BLOCKED`, а не silent free/paid default.

### Preference после hard gates

1. Сначала выбрать самый быстрый service level, который бизнес реально выдерживает
   по разрешённым ZIP без ухудшения account health.
2. Среди templates с одинаковой честной speed/coverage и одинаковым landed total
   выбрать free shipping.
3. Paid-fast может конкурировать с free-slow только как отдельная гипотеза:
   скорость и price presentation нельзя смешивать в одном выводе.
4. Paid-standard при доступном free-standard разрешается только experiment flag или
   доказанная экономическая необходимость.
5. Никаких выдуманных ranking weights. После pilot selector обучается только на
   наших Walmart impressions, conversion, Buy Box и contribution profit.

## Controlled experiment

Истинный A/B одного SKU через duplicate listings запрещён. Используется matched-pair
experiment на разных, максимально сопоставимых новых SKU и только после отдельного
post-pilot owner gate.

### Тест A — только framing

- Arm FREE: `P=T*`, `S=0`;
- Arm PAID: `P=T*-S`, `S>0`;
- одинаковые speed, coverage, content quality, inventory и landed total.

Так измеряется именно психологический эффект split.

### Тест B — service trade-off

- Arm FREE_STANDARD;
- Arm PAID_FAST;
- landed economics одинаково защищены.

Это отдельный тест влияния скорости; его нельзя объединять с Test A.

### Основная метрика

```text
contribution profit per 1,000 impressions
```

Она одновременно учитывает visibility, CTR/conversion и реальную прибыль.

Дополнительные метрики:

- impressions и product-page views;
- CTR, conversion, units, GMV;
- Buy Box eligibility/win rate;
- Listing Quality shipping component;
- item/ship price против Buy Box report;
- cancellation, return и shipping-related complaint rate;
- contribution profit per order;
- фактическая label cost против model.

Paid shipping становится default не после одного удачного SKU, а только после
повторяемого account-level результата без ухудшения policy/Buy Box/account health.
До этого `FAST_FREE` остаётся default.

## Реализация в Walmart New SKU engine

Owner decision 2026-07-26: выбор shipping presentation остаётся ручным и
опциональным. После выбора канала Walmart Bundle Factory:

1. показывает только active shipping templates выбранного Walmart account;
2. позволяет открыть exact rate/service/coverage details в modal;
3. сохраняет template ID и normalized snapshot/hash в канонической Walmart request;
4. для free shipping оставляет всю required total в item price;
5. для paid shipping вычисляет `item price = required total - customer shipping`,
   не добавляя shipping поверх уже рассчитанной all-in суммы;
6. не позволяет owner selection автоматически заменить никаким «лучшим» template.

Frozen release v26 реализует:

- `shipping_template_id` и exact template snapshot/hash;
- explicit scenario matrix и customer shipping charge;
- `item_price`, `landed_total`, ETA и referral fee с `item + shipping`;
- worst-case `30%` contribution-margin certification;
- strategy disposition
  `FAST_FREE_DEFAULT | PAID_FAST_EXPERIMENT | PAID_STANDARD_EXCEPTION | BLOCKED`;
- signed one-SKU `SKU_TEMPLATE_MAP` payload после `MP_ITEM`;
- read-only post-publish `/items/associations` verification exact template ID и
  fulfillment center;
- fail-closed pending outcome, пока Walmart association не распространилась;
- replay fence: повторный apply не создаёт второй item или template feed.

V26 engine SHA `e44553af…a78135`, manifest SHA `e441a1c0…91460`, certificate SHA
`45526f11…73ca5`. Frozen Product Truth `468/468`, focused shipping/permit `18/18` и
fake-live integration `3/3` прошли. Production read-only store1 probe разобрал все
`11` active templates и подтвердил `3` free templates; parser нормализует только
легитимно опущенный Walmart неиспользуемый zero variable charge и fail-closed
отклоняет отсутствие обеих переменных ставок. Реальные Walmart writes равны `0`.

Текущие шесть RITZ/OREO owner previews по решению владельца используют explicit
free-shipping selection: `S=0`, поэтому required landed total целиком является item
price. Это commercial choice для текущего pilot review, а не запрет на paid template
для следующих SKU.

## Evidence confidence

| Вывод | Confidence |
|---|---|
| Walmart Buy Box/competitive price использует item + shipping | Высокий, official current |
| Shipping cost/speed влияют на Buy Box; excessive shipping опасен | Высокий, official policy |
| US Listing Quality shipping component измеряет promised speed | Высокий, official current |
| Fast/free обычно помогает visibility и conversion | Средне-высокий, Walmart first-party directional |
| Низкая base price может использовать buyer inattention | Средний, academic, mostly non-Walmart/older |
| Paid shipping улучшит именно наш Walmart результат | Не доказано; нужен controlled account experiment |
| Forum anecdotes описывают текущий algorithm | Низкий |
