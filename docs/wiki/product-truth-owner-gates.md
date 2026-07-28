# Product Truth — единый реестр owner gates

> **Статус:** живой decision ledger, сверено 2026-07-28.
>
> **Канон:** [[product-catalog-architecture]]. Execution order:
> [[donor-catalog-execution-roadmap]]. Permanent module:
> [[product-truth-command-center]]. Web operations:
> [[product-truth-web-operations-control-plane]].
>
> Ни один пункт этого файла не считается одобренным по факту его наличия. Owner
> approval существует только после явного ответа владельца на точный пункт.

## Зачем этот файл

Все Product Truth решения собраны здесь, чтобы владелец не получал несколько
перекрывающихся промптов от Codex и Claude Code. Каждый gate:

- имеет точную границу;
- перечисляет разрешённые действия;
- перечисляет действия, которые он **не** разрешает;
- может быть одобрен независимо от остальных;
- после использования помечается consumed с evidence.

## Текущий статус

| Gate | Состояние | Что блокирует |
|---|---|---|
| G1. Import permanent candidate | `CONSUMED_2026-07-26` | Закрыт; evidence ниже |
| G2. Web Operations Stage A | `CONSUMED_LOCAL_2026-07-26` | Закрыт; runtime hardcoded `OFF`, evidence ниже |
| G2b. Bundle Factory no-spend web bridge | `AWAITING_EXACT_OWNER_APPROVAL` | Production служебная migration и bounded `doctor → plan` activation |
| G3. Phase 1 store dispositions | `CONSUMED_SCOPE_2026-07-26` | Census, owner scope receipt и report-bound disposition sealed |
| G4. Walmart ITEM v6 read-only report | `CONSUMED_2026-07-26` | Existing request READY, exact report скачан и скомпилирован; второй create не выполнялся |
| G5a. Scope-only backfill apply | `CONSUMED_SCOPE_ONLY` | `5935/5935` scopes applied and verified |
| G5b. No-paid legacy bridge canary | `CONSUMED_2026-07-26` | Exact five-listing plan applied: `35/35` rows, no paid/provider/marketplace actions |
| G5c. Graph-aware no-paid wave | `CONSUMED_2026-07-27` | `14` listings / `70` rows applied; postcheck `ALREADY_APPLIED` |
| G5d. Standing no-paid waves ≤100 rows | `ACTIVE_2026-07-27` | Collision-free only, fresh `READY_TO_APPLY` required; all money/marketplace gates remain closed |
| G6. Consumer SHADOW activation | `NOT_READY` | Coverage недостаточен: content `21/5935`, Unit Economics `21 UNSOURCEABLE`, Procurement `0 ready` |
| G7. Provider canary / paid wave | `CANARY_CONSUMED_GRAPH_FIX_LOCAL` | Listing-bound plan `4e8524d7…a05d` выполнен один раз без retry; outcome `AMBIGUOUS` выявил same-donor multi-listing identity conflict. Contract `1.5.0` исправлен и локально сертифицирован `514/514`; следующего paid gate пока нет |
| G8. Marketplace/purchase actions | `NOT_READY` | Никогда не разрешаются data/readiness gate-ами |

## Рабочий режим без повторных вопросов — owner direction 2026-07-27

Владелец потребовал выполнять задачу под ключ и не спрашивать разрешение на каждый
обычный технический шаг. Без нового owner prompt выполняются все уже находящиеся в
scope безопасные действия: чтение, исследование, код, тесты, build, Wiki-Brain,
локальные/immutable artifacts, read-only marketplace checks, preview, fresh
shipping-template reads и предусмотренные движком internal pilot preparation
steps, которые явно сообщают `marketplace_mutated: false`.

Эта standing direction устраняет повторные вопросы, но не превращается в подпись или
фактическое evidence. Она не разрешает paid provider spend, новую production
migration/backfill вне уже consumed gate, Walmart feed POST, delist, repricing,
purchase, расширение pilot, waves или schedule. Для live Walmart new-SKU apply
по-прежнему нужен exact candidate-bound Ed25519 owner permit по
[[walmart-new-sku-operator-runbook]]. Общая фраза «разрешаю всё» не может заменить
SKU/UPC/payload/account/evidence-bound permit.

## Owner decision 2026-07-26

Владелец подтвердил текущий Phase 1 selling-account scope и разрешил продолжить
G1–G4 в границах этого ledger:

