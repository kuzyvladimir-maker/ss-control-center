# Walmart New SKU — execution board

> **Статус:** active implementation board, обновлено 2026-07-28.
>
> **Канон:** [[product-catalog-architecture]]. Операторский workflow:
> [[walmart-new-sku-operator-runbook]]. Product Truth prerequisites:
> [[product-truth-command-center]]. Этот board не разрешает production migrations,
> Walmart publication, paid provider calls, repricing, delist или purchase.

## Конечная цель

Сделать `Walmart New SKU` полноценным опциональным подмодулем Bundle Factory:

1. кандидат и контент читаются только из Product Truth;
2. используется существующий owner-approved UPC pool;
3. Walmart payload, policy, economics и lifecycle проверяются до публикации;
4. Claude Code только исполняет frozen engine и его точный `next_command`;
5. первый реальный SKU проходит весь путь до seller- и buyer-подтверждённого `LIVE`;
6. второй SKU и любые волны требуют отдельного решения владельца.

Уточнение цели владельца от 2026-07-22: это не отдельный скрипт, не второй Bundle
Factory и не Walmart-only товарный каталог. Общий Bundle Factory сохраняет общие
job/draft/approval primitives, но Amazon, Walmart и будущие каналы имеют независимые
channel-ветки со своими content, attributes, images, compliance, payload, publish и
verify lifecycle. Walmart-ветка использует Product Truth / донорский справочный
каталог как единственный источник товарной идентичности, фактов, изображений,
закупочных offers и evidence. Полный каталог наших существующих Walmart-листингов не
является входом или prerequisite нового SKU. Непосредственно перед certification
движок проверяет только два exact идентификатора будущего листинга: staged seller SKU
должен отсутствовать, а выделенный UPC не должен быть занят в Walmart catalog.

Knowledge Base конкретного канала переводится в versioned executable validators,
candidate-bound policy evidence и live marketplace spec; markdown сам по себе не
является runtime-разрешением. После успешного pilot 1–2 SKU масштабирование на волны
15–20 и затем расписание проектируются как отдельные releases с новыми owner gates,
лимитами, stop conditions и мониторингом. Текущий pilot release этого не разрешает.

Текущий release намеренно поддерживает только один exact shelf-stable товарный
вариант в multipack `2` или `3`, один candidate на plan и максимум два pilot SKU.
Mixed/variety/frozen и партии 15–20 не входят в этот release.

Уточнение владельца от 2026-07-23: целевая contribution margin равна `30%` после
goods, packaging materials, seller shipping label и Walmart referral fee. Walmart
разрешён как источник закупки. Высокая цена относительно локального Walmart
comparable не отклоняет candidate внутри Bundle Factory: это обязательный warning для
owner review, потому что бизнес доставляет в зоны, где retail delivery недоступен.
При этом официальный Walmart Pricing Rule остаётся внешним риском unpublish/Buy Box.

Уточнение владельца и evidence review от 2026-07-26: требуемая customer total до
налога может делиться между `item price` и customer shipping по уже существующему
Walmart template. Всегда `landed total = item price + customer shipping`; referral
и contribution margin считаются с landed total. При одинаковых speed/coverage/total
default — free shipping. Paid shipping допускается только как controlled experiment,
реально более быстрый service либо экономически необходимое исключение. Полный канон:
[[walmart-new-sku-shipping-price-strategy]].

## Текущий итоговый срез — 2026-07-27

