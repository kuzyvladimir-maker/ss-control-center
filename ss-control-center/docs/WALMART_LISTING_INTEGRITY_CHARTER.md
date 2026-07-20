# Walmart Listing Integrity — каноническая цель и журнал

Статус: ACTIVE
Дата фиксации: 2026-07-18
Назначение: единый источник цели, критериев готовности, решений и прогресса. Этот файл обновляется после каждого существенного этапа.

Правило ведения: `СДЕЛАНО` означает наличие проверяемого артефакта и пройденной проверки; подготовленный контракт без реальных входных данных не выдаётся за завершённый аудит. Отдельно фиксируются доказанное, оставшиеся блокеры и следующий разрешённый шаг.

## Главная цель

Исправить все Walmart-листинги так, чтобы фактический товар, вариант, размер, состав набора и количество полностью соответствовали всему содержимому карточки: title, description, bullet points, атрибутам, MAIN и каждому gallery-изображению.

Идеальный листинг — одно правдивое, внутренне согласованное целое: каждый текстовый элемент и каждое изображение описывают и дополняют один и тот же продаваемый SKU/набор. Бизнес-результат — устранить предотвратимые возвраты, вызванные неверным ожиданием покупателя, и не создавать новых проблем с индексацией.

Все аудиты, алгоритмы, справочники, донорские данные и тестовые прогоны — средства достижения этой цели, а не самостоятельная конечная цель.

Измеримый предел ответственности этой программы — свести к нулю возвраты, вызванные неверным ожиданием из-за нашей карточки: неправильным товаром, вариантом, размером, количеством, составом набора, текстом или изображениями. Возвраты по независимым причинам — например, из-за повреждения перевозчиком или личных предпочтений покупателя — не могут служить критерием качества листинга.

## Исходная проблема

- У мультипаков MAIN иногда показывал одну единицу, хотя листинг продавал несколько. Покупатели неверно понимали количество и заказывали кратно больше нужного.
- После массовой генерации часть MAIN-изображений стала относиться к другому товару, варианту, размеру или даже другой товарной сущности.
- В некоторых карточках MAIN и дополнительные изображения показывали разные товары.
- Title, description, bullets, атрибуты и изображения могли противоречить друг другу.
- Предыдущие массовые исправления затронули индексацию части листингов.

## Определение готового листинга

Для каждого SKU должны одновременно выполняться все условия:

1. Точно установлено, что именно продаётся: товар, вариант, размер, единиц в каждой упаковке, внешний multipack count и состав bundle/variety set.
2. Title однозначно и правдиво отражает продаваемую сущность и количество.
3. Description, bullet points и все структурированные атрибуты не противоречат SKU truth и друг другу.
4. MAIN показывает правильный товар и визуально не вводит в заблуждение относительно количества.
5. Каждое gallery-изображение относится к правильному товару/компоненту и выполняет понятную роль; чужих, дублирующихся или противоречивых изображений нет.
6. Buyer-facing Walmart PDP после публикации совпадает с утверждённой версией карточки.
7. Изменение не ухудшило published status, поиск, индексацию и доступность предложения.
8. Сохранены доказательства «до/после», источники истины, решение проверяющего и способ отката.

## Обязательные источники знаний

1. Walmart Policy Knowledge Base — действующие правила, запреты и рекомендации площадки с источником и датой актуальности.
2. SKU Reference Catalog — точная внутренняя истина по каждому SKU, multipack, bundle и variety set.
3. Donor/Research Catalog — обогащённые факты, изображения, цены, продавцы и даты из нескольких независимых источников. Донор не может сам по себе определять истину нашего SKU.

## Непереговорные правила безопасности

- Сначала read-only диагностика и доказательства; исправление — отдельный контролируемый этап.
- Текущий seller catalog или buyer PDP не может сам подтвердить identity, package facts или количество проверяемого листинга.
- OCR не может единолично доказать identity товара или вынести окончательный `BAD`.
- Никаких массовых Walmart writes, удаления или пересоздания листингов без утверждённого плана, canary и rollback.
- Неизвестность получает `REVIEW/UNSUPPORTED/TECHNICAL_ERROR`, но никогда не маскируется под `PASS`.
- MAIN и gallery имеют отдельные правила и отдельные вердикты.
- Любое исправление перепроверяется на buyer-facing PDP и на сохранение индексации.

## Последовательность достижения цели