- Amazon store1 `Salutem Solutions` — `IN_SCOPE`;
- Amazon store3 `AMZ Commerce` — `IN_SCOPE`;
- Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC` — `IN_SCOPE`;
- Amazon store2 `Vladimir Personal` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`;
- Amazon store4 `Sirius International` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`;
- Amazon store5 `Retailer Distributor` — `EXCLUDED_OWNER_CONFIRMED_BLOCKED`.

Три исключённых Amazon-аккаунта сейчас заблокированы, по ним не выполняются
listing intake, enrichment или marketplace actions. Это **не удаление** аккаунтов
и не вечное исключение: после разблокировки любой из них возвращается только через
successor census, свежий authoritative report и новый manifest.

Решение разрешает:

- G1 — локальный import exact certified permanent candidate без push/deploy;
- G2 — реализацию Stage A с runtime hardcoded `OFF`;
- G3 — выпуск owner-bound census/disposition artifacts по фактам выше;
- G4 — одну новую zero-retry read-only попытку через sealed workflow.

Оно не разрешает G5–G8, production activation, paid provider waves, delist,
repricing, listing publish/apply или purchase.

## G1 — импорт permanent candidate в shared local `main`

### Consumed evidence 2026-07-26

- imported shared `main` commit:
  `df1e6600ef3a38ba402b5785ac7ed4ef1a3597a2`;
- imported tree:
  `a74a45697a88509478ecf1750995194c9b7c0e6c`;
- required base:
  `af403b1ffbbfa7c039935824c8b9cd8bd59aa99e`;
- two scoped recovery stashes retained; unrelated dirty worktree remained;
- shared Product Truth certification `445/445`, targeted ESLint and Wiki-Brain
  `0/0` passed;
- no push, deploy, DB/provider/paid/marketplace action occurred.

Global shared-worktree TypeScript remains independently red on two active,
uncommitted Walmart new-SKU files. The exact imported commit passed TypeScript and
production build from a no-hardlink clean checkout; this external dirty-worktree
warning does not weaken or expand G1.

### Разрешает

- импортировать exact verified candidate из recovery bundle/isolated branch;
- сохранить только scoped Product Truth code/docs/UI changes;
- разрешить конфликты без перезаписи unrelated owner worktree;
- повторить certification/build в shared tree.

### Не разрешает

- `git push`, PR/merge в remote;
- deploy;
- production env activation;
- DB migration/backfill;
- provider/API/marketplace calls;
- paid spend.

### Exact owner phrase

```text
Разрешаю G1: импортировать exact Product Truth permanent candidate в локальный
shared main, сохранив все unrelated изменения worktree. Push, deploy, production
activation, DB writes, provider calls и marketplace actions не разрешаю.
```

## G2 — Web Operations Stage A, runtime hardcoded OFF

Полный design: [[product-truth-web-operations-control-plane]].

### Consumed evidence 2026-07-26

- code commit:
  `fc98be84cdb6c909e0d5a6db45f8b6570e01bcde`;
- tree:
  `37a706c362201e46c6401756fc0b0347995f9199`;
- Product Truth certification `451/451`, TypeScript, targeted ESLint, Prisma
  validate, production build и `git diff --check` — `PASS`;
- отдельная SSCC migration family создана, но к production DB не применялась;
- runtime остаётся hardcoded `OFF`; routes, worker claim, production trust-root,
  provider calls/spend и marketplace actions отсутствуют.

### Разрешает

- отдельную SSCC migration family для command/artifact/event tables;
- canonical parsers/state machine;
- отдельный Product Truth Ed25519 domain/verifier;
- append-only DB triggers;
- adversarial/local tests;
- runtime hardcoded `OFF`.

### Не разрешает

- production migration apply;
- создание/enrollment production owner key;
- worker claim или запуск CLI;
- DB business-data writes;
- provider calls/spend;
- marketplace/purchase actions.

### Exact owner phrase

```text
Разрешаю G2: Product Truth Web Operations Stage A по
product-truth-web-operations-control-plane.md — отдельная SSCC
schema/contracts/tests, отдельный Product Truth Ed25519 domain, runtime hardcoded
OFF. Не разрешаю production activation, worker claim, DB apply, provider calls,
paid spend или marketplace actions.
```

## G2b — Bundle Factory bounded no-spend web bridge

### Уже доказано

- clean release commit `8178f5194c149e473dddcb2ddfa9a2e15282a91f`,
  tree `f4cc943349e69ba721d989315abf1900506d7d08`, executable SHA-256
  `aa0c3feca72b31733793ea3e48f0ae6558a2e633e4cb4449a61cc9a45679b279`;
- migration SHA-256
  `16ddaf8baa8c00c7a54d7eea5e9680bbba947dc28afe899931f6a345e4db0e0b`;
- Product Truth `508/508`, Bundle Factory UI/route `2/2`, TypeScript, focused
  ESLint и production build = `PASS`;
- Vercel deployment `dpl_4twNT8rNHA4pX7Ww5tYyKKSZpCni` = `Ready`, но runtime
  `OFF`;
- read-only production preflight: все три control tables отсутствуют,
  activation env отсутствует;
- provider calls, Product Truth business writes и Walmart actions = `0`.

### Точная граница

Gate разрешает только служебные control-plane tables в основной SSCC DB и
последовательную активацию `ADMISSION_ONLY → LOCAL_NO_SPEND →
PRODUCTION_READ_ONLY` для `doctor` и `plan`. Он не разрешает `execute`, `resume`,
provider call, paid spend, canonical/business-data write либо Walmart action.
Каждый переход обязан пройти отдельный технический postcheck; ошибка
останавливает sequence.

### Exact owner phrase

```text
Разрешаю G2b для release 8178f519: применить только служебную Stage A migration
к основной SSCC production DB и последовательно проверить ADMISSION_ONLY,
local no-spend worker и PRODUCTION_READ_ONLY только для doctor и plan.
Разрешаю отдельный worker token и чистый pinned worker. Не разрешаю execute,
resume, provider calls, paid spend, Product Truth business writes или любые
Walmart/marketplace actions.
```

## G3 — authoritative Phase 1 store dispositions

### Уже доказано

- Amazon store1 `Salutem Solutions`: connected US, свежий полный report,
  1 563 rows → рекомендовано `IN_SCOPE`.
- Amazon store3 `AMZ Commerce`: connected US, свежий полный report,
  514 rows → рекомендовано `IN_SCOPE`.
- Amazon store5 `Retailer Distributor`: credentials есть, US participation
  отсутствует, report пуст, last observed technical state `DEACTIVATED`;
  владелец 2026-07-26 подтвердил текущий business state `BLOCKED` и исключение
  из текущего Phase 1 snapshot.
- Amazon store2 `Vladimir Personal`: Sellers API 403, seller ID отсутствует,
  last order 2026-05-18.
- Amazon store4 `Sirius International`: credentials/seller ID отсутствуют,
  last order 2026-05-11.
- Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC`: connected/active →
  `IN_SCOPE`, но authoritative ITEM v6 report отсутствует.

Код не мог решить бизнес-факт для store2/store4/store5. Владелец закрыл этот
вопрос решением 2026-07-26: все три сейчас blocked и исключаются из текущего
manifest denominator.

### Принятое disposition

```text
Amazon store2 Vladimir Personal, store4 Sirius International и store5 Retailer
Distributor сейчас заблокированы и исключены из текущего Phase 1 snapshot.
Amazon store1 Salutem Solutions, store3 AMZ Commerce и Walmart store1 SIRIUS
TRADING INTERNATIONAL LLC остаются в Phase 1.
```

### Consumed evidence 2026-07-26

- contract fix commit
  `4465e14adc14de83c9b56c95ee5e6e3e8db9143c`: owner-attested
  `UNRESOLVED` остаётся required scope и может быть закрыт только явным
  `EXCLUDED_OWNER_CONFIRMED`; Product Truth `452/452`, TypeScript и targeted
  ESLint прошли;
