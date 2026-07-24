# Uncrustables trial run — 12 новых ASIN через box-planner (2026-07-23/24)

Owner order 2026-07-23: «Сделаем какой-то пробный забег на 10-15 новых асин?» →
комбинированный план (забег + вшивание в BF) → «продолжай». Это второй боевой
прогон конвейера после batch 1+2 и первый, где рецепты генерирует и валидирует
**BF-модуль** `src/lib/bundle-factory/uncrustables-box-planner.ts`.

## Опубликовано (все ACCEPTED, store1)

| SKU | ASIN | Рецепт | Цена | Попыток рендера |
|-----|------|--------|------|-----------------|
| GF-ASOQ-498A | B0HB8LVD23 | 24ct Berry Burst 2×4 + Blackberry Boom 2×4 + Raspberry 2×4 | $76.99 | 1 |
| WQ-AS5D-P5DQ | B0HB9RN6KJ | 28ct Bright-Eyed 8 + Burstin' 8 + Beamin' 8 + Strawberry 4 | $82.99 | 3 |
| SU-ASWN-VL7M | B0HB9NHV4L | 30ct Chocolate 10 + Hazelnut 2×4 + PB classic 3×4 | $85.99 | 3 |
| YV-ASLV-2L69 | B0HB9VBJZ2 | 30ct Honey 10 + Strawberry 3×4 + PB 2×4 | $85.99 | 2 |
| HJ-ASM2-TK3J | B0HB9R16JY | 48ct Honey 2×10 + Chocolate 2×10 + Grape 2×4 | $135.99 | 2 |
| RM-ASBQ-BX9G | B0HB9LST9D | 48ct Burstin' 2×8 + Beamin' 2×8 + Bright-Eyed 2×8 | $135.99 | 2 |
| ER-ASKW-EDKD | B0HB9YT5S3 | 28ct Honey 10 + Chocolate 10 + Up & Apple 8 | $82.99 | 3 |
| UA-ASI2-Y29N | (review) | 54ct Chocolate 10 + Bright-Eyed 8 + Honey 2×10 + Berry Burst 4×4 | $144.99 | 4 |

В итерациях на момент заметки: wheat-duo-24 (7-я попытка), xl-96 (4-я),
xl-protein-90 (4-я), choc-berry-60 (10-я). Худший слаг batch 1+2 требовал
9 попыток — это нормальная экономика процесса при бесплатных рендерах
(подписочный image_gen, ~2-4 мин/рендер).

## Что нового доказано (сверх batch 1+2)

1. **Box-planner как gate**: все 12 рецептов прошли `validateRecipe()`
   (диапазоны кулеров, кратность коробкам, renderable-лимиты) и копия
   сгенерирована `buildListingCopy()` — ни одной ручной правки текста.
2. **Двухслойная верификация**: мои покоробочные кропы + панель из 3 слепых
   агентов-скептиков на рендер (layout / typography / art), калиброванных по
   опубликованной когорте. Панель ловила однобуквенные дефекты, которые
   пропускал одиночный проверяющий: Botter/Batter/Butteer/Sutter, «KEEP
   PROZEN», двойные амперсанды, лишний 5-й гель-пак, «Only at Walmart»
   роундель, россыпь черники, 5/3 коробки вместо 4, потерянный blueberry
   у Beamin'.
3. **Контракт рендера дорос до 10 боевых пунктов**: + FRUIT ART (свой арт,
   с перечислением ягод), GEL PACKS 2+2, GEL PACK TEXT (точные строки),
   RETAILER FLAGS (омит «Only at Walmart»), BUTTER spelling, амперсанд при
   переносе строки, NO LOOSE PROPS, розовый Berry Burst, точная строка
   красных Reduced Sugar. Каждый пункт добавлен ПОСЛЕ пойманного дефекта
   и устранил свой класс брака в следующих рендерах.
4. **Sealed-конвейер масштабируется инкрементально**: trial-манифест
   переминчивается с ростом (1→3→6→7→8 пруфов), dual-manifest preflight
   (v3 batch12 + trial1) с кросс-манифестной уникальностью proof/subject;
   пермит пиннится к sha манифеста, содержащего его пруф.
5. **Типографика воркера деградирует волнами** (время суток / нагрузка
   image_gen): утренние рендеры проходили с 1-2 попыток, ночные — салат
   опечаток. Стратегия: ре-роллы дёшевы, паника не нужна; полный контракт +
   панель отсеивают всё.

## Экономика забега

8 листингов = 328 сэндвичей номинального ассортимента, ценовой ряд
$76.99–$144.99 по канонической модели (landed×2). Рендеров потрачено ~35
(бесплатные, подписка), агентов-верификаторов ~120 вызовов.

Связанное: [[uncrustables-preview-publish-batch12]],
[[uncrustables-studio-integration-plan]], [[uncrustables-cooler-packing]],
[[bundle-factory-master-plan]].