- ✅ **Выполнение: движок.** Frozen operator release v32:
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-27-v32`; engine SHA
  `cc086942…89898`, manifest SHA `efa8e8cd…135b`, certificate SHA
  `17bfde04…050c`. Product Truth `472/472`, focused Walmart `21/21`, fake-live
  `3/3`, TypeScript PASS. V31 и старше — только audit history.
- ✅ **Выполнение: Product Truth.** Exact Target content активирован для RITZ Bits
  Cheese 8.8 oz, donor `75422f18-e3d2-4c62-ae62-7287aaa75119`, canonical variant
  `cpv1:ba797…194a9`, observation `pco:68af…d59e`, activation receipt SHA
  `bdbfb3b2…e8aa1`. Seller listing catalog не использовался.
- ✅ **Выполнение: Walmart spec и shipping.** Current Get Spec принимает Product Type
  `Snack Crackers` в `MP_ITEM 5.0.20260501-19_21_29-api`; generic `Crackers`
  отклонён. Pilot использует active free `Default Template`, ID
  `202402999000149568`, normalized snapshot SHA `b009dc3f…84a1b`. Mutable values
  повторно читаются непосредственно перед certification.
- ✅ **Выполнение: pilot 1.** Pack of 2 staged как SKU `WM-5861-AF0E`, UPC
  `756441906004`, accepted owner-preview price target `$33.13`, wave
  `WM-PILOT-20260727-b305eb4f`, candidate
  `wm-e241c5c8317dc0b5`, stage SHA `f31fd5d4…c97c`; Walmart mutation `false`.
- ✅ **Выполнение: pilot 2.** Pack of 3 staged как SKU `WM-E031-D5C4`, UPC
  `756441906011`, accepted owner-preview price target `$40.36`, wave
  `WM-PILOT-20260727-a3d70341`, candidate
  `wm-753c7be4172d0da9`, stage SHA `b467491c…fc3a`; Walmart mutation `false`.
- ✅ **Выполнение: owner preview.** Owner-only Sites version 9, source commit
  `d5daebe4e01161335416dabc4d5e717a9cd976d4`, успешно развернута:
  `https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`. В ней показаны два
  staged pilot SKU и отдельная readiness page.
- ⛔ **Внешний evidence gate.** Нельзя честно запечатать certification без реальных
  Seller Center health/ingestible privilege, resale/image-rights evidence,
  UPC registry/assignment authority, physical packed measurements, country of
  origin, expiration/lot SOP и fulfillment-center/lag. Разрешение «делай всё» не
  заменяет эти факты.
- ⛔ **Live owner gate.** После evidence → certification → dry-run → approval →
  apply-preview нужен отдельный Ed25519-signed permit на exact payload первого SKU.
  Текущий snapshot не публиковал Walmart listing. Волны 15–20 и schedule не
  разрешены.

UPC reservations текущих staged artifacts истекают
`2026-07-28T13:52:56.990Z` / `2026-07-28T13:55:59.720Z`. После expiry оператор не
правит JSON и не выбирает UPC вручную; он запускает новый v32 doctor и следует exact
recovery `next_command`. `rotate-upc` разрешён только после доказанного
`MP_ITEM_MATCH`.

## Production incident — 2026-07-28, Campbell's 5 × 8

- ✅ **Выполнение: exact request найден.** Production `GenerationJob`
  `cms4q03ni003v04lc00uy293y` содержит owner prompt на пять Campbell's canned-soup
  listings по восемь банок, store 1 / SIRIUS и active free `Default Template`.
  Запрос не потерялся.
- ✅ **Выполнение: root cause доказан.** Старый Studio API не извлекал количество из
  plain-language prompt, молча записывал default `listing_count=2`, создавал
  `PENDING / WALMART_REQUEST_READY` и останавливался. Result page при этом назывался
  `Building listings`, хотя frozen engine не запускался. Это UI/orchestration defect,
  а не ошибка владельца.
- ✅ **Выполнение: fail-closed исправление.** Добавлен deterministic RU/EN parser
  `listing_count`/`pack_count`, conflict check между prompt и structured fields,
  HTTP `422` для scope вне verified release и отдельный Walmart scope block в UI.
  Запрос `5 листингов / по 8 банок` теперь сохраняется как exact `5 × 8` intent и
  получает два понятных blocker; его запрещено заменять на `2 × 2` или создавать как
  ложную running job.
- ✅ **Выполнение: честный web status.** Кнопка текущего pilot называется
  `Prepare Walmart request`; success page прямо сообщает, что inputs записаны, но
  generation не стартовала и Walmart publication равна `0`. До отдельного
  default-OFF web→worker bridge Command Center не выдаёт web-session за исполнение
  frozen operator CLI.
- ✅ **Выполнение: regression.** Exact русский Campbell's test, structured/prompt
  conflict tests, supported-pilot test, targeted ESLint и полный Next production
  build прошли.
- ⛔ **Product Truth readiness для exact owner intent.** В production донорском
  каталоге найдены ровно пять Campbell's canned-soup variants с
  `identityStatus=exact_confirmed`, exact content и 7–12 изображениями: Tomato,
  Cream of Chicken, Golden Mushroom, Heart Healthy Cream of Mushroom и Chunky
  Chicken Pot Pie. Но у всех пяти отсутствуют свежие append-only
  `DonorOfferObservation` с canonical variant binding; текущие materialized offers
  датированы 2026-07-10/11 и не являются свежим 24-hour price evidence. Frozen v32
  также разрешает только pack 2/3 и максимум два SKU. Legacy `bestPrice` не может
  быть подменён под current FACT.
- ⬜ **Следующая отдельная реализация.** Для реального Campbell's `5 × 8` нужен новый
  post-pilot release: targeted fresh price evidence по пяти exact variants,
  arbitrary homogeneous pack count `8`, bounded five-candidate plan, пять
  count-accurate image previews, новый regression/frozen release и затем обычные
  certification/owner gates. Это расширение не включено молча в v32 и не выполняет
  Walmart write.

## Правило статусов

- `✅ Завершено` — фаза завершена и проверена;
- `🔄 Выполнение` — единственная текущая фаза;
- `⬜ Ожидает` — ещё не начато;
- `⛔ Owner gate` — всё возможное подготовлено, требуется понятное решение владельца
  или внешний вход.

После завершения каждого пункта или смены текущей фазы progress update обязан показать
весь краткий фазовый план с этими отметками. Технический лог без видимого положения в
плане не считается достаточным отчётом владельцу.

## Минимальный реестр owner-gates

Общая цель не является бессрочным разрешением на неизвестные будущие production
bytes. При этом оператор не спрашивает «продолжать ли» для обычной работы. Без нового
решения выполняются чтение, код, тесты, Wiki-Brain, plans, doctor, candidate/evidence
подготовка, economics, policy analysis, dry-run и preview.

Отдельное короткое решение владельца требуется только для уже подготовленного и
показанного действия:

1. ~~применить post-Product-Truth Walmart lifecycle migration~~ — закрыто
   2026-07-23: schema-only activation v3 применён;
2. выполнить платный provider call, только если бесплатных evidence недостаточно;
3. отправить exact первый Walmart SKU после preview;
4. отдельно разрешить второй pilot SKU;
5. после pilot отдельно разрешить bounded waves и ещё позже schedule.

Product Truth schema gate уже закрыт: exact восемь migrations применены и независимо
сертифицированы. Полный cross-channel Phase 1 manifest/backfill остаётся обязательной
отдельной задачей Product Truth Platform, но не стоит на критическом пути первого
Walmart SKU: единственный pilot candidate может закрыть свой exact gap только через
канонический sealed `TARGETED_WALMART_EVIDENCE` lane. Это не разрешает mass backfill,
не создаёт отдельный каталог и не уменьшает полный Phase 1 denominator.

Эти решения нельзя выдавать одним пакетом заранее: downstream plan/payload/source ещё
не существует и его exact scope невозможно проверить. Один gate — одно короткое
owner-сообщение обычным языком; hashes, artifact binding и confirmation собирает
Codex. Повторно спрашивать разрешение внутри уже одобренного exact действия запрещено.

## Фазовый план

### ✅ Фаза 0 — Фактическая исходная точка

- [x] Полностью перечитан обязательный Product Truth/Walmart canon.
- [x] Текущий source, Git boundary, frozen release и production prerequisites
  проверены на 2026-07-22.
- [x] Исторический frozen release self-verify прошёл; его operational suite
  `146/146` остаётся только исходной точкой, а не текущим release-кандидатом.
- [x] Read-only production doctor подтвердил отсутствие Product Truth schema.
- [x] Подтверждено: ITEM v6 attempt от 2026-07-22 получил `HTTP 429`, request ID
  отсутствует, retry не выполнялся и запрещён.
- [x] Исправлен wall-clock-stale Product Truth census fixture без ослабления
  production TTL; предположение о runtime-дефекте Prisma CLI снято полным frozen
  integration-прогоном.

**Внешние эффекты этой фазы:** одна read-only Turso schema inspection; Walmart/DB
writes, provider/model calls и listing mutations — `0`.

### ✅ Фаза 1 — Единый Bundle Factory и Walmart channel adapter

- [x] Доказать, что Walmart runtime использует общие `GenerationJob`, `BundleDraft`,
  `MasterBundle`, `ChannelSKU` и общий `distribution-pipeline`, а не второй Bundle Factory.
- [x] Закрыть legacy Studio Walmart path, который напрямую читал mutable
  `DonorProduct`; Amazon Studio оставить без изменений.
- [x] Добавить fail-closed regression gate для API и уже созданных legacy Walmart jobs.
- [x] Исправить time-dependent Product Truth fixture без ослабления production TTL.
- [x] Доказать единый runtime path:
  `Bundle Factory → Walmart adapter → Product Truth → BundleDraft/ChannelSKU → distribution-pipeline`.
- [x] Повторить общий Product Truth suite `426/426`, Walmart suite `160/160`,
  focused matcher/evidence regressions `33/33` и frozen fake-live `3/3`.
- [x] Доказать в fake-live ровно один feed POST, отсутствие второго POST при replay
  и финальный `BUYER_VERIFIED/LIVE`.

### ✅ Фаза 2 — Matcher provenance и новый frozen release

- [x] Выдать matcher версию `canonical-product-match/1.2.1` и отдельно закрепить
  SHA точных implementation bytes и matcher release manifest.
- [x] Протащить полный matcher provenance через donor decisions, Product Truth,
  COGS, read-contract `3.2.0`, Walmart plan `1.4.0` и listing manifest `1.1.0`.
- [x] Сохранить ровно восемь canonical Product Truth migrations; production activation
  остаётся отдельным owner-gated plan, а не девятой скрытой migration.
- [x] Повторно проверить current source: Product Truth `427/427`, Walmart `160/160`,
  focused matcher/evidence regressions `33/33`, frozen fake-live `3/3`, Prisma schema valid.
- [x] Выпустить и проверить новый frozen Walmart release: operational suite из
  persistent release `147/147`, source-release meta suite `13/13`.
- [x] Сохранить runbook, manifest/certificate/checksums и release location в
  долговечном artifact boundary без помещения runtime dependencies в обычный Git.

### ✅ Фаза 3 — Исправленный план Product Truth v3

- [x] Использовать первое owner approval ровно один раз для plan v2. Turso отверг
  direct `PRAGMA ignore_check_constraints` внутри write-transaction до commit;
  транзакция целиком откатилась, retry не выполнялся.
- [x] Свежим read-only plan сразу после ошибки доказать отсутствие частичной мутации:
  на тот момент production schema SHA остался `591d6ec4…9aea`, все восемь migrations
  были pending, durable schema/data writes = `0`.
- [x] Заменить только несовместимый direct PRAGMA на table-valued pragma `SELECT`,
  сохранив fail-closed constraint check; проверить query внутри реальной Turso
  write-transaction с rollback.
- [x] Повторить тесты: focused migration `16/16`, Product Truth `427/427`, Walmart
  `160/160`, frozen operational `147/147`, source-release `13/13`, fake-live `3/3`.
- [x] Построить свежий read-only plan v3 против неизменившейся production DB:
  `data/walmart-new-sku-engine/activation/20260723T004458Z-product-truth-plan-v3`,
  SHA `96b675ac71344a4ded72e51cbe9d4b880139d7d5dd288e67895b8f87924b1d7f`,
  `canApply=true`, `blockers=[]`, exact migrations `8`, compatibility rows `128`,
  active writers/unfinished migrations/unsettled metered receipts = `0`.
- [x] Выпустить и проверить frozen release v3 с исправленным activation runner:
  engine SHA `eda6dc94…5e11`, manifest SHA `20f5f86d…c1d`, certificate SHA
  `2c160359…1bd6`.

### ✅ Фаза 4A — Product Truth production schema

- [x] Снять новый self-contained production backup для plan 2026-07-22:
  `data/walmart-new-sku-engine/activation/backups/20260722T224444Z`, portable SHA
  `6e69911d1ab83f77545c9fa5789d35e29f11cd434a25b24d2f03e3fdef952526`;
  `integrity_check=ok`, FK violations `0`, manifest SHA
  `84c3b2bfdf625bf5a0b9a40534aab2de590eece79a6f51309f1c054547fa8f02`.
- [x] Доказать writer quiescence без перекладывания технической проверки на owner:
  reference enrichment/harvest/COGS crons отсутствуют в `vercel.json`, legacy routes
  и manual mutation endpoints retired/410, canonical writers не фоновые процессы,
  plan-bound active writer counts = `0`; apply всё равно повторяет drift/writer
  preflight и fail-closed останавливается до записи при любом изменении.
- [x] Зафиксировать первый неуспешный apply как полностью rolled-back incident;
  approval v2 и plan v2 сохранить только как evidence и запретить их reuse.
- [x] Выполнить полную локальную репетицию на отдельной копии production backup:
  все `8/8` migrations applied/tracked одной транзакцией примерно за 2 секунды,
  schema after `8c9fc783…d511`, compatibility rows `128/128`, cancellations `0`,
  `integrity_check=ok`, FK violations `0`, postcheck blockers `[]`. Durable summary
  SHA `1afd1b5c…1225`; Turso/Walmart/provider calls и production writes = `0`.
- [x] Получить короткое повторное owner decision, связанное именно с исправленными
  bytes/plan v3; это тот же набор восьми schema changes, а не новый объём работ.
- [x] После v3 owner approval применить exact migration plan один раз: 8/8
  applied/tracked, schema after `8c9fc783…d511`, activation report SHA
  `9039f226…a1db`, migration certification SHA `d26f5702…8093`.
- [x] Независимым post-commit read-only plan подтвердить обе ledgers, 8/8 migrations
  и `blockers=[]`; plan SHA `37c6d141…13fa`. Business-data writes = `0`.
- [x] Получить migration certification и schema readiness report.

Полный Amazon+Walmart manifest/backfill не закрыт, но вынесен в отдельный platform
track и больше не обозначается blocker текущего Walmart pilot. Для выбранного одного
кандидата обязателен exact Product Truth evidence, а не общий mutable donor read.

### ✅ Фаза 4B — Walmart publish lifecycle v3

- [x] После Product Truth построить новый lifecycle v3 plan: SHA
  `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`,
  `eligibleForApply=true`, `blockers=[]`, duplicate active UPC reservations `0`.
- [x] Выполнить локальную репетицию на копии production backup после применения exact
  восьми Product Truth SQL migrations: lifecycle apply `applied`, integrity `ok`, FK
  violations `0`, required objects `10/10`; повторный plan fail-closed вернул только
  `MIGRATION_ALREADY_ACTIVATED`. Runtime probes подтвердили active-fence, global
  two-SKU cap и buyer-evidence/attempt-SKU guard. Summary SHA
  `3bc021833bd9a1c049e7ba38be46a57ea532b077b65150c12ab31515475ee9ef`.
- [x] После понятного owner approval применить только lifecycle migration:
  production report =
  `data/walmart-new-sku-engine/activation/20260723T053000Z-walmart-lifecycle-apply-v3`,
  status `applied`, report SHA
  `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`.
  Business-data backfill, Walmart/provider/model calls и публикации = `0`.
- [x] Transactional apply до commit повторно проверил exact target/schema/migration
  bindings, все обязательные lifecycle objects, Prisma migration history и
  immutable activation receipt. Production schema SHA изменился только с
  `8157c318016ade9f524394a42ca50e294a7776cd2d27bc13dfa6009a356d3a9c` на
  `c54877cb6cf9cb2e823092a739bc078a11af1e4102a6d1c650ee200e23c3dbeb`.
  One-shot active-attempt fence, buyer-evidence binding и historical two-SKU cap
  отдельно доказаны local backup-shaped runtime probes и frozen fake-live replay.

### ✅ Фаза 4C — Актуальная Walmart Knowledge Base и executable policy gates

- [x] Сверить runtime policy snapshot с официальными Walmart Marketplace Learn и
  Developer Portal страницами на 2026-07-26; pinned snapshot =
  `walmart-us-prepublication/2026-07-26.1`.
- [x] Расширить structured review с 9 источников/8 доменов до 14 источников/11
  доменов: отдельно добавлены account publish eligibility, image policy,
  shipping/fulfillment и pricing competitiveness.
- [x] Зафиксировать owner commercial contract: fresh exact-variant comparable,
  линейная нормализация pack count, required landed total как сумма item price и
  exact customer shipping charge, referral с landed total и contribution margin не
  ниже `30%`. Current preview с нулевой customer shipping charge остаётся только
  free-shipping scenario. Comparable — warning, не hard reject; официальный Walmart
  Pricing Rule остаётся отдельным внешним риском.
- [x] Провести отдельное official/academic/seller-community исследование
  free shipping против partitioned price и закрепить
  [[walmart-new-sku-shipping-price-strategy]]: Walmart price competitiveness видит
  `item + shipping`; shipping cost/speed отдельно влияют на Buy Box; fast/free
  является default при равной скорости; paid shipping требует experiment/exception.
- [x] Сделать обязательными fresh Seller Center Health & compliance evidence,
  `INGESTIBLE_PRODUCTS=APPROVED`, owned inventory, отсутствие retail arbitrage,
  competitor packaging/promotional inserts и exact fulfillment center/lag binding.
- [x] Исправить ошибочную внутреннюю дату Product ID policy: официальная страница
  обновлена 2025-06-05, а не 2026-07-15.
- [x] Повторная official recheck 2026-07-23 не обнаружила spec drift: Developer
  Portal по-прежнему рекомендует `MP_ITEM 5.0.20260501-19_21_29-api` и
  `MP_ITEM_MATCH v4.2`, то есть frozen v23 использует текущий Item Spec.
- [x] Перенести policy gates в current immutable release v23 и доказать: frozen
  Product Truth `429/429`, Walmart unit/security exit `0`, fake-live `3/3`, ровно
  один fake POST и replay без второго POST.

### ✅ Фаза 4D — Offline owner signer без доступа Claude Code

- [x] Создать отдельный owner-only `walmart:new-sku:owner-signer` для инициализации,
  inspect и подписи exact one-SKU permit.
- [x] Свести report request, catalog activation и MP_ITEM submit к одному
  owner-control public key, сохранив три непересекающихся signing domain. Подпись
  report технически не подходит для catalog/listing и наоборот.
- [x] Исключить пользовательский пароль, хранение private key внутри repository,
  network/Walmart/DB/model access и расширение scope на
  delist/reprice/purchase/schedule либо больше одного POST.
- [x] Проверить encrypted-at-rest custody + macOS Keychain, exact request/hash binding, понятные
  summary, 64-byte signature, immutable freeze closure и fail-closed tamper cases:
  post-enrollment owner/report/catalog suites `92/92 PASS`.
- [x] Описать автоматический owner-control workflow обычным языком в
  [[walmart-new-sku-operator-runbook]]. Claude Code эту поверхность не запускает.
- [x] Автоматически создать production owner-control key без пользовательского
  пароля, подтвердить `OWNER_CONTROL_READY` и закрепить public fingerprint
  `ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a`.
- [x] Выпустить и проверить immutable Bundle Factory Walmart release v7 с pinned
  production public key.
- [x] После успешного fresh GET-only absence probe выпустить новый one-shot ITEM v6
  report executor с закреплённым production trust root; старый executor с пустым
  trust root оставить только как `NO-GO` audit evidence.

### ✅ Фаза 5 — Product source и exact duplicate guard

- [x] Исторический pre-enrollment one-shot report-request executor доказал safety:
  manifest SHA
  `2faa4399e751ad4d7877629347ba7c6138d915ca99bfca5909f4c33d77918c5e`, bundle SHA
  `b44b6a354d512cda3229186c3da0224a65f1c807d7732db622945681d5f7429e`;
  sidecars `OK`, private modes `0500/0400`, focused safety suite `71/71 PASS`.
- [x] Подтверждено, что этот frozen executor содержит пустой production trust root:
  он корректно не способен выполнить POST и не должен выдаваться как исполнимый.
  Подготовленные pre-enrollment plan/session остаются audit evidence, но не
  переиспользуются после нового release.
- [x] Общий encrypted owner-control key создан вне repository автоматически;
  закреплён только public enrollment, пользовательский пароль отсутствует.
- [x] Выполнить fresh GET-only absence probe, пересобрать exact
  session/ledger/plan и заморозить новый self-bound one-shot executor: evidence SHA
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`,
  manifest SHA
  `1e87043d3cf0ab879f184c5a8bbbb5445e84e3ed4a2fd6e56b1951efb13cf575`,
  bundle SHA
  `2afdb43f918be2fff93db8426f6e1bf683a846471a792288cff451847e07e7f3`,
  focused suite `12/12 PASS`.