1. Сертифицировать алгоритм на frozen golden cohort: ordered batch-4, shuffled batch-4 и singleton.
2. Получить точные buyer-facing снимки и достоверную SKU truth для текущего каталога.
3. Провести вручную размеченный Shadow-50 по текущим MAIN и отдельный gallery pilot.
4. Выполнить sharded/resumable read-only массовый аудит без Walmart writes.
5. Сформировать реестр ошибок: SKU/item ID, тип нарушения, доказательства, риск и предлагаемое исправление.
6. Разработать remediation-инструменты по типам ошибок и проверить их на canary-наборе.
7. Исправлять партиями с ручным approval, post-write buyer verification, контролем published/indexing и rollback.
8. Измерять возвраты и повторно сканировать каталог, пока не останется известных несоответствий.

## Текущий статус на 2026-07-19

- Корень quantity-confusion и смешивания изображений формализован в typed truth и отдельных MAIN/gallery правилах.
- Claude BF-Images сообщил об успешном deploy/restart remote subscription worker до
  receipt v2 и authenticated health. Новый worker build:
  `sha256:fed5fa5e49914c1df1ae2197c51be4d7c0342f2adad4d01819f792622614f0f9`;
  ledger `ledger-2c53fa5f-f761-4660-80b9-24e934e172aa`, epoch
  `epoch-986b9a13-740b-4403-b433-378f2613d4f0`; Ed25519 key/SPKI сохранены.
  Он подписывает receipts и имеет durable server-side `call_key` reservation ledger:
  повторный ключ блокируется `409` до запуска модели. Старый build
  `080d3a50d…` и связанные с ним checkpoints/run-locks инвалидны. Точный операторский
  отчёт: `WALMART_REMOTE_WORKER_OPERATOR_REPORT_2026-07-19.md`. Observer повторно
  выполняет authenticated health и fail-closed сверяет все frozen worker/ledger поля
  перед любым model POST; отдельный локальный health capture полезен, но не является
  дополнительным engine gate.
  Mutable alias `sonnet` и число внутренних turns одного CLI invocation не выдаются
  за криптографически закреплённый backend snapshot.
- Локальный execution engine v4 отделяет бессрочный immutable audit family от
  renewable 24-hour permit конкретной deterministic partition. Все изображения
  frozen в batch-4; partition содержит не более шести shard/calls. Первый полный
  source-aware plan создаёт sealed preflight certificate, а последующие
  executions перечитывают только family metadata и выбранную partition, не все
  Product Truth/buyer sources заново. Permit renewal не меняет family SHA или
  `call_key`. Допуск partition требует внешнюю Ed25519 owner authorization,
  append-only one-shot allowance reservation и hard freshness, вычисляемую от
  самого старого authoritative scope, Product Truth, buyer index и каждого locked
  buyer snapshot плюс 24 часа.
- Success observation использует подписанное server reservation time; permit и
  partition включены в signed worker request/receipt. Attempt без результата
  сначала получает полный `vision_timeout + response_margin` grace и не может
  быть преждевременно закрыт вторым executor. Near-expiry permit не допускается
  к health/OCR/POST. После grace ambiguous attempt может стать только sealed
  `TECH_ERROR/REVIEW`, никогда `PASS`. Offline audit требует для success и terminal
  отдельные exact `0444` observation/attempt files, проверяет их лимиты и стабильность
  во время чтения, а namespace observation и derived attempt резервируется глобально
  для всех partitions. Attempt связывается с permit/partition/shard/call/request,
  policy, local OCR и подписанным worker receipt. Audit/verify остаются
  воспроизводимыми после expiry.
- Fail-closed runner имеет точные call budgets, независимые checkpoints для layouts, immutable sealed reports и zero-model replay.
- Source authority matrix запрещает seller/PDP и donor self-validation товарной истины.
- Buyer snapshot v3 проверяет точный SKU → GTIN → itemId → PDP chain, байты изображений, SHA-256, декодирование и размеры; реальный PDP adapter ещё не подключён.
- Frozen artifact-only Gate B cohort полностью выполнен во всех трёх обязательных layouts:
  - shuffled batch-4 — 6 вызовов, 12 `BAD` / 12 `PASS`;
  - ordered batch-4 — 6 вызовов, 12 `BAD` / 12 `PASS`;
  - singleton — 24 вызова, 12 `BAD` / 10 `PASS` / 2 `REVIEW`.