- immutable evidence commit
  `e129060e470c20a3f38f5c7793ed373290323b32`;
- authoritative census: 6 required scopes, 4 technically connected,
  2 unresolved, 0 blockers; content SHA-256
  `ca0380c47f6b936fb761f5eb58c437433b6f7f9a6d34e82da6a4f13baecdeda3`;
- capture SHA-256
  `31bfa842f07c8c3ef7f128e62756a3e0933276f2eb97ae3d54a292b263b5452d`;
- owner scope receipt SHA-256
  `17e86147c36cc4467b764b96008fe816bbdda8e68d5c6406c5ea2211dd64f23e`;
- evidence root:
  `ss-control-center/data/audits/product-truth-phase1-scope/20260726T142613Z-g3-v1`.

Owner scope decision завершён. Exact `phase1-scope-disposition/v3` не выпускается
до G4, потому что `IN_SCOPE` Walmart обязан быть связан с фактическими ITEM v6
bytes/report ID/count/hash. Pending receipt машинно помечен
`mustNotBePassedToProductTruthManifestCli=true`.

### Historical proposed wording — superseded

```text
Подтверждаю G3: Amazon store2 Vladimir Personal и store4 Sirius International
сейчас не являются подключёнными selling accounts; Amazon store5 Retailer
Distributor исключить как deactivated без US participation. Amazon store1
Salutem Solutions, store3 AMZ Commerce и Walmart store1 SIRIUS TRADING
INTERNATIONAL LLC оставить в Phase 1.
```

### Если заблокированный магазин будет восстановлен

Владелец называет exact store. Для него создаются successor census/disposition,
восстанавливаются credentials/identity, снимается свежий полный Amazon report и
выпускается successor manifest. Старый manifest задним числом не изменяется.

G3 разрешает только owner-bound census/disposition artifacts. Он не разрешает
network call, manifest, backfill, provider spend или marketplace write.

## G4 — одна попытка получить Walmart ITEM v6

Новый bounded GET-only probe показал, что list endpoint вернул только ITEM v2.
Для authoritative Phase 1 нужен fresh ITEM v6 report.

### Разрешает

- не более одного OAuth token call;
- не более одного Walmart report-create POST;
- report download/poll только в рамках engine-generated exact authorization;
- `retries=0`;
- сохранение exact response/report bytes и SHA.

### Не разрешает

- listing/price/inventory/delist write;
- второй report-create;
- provider call/spend;
- backfill;
- publish.

### Standing read-only owner direction 2026-07-26

Обычный сбор отчётов, чтение каталогов и сохранение evidence для уже утверждённых
магазинов выполняются автоматически и не требуют пооперационной confirmation-фразы.
Технические scope/rate/idempotency limits остаются обязательными. Отдельное
подтверждение по-прежнему требуется перед paid mass runs, изменением/удалением
листингов, ценами, inventory writes, закупками и другими денежными действиями.
Quarantined session и старые permit/authorization bytes повторно использовать
запрещено.

### Consumed implementation evidence 2026-07-26

- one-token successor commit:
  `c8cb50fe4a56480f90b207531453206f83ab1826`;
- один shared OAuth transport выполняет точный absence guard GET и допускает create
  POST только при exact `0 rows` без cursor; любой иной результат запрещает POST;
- clean checkout: TypeScript, targeted ESLint, `git diff --check` и `227/227` —
  `PASS`;
- frozen bundle SHA-256:
  `09e108c1fb59c6868ab6dacc42d02fa7f943254d55b0f31ff73ce8f015b2ffca`;
- engine manifest SHA-256:
  `5ce2ec8807784529fc0afc0edf2af86cc9165ca27a4f8f6caa478db598fea94f`;
- standing read-only contract commit
  `fbe4dd38a583aba3fa92cb104338ae42faa4a594`, clean checkout `227/227`;
- единственный conditional create принят Walmart с HTTP `200`; request ID
  `019f9f34-9bad-7390-b236-341290db319a`, SHA-256
  `e92d7021f5c8fb4f5e7ec877469c028f1ba4161d89cb861b6dd32a40e23b6d47`;
- guard подтвердил exact absence; report-create calls `1`, listing/price/inventory/
  delist writes `0`, database/model/paid-provider calls `0`;
- первые 20 poll вернули `RECEIVED`; poll 21 и отдельный continuation poll 22
  получили Walmart `429 REQUEST_THRESHOLD_VIOLATED`. Повторный create запрещён;
  continuation продолжает только чтение существующего request;
- final conservative cadence commit `59f25201`: poll `180s × 9`, focused `43/43`;
- request достиг `READY` continuation-only GET-ами; raw ZIP SHA-256
  `fa858d5ca65616627acb4578097861c6abcd42fad8332d2f0378ff59baa9c56d`;
- production ITEM v6 parser commit `cfb41078`: фактические spaced headers,
  self-describing UPC/GTIN и legacy Item ID/WPID разделены; clean Walmart report
  suite `229/229`;
- complete Walmart catalog: `5236` rows, из них `3891 PUBLISHED`,
  `734 SYSTEM_PROBLEM`, `611 UNPUBLISHED`, malformed/duplicate/conflict = `0`;
- decoded CSV SHA-256
  `07de74f3302ae80970d8f31be9d9ff716d91d379ddddfdbffe5706b44acfefb1`;
  sanitized catalog source SHA-256
  `70684781742ce31b0a3559eb469ee1030874dcbfd70a6ee4656e7c273144f9b2`;
- fresh GET-only Amazon reports получены без report-create: store1 `1571` rows,
  SHA `b3839047…d5e14`; store3 `502` rows, SHA `51e331ed…5842`;
- Phase 1 manifest policy commit `9090580e` (`phase1-scope-builder-policy/1.3.0`)
  прошёл clean Product Truth `453/453`;
- authoritative manifest v3: `5935` live listings, `6` required scopes,
  `3` exact reports, `0` blockers; canonical JSON SHA-256
  `94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`.

