# Независимое ревью смешанных Walmart-листингов — 2026-08-08

## Объём и вердикт

Проверен `main` на коммите `1706030cc72a3b53da4e2a589284a70ddd926dca`.
Код не исправлялся, marketplace-записи и коммиты не выполнялись.

**Вердикт:** разбор корректного запроса `2 вида × 4 банки`, sealed mixed work
items, сумма себестоимости, сумма веса при создании черновика, mixed-копирайт и
mixed-изображение реализованы. Но сквозной путь **ещё нельзя считать безопасным
для публикации смешанных листингов**: promotion и evidence снова сводят смесь к
первой составляющей, а новый multi-item transport имеет неатомарные состояния и
не подключён к рабочей очереди Bundle Factory.

## Реально сломается

### 1. Критично: при promotion смесь снова превращается в «первый товар × весь pack»

- `src/lib/bundle-factory/walmart-studio-draft-engine.ts:343-364` правильно
  суммирует стоимость и net weight всех составляющих.
- `src/lib/bundle-factory/validation/promote-draft.ts:993-1023` затем берёт только
  `snapshotComponents[0]` и вызывает homogeneous-оценщик с полным
  `draft.pack_count`.
- `src/lib/bundle-factory/validation/promote-draft.ts:1101-1162` берёт только
  первый ingredient statement и только net content первого товара.
- `src/lib/bundle-factory/validation/promote-draft.ts:1250-1271` передаёт в
  listing evidence только один `component`.
- `src/lib/bundle-factory/walmart-studio-listing.ts:259-348` и
  `src/lib/bundle-factory/validation/validators/validator-walmart-product-truth.ts:65-240`
  вообще моделируют только одну identity/content/price chain и поэтому могут
  пропустить отсутствие доказательств по остальным товарам.

**Вход:** 4 банки по 10.5 oz + 4 банки по 18.8 oz. Черновик считает 117.2 oz
net, но promotion при первом товаре 10.5 oz оценивает упаковку от 84 oz net; при
первом товаре 18.8 oz — от 150.4 oz net. Ingredient image и Product Truth
evidence при этом описывают только первый суп.

Дополнительные проявления той же ошибки:

- `src/lib/bundle-factory/walmart-studio-draft-engine.ts:603` всегда записывает
  `composition_type: "SINGLE_FLAVOR"`; это значение переносится в MasterBundle в
  `src/lib/bundle-factory/validation/promote-draft.ts:535-542,590-598`.
- `src/lib/bundle-factory/walmart-studio-draft-engine.ts:560-570` отправляет в
  compliance gate только первый товар. Второй бренд/товар смеси не проверяется
  этим gate.
- `src/lib/bundle-factory/walmart-duplicate-listing.ts:26-57,71-117` определяет
  дубликат только как `первый canonical variant + pack count`. Две разные смеси
  с одинаковым первым товаром будут ложным дубликатом; та же смесь с другим
  порядком составляющих сможет обойти проверку.

### 2. Критично: batch-submit не обеспечивает заявленную атомарность и не является рабочим UI-путём

- `src/lib/bundle-factory/distribution/walmart-batch-submit.ts:295-368` создаёт
  durable claim для каждого подготовленного SKU.
- Feed composers вызываются уже после всех claims, но вне cleanup-блока:
  `src/lib/bundle-factory/distribution/walmart-batch-submit.ts:131-140`. Если
  обнаружится duplicate product ID, differing header или другая ошибка сборки,
  все уже созданные claims останутся висеть в `CLAIMED`.
- При падении второй/последующей отметки `REQUESTING` код вызывает `releaseAll`
  (`walmart-batch-submit.ts:173-206`). Но уже отмеченные строки классифицируются
  как `UNKNOWN`, а не откатываются, хотя POST ещё не начинался:
  `walmart-publish-lifecycle.ts:840-875`. Поэтому комментарий про rollback не
  соответствует поведению.