- Gate B policy v2 проверяет fail-closed directional safety, точный состав и порядок каждого batch, call/attempt accounting, OCR, schema, sealed provenance и отсутствие fallback/remote writes по всем исходным отчётам. Exact equality вердиктов сохраняется отдельной неблокирующей диагностикой.
- Новый sealed zero-model replay получил `gate_b_go=true`: 36/36 проверок известных `BAD` дали `BAD`; ни один известный `PASS` не получил `BAD`; false pass, false bad и technical error отсутствуют; 10/12 известных `PASS` получили `PASS` во всех layouts — 83,33% при пороге 80%.
- Exact verdict agreement составляет 22/24. Два безопасных singleton-отклонения явно сохранены:
  - `pass-pair-faisalx-2223` — `REVIEW`, потому что обязательные 28 fl oz не были прочитаны моделью или локальным OCR;
  - `pass-pair-faisalx-4779` — `REVIEW`, потому что модель разнесла NABISCO/OREO/GOLDEN/FAMILY SIZE по полям так, что fail-closed comparator не подтвердил автоматический `PASS`.
- Во время singleton один уже завершившийся Codex call не попал в checkpoint из-за отключения HTTP-клиента. Он восстановлен строго offline из immutable raw Codex session log. Новый replay заново проверяет exact prompt/result/model/CLI, receipt, evidence, session bytes и детерминированную визуальную связь с frozen full-view.
- Восстановленный call не выдаётся за обычный HTTP response: `client_response_observed=false`, normal worker/image/runtime attestations остаются `false`. Во всём Gate B разрешён максимум один такой строго доказанный primary singleton call.
- Независимый финальный аудит подтвердил Gate B v2 `GO`. После добавления следующего no-spend слоя расширенный Walmart test suite — 198/198, Oxylabs calibration contract — 8/8, worker tests — 8/8, релевантный Walmart script suite — 4/4; targeted strict TypeScript, ESLint и `git diff --check` — PASS.
- Общий scripts suite сейчас 9/10: отдельный Uncrustables readiness test останавливается на `FROZEN_MAIN_SPEC_V2 SHA mismatch`. Это не относится к Walmart-коду и не исправлялось в этом потоке, но поэтому общий репозиторий не выдаётся за полностью зелёный.
- Текущий controlled-partition code gate допускает только trusted-custody режим с
  официальной свежей owner authorization/permit, intact allowance ledger и одним
  executor. Remote worker ещё не обновлён и не проверен против текущего
  request/receipt/ledger contract, реальный family bundle не собран и subscription
  calls новым движком не выполнялись. Unattended mass остаётся отдельным `NO-GO`.
- После закрытия success-attempt, observation-mode и cross-partition namespace gaps
  объединённые freezer/engine/observer/production/source-aware suites: 94 tests,
  93 PASS, 0 FAIL, 1 sandbox-only loopback redirect SKIP. Тот же redirect test вне
  sandbox прошёл 1/1. Worker suite прошёл 22 non-loopback tests в sandbox, а его
  отдельный loopback integration прошёл 1/1 вне sandbox; targeted ESLint и
  `git diff --check` — PASS. Model/provider/DB/marketplace calls во время
  сертификации = 0.
- Ограничение trust boundary остаётся явным: worker receipt v2 не подписывает
  `attempt_body_sha256`, а локальные `0444`/hash/stable-read проверки не защищают от
  администратора или враждебного same-user процесса, намеренно меняющего artifact
  root во время исполнения. Это не blocker для одного изолированного trusted-custody
  executor с pinned code и remote one-shot ledger, но не является независимым
  криптографическим доказательством pre-POST существования attempt и не допускает
  unattended mass.
- Предыдущий Codex SSH health-check был отклонён средой, но этот blocker затем закрыт
  Claude BF-Images в общей VS Code workspace: deploy/restart и двухшаговый ledger
  bootstrap выполнены, authenticated health reported, model calls = 0.