- [x] Решением владельца
  `owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight`
  Product Truth закреплён как единственный product source.
- [x] Удалить обязательные ITEM v6 source/DB mirror/`WalmartReport` inputs из doctor,
  plan и runtime; полный seller-catalog scan не выполнять.
- [x] Закрыть legacy compatibility path: active plan/doctor/certification/runtime
  release v11 принимает только exact-identifier point guard и отклоняет старый
  full-seller-catalog binding.
- [x] Удалить ручной canonical identity input: release v12 впервые использовал
  `EVIDENCE_VERIFIED_BOOTSTRAP`, выводит conservative identity из sealed donor
  brand/title/size и требует fresh exact Walmart proof до canonical write.
- [x] Запечатать seller-scoped point guard: exact staged SKU `404` и exact UPC `SPEC`
  search обязательны до certification.
- [x] Доказать persistent Walmart unit/security `179/179`, operator CLI `7/7`,
  Product Truth `429/429` и frozen fake-live integration `3/3`.
- [x] Выпустить и проверить immutable release v23: engine SHA
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`,
  manifest SHA
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`,
  certificate SHA
  `cc5603d8d56421c151b92b5a6726c1cf10c3dfa52732614763cde6dc6fec9242`.
- [x] После owner Image Truth correction выпустить immutable release v24:
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-26-v24`; engine SHA
  `67804f05b9fc515f71c258f29e4655d4cda5c3c2470f05c582744bf4657c2127`,
  manifest SHA
  `2a973a4fcdb9076820561e1f07d1f0a24a94c2d9985bceed7b12fee329933236`,
  certificate SHA
  `8f7d4bf262adbfad4773e22e0f1d50dd612ff4ea4bf9c5a44aaa2f9255114893`.
  Persistent frozen bytes прошли self-verify, focused Image Truth `93/93`,
  Product Truth certification `445/445`, fake-live `3/3` на том же engine SHA,
  workspace typecheck с errors `0`; реальных Walmart/DB/provider writes `0`.
- [x] Новый и старый one-shot ITEM v6 executors оставить только audit evidence;
  authorization/POST/activation не выполнять.

### ✅ Фаза 6 — owner preview принят, template-aware pricing

- [x] Собрать только provisional shortlist из legacy donor bytes для ускорения
  последующей exact-проверки: RITZ Bits Cheese 8.8 oz, RITZ Bits Peanut Butter
  8.8 oz, OREO Thins Mint 11.78 oz. Это не Product Truth authority и не выбор
  кандидата; shortlist SHA
  `bac54c85864ce09e0382422cc2c140e80e50b5a4871fe83d55824e752d116161`.
- [x] Выбрать один кандидат для бесплатного commercial preflight: RITZ Bits Cheese
  Sandwich Crackers 8.8 oz, homogeneous pack of 2.
- [x] На новой локальной копии exact portable production snapshot применить штатным
  engine текущие 8/8 Product Truth migrations и прогнать frozen v12
  `doctor→plan`: `EVIDENCE_VERIFIED_BOOTSTRAP`, один donor, один direct
  first-party Walmart.com offer, provider calls `0`, production writes `0`.
  Local plan SHA
  `5970067627b633beac37b36c720c333898ebec682db864666cace687bc74803a`;
  старый human preview SHA
  `4aea7beda755b1835fa9c6d0438ca0fedc853213ac9d3f131228c452a39ce96c`.
- [x] Пометить старый v20 commercial reject как исторический: он применял
  superseded policy `20% + 125% ceiling` и не является current business decision.
- [x] Встроить в canonical `doctor` бесплатный commercial discovery
  `walmart-new-sku-commercial-discovery/1.1.0`: он читает только донорский Product
  Truth, не читает seller catalog, не вызывает providers/Walmart, разрешает Walmart
  sourcing, исключает Amazon/клубы и не может передать provisional row в plan.
- [x] Добавить exact-size guard между content donor, procurement offer и Walmart
  comparable. Он выявил и отклонил ошибочно слитый SKIPPY: donor title `80 oz`,
  Publix source `16.3 oz`, Walmart comparable `64 oz`.
- [x] Сделать blocked `doctor` операционно видимым: при `--out` green receipt не
  создаётся, вместо него пишется hash-verifiable
  `walmart-new-sku-doctor-diagnostic/1.0.0` с `next_command: null`; `plan` не может
  принять diagnostic как receipt. Исторические v20 diagnostics:
  pack-of-2 SHA `57b1f71e…9496a`, pack-of-3 SHA `b2f0b1ef…ca5eb`.
- [x] Рассчитать RITZ по owner policy: pack-of-2 `$33.13`, profit `$9.94`; pack-of-3
  `$40.36`, profit `$12.11`; contribution margin обоих вариантов ровно `30%`.
- [x] Сгенерировать два non-publishable owner preview из sealed Product Truth:
  `data/walmart-new-sku-engine/previews/20260723T132637Z-ritz-cheese-pack2-pack3-owner-preview.json`,
  SHA `a84a84d6786a249c4f40760fbc5090f60edc88320ae065aa8b2dadda7559596d`.
- [x] Собрать Walmart-подобную gallery и проверить lint/build/render `2/2`.
- [x] Доказать frozen v23: Product Truth `429/429`, fake-live `3/3`, ровно один fake
  POST и replay без второго POST. Реальные Walmart writes, DB writes, paid calls и UPC
  reservation равны `0`.
- [x] Повторно проверить 2026-07-25 immutable release v23 и mutable/frozen boundary:
  release verify подтвердил engine/manifest, а пять ключевых Walmart engine/preview/
  economics/discovery файлов byte-exact совпали с frozen snapshot. Gallery повторно
  прошла lint, production build и render `2/2`.
- [x] Сверить 2026-07-25 buyer-view с актуальными публичными Walmart PDP exact
  product и pack-4: `https://www.walmart.com/ip/34312392` и
  `https://www.walmart.com/ip/5207432412`. Gallery по умолчанию теперь показывает
  Walmart-подобную покупательскую страницу с store/title/rating/online price,
  Shipping/Pickup/Delivery, seller, save actions, key features, product details и
  specifications; economics/UPC/Product Truth proof скрыты за отдельным owner
  evidence toggle и не смешиваются с buyer-view.
