# Uncrustables: историческая форензика ASIN и модель восстановления

> Срез на 2026-08-13. Цель документа — определить, какие исторические карточки
> Uncrustables создавали оборот, какие из них исчезли, из чего они состояли и
> какие коммерческие решения стоит воспроизвести в новых карточках.
>
> Это аналитика оборота, а не прибыли: возвраты, refunds, COGS и стоимость
> упаковки здесь не вычтены.

## 1. Короткий ответ владельцу

Главный результат: историческая линейка держалась на двух типах офферов.

1. **Mixed-flavor bundles на 24–50 сэндвичей.** Абсолютный лидер — шесть вкусов,
   24 штуки: 1 003 проданных набора и $90 835,74 gross order-line turnover.
2. **Single-flavor bundles на 28–30 сэндвичей.** Особенно хорошо повторялись
   Strawberry 30, Grape 30, Raspberry 30, Honey 28, Peanut Butter 28 и
   Chocolate Hazelnut 30.

В апрельской когорте исчезновения наиболее ценными были именно single-flavor
28/30-count карточки. Шесть лидеров этой когорты дали 376 наборов и $37 157,84 —
82,1 % оборота всей когорты, помеченной Veeqo inactive 30 апреля.

Старый контент не следует копировать буквально. Карточки продавались **несмотря
на** системные ошибки:

- MAIN часто показывал одну розничную коробку, хотя продавался pack of 2/3/7;
- bullets и description описывали одну коробку, а не весь оффер;
- `flavor`, `specialty`, `unit_count` и фактический title иногда расходились;
- один MAIN переиспользовался между разными количествами;
- использовались promotional и nutrition/health-like формулировки, которые не
  соответствуют нынешнему бренд-голосу.

Поэтому воспроизводить нужно **спрос на конкретный вкус + понятный total count +
точный рецепт набора**, а контент строить заново по Product Truth и текущему
канону изображений.

## 2. Что доказано и чем

### Первичные источники

- 26 Amazon All Orders reports за 2024-07-01 — 2026-08-13: 14 426 строк,
  102 ASIN/SKU identity, 2 843 non-cancelled units, $313 978,45 gross turnover.
- Veeqo/Vico catalog capture: 79 точных product records с title, description,
  Amazon channel status и MAIN reference.
- Текущий Amazon Catalog/Listings snapshot для top-30 исторических identity.

Машинные артефакты:

- [полный исторический реестр](../../ss-control-center/data/audits/uncrustables-historical-orders-20260813-v1/historical-uncrustables-registry.md);
- [ранжированный sales report](../../ss-control-center/data/audits/uncrustables-historical-orders-20260813-v1/uncrustables-sales-summary.md);
- [форензика top-30](../../ss-control-center/data/audits/uncrustables-leader-forensics-20260813-v2/leader-forensics-summary.md);
- [Veeqo capture](../../ss-control-center/data/audits/uncrustables-veeqo-history-20260813-v1/veeqo-capture.json).

### Границы доказательства

- Amazon Orders доказывает строки заказов и gross turnover, но не чистую
  выручку и не прибыль.
- `inactive_after=2026-04-30` доказывает дату деактивации Amazon-channel record
  в Veeqo, но не Amazon reason code.
- Текущий Amazon Catalog 404 доказывает, что ASIN отсутствует сейчас, но сам по
  себе не доказывает причину удаления.
- Текущий seller contribution живых ASIN — более позднее наблюдение. Его нельзя
  выдавать за точный byte-for-byte snapshot карточки в момент старых продаж.
- Публичные mirrors используются только как вторичное подтверждение полей уже
  исчезнувших карточек.

## 3. Какие карточки создавали основной оборот