- После успешного POST feed ID принимается по SKU последовательно
  (`walmart-batch-submit.ts:267-275`). Если `acceptWalmartSubmission` упадёт на
  середине, первые SKU будут `ACCEPTED`, остальные останутся `REQUESTING` без
  записанного feed ID (`walmart-publish-lifecycle.ts:755-795`). Возобновить их по
  этому коду нельзя безопасно.
- Неизвестный результат самого MP_ITEM POST обработан правильно: все
  `REQUESTING` переходят в `UNKNOWN`, повторного POST нет
  (`walmart-batch-submit.ts:208-242`). Это важная положительная проверка.
- `submitWalmartBatch` вызывается только из
  `scripts/walmart-publish-batch.ts:69`. Рабочая UI/cron-очередь по-прежнему
  намеренно берёт **один** draft и делает отдельный POST на каждый tick:
  `src/lib/bundle-factory/publish-queue.ts:417-424,467-523`. Значит «Publish
  batch» в Bundle Factory сейчас означает очередь одиночных feeds, а не новый
  multi-item feed.

**Вход:** любой batch из двух и более SKU плюс ошибка composer, DB-сбой во время
mark/accept либо обычный запуск из UI. В первых двух случаях остаётся
нереконсилируемое частичное состояние; в последнем новый batch transport вообще
не используется.

### 3. Явно противоречивый состав молча превращается в однотоварный multipack

- `src/lib/bundle-factory/walmart-studio-request.ts:111-130` при несовпадении
  `flavors × units` с pack count возвращает оба поля как `null`.
- `src/lib/bundle-factory/walmart-studio-request.ts:171-200` после этого уже не
  видит исходного противоречия, не добавляет blocker и выбирает `1 × packCount`.
- Модельный путь делает то же самое:
  `src/lib/bundle-factory/walmart-request-interpreter.ts:168-188`.

**Воспроизведено:** «4 листинга по 8 банок, по 3 вида, по 3 банки каждого»
возвращает `flavors_per_listing=1`, `units_per_flavor=8`, `blockers=[]`.
Модельный ответ `pack=8, flavors=3, units=3` возвращает оба mixed-поля `null`,
не добавляя запись в `unsupported` или `assumptions`.

Тест `walmart-request-interpreter.test.ts:181-197` называется «refused, not
published», но проверяет только исчезновение двух полей; отказа в нём нет.
Тест `walmart-mixed-assortment.test.ts:246-255` покрывает другой случай —
конфликт prompt с ручным override pack count.

### 4. Подпись homogeneous work item не защищает component evidence

Узкий вопрос из handoff проверен: добавить вторую составляющую и сохранить
валидный hash нельзя — тогда `components` входит в `sealShape`, а суммы и
уникальность также проверяются.

Но дыра существует в другом виде:

- `src/lib/bundle-factory/walmart-studio-draft-contract.ts:172-181` исключает
  весь `components` для однотоварного multipack.
- `walmart-studio-draft-contract.ts:184-244` требует совпадения только
  `canonical_variant_id` первой составляющей с singular-полем. Donor ID,
  content/price observation и title с singular-полями не сверяются.
- Движок читает именно поля из `components`:
  `src/lib/bundle-factory/walmart-studio-draft-engine.ts:259-280`.

**Воспроизведено:** в уже запечатанном homogeneous item заменены
`component.donor_product_id`, оба observation ID и title при неизменном canonical
variant. `parseWalmartStudioDraftWorkItem()` принял прежний SHA-256 как валидный.
Если альтернативный donor/evidence разрешается в тот же canonical variant и
готового draft с этим fingerprint ещё нет, фактический источник после admission
можно изменить без нарушения seal.

### 5. Ready-build idempotency key смеси не включает вторичные составляющие

Сам `draftRecipeFingerprint` сделан правильно:
`src/lib/bundle-factory/walmart-studio-draft-engine.ts:167-193` включает все
canonical/content/price/quantity поля смеси. Две разные смеси с тем же первым
товаром там не сталкиваются (кроме теоретической SHA-256 collision).

Но внешний `readyBuildSha` в
`src/app/api/bundle-factory/studio/generate/route.ts:461-476` хеширует только
singular-поля каждого work item, а при найденном job проверяет лишь user ID
(`route.ts:478-486`).