## Что происходит после закрытия G3 + G4

1. Canonical census/disposition и authoritative Phase 1 manifest v3 уже готовы.
2. Read-only `backfill-plan` выполнен: plan `162b2dbd…53cf78`, denominator/scope
   imports/review tasks = `5935/5935/5935`, canonical cost recomputes,
   provider calls и DB writes = `0`.
3. Preview доказал обе migration ledgers ready, exact 8/8 protected migrations,
   exact `ProductTruthListingScope`, writer activity/FK violations = `0`.
4. Владелец отдельно разрешил записать ровно `5935` позиций каналов продаж в
   `ProductTruthListingScope` и запретил иные production-действия.
5. Scope-only apply завершён `APPLIED`: inserted/exact scopes = `5935/5935`;
   missing/conflicting/unexpected/writers/FK = `0`; canonical cost recomputes,
   legacy promotions, provider/paid calls и marketplace/procurement mutations =
   `0`.
6. Отдельный no-paid bridge canary plan `ba899ce9…fae3d` применён по отдельному
   owner gate: `35/35` canonical rows для `5` listings, donor transitions `5`,
   partial/FK violations `0`; postcheck = `ALREADY_APPLIED`.
7. Post-canary readiness reconciled `5935/5935`: Bundle Factory и Listing
   Improvement `5 ready`, Unit Economics `5 UNSOURCEABLE`, Procurement `0 ready`;
   остальные `5930` scopes ещё не materialized.
8. Consumed G5a/G5b approvals не разрешают graph-aware wave, consumer activation,
   paid enrichment или marketplace actions. Следующий DB writer требует нового
   immutable plan и нового exact owner gate.

### G5c consumed evidence 2026-07-27

- fresh source snapshot SHA-256:
  `0f0b0d48841661c6caad3fcd0da1ded0da6dc5a0cf243876822dfb6a4b2bc4ed`;
- fresh bridge plan SHA-256:
  `1f5f90a71944520fcc6a65460555f54405d8886a35099e9d3746d451aadc5b5c`;
- graph-aware apply plan SHA-256:
  `367ffc2fead16f897235387a17cad8583d184fc23f605fedaf4218b687d60354`;
- preflight report SHA-256:
  `07706ccf11252db1e03705b58fe9a963a9644bd6affe1b78e671c5f18562d72c`;
- exact scope: `14` listings, `7` unique donor-content graphs, maximum `70`
  canonical rows, donor transitions `7`;
- preflight: `READY_TO_APPLY`, absent `70`, exact-existing `0`, FK violations
  `0`;
- `FaisalX-3816` не входит в план и остаётся quarantined;
- provider/paid/retailer/marketplace/procurement calls/actions и consumer cutover
  равны `0`;
- plan expires `2026-07-29T12:16:37Z`.

Owner approval artifact SHA-256 =
`3a7c6f36283716e1211186f69b7e9efbc8af10a5324b80b208a28fca9f7a1033`.
Fresh pre-send preflight SHA-256 =
`73b7456dd53101c9eef37eac76c44372dd7754da6128a0ca324f8bb8b801bc37`
повторно дал `READY_TO_APPLY`. Apply завершён `APPLIED`: inserted `70/70`,
donor transitions `7`, FK violations `0`; report SHA-256 =
`38ddef906750b789827a372eee9c57fe9fedbfbfc929bc95169004e363eb9284`.
Independent postcheck SHA-256 =
`43bb220736bae30de924948632291a8d359f0b381dacda335ca73ed09f600262`
подтвердил `ALREADY_APPLIED`, exact-existing `70`, absent `0`.

Full readiness report SHA-256 =
`014770f0a8c4045e9a8ec0770caae86709c533683590c4c1fa10ecd2d33ec644`:
`5935/5935` reconciled, Bundle Factory/Listing Improvement `19 ready`, Unit
Economics `19 UNSOURCEABLE` / `5916 missing`, Procurement `0 ready`; provider
calls/DB writes `0`, cutover `0/4`.

Этот consumed gate разрешал только exact plan выше одной transaction. Он не
разрешает paid enrichment, retailer fetch, consumer activation, исправление
`FaisalX-3816`, публикацию/изменение листингов, цены, inventory или закупку.

### G5c exact owner phrase

```text
APPROVE_PRODUCT_TRUTH_LEGACY_BRIDGE_WAVE:ptlb-wave-cb890414ab73b579d117599a:367ffc2fead16f897235387a17cad8583d184fc23f605fedaf4218b687d60354:14_LISTINGS:70_MAX_ROWS:NO_PAID_CALLS:NO_MARKETPLACE_MUTATIONS
```

### G5d standing no-paid policy

Владелец 2026-07-27 установил постоянное правило:

- Codex автономно выполняет local work и read-only production;
- collision-free Product Truth canonical materialization wave может применяться
  автономно, если exact row ceiling не превышает `100` и fresh preflight имеет
  status `READY_TO_APPLY`;
- paid/provider calls, marketplace/listing writes, price/inventory changes,
  delisting, consumer activation и procurement всегда требуют отдельного owner
  gate.

Canonical policy artifact:
`ss-control-center/data/audits/product-truth-legacy-bridge/standing-policy-20260727-v1.json`;
SHA-256 =
`0ede5d62c3c28c70b5c9d1f97fc711d652ef3a1d91a4d0da50623a460ffe2696`.
Он pinned к current production target fingerprint и authoritative manifest
`94359db1…9062c`; смена target/manifest, identity collision, stale/non-ready
preflight или row ceiling `>100` fail closed. Policy не разрешает self-expansion
своих границ.

### G5d implementation evidence 2026-07-27

- wave apply report contract `2.1.0` принимает либо exact one-time approval, либо
  canonical standing policy + fresh immutable preflight;
- standing verifier проверяет exact keys, canonical bytes/SHA, target/manifest,
  ceiling `≤100`, freshness `≤15 min`, `READY_TO_APPLY`, collision-free scope и
  все no-paid/no-marketplace safety assertions до открытия write transaction;
- targeted tests `21/21`, TypeScript, targeted ESLint и полный Product Truth
  certification `477/477` прошли;
