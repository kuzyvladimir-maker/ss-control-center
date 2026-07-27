# Product Truth — единый реестр owner gates

> **Статус:** живой decision ledger, сверено 2026-07-27.
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
| G3. Phase 1 store dispositions | `CONSUMED_SCOPE_2026-07-26` | Census, owner scope receipt и report-bound disposition sealed |
| G4. Walmart ITEM v6 read-only report | `CONSUMED_2026-07-26` | Existing request READY, exact report скачан и скомпилирован; второй create не выполнялся |
| G5a. Scope-only backfill apply | `CONSUMED_SCOPE_ONLY` | `5935/5935` scopes applied and verified |
| G5b. No-paid legacy bridge canary | `CONSUMED_2026-07-26` | Exact five-listing plan applied: `35/35` rows, no paid/provider/marketplace actions |
| G5c. Graph-aware no-paid wave | `CONSUMED_2026-07-27` | `14` listings / `70` rows applied; postcheck `ALREADY_APPLIED` |
| G5d. Standing no-paid waves ≤100 rows | `ACTIVE_2026-07-27` | Collision-free only, fresh `READY_TO_APPLY` required; all money/marketplace gates remain closed |
| G6. Consumer SHADOW activation | `NOT_READY` | Coverage недостаточен: content `19/5935`, Unit Economics `19 UNSOURCEABLE`, Procurement `0 ready` |
| G7. Provider canary / paid wave | `NOT_READY` | Отдельный plan, permit, budget, balance и owner approval |
| G8. Marketplace/purchase actions | `NOT_READY` | Никогда не разрешаются data/readiness gate-ами |

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
