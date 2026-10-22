# Повторное независимое ревью исправлений mixed Walmart listings — 2026-08-08

## Объём и вердикт

Проверен текущий `main` на коммите
`aa1fd6be6ed36499bcd4ceb8dd279a4b223710d1`; исправления по предыдущему отчёту
находятся в коммите `06177b2424f0e1ee2d4a99b693f2df7176e7eba2`.
Код не исправлялся, коммиты и marketplace-записи не выполнялись.

**Вердикт:** исправление подписи сделано правильно. Также закрыты прямой
детерминированный разбор противоречия, ready-build key, `composition_type`,
duplicate identity и падение длинного bullet. Однако promotion исправлен не до
конца, а UI/model-путь всё ещё может потерять смешанный состав. Смешанную ветку
пока нельзя считать полностью готовой к публикации.

## Реально сломается

### 1. Критично: promotion дважды добавляет внешнюю упаковку и выбирает слишком маленькую коробку

- `src/lib/bundle-factory/validation/promote-draft.ts:1024-1051` сначала вызывает
  homogeneous-оценщик отдельно для каждой составляющей, затем суммирует его
  `package_weight_oz` и берёт размеры одной самой длинной коробки.
- Но homogeneous-оценщик уже добавляет к **каждой** составляющей 15 % retail
  tare и 6 oz внешней коробки:
  `src/lib/bundle-factory/walmart-studio-listing.ts:177-184,213-220`.

Численный контрпример из живого набора:

| Расчёт | Вес | Коробка |
|---|---:|---|
| 4 × 10.5 oz как отдельная посылка | 54.3 oz | 8 × 6 × 4 |
| 4 × 18.8 oz как отдельная посылка | 92.5 oz | 9 × 6 × 6 |
| То, что сейчас запишет mixed promotion | **146.8 oz** | **9 × 6 × 6** |
| Та же формула один раз на всю коробку | **140.8 oz** | **10 × 8 × 6** |

Чистый net weight 117.2 oz рассчитан верно, но downstream-поля shipping package
неверны: outer box учтён дважды, а packed volume двух составляющих вообще не
сложен. Это может дать неправильную весовую доставку и физически недостаточный
package size.

**Вход:** любой mixed listing из двух и более составляющих. На разноразмерных
товарах ошибка особенно заметна, но двойная внешняя упаковка существует и при
одинаковом размере.

### 2. Высоко: смесь разных размеров намеренно останавливается при promotion

`src/lib/bundle-factory/validation/promote-draft.ts:1197-1206` возвращает
`studioNetContent = null`, когда размеры составляющих различаются, а
`promote-draft.ts:1283-1287` сразу бросает исключение. Это безопасный fail-closed:
неверный net content не уйдёт в Walmart. Но это означает, что реально полученная
смесь 10.5 oz + 18.8 oz может стать черновиком, однако **не может быть
подготовлена к публикации** текущим кодом.

Нужен поддерживаемый Walmart-контракт для net content смешанной коробки либо
явный admission blocker до создания такого draft. Сейчас отказ обнаруживается
слишком поздно.

### 3. Высоко: evidence второй и последующих составляющих всё ещё не содержит content/price chain

- Promotion передаёт все `product_truth_component`:
  `src/lib/bundle-factory/validation/promote-draft.ts:1312-1328`.
- Но evidence builder сохраняет для дополнительных составляющих только
  `canonical_variant_id`, `donor_product_id`, `product_name` и `quantity`:
  `src/lib/bundle-factory/walmart-studio-listing.ts:312-320`.
- Полные identity/content/price поля по-прежнему строятся только из первой
  составляющей: `walmart-studio-listing.ts:329-355`.
- Studio Product Truth validator также проверяет единственные top-level
  identity/content/price и никогда не валидирует `evidence.components`:
  `src/lib/bundle-factory/validation/validators/validator-walmart-product-truth.ts:120-163,210-219`.

**Воспроизведено:** у второй составляющей заменены content observation, source
URL, price observation, offer и цена при неизменных canonical/donor/name/qty.
`buildWalmartStudioListingEvidence()` вернул байт-в-байт ту же запись. Значит
заявление «evidence carries the whole chain» для смеси пока неверно, и truth
validator не может доказать точный content/price source каждого товара.

### 4. Критично: кнопка Interpret request → Use this теряет mixed composition

Модель действительно возвращает `flavors_per_listing` и `units_per_flavor`, но:

- UI-тип эти поля не содержит:
  `src/app/bundle-factory/new/page.tsx:257-267`;
- readback их не показывает: `page.tsx:891-920`;
- `applyInterpretation()` заменяет исходный бриф на голый `search_query` и
  переносит только listing/pack count: `page.tsx:478-487`.

После этого `/studio/generate` получает, например, `Campbells Soup` плюс
`20 listings / pack 8`. Детерминированному parser уже неоткуда узнать про
`2 вида по 4`, поэтому он законно строит однотоварный Pack of 8.

**Вход:** корректный mixed-бриф «20 листингов по 8 банок, 2 вида по 4 банки
каждого», затем кнопки `Interpret request` и `Use this`. Состав молча меняется на
один вкус — ровно тот класс ошибки, ради которого mixed feature создавалась.

Дополнительно модельный нормализатор всё ещё превращает противоречивые
`pack=8, flavors=3, units=3` в два `null` без записи в `unsupported` или
`assumptions`: `src/lib/bundle-factory/walmart-request-interpreter.ts:168-188`.
Прямой parser это противоречие теперь блокирует; второй путь — нет.

### 5. Высоко: batch composer leak закрыт, но два неатомарных состояния остались