- `mass_run_go=false`. Golden cohort проверяет только 24 frozen MAIN artifacts (`buyer_facing_verified=0/24`) и не подтверждает текущие live PDP, title, description, bullets, attributes или gallery. Реальный PDP adapter, реальные source snapshots, независимо размеченный Shadow-50 и gallery pilot ещё не завершены.
- `catalog-truth-export/v1` готов как offline read-only компилятор: он принимает только approved exact revision общей Product Truth Platform и точную buyer binding, блокирует superseded/unapproved/unsupported truth и повторно компилируется из исходников для защиты от полностью переподписанной подделки. Реальный snapshot каталога им ещё не собран.
- Shadow policy v3 готова на уровне offline-контракта: выборка детерминированно пересобирается из четырёх sealed raw sources — полного PUBLISHED population, partitioned exact-180-day performance, prior visual evidence и verified remediation evidence. До MLMQ money calibration sales tiers ранжируются только по `units_sold`; квоты, policy и `NO-GO` deep-frozen и изолированы от manifest; прежний operational seed намеренно сохранён как `walmart-shadow-50-v2`; сортировка locale-independent. Self-verifier проверяет полную семантику, а обязательный operational verifier полностью rebuild-ит manifest из Product Truth, buyer index и четырёх sources. `shadow_execution_ready=false` сохраняется, пока нет реальных данных, PDP capture, human labels и отдельного runner.
- Human-label contract v2 готов: trusted context отделён от raw labels, нужны два разных доверенных reviewer и третий adjudicator при конфликте. Source-aware builder/verifier требует точный порядок всех 50 manifest cases, exact catalog export и фактические локальные `Uint8Array` MAIN; сверяет SHA-256, byte length, PNG/JPEG/WebP format и dimensions. Immutable assignment и фактическое начало model execution проверяются отдельным evidence. Реальные 50 кейсов ещё не размечены.
- Все body hashes и source-aware rebuilds доказывают неизменность и соответствие переданным frozen inputs, но не являются цифровой подписью и сами не доказывают авторство/актуальность источников. Поэтому реальные snapshots должны поступить из утверждённых upstream exporters и пройти отдельный provenance gate.
- Для legacy-каталога пока нет immutable и независимо подтверждённого аудиторского snapshot общей Product Truth Platform. Seller catalog, buyer PDP, donor, title-derived pack count, remediation plan и AI-derived shipping/components могут быть наблюдением или подсказкой, но не устанавливают, что фактически отгружается по SKU.
- `SUMMARY_Walmart_Cards_for_Codex_2026-07-18.md` сохранён как полезный исторический handoff, но не как доказательство завершения. В нём одновременно заявлены «практически закрыто / ничего живого-битого не висит» и отдельная живая June-cohort из 282 битых плиток; это противоречие вместе с сообщённым владельцем смешиванием MAIN/gallery требует нового authoritative read-only snapshot. Числа и статусы из handoff нельзя переносить в текущий verdict без перепроверки.
- Экономный путь — не обогащать сразу 1500+ SKU: сначала создать sealed read-only risk/sales pool, затем независимо подтвердить truth только для достаточного числа кандидатов во всех квотах Shadow-50.
- One-call Oxylabs `walmart_product` calibration probe подготовлен и протестирован: dry-run по умолчанию, exact numeric item ID, global metered permit, ровно один primary attempt, ноль retries/fallback/health probes, raw bytes до receipt, immutable filenames и source-aware verification. Разрешённый live-вызов должен идти только через зафиксированный CLI-путь с real fetch transport; платный вызов требует отдельного разрешения и пока не выполнялся.
- Свежий read-only baseline Turso на `2026-07-18T23:10:07.102Z` насчитал 3 877 строк Walmart mirror и 2 859 `PUBLISHED + ACTIVE`. Это пока provisional population, а не доказанный полный denominator: в `WalmartReport` нет ни одного `ITEM_CATALOG` report, raw ITEM report не сохранён и полнота зеркала независимо не подтверждена.
- Все 2 859 непустых `WalmartCatalogItem.itemId` уникальны, но являются 12-символьными alphanumeric WPID; числовых public walmart.com item ID среди них нет. Seller WPID запрещено выдавать за buyer item ID. Полный каталог и performance должны соединяться по каноническому ключу `(channel, storeIndex, raw SKU)`; числовой buyer item ID разрешается только после exact SKU → GTIN → unique item resolution для выбранных audit cases.
- Текущий performance source непригоден для честного exact 180-day Shadow source: `WalmartSkuPerf` содержит 571 строку, покрывает только 380 из 2 859 текущих PUBLISHED SKU и последний раз вычислялся 2026-06-14; локальные `WalmartOrder` охватывают примерно 96, а не 180 дней, `WalmartReconTransaction` пуст. Отсутствующие продажи нельзя молча считать нулевыми.
- Offline ITEM v6 published-source compiler и default-deny phased capture CLI прошли fix-and-retest gate. Реальный POST был зарезервирован `2026-07-19T03:57:17.129Z`, но через 56 ms перешёл в `AMBIGUOUS_POST_NETWORK_OUTCOME`: create response/requestId отсутствуют, retry запрещён, source не создан. Позднее неизвестный параллельный процесс выполнил один read-only list GET; canonical execution зафиксировал terminal `PAGINATION_INCOMPLETE`, после чего другой конфликтующий execution добавил недоверенные `CAPTURED`/`ABSENCE_ONLY` files. RequestId не принят, create POST не повторялся, исходные четыре custody-файла byte-identical. Вся session и reconciliation code quarantined read-only; конфликтующий final запрещено использовать для source compile или owner reissue. Подробности и hashes: `WALMART_ITEM_RECONCILIATION_PROVENANCE_INCIDENT_2026-07-19.md`. Reconciliation adapter и owner-reissue engine реализованы на уровне кода, но новый POST остаётся закрыт до отдельного owner disposition и свежего допустимого evidence; никакой permit из quarantined final выпускать нельзя.
- Первоначальный one-shot exact-180-day Orders/Returns contract был отклонён: полный запрос физически требовал `requested_at === cutoff`. Partitioned performance v3 теперь сохраняет ровно 180 дней через заранее закреплённый future cutoff и минимум две строго перекрывающиеся части для каждого из трёх Orders scopes, доказывает отсутствие дыр, проверяет timestamps и детерминированно обрабатывает только идентичные overlap-дубли. Независимый математический/data review дал offline performance + Shadow contract `GO`; сокращение до 179 дней не использовалось. Operational execution остаётся `NO-GO`, пока не создан доверенный Orders/Returns capture adapter.
- Семантика Walmart MLMQ `PRODUCT chargeAmount` для `quantity > 1` ещё не подтверждена как unit price либо line total. До одной реальной сверки с order total/settlement денежные sales tiers не могут считаться доказанными; безопасный Shadow ranking может использовать только подтверждённые units и явно оставаться `NO-GO` по gross sales.
- Локальные exchange seals доказывают неизменность относительно доверенного capture adapter, но не являются подписью Walmart и не защищают от администратора того же компьютера, который намеренно заменит и raw bytes, и seal. Этот trust boundary должен оставаться явным; source-grade запуск требует доверенного custody/исполнения, а не заявления об независимой криптографической аутентичности Walmart.
- В production-схеме пока нет versioned approved Product Truth revision store и реального immutable Product Truth audit snapshot. Legacy visual/remediation state может служить candidate/risk evidence, но не independently verified buyer-facing truth или доказанным успешным исправлением.
- Walmart writes, database writes, R2 writes, model calls и платные provider/fallback-вызовы на этом этапе не выполнялись.