**Вход:** повторить тот же prompt/settings после изменения порядка/готовности
доноров так, чтобы первые товары work items остались прежними, а вторые
изменились. ID совпадёт, новый brief не будет записан, и оператор получит старую
смесь.

### 6. Title fallback укладывается в 150, но длинный donor identity переносит падение в bullet

`src/lib/bundle-factory/walmart-new-sku-engine.ts:1454-1479` корректно деградирует
заголовок до generic `Variety Pack`, поэтому лимит 150 соблюдается. Но
`walmart-new-sku-engine.ts:1481-1488` снова использует полное identity при
отсутствии `flavor` и жёстко ограничивает bullet 100 символами.

**Воспроизведено:** две составляющие без короткого `flavor`, каждая с identity
181 символ, дают `WalmartNewSkuPlanError: BULLET_2_TOO_LONG:181>100`. То есть
исправленный длинный заголовок не гарантирует создание draft.

## Шесть запрошенных проверок — краткий итог

| № | Итог |
|---|---|
| 1. `sealShape` | Двухкомпонентную смесь подменить нельзя; metadata/evidence одной составляющей подменить можно. |
| 2. Cost/weight | В draft engine сумма верна; при promotion разноразмерный weight снова становится неверным. |
| 3. Fingerprint | `draftRecipeFingerprint` состава корректен; внешний `readyBuildSha` состав теряет. |
| 4. Image | Mixed grid использует обе картинки и точные количества. Homogeneous implicit/explicit дают одинаковые bytes/SHA. |
| 5. Batch submit | UNKNOWN/no-retry после неясного POST верен; partial marking/accept и wiring не готовы. |
| 6. Title | Сам title ≤150; отсутствие короткого flavor всё ещё может остановить build на bullet. |

## Стилистика и качество тестов (не самостоятельная поломка runtime)

1. `walmart-new-sku-multipack-image.test.ts:195-210` доказывает равенство двух
   **текущих** homogeneous-путей, но не сравнивает результат с зафиксированным
   pre-change golden SHA. Сейчас байты совпадают; от будущей совместной регрессии
   обоих путей тест не защищает.
2. Generic title fallback без вкусов безопасен по длине и фактам, но хуже для
   покупателя. Короткий display flavor нужен как нормализация Product Truth, а не
   как усечение полного названия.
3. Комментарии promotion/validator всё ещё утверждают, что Studio draft построен
   из «ONE exact canonical variant» (`promote-draft.ts:993-999`,
   `validator-walmart-product-truth.ts:65-71`). После mixed feature это уже
   неверное описание контракта и маскирует реальные однокомпонентные допущения.

## Выполненные проверки

- `npx tsc --noEmit -p tsconfig.json` — **pass**.
- Команда из handoff `node --import tsx --test "src/**/tests/**/*.test.ts"` —
  завершилась кодом 0, но запустила **0 тестов**: quoted glob не разворачивается.
- Реальный запуск всех найденных `*.test.ts`: **2071 tests, 2058 pass, 12 fail,
  1 skipped**. Двенадцать failures — известная посторонняя группа, указанная в
  handoff; новых mixed-Walmart failures в suite нет.
- Профильные Walmart tests: **93/93 pass**; Studio/durable-build: **24/24 pass**;
  batch-feed composer: **8/8 pass**.
- Выполнены отдельные pure diagnostics для contradictory prompt, model
  interpretation, seal tampering и long no-flavor identity; их результаты
  приведены в находках выше.
- POST `/api/bundle-factory/studio/generate` и cron tick повторно не запускались:
  в этой среде они создают durable jobs/drafts в общей базе, а задача была
  review-only. Живой Walmart POST не выполнялся ни при каких обстоятельствах.

## Рекомендация владельцу

Не публиковать mixed drafts до исправления пунктов 1–5 и теста полного пути
`prompt → mixed work item → draft → promotion → validator → duplicate identity →
batch lifecycle`. Однотоварный путь не затронут ошибкой mixed weight, но его
component evidence сейчас также не полностью защищён seal.
