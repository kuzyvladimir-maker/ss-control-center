# 🤝 Разделение труда между чатами: обогащение → потребители (КОНТРАКТ)

> **Утверждено владельцем 2026-07-08.** Реализует канон
> [[product-catalog-architecture]] («ОДИН движок enrichProduct() пишет — все читают»).
> Причина: оба чата (COGS и картинки/контент) гоняли ОДИН и тот же конвейер
> «распознай листинг → найди в рознице → запиши донора» независимо → vision-лимиты
> и Unwrangle-кредиты платились ДВАЖДЫ за SKU, а два слепых балансировщика
> насыщали линии друг друга (ночь 2026-07-07/08: −9.4k кредитов при +30 SKU).
> Связано: [[retail-source-capability-matrix]], [[cogs-true-cost-agent]], [[task-registry]].

## Правило одной строкой

**Обогащает — только COGS-чат. Все остальные читают готовое и НЕ зовут
identify / retail-search / donor-harvest сами.**

## Кто что делает

| Стадия | Владелец | Что пишет |
|---|---|---|
| Распознавание листинга (vision) | **COGS-чат** | `SkuShippingData.productIdentity` (кэш identity) |
| Поиск в рознице (Oxylabs/Unwrangle/браузер) | **COGS-чат** | `DonorProduct` (вариант) + `DonorOffer` (пак/цена) |
| Рецепт SKU (состав) | **COGS-чат** | `SkuComponent` (sku → вариант × qty) |
| Себестоимость | **COGS-чат** | `SkuCost` (clean / needsReview / unsourceable) |
| Контент-харвест донора (галерея/атрибуты) | **COGS-чат** (`harvestDonorDetail`) | `DonorProduct.imageUrls/…` |
| Генерация картинок + публикация в ASIN | **Картинки-чат** | читает `DonorProduct/SkuComponent`, пишет только свои артефакты |
| Проверка СВОИХ сгенерённых картинок (vision) | Картинки-чат | ок — это его собственные вызовы, не обогащение |

## Интерфейсы контракта

1. **«Готов для картинок»** — SKU считается обогащённым, когда есть рецепт с донором и фото:
   ```sql
   SELECT sc.sku, sc.donorProductId, dp.imageUrls, dp.title
   FROM SkuComponent sc JOIN DonorProduct dp ON dp.id = sc.donorProductId
   WHERE dp.imageUrls IS NOT NULL AND dp.imageUrls != '[]'
   ```
   (+ identity в `SkuShippingData.productIdentity`, + цена в `SkuCost`.)
2. **Очередь приоритетов** — если картинки-чату нужны конкретные SKU первыми, он пишет
   их в `Setting` key **`enrich_priority_skus`** (JSON-массив SKU). Все драйверы
   обогащения (`nextUncostedWalmartSkus`, `cogs-sweep-cooperative.ts`, hourly cron)
   обслуживают этот список первым.
3. **Единый vision-роутер** — `askVisionJson()` из `src/lib/sourcing/vision.ts`
   (взвешенные линии + in-flight балансировка + circuit-breaker). COGS-identify
   переключён на него 2026-07-08; свой round-robin в `identify.ts` удалён.
   SKU без фото → text-only через `generateTextViaClaudeWorker` (боксовый Claude-text).
4. **Донор не найден/не подходит** — картинки-чат НЕ ищет сам, а добавляет SKU в
   `enrich_priority_skus` и берёт следующий готовый.

## Что это даёт

- Каждая дорогая операция (vision identify ~30-60с, retail-поиск 1-21 кредит)
  платится **один раз за SKU**.
- Бокс перестаёт быть полем боя двух слепых балансировщиков — один планировщик
  видит общую загрузку линий.
- Качество обогащения одно на всех: движок правды v4 (strict-size exact,
  first-party-only, form-guard, unsourceable, live-verify).