- fresh canonical-aware read-only production snapshot SHA-256
  `95f247db29524122cebe60495731c265743da1db87bc9167f8aede4428f30e3c`;
- bridge plan SHA-256
  `a97497cadf652891c06ae100e919ca01d6049831cc751b08a0568a69c0f06cd7`;
- artifact index SHA-256
  `46c7412c89c34a7247137e392246d793322f9c4267ef3e07d5024749ead12008`;
- exact result: `19 ALREADY_CANONICAL`, `0` новых content-complete no-paid
  candidates, `82` identity-only, `5834` quarantined; `FaisalX-3816` fail-closed
  на exact donor→different-variant conflict;
- production writes в этом audit = `0`; provider/paid/retailer/marketplace/
  procurement actions = `0`. Standing policy не потреблялась новым DB write,
  потому что допустимого следующего content-complete scope нет.

### G5d consumed no-paid Target-content wave 2026-07-27

- exact live-image/base-unit barcode evidence:
  `5e6cc6681f64f00ade0b654c0b989c59e5866227e254e8f422cd15226389a254`;
- exact Target raw HTML:
  `2636f1aac6b378c2d0a2d96d2b94d1a84653e9cf3c04077c95ec2c637a4a844b`;
- exact scope: `walmart:1:FaisalX-1148`, Target item `17189284`, one listing,
  maximum `7` canonical rows;
- apply plan SHA-256:
  `972848eece53befd761b6210f627d1d6bf6d2a03b595b9ef0ce6dc837ed5706b`;
- preflight = `READY_TO_APPLY`, absent `7`, exact-existing `0`, FK violations
  `0`; standing policy SHA `0ede5d62…2696`;
- apply inserted `7/7`, donor transition `1`, Bundle Factory/Listing Improvement
  ready `1/1`, Unit Economics `UNSOURCEABLE`, Procurement `0`;
- independent postcheck SHA-256
  `300236beadee234766e1fad676016b96d0d557a28cca4bb0c4416ab9857243d9`
  = `ALREADY_APPLIED`;
- historical apply report SHA-256
  `8bc6a11037dc40c116b1574975a70108c20a79cce3037ad68b156ed4b999ccf4`
  содержит operator timestamp anomaly (`completedAt < startedAt`). Data graph
  независимо подтверждён postcheck и fresh read-only audit; append-only rows не
  переписывались. Successor engine fail-closed отклоняет future/inverted
  timestamps до write transaction.
- successor certification: targeted `25/25`, full Product Truth `481/481`,
  TypeScript и ESLint = `PASS`;
- full readiness report SHA-256
  `5c56c4250272b6a138d209e91d79f8f6a91ac09676d31fb3ebf6d0064b18e92b`:
  `5935/5935`, content-ready `20`, Unit Economics `20 UNSOURCEABLE` /
  `5915 missing`, Procurement `0`; provider calls/DB writes `0`.

Consumed standing authority разрешила только no-paid/read-only evidence и
collision-free canonical wave выше. Она не разрешает paid/provider calls,
marketplace writes, price/inventory changes, delisting, activation или
procurement.

### G5d consumed generic direct-Target wave 2026-07-27

- generic direct-Target contract:
  `product-truth-direct-target-content-evidence/1.0.0`; exact donor, offer, GTIN,
  Target item/URL, raw HTML SHA, canonical artifact SHA, freshness и нулевые
  paid/provider/model/database/marketplace counters проверяются fail closed;
- выполнены ровно два first-party GET без retry:
  - Arnold Target `12973001` — evidence
    `1fd29173fb1c6523b2dd0c885860a768e7cc27770e66352069d99218306c7988`,
    raw HTML
    `d7bebfde3a428eac694b29cd1392f889ae3540dfe783166405792c4d62066f69`;
  - Iberia Target `80838482` — explicit allergen warning отсутствует, поэтому
    evidence artifact не создан и никакой allergen truth не выдуман;
- fresh read-only bridge source
  `7b50ae07618f87328d3e50b4f38e2667cfdaf2774e8c934b43eff60f4469e601`,
  plan
  `9a0d5980e7e01f593337bd8d8294fe749ec09379e58d8101f3ac27aaa59ee7ed`
  допустили только `walmart:1:FaisalX-1228`;
- apply plan
  `91181832553738c70a0bb945844a8962a35f778572425b4fcf95193f2120a069`:
  `1` listing, maximum `7` rows, paid/provider/marketplace/procurement `0`;
  preflight
  `16527f8a093558ff9d034eba0e3e807fb0aa7ffbff68110726b68179d368cf35`
  = `READY_TO_APPLY`;
- standing-policy apply report
  `869eebaa4c0e22d195286a4d9749d905bf0a45a2b56a1a58af06894768ab9ca5`
  = `APPLIED`, `7/7`, donor transition `1`; independent postcheck
  `5705560d74826d2a09f045dd89d80f64e16d3ff4c82763c5929cc27f25407cc5`
  = `ALREADY_APPLIED`;
- successor read-only audit source
  `487e168197df258431b1997d898e00e06c24627115b559c4bbdb41392bb76204`,
  plan
  `b29071792a11ddc832d18e139463b6d8b095dc266e81afe54b07c125761dfded`:
  `21 ALREADY_CANONICAL`, `0` новых no-paid content-only candidates,
  `81` identity-only, `5833` quarantine;
- full readiness report
  `cac3725728c0a3d78792d68425492ba40ae1c232993a05aac37c5a8f57944192`:
  denominator `5935/5935`, Bundle Factory/Listing Improvement `21 ready`,
  Unit Economics `21 UNSOURCEABLE` / `5914 missing`, Procurement `0`;
  provider calls и DB writes `0`;
- первый readiness attempt получил transient metadata-read false negative по
  существующему trigger `ProductContentObservation_hash_contract_insert`.
  Независимый `sqlite_master` read и полный schema gate подтвердили trigger,
  повторный immutable readiness v5 завершился успешно. Schema не изменялась;
- certification: Product Truth `487/487`, TypeScript и ESLint = `PASS`.