- [x] Собрать из clean gallery commit
  `d772c9a8c19bce5bae06698e50921b87defc894e` текущий Sites deployment archive:
  SHA-256 `9ac1aa7404884ba3ff5a8f27efe9773bd71a4cd923d32de6005b2e28b16d691a`;
  `.env`, `.git` и `node_modules` в archive отсутствуют. Предыдущий
  `ec1e3643…34ed61` / `edae5af7…a484a3` superseded после исправления семантики
  heading: exact product title теперь является единственным buyer-page `h1`.
  Отправка current archive наружу остаётся отдельным понятным owner gate и не
  разрешает Walmart publication.
- [x] Read-only проверить Sites target: существующий project активен, access mode
  `custom`, allowlist содержит только owner account, saved versions `0`, preview/live
  URL отсутствуют. Новый site не создаётся; после owner gate используется этот exact
  project и current clean commit.
- [x] После явного owner approval 2026-07-25 сохранить Sites version `1` из exact
  commit `d772c9a8…fc894e` и успешно развернуть owner-only production URL
  `https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`. Post-deploy
  `get_site` подтвердил current live URL, `custom` access, ровно один owner account
  и отсутствие allowed groups. Автоматический deployment screenshot визуально
  подтвердил buyer-view, обе pack-карточки, изображения, title и prices. Walmart,
  UPC, Product Truth DB и paid providers не вызывались.