Исправление composer отказа настоящее: `walmart-batch-submit.ts:131-167` теперь
вызывает cleanup для всех claims до POST.

Остались две ранее найденные runtime-дыры:

1. При сбое второй/последующей пометки `REQUESTING` первый item уже имеет
   `request_count=1`, хотя POST ещё не начинался
   (`walmart-batch-submit.ts:200-233`). `releaseAll()` вызывает общий lifecycle
   classifier (`walmart-batch-submit.ts:429-443`), а тот превращает
   `REQUESTING/1` в `UNKNOWN` и сохраняет активный fence
   (`walmart-publish-lifecycle.ts:154-175`). Получается ложный неизвестный POST,
   который в действительности не выполнялся.
2. После успешного MP_ITEM POST feed ID принимается по SKU последовательно без
   общей recovery-ветки (`walmart-batch-submit.ts:294-302`). Если второй accept
   падает, первые строки становятся `ACCEPTED`, остальные остаются
   `REQUESTING` без записанного feed ID. Точный feed-result для них штатно не
   прочитать.

Сам `submitWalmartBatch` всё ещё вызывается только из
`scripts/walmart-publish-batch.ts`; production UI/cron queue остаётся
one-listing-per-POST. Живой multi-item feed по-прежнему не проверен. Поэтому
этот transport нельзя подключать к очереди до lifecycle-тестов и исправления
обоих частичных состояний.

## Исправлено и подтверждено

1. **Seal — полностью закрыт.**
   `walmart-studio-draft-contract.ts:172-192,248-260` сверяет все поля, которые
   движок читает: quantity, canonical variant, donor, content observation,
   price observation и title. Каждая подмена однотоварной составляющей
   отвергнута; подмена evidence второй составляющей смеси даёт
   `WORK_ITEM_HASH_MISMATCH`. Legacy brief без `components` продолжает читаться.
2. **Прямой parser противоречий — закрыт.** Bare `3 вида` распознаётся, а
   `8 банок / 3 вида` и `8 / 3 × 3` возвращают
   `PACK_COMPOSITION_CONFLICT`, а не silent fallback.
3. **Draft cost/net weight — закрыты.** Себестоимость и exact net weight на
   стадии draft суммируются по `price × qty` и `mass × qty`. Ошибка выше
   находится в отдельном shipping-package estimator promotion.
4. **Idempotency — запрошенная collision закрыта.** `readyBuildSha` и
   `draftRecipeFingerprint` включают все составляющие с количествами. Две смеси
   с общим первым товаром, но разным вторым, больше не возвращают старый build.
5. **`composition_type` — закрыт.** Mixed draft пишет `MIXED_FLAVOR`.
6. **Duplicate identity — закрыт.** Ключ включает весь отсортированный состав;
   разные смеси с общим первым товаром различаются, одна смесь в другом порядке
   считается тем же listing.
7. **Title/bullet length — технически закрыты.** Длинный donor identity без
   `flavor` больше не вызывает `BULLET_TOO_LONG`; полные имена остаются в
   description.
8. **Ingredients — закрыты.** Promotion объединяет подписанные ingredient
   statements всех составляющих (`promote-draft.ts:1140-1167`).
9. **Image — без регрессии.** Mixed grid использует разные source images и
   количества; explicit и implicit homogeneous paths дают одинаковые bytes/SHA.
10. **Неизвестный исход самого POST — правильно.** UNKNOWN остаётся
    fail-closed, автоматического повторного POST нет.

## Стилистика и качество тестов

1. Short-label обрезается на 48 символах. Две разновидности с общим длинным
   префиксом могут получить два одинаковых bullet, например дважды
   `4 x Chunky Extremely Long Shared Product Name That`; description при этом
   остаётся точным. Это не подмена товара, но owner preview и покупателю трудно
   различить состав.
2. Draft-time compliance call всё ещё передаёт только первый товар
   (`walmart-studio-draft-engine.ts:560-570`). Поздний Walmart static-policy
   validator проверяет все MasterBundle components, поэтому нормальный
   validate/publish path остаётся fail-closed; однако ранний draft status может
   быть оптимистичным.
3. Нет теста mixed promotion, который проверяет итоговые package fields,
   multi-component evidence и unequal-size net-content behavior. Поэтому
   профильные тесты зелёные при воспроизводимой ошибке promotion.
4. Нет unit/integration test самого `submitWalmartBatch`; тестируется feed
   composer, но не переходы нескольких durable claims вокруг POST.

## Выполненные проверки

- `npx tsc --noEmit -p tsconfig.json` — **pass**.
- Parser/seal/content/duplicate/listing/interpreter — **43/43 pass**.
- Image/batch-feed/lifecycle/draft-contract — **33/33 pass**.
- Все `*.test.ts`: **2084 tests; 2071 pass; 12 fail; 1 skipped**. Двенадцать
  падений — та же известная посторонняя группа, не mixed-Walmart regression.
- Pure diagnostics: поочерёдная подмена каждого sealed field; подмена второй
  mixed component; расчёт package weight/dimensions; direct/model request
  conflict; неизменность evidence при подмене второго content/price chain;
  длинные одинаковые short labels.
- Живой Walmart POST и повторная запись production-данных не выполнялись.

## Рекомендация

Не подключать mixed listings к массовой публикации, пока не закрыты пункты
1, 3, 4 и batch lifecycle из пункта 5. Разноразмерные смеси либо надо
поддержать корректным Walmart net-content контрактом, либо блокировать ещё при
admission. Подпись повторно переделывать не нужно — она теперь выдержала
независимые негативные проверки.