| Rank | ASIN / SKU | Конфигурация | Units | Gross turnover | Текущий статус |
|---:|---|---|---:|---:|---|
| 1 | `B0DQ92QQ56` / `P5-EYLN-3YHG` | 6 flavors, 4 ct × 6 = 24 | 1 003 | $90 835,74 | live |
| 2 | `B0DQ2PWTDM` / `T4-Y0G0-ZHII` | Raspberry, 10 ct × 3 = 30 | 307 | $31 016,36 | live |
| 3 | `B0DQ1FGVD2` / `4D-7Z1N-8091` | Grape, 15 ct × 2 = 30 | 237 | $23 837,21 | live |
| 4 | `B0DQ95N73D` / `V2-049D-3EGU` | 6 flavors, 4 ct × 12 = 48 | 153 | $22 450,91 | live |
| 5 | `B09B6F4XG2` / `U6-T67A-LKQ0` | Strawberry + Grape + Chocolate, 45 total | 79 | $10 740,57 | Catalog 404 |
| 6 | `B0DQVJ7J7P` / `Z1-026E-4UJA` | 5 flavors, 10 ct × 5 = 50 | 71 | $10 059,19 | live |
| 7 | `B09XR66NBN` / `AA-OBKO-4ONW` | Whole Wheat Strawberry, case 72 | 51 | $9 060,71 | Catalog 404 |
| 8 | `B0DQ549926` / `F3-2X1R-MTQN` | Strawberry, 10 ct × 3 = 30 | 87 | $8 504,23 | April inactive + 404 |
| 9 | `B0G2N7814L` / `714671746159` | Grape gift set, 4 ct × 6 = 24 | 79 | $7 691,59 | live |
| 10 | `B0DQ1CSQQG` / `6X-HAJ6-NN8X` | Grape, 10 ct × 3 = 30 | 77 | $7 393,44 | April inactive + 404 |

Девять mixed/variety identity в top-30 дали 1 415 units и $154 021,49. Но один
ASIN №1 дал почти две трети их оборота. Без него оставшиеся восемь mixed/variety
identity дали 412 units и $63 185,75. Поэтому вывод «любой mixed bundle продаётся
лучше single flavor» данными не подтверждён.

Зато повторяемый сигнал по total count сильнее:

- два разных Grape 30 рецепта — 15 ct × 2 и 10 ct × 3 — оба попали в top-10;
- два Strawberry 30 рецепта — 10 ct × 3 и 15 ct × 2 — оба вошли в лидеры
  апрельской удалённой когорты;
- два Chocolate Hazelnut 30 рецепта — 15 ct × 2 и 10 ct × 3 — также продавались;
- Honey 28 и Peanut Butter 28 были следующей устойчивой парой.

Это не причинный A/B-тест, но это достаточный коммерческий сигнал, чтобы
приоритизировать 24/28/30-count рецепты при условии нормальной unit economics.

## 4. Что именно исчезло в апрельской когорте

17 ASIN/SKU rows, соответствующих 16 уникальным ASIN, получили в Veeqo почти
одинаковый `inactive_after` 2026-04-30T04:26:29Z. Вместе они дали 431 unit и
$45 262,12 gross turnover. В top-30 восемь наиболее оборотных из них сейчас
также возвращают Amazon Catalog 404.

| Приоритет | ASIN | Конфигурация | Units | Turnover | Последний заказ |
|---:|---|---|---:|---:|---|
| 1 | `B0DQ549926` | Strawberry, 10 ct × 3 = 30 | 87 | $8 504,23 | 2026-04-12 |
| 2 | `B0DQ1CSQQG` | Grape, 10 ct × 3 = 30 | 77 | $7 393,44 | 2026-04-27 |
| 3 | `B0DQ5VR1PS` | Honey, 4 ct × 7 = 28 | 68 | $6 910,38 | 2026-04-18 |
| 4 | `B0DQ3QKDXC` | Strawberry, 15 ct × 2 = 30 | 53 | $5 384,97 | 2026-04-28 |
| 5 | `B0DQ62Z4ZR` | Peanut Butter, 4 ct × 7 = 28 | 46 | $4 649,28 | 2026-04-19 |
| 6 | `B0DQ5HBWFT` | Chocolate Hazelnut, 15 ct × 2 = 30 | 45 | $4 315,54 | 2026-04-14 |
| 7 | `B0DQ28HHHG` | Strawberry, 4 ct × 16 = 64 | 23 | $4 003,48 по двум SKU | 2026-04-08 / 2025-12-05 |
| 8 | `B0DQ5GFZN7` | Chocolate Hazelnut, 10 ct × 3 = 30 | 23 | $2 354,39 | 2026-04-27 |

Остальные восемь rows дали только $1 746,41. В их числе 45/48/50/60/108-count
конфигурации и три identity с нулём non-cancelled units. Их нельзя ставить в
первую волну только потому, что они существовали.

## 5. Разбор карточек «на молекулы»

### 5.1. Title