- [x] По owner feedback «Pack of 3 выглядит не очень качественно» переработать только
  hero composition: три почти фронтальные упаковки, симметричный ряд, минимальное
  перекрытие и source image `1400×1400 qlt=95` (`HTTP 200 image/jpeg`). Gallery
  lint/build/render `2/2` прошли; owner-only Sites version `2` из clean commit
  `674d6945…2b6191` успешно заменила version `1` по тому же URL. Товар, тексты,
  economics, UPC и Walmart state не менялись.
- [x] После повторного owner review признать version `2` визуально неверной: donor
  hero является opaque JPEG с белым прямоугольным canvas, поэтому любое overlap
  верхнего слоя закрывает нижнюю упаковку белым фоном. Исправить сам compositor:
  Pack of 2/3 используют отдельные grid columns без overlap, rotation, shadow или
  `z-index`. Добавить regression `never overlaps opaque JPEG package canvases`;
  gallery lint/build/render `3/3`. Owner-only Sites version `3` из clean commit
  `79de4979…255fbd` успешно развернута по тому же URL; version `2` superseded.
- [x] Повторно проверить 2026-07-25 все шесть preview image URL: `6/6` вернули
  `HTTP 200 image/jpeg`. Это доказывает работоспособность галереи, но не заменяет
  publication-rights и count-accurate final-image gate.