Эта consumed wave не открывает G7, consumer activation, marketplace/listing
writes, prices/inventory, delisting или procurement.

### G7 exact canary proposal 2026-07-27

Локальный proposal (не plan, не permit и не approval):
`ss-control-center/data/audits/product-truth-g7-proposal/20260727T133500Z-canary-v1/proposal.json`;
SHA-256 =
`df3da1596619216a1b94908123381bfb618bf450284640356cb018837e065b88`.

Предложенный canary содержит пять explicit unique listings и пять
collision-free donor/variant graphs:

1. `walmart:1:RizwanX-3237` — Glory Mustard Greens, missing `ALLERGENS`,
   текущий priority = `2` orders / `2` units;
2. `walmart:1:FaisalX-1315` — Fritos Flamin' Hot, missing `STORAGE`;
3. `walmart:1:RizwanX-3481` — Popeye Leaf Spinach, missing
   `ALLERGENS + NUTRITION`;
4. `walmart:1:RizwanX-3499` — GOYA Pinto Beans, missing `ALLERGENS`,
   donor может покрыть `4` listings;
5. `walmart:1:FaisalX-2195` — Mott's Apple Juice, missing
   `ALLERGENS + STORAGE`.

Каждый graph имеет exact numeric first-party direct Walmart offer с current
`sourceApi=oxylabs`; clubs и BJ's исключены, concurrency `1`, attempt ceiling
`1`. Консервативный worst-case proposal: до `5` Oxylabs query calls/units и до
`5` Unwrangle detail calls / `12.5` units, суммарно максимум `17.5` provider
units. Это ceiling proposal, а не разрешение потратить.

Для owner review выбраны recommended values: `UNWRANGLE_RESERVE_FLOOR=15000`
и exact maximum `17.5` provider units. Это не owner approval. Они
материализованы только как offline unapproved request, после чего canonical
existing planner выпустил exact plan; proposal и plan generation создали
`0` provider calls, `0` database/marketplace writes и не изменили consumers:

- plan:
  `ss-control-center/data/audits/product-truth-g7-plan/20260727T133907Z-canary-v1/plan.json`;
- plan SHA-256:
  `ae810cb1a3badcc0e562b6d229912bc3c961a296f68062405b7548710b55360e`;
- target-set SHA-256:
  `f72840147c5fd436f8c4741af902abafebad36ddc920e2d292dc3f5f0f58c2ab`;
- run ID: `pt-g7-canary-20260727T133907Z`;
- expires: `2026-07-28T12:39:07.000Z`;
- ceilings: Oxylabs query `5 calls / 5 units`, Unwrangle detail
  `5 calls / 12.5 units`, Unwrangle reserve floor `15000`;
- plan generation: offline, DB connections `0`, provider calls `0`;
- automatic publish/delist/reprice/purchase = `false`.

G7 теперь ожидает только exact owner money/provider approval для этих bytes,
fresh balance evidence, plan-bound metered permit и execution confirmation.
Если plan истечёт, approval не переносится: нужен новый fresh plan SHA.

### G7 exact owner approval and balance-evidence blocker 2026-07-27

Владелец выдал exact approval для plan
`ae810cb1a3badcc0e562b6d229912bc3c961a296f68062405b7548710b55360e`:
пять listings, Oxylabs `5 calls / 5 units`, Unwrangle detail
`5 calls / 12.5 units`, reserve floor `15000`; clubs/BJ's, marketplace writes,
price/inventory changes, delisting, consumer activation и procurement запрещены.

Fresh remote `doctor` после approval подтвердил operational schema и target
fingerprint `57ff2af9…0003`; provider calls `0`. Execution не начался и
provider units не потрачены. Перед сборкой canonical approval artifact контракт
потребовал Unwrangle balance evidence не старше десяти минут. Бесплатного
Unwrangle balance endpoint нет, production cache `svc_unwrangle_credits` пуст,
а последний независимый receipt `2026-07-27T13:16:48.681Z` уже stale.

Первоначальный exact approval разрешает только пять рабочих Unwrangle detail
calls и максимум `17.5` run units; он не разрешает дополнительный
`target_search` balance probe. Поэтому execution остаётся fail-closed, старый
timestamp не переиздаётся и незаявленный шестой provider call не выполняется.
Минимальный следующий money gate — один отдельный Unwrangle `target_search`
balance probe максимум `1` unit, только для immutable balance evidence; после
него основной plan сохраняет собственные неизменные ceilings.

### G7 expired approval and byte-new replacement 2026-07-28

Когда владелец выдал отдельный balance-probe gate для old plan
`ae810cb1…5360e`, его expiry `2026-07-28T12:39:07Z` уже прошёл. Pre-network
проверка остановила workflow: old main approval и probe gate не были
использованы, provider calls/units и production writes остались `0`.

Canonical offline planner бесплатно выпустил replacement:

- plan:
  `ss-control-center/data/audits/product-truth-g7-plan/20260728T175740Z-canary-v2/plan.json`;
- plan SHA-256:
  `bca2decb19297a5aac96d39965c3988303f19cdffbb5d23a0e3b821be846413c`;
- request SHA-256:
  `3ee96292c8fbfabb36a45bf8f06c10c531240784536dc4387cb3e9ec08a3dc83`;
- approval instructions SHA-256:
  `5b7954b5ce09fc22479a45ee124764682eb30fb94cf231b77332a823ebf32e5b`;
- run ID: `pt-g7-canary-20260728T175740Z`;
- expires: `2026-07-29T17:27:40.000Z`;
- target set неизменен: `f7284014…c2ab`, те же exact пять listings;
- ceilings неизменны: Oxylabs `5/5`, Unwrangle detail `5/12.5`, reserve
  floor `15000`; clubs/BJ's и все marketplace/business actions запрещены;
- plan generation: offline, DB connections `0`, provider calls `0`.

Approval bytes старого plan не переносятся. Следующий owner token должен одним
exact решением связать replacement plan, отдельный one-call/one-unit balance
probe и основной run ceiling `17.5` (`18.5` combined maximum).

### G7 live Target Search tariff drift and fail-closed stop 2026-07-28