Рабочая историческая формула была очень прямой:

`Uncrustables + exact flavor(s) + retail box count + Pack of N + total pieces`

Для mixed cards добавлялись число коробок каждого вкуса и полный перечень
flavors. В title всегда находился поисковый intent, который покупатель мог
сопоставить с оффером: бренд, вкус, frozen sandwich, фасовка и total count.

Сильная сторона старых title — прозрачная математика. Слабые стороны —
перегруженность, разный порядок слов, лишние дефисы и иногда неточная продуктовая
линия. В новом title математика должна сохраняться, а flavor wording должен
дословно соответствовать exact variant.

### 5.2. Bullet points

У живых mixed-лидеров использовалось шесть однотипных bullets:

1. число коробок и total sandwiches;
2. список вкусов;
3. freezer storage / thawing;
4. crustless form;
5. no-cook convenience;
6. nutrition/protein-style benefit.

У single-flavor cards было обычно пять manufacturer-style bullets:

1. количество в **одной** розничной коробке;
2. bread/product form;
3. flavor/filling;
4. отсутствие отдельных ингредиентов или nutrition claim;
5. thaw / unwrap / eat.

Главный дефект: bullet №1 нередко описывал одну коробку вместо полного bundle.
Например Raspberry 30 говорил про одну 10-count box, а Grape 30 — про один
15-count pack. Публичные mirrors показывают тот же шаблон у исчезнувших
Strawberry, Grape, Honey, Peanut Butter и Chocolate cards:

- [Strawberry 30, `B0DQ549926`](https://www.ubuy.com.es/en/product/MWMK8HM8O-uncrustables-peanut-butter-strawberry-jam-sandwiches-10-count-frozen-pack-of-3-total-30-pieces);
- [Grape 30, `B0DQ1CSQQG`](https://www.ubuy.ae/en/product/MWCMRGZA6-smucker-x27-s-uncrustables-frozen-peanut-butter-grape-jelly-sandwich-10-count-pack-of-3-total-30-pieces);
- [Honey 28, `B0DQ5VR1PS`](https://www.ubuy.com.pk/en/product/MXOALYZU2-uncrustables-sandwich-peanut-butter-honey-spread-4-count-pack-of-7-total-28-pieces);
- [Strawberry 30, `B0DQ3QKDXC`](https://www.ubuy.com.br/en/product/MWCMRGYP2-smucker-x27-s-uncrustables-peanut-butter-strawberry-jam-sandwiches-15-count-frozen-pack-of-2-total-30-pieces);
- [Peanut Butter 28, `B0DQ62Z4ZR`](https://www.ubuy.hk/en/product/MWMK8HMRO-uncrustables-frozen-peanut-butter-sandwich-4-count-pack-of-7-total-28-pieces);
- [Chocolate Hazelnut 30, `B0DQ5HBWFT`](https://www.ubuy.com.bh/en/product/MXVTO15SE-frozen-chocolate-flavored-hazelnut-spread-sandwich-15-count-pack-of-2-total-30-pieces).

Новые bullets должны описывать весь оффер, а не копировать retail-box copy.
Nutrition/health-like claims переносятся только при точном подтверждении для
каждого варианта; в базовом шаблоне они не нужны.

### 5.3. Description

Veeqo сохранил description для всех 17 апрельских rows. Это были длинные
manufacturer-style тексты по вкусу: удобный snack/lunch, мягкий хлеб, начинка,
индивидуальная упаковка, хранение в морозилке и thaw-before-eating.

Контент был переиспользован: 17 rows сводятся к 12 уникальным descriptions.
Тексты Strawberry/Grape/Chocolate повторялись между разными pack counts и почти
всегда описывали одну retail box, не весь bundle. Формулировки вроде `perfect`,
`best`, `kid-approved`, `feel good`, `packed with protein` нельзя переносить в
новый контент.

Новый description должен состоять из трёх фактических блоков:

1. точный состав bundle и total count;
2. storage/thawing instructions и individually wrapped form, если доказано;
3. обязательный дисклеймер: `Curated and assembled by Salutem Solutions LLC as
   a gift basket.`

### 5.4. Атрибуты

Поля старых карточек строились вокруг:

- `flavor` / `specialty`;
- `number_of_items` — число retail boxes;
- `number_of_pieces` — total sandwiches;
- `unit_count` и unit type;
- `item_form` — round sandwich;
- size, ingredients, UPC.

Здесь было больше всего скрытых противоречий:

- live Raspberry 30 имеет Grape в `flavor`, `specialty` и ingredients;
- Strawberry 30 mirror содержит `flavor=Raspberry`;
- mixed 50 title перечисляет пять вкусов, а `flavor` включает также Honey;
- `unit_count` часто равен весу одной коробки, хотя title продаёт несколько;
- size (`Small`, `Medium`, `XL`) использовался как произвольный ярлык;
- ingredients могли соответствовать соседнему вкусу или неполному mixed recipe.

Это объясняет, почему исторические атрибуты можно использовать как подсказку
схемы, но не как источник Product Truth. В новом листинге каждый flavor,
ingredient, allergen, count и weight должен вычисляться из exact recipe.

### 5.5. Изображения

Для анализа достаточно зафиксировать структуру, а не хранить отдельную коллекцию.
У восьми проверенных оборотных апрельских concepts была одна схема: одна retail box, старый
Salutem cooler и два видимых cold packs на белом фоне. Изображения были 500×500;
17 rows содержали только 10 уникальных MAIN hashes, то есть композиции
переиспользовались между разными offer counts. Поэтому MAIN
показывал flavor, но не доказывал полный bundle quantity.

У текущих mixed-лидеров схема стала лучше:

- 24-count показывает шесть коробок — по одной каждого вкуса;
- 48-count показывает двенадцать коробок — по две каждого вкуса;
- gallery содержит package/nutrition panels по вариантам.

Новый production MAIN должен следовать действующему frozen v2.0 contract:
точные package references, визуально проверяемая математика рецепта, approved
cooler anchor, четыре gel packs, белый фон и frozen QA. Старые MAIN являются
только историческим evidence, не шаблоном для копирования.

## 6. Что реально работало, а что было случайным багажом

### Воспроизводить

- high-intent title с exact flavor и total count;
- прозрачную формулу `retail count × boxes = total pieces`;
- 24-count mixed six-flavor как benchmark, не как основание дублировать живой ASIN;
- single-flavor 28/30-count линейку;
- 48-count mixed как следующий размер при подтверждённой экономике;
- freezer/thawing instructions;
- визуальное доказательство всех компонентов оффера.

### Не воспроизводить

- одну коробку на MAIN для многокоробочного bundle;
- bullets/description одной коробки под multipack title;
- общий flavor description, переиспользованный без проверки recipe;
- UPC одной retail box в качестве идентификатора нового bundle;
- произвольные `Small/Medium/XL` и неверный `unit_count`;
- health/nutrition claims без exact evidence;
- promotional adjectives и delivery claims;
- исторические ошибки flavor/ingredients ради буквального клонирования.

## 7. Приоритет восстановления

### Tier 1 — восстановить первыми

1. Strawberry 30.
2. Grape 30.
3. Honey 28.
4. Peanut Butter 28.
5. Chocolate Hazelnut 30.

Внутри Strawberry/Grape/Chocolate конкретный retail-box recipe (10×3 или 15×2)
выбирается не по старому ASIN, а по текущей доступности, exact package truth,
COGS, cooler fit и ROI.

### Tier 2 — после проверки перекрытия с живыми карточками

1. Трёхвкусовый variety 45, исторически $10 740,57.
2. Whole Wheat Strawberry case 72, исторически $9 060,71.
3. Более крупные 48/50/64-count конфигурации только там, где они не дублируют
   живой offer и проходят unit economics.

### Не приоритизировать

- 108-count и другие крупные конфигурации с единичными продажами;
- identity с нулём non-cancelled units;
- odd bundle counts вне рациональных cooler zones;
- новый ASIN, который просто дублирует уже живой 24/48-count лидер.

## 8. Итоговая гипотеза

Покупатель реагировал прежде всего на понятный поисковый объект: конкретный
Uncrustables flavor или variety, достаточный запас продукта и явный total count.
Качество старого контента не объясняет успех: у одного из крупнейших лидеров
Raspberry 30 до сих пор неверные Grape attributes, а у многих удалённых карточек
неверно описан offer quantity.

Следовательно, стратегия восстановления — не «скопировать победителей», а
**воссоздать победившие offer concepts с чистой товарной правдой, полной
математикой bundle и проверяемым контентом**.