- [x] Owner review 2026-07-26 вернул version `3` на доработку: отдельные grid
  columns устранили белое перекрытие, но упаковки стали неестественно маленькими и
  слишком далеко друг от друга. Зафиксирован новый золотой закон Image Truth:
  exact physical variant и current package artwork совпадают минимум на `99%`;
  generative redraw/reconstruction упаковки запрещены; multipack показывает ровно
  `N` полных exact-source единиц; права на публикацию остаются независимым gate.
  Walmart MAIN не содержит добавленный `PACK OF N` badge, а product group целится
  в `95%` длинной стороны квадратной рамки без distortion/overlap/clipping.
- [x] Полностью классифицировать все `20/20` изображений exact Target donor:
  current red/orange artwork разрешён; old purple artwork `#2/#18/#19` и
  два не доказанных exact-product promo `#6/#14` исключены. Новый fail-closed
  packaging-artwork manifest требует решения по каждому обнаруженному URL,
  одного `canonical_variant_id` и одной current artwork revision; неизвестный
  либо смешанный artwork не проходит в preview/listing manifest.
- [x] Выпустить gallery version `5`, superseding историческую version `4`:
  compositor удаляет только связанный с краями near-white canvas, сохраняет
  exact donor package pixels и детерминированно составляет ровно `2` либо `3`
  видимые упаковки на белом `2200×2200` canvas. Generative redraw, новый дизайн,
  badge/overlay и opaque-white перекрытие отсутствуют; product group занимает
  почти всю рамку. Engine regression `101/101`, gallery lint/build/render `3/3`.
  Новый preview artifact
  `data/walmart-new-sku-engine/previews/20260726T162500Z-ritz-cheese-pack2-pack3-owner-preview.json`,
  SHA `3e0a406f6f7ae57377884cea149136df6ee551dfc30b1e2ebbfaac2fecd3d030`.
  Owner-only Sites version `5` из clean commit
  `df13727dc21731d1cb5746795abd433649778cf3` успешно развернута по прежнему URL
  `https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`.
  Walmart, UPC, Product Truth DB и paid providers не вызывались.
- [x] Владелец 2026-07-26 явно принял buyer-view целиком для pack-of-2/pack-of-3:
  exact-source изображения, количество упаковок, title, описание, цену и общий вид
  листинга. Это закрывает owner review текущего preview, но не является разрешением
  на UPC reservation, certification либо Walmart publication.
- [x] После принятия первого preview подготовить следующие exact donor candidates
  без seller-catalog scan, Walmart API, paid providers или production writes:
  RITZ Bits Peanut Butter 8.8 oz — Product Truth plan SHA
  `d24f00aacf998e3ddd04a0a9869b92874b6e0edf613e91bc6136d1c488791727`;
  OREO Thins Mint 11.78 oz — plan SHA
  `c71857dbdfe8019c3eb691882ad0791c38262c406be63bc1905acea4f94225e6`.
  Оба plan имеют provider calls `0`, DB writes `0` и привязаны к одному exact
  canonical variant.
- [x] Обобщить Image Truth tooling: contact-sheet builder классифицирует каждый
  exact donor URL; owner preview принимает override MAIN только если URL уже входит
  в donor Product Truth gallery; multipack builder выбирает отдельную
  aspect-aware композицию для широких упаковок без distortion, generative redraw,
  badge и opaque-white overlap. Focused artwork/multipack/preview regression `8/8`,
  workspace TypeScript errors `0`.
- [x] Сгенерировать ещё четыре non-publishable owner preview:
  RITZ Peanut Butter pack-of-2/3 artifact SHA
  `d078790ee31616eb0a3998c8852a876402dde6cdeed20d3b60a40b8a6cda9337`;
  OREO Mint pack-of-2/3 artifact SHA
  `ea3594afb244ef9b54915b30da441428cd808d1aadb59e3a78d1548333e7b7eb`.
  RITZ использует только current red/brown artwork; old purple и mixed-product
  images исключены. OREO legacy MAIN исключён, current donor image подтверждён
  exact current revision. Все четыре MAIN имеют `2200×2200` и показывают ровно
  заявленные `2/3` полные упаковки.