## Канонические артефакты

- Qualification contract для исторических visual/remediation evidence —
  `docs/WALMART_SHADOW_SOURCE_QUALIFICATION.md`. Он запрещает считать `ok=1` или
  общий `feedStatus=PROCESSED` доказательством buyer-facing исправления и задаёт
  безопасный zero-evidence baseline.

- Golden manifest — SHA-256 `8997a46fe8ef9ecccb165cc9548e0097d07561c2daa9079c09a17d3e25f2d403`: `data/audits/walmart-visual-pilot-golden-pairs-v3.json`
- Shuffled sealed run — body seal `fcb35f96d156f016badb617672cf6ecf4cfcf8737f2d0f601bda1f1df7b597d1`: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex/report-20260718T204434Z-fcb35f96d156f016.json`
- Ordered sealed run — body seal `4a1f21d05c6ad2ee1cff3f59cfa15c64b8332a7b072d7afcb899ca460068e8dd`: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-3be8593f5486-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex/report-20260718T210254Z-4a1f21d05c6ad2ee.json`
- Singleton sealed run — file SHA-256 `701b507fe13cf90cf760d90110e9bf02272592dfe59e3f78b41f84e1c4371c99`, body seal `6906839a63982057513366399bebe9bad06a41c8fb6a07f3a52c8b7de32b61ee`: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-4ae2043186a5-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex/report-20260718T214427Z-6906839a63982057.json`
- Recovery receipt — file SHA-256 `0234cf0aded83fdf6585f8cf3df90ebc39062dd6b163ce62575c9c8efc21f30a`, body seal `59d487470b9a77fcfa7d6b4c9b91a74f9396c2daba72057e1ba0f119d0f17a12`: `data/audits/walmart-visual-pilot-runs/walmart-main-artifact-pairs-12x2-20260718-v3-8997a46fe8ef-4ae2043186a5-eb9f8b5ab932-ce33e8f6-5813f5bae69c-codex/recovery-20260718T213840Z-59d487470b9a77fc.json`
- Recovery evidence — canonical SHA-256 `9b4e28f0f6957d778ad5de9f64b511eeb7a5c3c77f47278144d89a93c4aa5a1d`: `data/audits/walmart-visual-pilot-recoveries/singleton-call-21-20260718-v2.json`
- Immutable raw Codex session — SHA-256 `d0d0f0a4f138ca3d4862fc87fbfeae3d026c7f203421aa8afcdce9032e6b386c`: `data/audits/walmart-visual-pilot-recoveries/rollout-2026-07-18T17-09-05-019f770f-b1bf-7841-acfe-ee3b627a70bf.jsonl`
- Канонический Gate B v2 replay — file SHA-256 `dc1a7751ba2c24aa0e0e96cda64f86b5669d3ddcaa2a4f5dd772901905a89332`, body seal `0a8e5c5d355dc8b9dd4fc98a1beccb2df07a703b890766ec07ebd93d7b8ef705`: `data/audits/walmart-visual-pilot-replays/report-20260718T220435Z-0a8e5c5d355dc8b9.json`
- MAIN comparator: `src/lib/walmart/catalog-visual-audit.ts`
- Truth preflight: `src/lib/walmart/catalog-visual-truth-preflight.ts`
- Buyer snapshot: `src/lib/walmart/buyer-facing-snapshot.ts`
- Gallery comparator: `src/lib/walmart/catalog-gallery-audit.ts`
- Pilot runner: `scripts/walmart-visual-audit-pilot.mjs`
- Shared Product Truth audit compiler: `src/lib/walmart/catalog-truth-export.ts`
- Source-aware Shadow-50 selection policy/compiler: `src/lib/walmart/shadow-50.ts`
- Independent human-label/adjudication contract: `src/lib/walmart/shadow-human-labels.ts`
- Offline Shadow manifest builder: `scripts/build-walmart-shadow-50.mjs`
- One-call buyer-PDP calibration contract and dry-run CLI: `src/lib/sourcing/oxylabs-walmart-product-calibration.ts`, `scripts/probe-walmart-buyer-pdp.ts`

## Журнал решений

- 2026-07-18 — главная цель расширена и зафиксирована как полная целостность листинга, а не только проверка MAIN или multipack quantity.
- 2026-07-18 — массовый аудит запрещён до полного Gate B и buyer-facing Shadow-50.
- 2026-07-18 — текущие листинги и донорские изображения исключены как самостоятельный источник product truth.
- 2026-07-18 — shuffled batch-4 прошёл 24/24; отчёт сохранён и перепроверен zero-model replay.
- 2026-07-18 — ordered batch-4 прошёл 24/24; 6 вызовов, 0 fallback, отчёт сохранён и перепроверен zero-model replay.
- 2026-07-18 — singleton завершён: 24/24 вызова, 12 `BAD`, 10 `PASS`, 2 безопасных `REVIEW`, без false pass, false bad и technical error.
- 2026-07-18 — одна потерянная checkpoint-запись уже завершившегося Codex session восстановлена offline с CAS/checkpoint guards и отдельной raw-session provenance; ordinary HTTP/worker attestation не подменялась.
- 2026-07-18 — принят Gate B policy v2: exact verdict agreement остаётся видимой неблокирующей диагностикой; blocking safety требует каждый известный `BAD` определить как `BAD` во всех layouts, никогда не выдавать `BAD` известному `PASS`, не иметь PASS↔BAD contradictions/technical/fallback и сохранять минимум 80% all-layout auto-PASS.
- 2026-07-18 — один raw-session recovery может удовлетворить execution-provenance gate только как отдельный тип доказательства, после полной offline-перепроверки и только для одного primary/one-image call. Он не удовлетворяет normal worker attestations и не открывает mass run.
- 2026-07-18 — новый sealed replay под текущим runner получил Gate B v2 `GO`; независимый аудит не нашёл оставшихся fail-open blockers в audited scope.
- 2026-07-18 — массовый аудит не разрешён: frozen MAIN artifact certification не заменяет проверку текущего buyer-facing PDP, полного текста карточки и gallery.
- 2026-07-18 — readiness-аудит следующего этапа запретил прямой Shadow-50: модель должна видеть те же sealed локальные байты MAIN, которые разметил человек; повторное скачивание URL во время model run недопустимо.
- 2026-07-18 — принято строить минимальный sealed audit snapshot подтверждённых рецептов из единой Product Truth Platform, а не отдельный Walmart-каталог. Связь `наш SKU → фактически отгружаемый товар/компоненты/outer units` подтверждает человек либо exact approved recipe revision, привязанная к SHA; donor и текущая карточка не выбирают truth. Новое подтверждение должно возвращаться в общий truth/enrichment-контур, а listing audit только читает его frozen snapshot.
- 2026-07-18 — независимо размеченный Shadow-50 должен быть sealed до первого model call; два проверяющих размечают каждый кейс независимо, разногласие разрешает третий adjudicator.
- 2026-07-18 — до массового каталога выбран staged-подход: offline truth/candidate package → один buyer-PDP schema-calibration call → capture-пилот → завершение Shadow-50 → gallery pilot → решение о sharded read-only scan.
- 2026-07-18 — реализован и source-aware перепроверен offline export из общей Product Truth Platform; отдельный Walmart truth catalog не создаётся.
- 2026-07-18 — Shadow-50 selection evidence теперь выводится только из четырёх frozen sealed raw sources и не принимает caller-derived risk/strata за истину; `shadow_execution_ready=false` сохранён.
- 2026-07-18 — реализован fail-closed human-label/adjudication contract v2, в котором raw labels не могут сами определить состав кейсов или подделать доказательство предмодельной разметки.
- 2026-07-18 — подготовлен строго одновызовный Oxylabs calibration probe; выполнен только dry-run, сеть и платный provider не вызывались.
- 2026-07-18 — независимый adversarial review обнаружил и закрыл fail-open self-verifier manifest, отсутствие source-aware context-to-bytes binding, runtime-мутацию policy/квот/`NO-GO`, незакреплённый seed, locale-dependent ordering и небезопасные object-prototype category keys.
- 2026-07-18 — текущая проверка после интеграции: Walmart 198/198, calibration 8/8, worker 8/8, релевантные Walmart scripts 4/4, targeted strict TypeScript/ESLint/diff-check — PASS. Общий scripts suite 9/10 из-за отдельного Uncrustables pinned-SHA mismatch; чужой артефакт не менялся.
- 2026-07-18 — свежая read-only диагностика реальных sources зафиксировала 2 859 provisional `PUBLISHED + ACTIVE`, отсутствие сохранённого `ITEM_CATALOG`, неполный/устаревший performance и только 96 дней локальной order history. Поэтому real Shadow-50 и mass run остаются `NO-GO`; неполнота не маскируется флагом `published_population_complete` или нулевыми продажами.
- 2026-07-18 — seller WPID отделён от public numeric buyer item ID на уровне принятого дизайна: population grain — `(channel, storeIndex, raw SKU)`, buyer item ID нужен только выбранным auditable cases после exact resolution. Требующий numeric item ID для всех строк Shadow source v2 должен быть заменён до real source export.
- 2026-07-18 — реализованы offline ITEM v6 compiler, zero-evidence bridge и phased local capture skeleton; live network не запускался. Независимый capture red-team оставил его `NO-GO`, найдя cross-account continuation, неверный network accounting, отсутствие deadline, symlink/relative-path gaps и невозможность обновить истёкший locator. Все пункты внесены в обязательный fix-and-retest gate.
- 2026-07-18 — первоначальные зелёные performance-тесты не приняты как достаточное доказательство: red-team воспроизвёл невозможность последовательного one-shot exact-180-day capture и дополнительные дефекты provenance, deep JSON limits, Returns lifecycle/quantity validation и detached zero-units/gross invariant. Contract переводится на partitioned v3 и будет повторно проверен другим проходом до любого real Shadow input.
- 2026-07-18 — исторический Claude handoff принят как карта прежних действий и кандидатов риска, но его утверждение о фактически закрытом live scope отклонено как недоказанное и внутренне противоречивое. Канонический статус определяется только новым source-aware аудитом текущих buyer-facing карточек.
- 2026-07-18 — ITEM capture прошёл полный цикл «реализация → независимый негативный review → два дополнительных исправления → повторный review»: 44/44 PASS, отдельные последние repro 3/3, strict TypeScript/ESLint/diff-check PASS. Технически разрешён только один контролируемый authoritative ITEM capture при trusted custody; он ещё не запускался и не разрешает mass scan.
- 2026-07-18 — performance v3 и Shadow v3 прошли независимый data-quality review после исправления exact-180 partitioning и отдельного Shadow deep-JSON `RangeError`: offline contract `GO`, integrated source/truth/Shadow suite 148/148 PASS. Real performance/Shadow остаётся `NO-GO` из-за отсутствия Orders/Returns capture adapter, внешней полноты seller-account registry и MLMQ money calibration.

## Следующий контрольный этап

1. `[СДЕЛАНО: контракт]` Зафиксированы source-aware Product Truth export, четырёхисточниковый Shadow policy v2 с fixed seed/immutable policy/full source rebuild, source-and-actual-bytes-aware human-label v2 и одновызовный calibration probe. Это кодовая готовность, а не реальный аудит каталога.
2. `[СДЕЛАНО: OFFLINE + ITEM CAPTURE CONTRACT]` Population/performance/prior/remediation соединяются по `(channel, storeIndex, raw SKU)`; public numeric buyer item ID требуется только от отобранных auditable cases. ITEM compiler/default-deny capture CLI и partitioned performance/Shadow v3 независимо перепроверены. Это готовность инструмента, а не реальный snapshot каталога.
3. `[СДЕЛАНО: КОД / НЕ ЗАКРЫТ REAL DISPOSITION]` Sealed adapter для `GET /v3/reports/reportRequests` реализован и проверен. Единственная live reconciliation chain противоречива и quarantined; её поздний `ABSENCE_ONLY` не авторитетен, requestId не принят и create POST не повторялся.
4. `[СДЕЛАНО: OWNER-REISSUE ENGINE / ИСПОЛНЕНИЕ ЗАПРЕЩЕНО]` Canonical permit и one-shot request path реализованы; legacy/generic-client ITEM create отключён. Quarantined evidence не удовлетворяет preconditions, поэтому owner disposition и свежий eligible evidence обязательны до любого нового permit/POST.
5. `[СДЕЛАНО: CONTROLLED-PARTITION CODE]` Engine/freezer/observer v4, external Ed25519 owner authorization, hard freshness, one-shot allowance/worker ledgers, exact `0444` observation/attempt custody и canonical global path namespace прошли merged suite и независимый QA. Это code readiness только для одного изолированного trusted-custody executor, не разрешение реального или массового прогона.
6. `[БЛОКИРОВАНО PROVENANCE/OWNER DISPOSITION]` Разрешить quarantined ITEM reconciliation incident в отдельном custody root. Нельзя выпускать permit из конфликтующего `ABSENCE_ONLY` и нельзя повторять исходный create POST. Только после нового eligible evidence возможен отдельный owner gate на permit/hashes/confirmation и duplicate-request risk.
7. `[НЕ СДЕЛАНО]` После безопасного ITEM disposition реализовать trusted phased capture adapter для partitioned Orders/Returns: PII только в ignored local `0600`, exact account/correlation/query/cursor/bytes binding, deadlines, call accounting, checkpoint/resume и source-aware replay. Реальные API-вызовы не выполнять до отдельной контрольной точки.
8. `[НЕ СДЕЛАНО]` Снять и запечатать реальные входы: authoritative raw ITEM report, exact 180-day orders/returns pages, prior visual evidence, verified buyer-facing remediation evidence, approved Product Truth revisions и buyer snapshot index. Для Shadow подтверждать только достаточное число кандидатов; не создавать параллельный каталог.
9. `[ЖДЁТ ОТДЕЛЬНОГО РАЗРЕШЕНИЯ]` Выполнить ровно один Oxylabs schema-calibration call для выбранного exact numeric item ID, проверить raw schema и только затем реализовать/проверить read-only buyer-PDP adapter: exact SKU → GTIN → unique itemId → provider echo → sealed raw PDP → локальные MAIN/gallery bytes.
10. `[НЕ СДЕЛАНО]` Сформировать реальный Shadow-50 по frozen risk/sales strata, построить trusted context и получить две независимые human labels до первого model call; конфликт передать третьему adjudicator.
11. `[НЕ СДЕЛАНО]` Реализовать отдельный Shadow runner и выполнить ordered batch-4 + seeded-shuffled batch-4 по тем же sealed локальным MAIN bytes: 26 обычных attested subscription calls без recovery/fallback/retry.
12. `[НЕ СДЕЛАНО]` Провести отдельный gallery golden/pilot: MAIN-certification не переносится автоматически на дополнительные изображения.
13. `[ЗАПРЕЩЕНО ДО ГЕЙТОВ]` Только после предыдущих этапов готовить sharded/resumable read-only аудит затронутого каталога. Любые Walmart writes остаются отдельным этапом с approval, canary, post-write PDP/indexing verification и rollback.