Владелец выдал combined approval для replacement plan
`bca2decb19297a5aac96d39965c3988303f19cdffbb5d23a0e3b821be846413c`,
пяти listings, основного ceiling `17.5` и отдельного Target Search balance
probe максимум `1` unit (`18.5` combined). Pre-network plan/expiry checks
прошли.

Единственный probe без retry вернул HTTP `200`, balance `99692.5`, но live
receipt показал фактическое списание `2.5` units. Immutable evidence:

- artifact:
  `ss-control-center/data/audits/product-truth-g7-balance-probe/ptbal-20260728t180000z/balance-evidence.json`;
- SHA-256:
  `9c38565005d6f5c347b863ffb3fe99743352d0ee5dcfbba196ba424685041a6f`;
- raw response SHA-256:
  `f8272c5acb326852d7462744cef147fffd769927e7c68547a24ed49ab3b84bbf`;
- provider calls `1`, actual units `2.5`, retry `0`;
- canonical/marketplace/price/inventory/delist/consumer/procurement writes `0`.

Поскольку `2.5 + 17.5 = 20.0` превышает exact approved combined ceiling
`18.5`, основной run не запускался. Локальный Target Search reservation
исправлен с `1` на live-observed `2.5` и закреплён regression test; полная
Product Truth certification = `489/489`.

Plan `bca2decb…6413c` остаётся byte-exact и действует до
`2026-07-29T17:27:40Z`. Если existing evidence старше десяти минут на момент
execution, контракт требует ещё один fresh probe. Поэтому следующий единый
owner gate должен одновременно:

1. признать уже фактически consumed `2.5` units;
2. разрешить не более одного нового evidence-only Target Search probe /
   `2.5` units только если evidence stale, без retry;
3. сохранить основной plan ceiling `17.5`;
4. установить cumulative maximum `22.5` units;
5. сохранить запреты clubs/BJ's, marketplace writes, price/inventory,
   delisting, consumer activation и procurement.

### Walmart Listing Integrity v14 canary authority 2026-07-27

Владелец дал точную standing-команду:
`В продолжании останавливайся. Я все подтверждаю и разрешаю полностью продолжить. Без дополнительных моих разрешений.`

Она потребляется только как owner confirmation для одного exact
`walmart:1:FaisalX-1148` canary через frozen release v14
`e9bc8e4f…dbc00e`, после SHA-bound review и отдельного Ed25519 one-SKU permit.
Разрешённый diff: только `description`, `bullets`, `MAIN`; title, attributes,
gallery, price, inventory, identifiers, status и delisting неизменны. Один
`MP_MAINTENANCE` POST maximum, retry/replay запрещены; после принятия разрешены
только GET того же feed и fresh Qualification. Эта команда не разрешает второй
SKU, controlled wave, mass/automatic apply, repricing, inventory, delisting,
purchase, paid provider spend или consumer activation.

Authority consumed for the exact canary: execution package
`47db1f096ce31042eba42a4176bbed189f481e33fe80e600682b8a114e22401f`,
payload `a9ca3439072385ce2409c4329babc662480300fc5a133e67006badccb452b50e`,
feed `18C62987D97D584A8C474291F416F0F8@AX8BBgA`; one POST, zero retry.
Повторный POST по этому permit запрещён. Пока feed nonterminal, authority
ограничена exact same-feed GET и последующей fresh Qualification.

### Walmart Listing Integrity attribute-only canary authority 2026-07-27

После завершения предыдущего gate владелец отдельно дал новую standing-команду:
`В продолжании останавливайся. Я все подтверждаю и разрешаю полностью продолжить.
Без дополнительных моих разрешений.`

В этой execution chain она была ограничена одним exact
`walmart:1:FaisalX-2768` attributes-only repair. Exact reviewed payload SHA
`5171d7171a9117342185d754da1556851501c7ac4042fe916adbb5a49b521a84`
разрешал только `flavor`, `count`, `countPerPack`, `multipackQuantity`. Title,
description, bullets, MAIN, gallery, price, inventory, identifiers, status,
delisting и другие SKU не входили в payload. Первый permit завершился definite
`HTTP 520` без `feedId` и не replay. Новый plan/permit после byte-identical fresh
read выполнил один POST; feed
`18C632A8D8735E4599AF541E02A79070@AX8BBwA` terminal `SUCCEEDED`.

Оставшаяся authority по этому SKU — только fresh no-write Qualification до
buyer `PASS`/доказанного `FAIL` и формирование фактической галереи. Эта standing
команда не превращается в automatic/mass apply, не разрешает price, inventory,
delisting, purchase, paid provider spend или параллельный write. Следующий SKU
до Qualification `PASS` заблокирован.

## Удобный комбинированный ответ

Если владелец принимает все текущие рекомендации, он может ответить одним
сообщением, не копируя длинные тексты:

```text
Разрешаю G1 и G2 в точных границах product-truth-owner-gates.md.
Подтверждаю рекомендуемые dispositions G3: store2/store4 не подключены,
store5 deactivated без US participation; store1/store3 Amazon и store1 Walmart
оставить в Phase 1.
Разрешаю G4: один zero-retry Walmart ITEM v6 read-only report request.
Никаких иных production, paid, provider, marketplace, repricing, delist или
purchase действий не разрешаю.
```

Можно одобрить только отдельные номера, например: `Разрешаю только G1`.

---

## G7 owner authority consumed — 2026-07-28

Владелец явно разрешил довести ограниченный Product Truth G7 workflow под ключ без
микро-подтверждений. Это решение было использовано только для exact five-listing
canary, fresh balance evidence и single-donor targeted runs. Итоговый immutable
closeout:

- файл:
  `ss-control-center/data/audits/product-truth-g7-closeout/20260728T194500Z/g7-closeout.json`;
- SHA-256:
  `c73aff010a5db3139f7674acefc52426dd9ca741e656e4866dcd00a16d771a4c`;
- расход: `32.5` provider units / `19` calls;
- marketplace/listing writes, price/inventory changes, delisting, consumer
  activation, procurement, clubs и BJ's: `0`.