- [x] Развернуть owner-only Sites version `6` из exact gallery commit
  `ffe5924152ceaf777f1ddffc9667aac290923742`, archive SHA
  `c5922a5f1caddc2c270ced4fcfeedb78b0684cf6fbd00ba9d22efdcfdf2189fc`.
  Галерея теперь содержит три exact товара и шесть buyer-view карточек с отдельным
  выбором товара и Pack of 2/3; lint, production build и rendered tests `3/3`.
  URL прежний:
  `https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`; access остаётся
  owner-only. Walmart, UPC, Product Truth DB и paid-provider effects равны `0`.
- [x] Owner review version `6` выявил UX-дефект: данные всех шести preview были
  доступны, но buyer PDP по умолчанию показывал только один листинг, а переключатели
  товара были недостаточно заметны. Version `7` из commit
  `d4e4728e451883ac396cf668b9abbb67a79e91bd`, archive SHA
  `5e3e22a679afec159b03db67194560c1f4a58af9ee59ba597f3e57643a915ceb`,
  открывается явным catalog overview: одновременно видны все `6` карточек,
  `3` товара, Pack of 2/3, MAIN, title, price и owner-review status. Каждая карточка
  имеет отдельный переход в полный Walmart buyer-view и явный возврат
  `All 6 listings`. Gallery lint/build/render `3/3`; owner-only URL не изменился,
  marketplace/UPC/DB/provider effects `0`.
- [x] Владелец подтвердил формулу split: если required total `$33.13`, а exact
  template charge `$11.99`, item price равен `$21.14`; суммарно сохраняется `$33.13`.
  Shipping нельзя добавлять поверх уже all-in рассчитанной цены.
- [x] Исследовать влияние split на Walmart algorithm и покупателей; зафиксировать
  evidence hierarchy, fast/free default, paid-shipping exception и matched-pair
  experiment в [[walmart-new-sku-shipping-price-strategy]].
- [x] Заменить zero-shipping-only economics на template-aware contract:
  exact template ID/rates, scenario charges, referral с landed total, worst-case
  margin, preview breakdown и post-publish association verification. Bundle Factory
  показывает account-scoped active templates, открывает exact детали в modal и
  сохраняет выбранный template snapshot в канонической Walmart request.
- [x] Реализовать official SKU association contract: после одного `MP_ITEM` engine
  отправляет ровно один `SKU_TEMPLATE_MAP` для того же SKU/template/fulfillment
  center; permit подписывает hashes обоих payload, replay не отправляет ни один feed
  повторно. `verify` читает `/items/associations` и не завершает pilot без exact
  template + fulfillment-center match.
- [x] Текущие шесть owner previews перевести на явный free-shipping selection:
  customer shipping `$0`, required total целиком остаётся item price. Новые artifact
  SHA: RITZ Cheese `f650c3d3…6531`, RITZ Peanut Butter `5611ecae…c32`, OREO Mint
  `2bc66a49…0e21`.
- [x] Развернуть owner-only Sites version `8` из exact gallery commit
  `7fcdc6f2937be9ea3b119bb30efb63635df6bbce`, archive SHA
  `ee316d8dabd7673da9e9e94b9d7a0872c658d3c120a23af0aef8ac951562f361`.
  URL прежний; одновременно видны все шесть free-shipping preview.
- [x] Выпустить и сертифицировать production-template-compatible frozen release v26:
  engine SHA `e44553af…a78135`, manifest SHA `e441a1c0…91460`, certificate SHA
  `45526f11…73ca5`. Persistent self-verify PASS; frozen Product Truth `468/468`,
  shipping/permit `18/18`, fake-live `3/3`, Control Center production build PASS.
  Fake flow сделал один `MP_ITEM` + один `SKU_TEMPLATE_MAP`, exact association
  read-back и ноль дополнительных POST при replay. Production read-only store1 probe
  разобрал все `11` active templates, включая легитимно отсутствующий неиспользуемый
  zero variable charge; free templates = `3`. Реальные Walmart writes/DB/provider
  effects равны `0`; v25 и старше не использовать для нового execution.
- [ ] После принятия preview повторить `doctor→plan` против fresh production target;
  максимум один Oxylabs query и один Unwrangle detail требуют отдельного понятного
  owner budget gate.
- [ ] Перед certification доказать отсутствие только exact staged seller SKU и
  выделенного UPC; полный seller-catalog novelty scan не нужен.

### 🔄 Выполнение — Фаза 7: Exact evidence кандидата

- [x] Выполнить fresh production `doctor` из frozen v26 для store1, pack-of-2,
  limit 1. Infrastructure gates прошли: authenticated Walmart exact-UPC GET `200`,
  Product Truth schema ready, lifecycle schema ready, owner trust ready,
  UPC available `13043`, duplicate draft reservations `0`. Единственный blocker:
  `NO_CURRENT_CANONICAL_PILOT_CANDIDATES`; `next_command=null`, поэтому plan/stage
  не запускались. Immutable diagnostic SHA
  `cb0727fd2094d606b1ac9ed22547dd235c0b2de7cc1513484ca64bab208d2dbc`.
- [x] Выбрать только уже принятый owner-preview target RITZ Bits Cheese 8.8 oz:
  donor `75422f18-e3d2-4c62-ae62-7287aaa75119`, direct first-party Walmart item
  `34312392`, exact query
  `RITZ Bits Cheese Sandwich Crackers Lunch Snacks 8.8 oz`. Старый v12 plan
  истёк и запрещён к исполнению.
- [ ] Получить отдельный owner budget gate на fresh targeted Product Truth
  `doctor→plan→execute`: максимум один Oxylabs query (`1` credit) и один Unwrangle
  detail (`2.5` credits), reserve floor `100`, без listing/UPC/marketplace actions.
- [ ] Связать новый viable candidate с одним exact Product Truth variant и direct
  first-party offer.
- [ ] Получить точные content, dimensions/weight, images/rights, category, brand,
  recall, policy, origin, fulfillment, UPC registry и economics evidence.
- [ ] Заблокировать candidate при любом unresolved или sibling evidence.

### ⬜ Фаза 8 — Green doctor и preview

- [ ] Получить `ready_for_plan=true`, `infrastructure_ready_for_pilot=true` и
  `blockers=[]`.
- [ ] Выполнить plan → stage → certify → dry-run → approve → apply-preview.
- [ ] Показать владельцу один понятный финальный preview без технических сокращений.

### ⛔ Фаза 9 — Один live SKU

- [x] Выполнить автоматическую key initialization вне repository и закрепить только
  public key; private key и machine secret недоступны Claude Code.
- [ ] Только после явного решения владельца отправить ровно один feed POST.
- [ ] Не повторять unknown/ambiguous POST.
- [ ] Проверить seller `ACTIVE/PUBLISHED`, buyer PDP и buyability до `LIVE`.

### ⬜ Фаза 10 — Handoff и решение по второму SKU

- [ ] Сохранить полную immutable artifact chain и итоговый отчёт.
- [ ] Передать Claude Code только verified frozen release и exact operator prompt.
- [ ] Отдельно решить: остановиться или повторить весь цикл для второго pilot SKU.
- [ ] После успешного pilot автоматизировать текущую каноническую request handoff
  между уже подключённым Walmart Studio UI и frozen operator run, не возвращая
  legacy mutable `DonorProduct` reads и не расширяя owner gate.

### ⬜ Фаза 11 — Post-pilot release для волн 15–20

- [ ] Только после seller- и buyer-подтверждённого pilot 1–2 SKU разобрать все
  acceptance/rejection/latency/policy результаты и утвердить критерии расширения.
- [ ] Выпустить новый release с bounded wave manifest, rate/budget ledger, duplicate
  fence, per-SKU owner-visible preview и автоматическими stop conditions.
- [ ] Текущий pilot ограничен одним SKU на plan и максимум двумя SKU на release.
- [ ] Волны 15–20 не входят в этот release и будут рассматриваться только после
  успешного отдельного pilot.

### ⬜ Фаза 12 — Расписание и постоянная эксплуатация

- [ ] Только после нескольких успешных ограниченных волн отдельно согласовать cadence,
  дневной/недельный cap, budget/rate limits и account-health stop thresholds.
- [ ] Claude Code исполняет только новый frozen scheduled-run suite и exact
  `next_command`; он не меняет engine, schema, policy или лимиты.
- [ ] Любой policy/spec/account/Product-Truth drift автоматически переводит контур в
  fail-closed pause до нового doctor и owner review.

## Текущий доказанный boundary

- Current persistent Walmart pilot release:
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-26-v26`; engine SHA
  `e44553afaf59ff57b0d02181bcfb8bcbcd3f0914043116a44db1681c57a78135`,
  manifest SHA `e441a1c00a368b3d831004c1f87fceac26d1336a328d1eb19c1d746286991460`,
  certificate SHA `45526f1155a307a981eb837f9afeaaec6510c29944992d187f0f925c0da73ca5`.
- Product Truth `468/468`, focused shipping/permit `18/18`, fake-live `3/3`;
  legacy full-catalog binding rejection, exact shipping association и replay fence
  включены в active regression.
- Legacy prompt Studio не является вторым Walmart creation path; канонический
  Walmart adapter остаётся внутри общего Bundle Factory.
- Product Truth production schema применена и подтверждена: 8/8 migrations,
  schema SHA `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`.
  Полный Phase 1 business backfill остаётся отдельным platform track.
- Post-Product-Truth lifecycle v3 применён schema-only: plan SHA
  `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`,
  activation report SHA
  `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`,
  production schema after
  `c54877cb6cf9cb2e823092a739bc078a11af1e4102a6d1c650ee200e23c3dbeb`.
- RITZ Bits Cheese 8.8 oz имеет два owner preview: pack-of-2 `$33.13` с profit
  `$9.94` и pack-of-3 `$40.36` с profit `$12.11`; contribution margin = `30%`.
  Preview artifact SHA
  `f650c3d361fee269087f0553a645d9592a31d11d14f08e72ec9a896116386531`.
  Count-accurate exact-pixel preview images готовы и защищены от смешения старого
  и нового artwork; template selection — explicit free shipping; publication rights
  остаются отдельным недоказанным gate.
  Provider calls, UPC reservation, certification и Walmart writes не выполнялись.
- Frozen v20 zero-candidate doctor и RITZ reject сохраняются только как аудит старой
  политики. Current v26 production doctor выполнен read-only: infrastructure ready,
  но `NO_CURRENT_CANONICAL_PILOT_CANDIDATES`; diagnostic SHA
  `cb0727fd…d2dbc`. Следующий допустимый шаг — отдельный owner-gated targeted evidence
  для принятого RITZ Cheese donor.
  SKIPPY по-прежнему не является кандидатом из-за cross-size merge
  `16.3 oz / 64 oz / 80 oz`.
- Lifecycle local rehearsal на backup-копии прошла, включая post-apply replay fence и
  три database-authoritative guard probes. Затем та же exact migration была
  применена одной production transaction; товарные данные и marketplace state не
  изменялись.
- Frozen ITEM v6 executors, sessions и empty ledgers сохранены только как safety/audit
  evidence. По текущему owner contract их нельзя исполнять; fresh full source,
  mirror activation и `WalmartReport` не требуются.
- Общий offline owner-control signer реализован; production key автоматически
  создан без пользовательского пароля, реальный doctor вернул
  `OWNER_CONTROL_READY`, public key pinned. Раздельный regression после enrollment:
  `92/92 PASS`; старые frozen releases всё ещё намеренно не принимают permit до
  выпуска замены.
- Full all-status Walmart ITEM catalog source отсутствует и для new-SKU workflow не
  требуется.
- Live Walmart new SKU создано: `0`.

## 🔄 Bundle Factory Product Truth fallback — 2026-07-28

- [x] Зафиксирован boundary: Walmart Studio использует только общий Product Truth;
  один exact donor = один independent targeted-evidence workflow, максимум пять
  owner-visible jobs в одной UI-группе, без multi-target paid run.
- [x] Автоматический участок до owner money gate ограничен no-spend
  `doctor → plan`; публикация, UPC reservation и Walmart mutation отсутствуют.
- [x] Реализовать Web→worker admission и immutable status поверх существующего
  Stage A custody.
- [x] Добавить в Walmart Studio кнопку запуска, прогресс и повторную readiness
  проверку; Generate продолжается только если data gaps и capability gaps закрыты.
- [x] Сертифицировать default-OFF/local no-spend release: Product Truth
  `506/506`, targeted integration/safety `51/51`, UI route `2/2`,
  TypeScript/ESLint/production build = `PASS`; provider, production DB и
  Walmart effects = `0`.
- [ ] Отдельно решить
  production admission/worker/metered activation gates.