Этот exact G7 gate считается **consumed**. Он не разрешает replay terminal/ambiguous
runs и не разрешает следующую paid wave на старом bootstrap contract. Локальная
реализация, тестирование и рецертификация `LISTING_BOUND_TARGETED_BOOTSTRAP`
продолжаются без нового owner gate; новый provider canary должен быть связан с новым
frozen plan/release и отдельным свежим budget evidence.

### Listing-bound v1.4 implementation status

Локальная реализация завершена и сертифицирована `512/512`. Первый read-only
production preflight до provider boundary выявил multi-word brand defect:
token-sorted canonical brand нельзя использовать как title phrase. Исправление
сохраняет raw byte-bound listing brand только для matcher proof, не меняя canonical
ID; regression входит в suite. Этот цикл потребил `0` provider units и не изменил
production DB/marketplace. Старый unbound bootstrap больше не может выпустить новый
plan. Следующий provider gate может потребляться только одним exact listing-bound
plan, одним SKU, без retry, после fresh balance evidence; он не распространяется на
controlled wave, consumer activation, repricing, inventory, delisting или
procurement.

### G7 listing-bound single-SKU canary gate 2026-07-28

Superseding frozen implementation:

- Git commit:
  `a5debaf7540e94f19bd0cac3f95548e94c862dd0`;
- Git tree:
  `a47aa03d5674fa32d313d58d0701d3245ab2793c`;
- clean-checkout TypeScript = `PASS`, Product Truth = `512/512`, worktree clean;
- read-only production `doctor` и `plan` выполнили `0` provider calls и `0`
  database writes.

Sealed exact canary:

- listing: `walmart:1:FaisalX-1177`, component `0`;
- donor: `c8b542f1-ed9b-45c5-883c-dcf9e00944ea`;
- Walmart item: `10452831`;
- target: `Pepperidge Farm Jewish Rye Seeded Bread 16 oz`;
- request SHA-256:
  `29c3e7eda6f0f9a1794d6359f4c98ae7a8507680a19d325cae19df63a3b911c5`;
- plan SHA-256:
  `4e8524d7332c562980aa7199e3f98cd797bdf731cdd4c04522867a734603a05d`;
- approval instructions SHA-256:
  `185568fefc51293f46e9838a7e1a78b2d0b4aab738452afedd5ed0d6cd628e9f`;
- run ID: `pt-listing-bound-canary-20260728t220718z`;
- expiry: `2026-07-29T20:00:00.000Z`;
- work ceiling: Oxylabs query `1 call / 1 unit`, Unwrangle detail
  `1 call / 2.5 units`;
- fresh balance evidence requires a separate Unwrangle Target Search probe
  `1 call / 2.5 units`;
- cumulative ceiling: `6` units, no retry, reserve floor `15000`.

Immutable request/plan custody:
`ss-control-center/data/audits/product-truth-listing-bound-canary/20260728T220718Z/`.

Required exact owner decision:

`APPROVE_PRODUCT_TRUTH_LISTING_BOUND_CANARY_V1:a5debaf7540e94f19bd0cac3f95548e94c862dd0:4e8524d7332c562980aa7199e3f98cd797bdf731cdd4c04522867a734603a05d:pt-listing-bound-canary-20260728t220718z:1_LISTING:OXYLABS_1_QUERY_CALL_1_UNIT:UNWRANGLE_BALANCE_PROBE_1_TARGET_SEARCH_CALL_2.5_UNITS:UNWRANGLE_1_DETAIL_CALL_2.5_UNITS:COMBINED_6_MAX_PROVIDER_UNITS:15000_UNWRANGLE_RESERVE_FLOOR:NO_RETRY:NO_CLUBS:NO_BJS:NO_MARKETPLACE_MUTATIONS:NO_PRICE_OR_INVENTORY_CHANGES:NO_DELISTING:NO_CONSUMER_ACTIVATION:NO_PROCUREMENT`

Владелец ответил на этот exact gate требованием продолжать без искусственных
остановок. Gate consumed только в перечисленных границах:

- balance probe: HTTP `200`, `2.5` units, balance `99670`, evidence SHA-256
  `c90105afc0bc0db29c028784ef3b34739f25525fa7468bc34002f1a73f784f12`;
- working run: Oxylabs `1` call / `1` unit, Unwrangle `1` call / `2.5` units,
  retry `0`;
- result: `AMBIGUOUS /
  UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`;
- exact price observation и variant decision сохранены, content observation
  отсутствует; provider response не был выдан за полный content truth;
- report SHA-256:
  `8d2a420c0c683edf81d1d7b7b630a31ec8990ef999ac574d76018183d629cd71`;
- artifact-index SHA-256:
  `28bf4110d6ed9e096fcb15457497a9e0c1944fde2e89d8c04120677d8a604357`;
- marketplace/listing/price/inventory/delist/consumer/procurement actions:
  `0`.

Fresh read-only full-denominator postcheck, source SHA
`1798a7b0…fbe49`, plan SHA `77c7cc9a…ffd5c`, сохранил aggregate counts:
`20` already canonical, `71` identity-only, `5844` quarantine. Он доказал
следующий дефект: тот же donor привязан также к `walmart:1:FaisalX-1176`, но
старые listing identities выводят разные variant IDs (`loaf/Seeded` против
`bag/Seeded Rye`). Run terminal и никогда не replay.

### Same-donor graph guard v1.5 — local status

Request/plan подняты до `1.5.0`, listing binding до `1.1.0`. Новый bootstrap
byte-exact seals все текущие authoritative Walmart listing scope/shipping/
component rows, ссылающиеся на donor. Если их independently derived variant IDs
не совпадают, `doctor` останавливается с
`TARGETED_EVIDENCE_LISTING_DONOR_GRAPH_VARIANT_CONFLICT` до provider boundary.
TypeScript = `PASS`; unit `15/15`; integration `12/12`; полный Product Truth
suite `514/514`. Это исправление выполнило `0` дополнительных provider calls и
`0` production writes. Следующие шаги: clean frozen release и выбор нового
untouched collision-free donor graph только через read-only `doctor`.
