# Product Truth Web Operations Control Plane

> **Статус:** `NO_SPEND_BRIDGE_PRODUCTION_ACTIVE / METERED_OFF /
> MARKETPLACE_OFF`.
>
> **Дата:** 2026-07-25.
>
> **Верхний канон:** [[product-catalog-architecture]]. Daily operator contract:
> [[product-truth-operator-runbook]]. Implementation board:
> [[product-truth-command-center]].
>
> Этот документ хранит design/decision packet и consumed production evidence.
> Активирован только bounded `doctor → plan`; он **не** выдаёт metered authority,
> не запускает provider, не расходует credits и не изменяет marketplace.

## 1. Решение в одном абзаце

Product Truth не нужен второй enrichment engine и не нужен второй operational
ledger. Канонический движок уже владеет:

- sealed `doctor → plan → execute/resume → status → report`;
- `ProductTruthOperationalRun → RunItem → Event`;
- leases, one-attempt boundary, terminal `ambiguous`;
- provider budgets, reservations, receipts и settlements;
- exact manifest/target/release/approval bindings.

Для постоянного модуля SS Command Center не хватает только узкого web-to-worker
control bridge:

```text
authenticated Catalog UI
  → typed command request
  → content-addressed immutable artifacts
  → external Ed25519 owner signature when authority/spend/write is required
  → durable command admission
  → one separately authenticated worker
  → exact allowlisted Product Truth CLI argv (shell=false)
  → existing Product Truth operational ledger
  → immutable result artifacts
  → read-only Catalog status
```

Web plane не исполняет произвольный код, не принимает произвольный `argv`, не
хранит owner private key и не становится владельцем Product Truth data model.

## 2. Что уже доказано и что отсутствует

### Уже существует

1. Product Truth exact-eight schema и read-contract.
2. Durable operational run store:
   `ProductTruthOperationalRun`, `ProductTruthOperationalRunItem`,
   `ProductTruthOperationalEvent`.
3. `ambiguous=no replay`, one-running-environment lock, item attempt boundary,
   event hash chain и immutable terminal results.
4. Distributed metered budget ledger и provider receipts.
5. Sealed CLI commands и operator runbook.
6. Read-only Catalog API/UI, который показывает run/items/queue/budgets/receipts.
7. Проверенный Ed25519 design pattern в Walmart new-SKU и Listing Integrity.
8. Проверенный lease/heartbeat/evidence pattern в ChannelMAX.

### Отсутствует

1. Отдельный Product Truth owner trust root.
2. Внешняя owner-signing ceremony для Product Truth command envelope.
3. Durable очередь **вызовов CLI**. Это не то же самое, что существующая
   `EnrichmentJob`/`ProductTruthOperationalRunItem` очередь работы движка.
4. Immutable custody входных/выходных CLI artifacts вне ephemeral filesystem
   Vercel.
5. Отдельно аутентифицированный long-running worker.
6. Release-bound admission API и его default-OFF activation.

## 3. Почему нельзя использовать существующие обходные варианты

| Вариант | Почему запрещён |
|---|---|
| Выполнить CLI внутри POST-запроса Next.js/Vercel | request timeout, ephemeral filesystem, потеря lease/результата |
| Передать в API строку shell-команды | command injection и обход canonical parser |
| Считать обычный UI click owner approval | session/RBAC не подписывает exact plan/budget bytes |
| Скопировать Walmart owner key | разные authority domains; Walmart permit не разрешает Product Truth spend/write |
| Использовать ChannelMAX job как Product Truth job | другой payload, другой worker и другой trust contract |
| Писать output только на локальный диск worker | результат теряется при смене машины и не доступен canonical UI |
| Автоматически retry неизвестный результат | нарушает `ambiguous=no replay` и может удвоить spend/write |
| Добавить девятую Product Truth migration | ломает frozen exact-eight release boundary |

ChannelMAX разрешено использовать только как образец CAS lease, heartbeat,
append-only events и terminal ambiguity. Walmart owner control разрешено
использовать только как образец Ed25519 verification/domain separation. Таблицы,
ключи, permits и authority между системами не переиспользуются.

## 4. Trust model

### 4.1 Два независимых principals

- **Owner signer** разрешает exact authority: migration/backfill apply,
  provider budget или execute/resume конкретного plan.
- **Worker identity** разрешает только claim/heartbeat/result-upload уже
  допущенной команды.

Компрометация worker token не даёт права создать owner approval. Компрометация
обычной web session не даёт права подписать command envelope. Owner private key
никогда не попадает в repository, Vercel, Product Truth DB или worker env.

### 4.2 Отдельный Product Truth trust root

Рекомендуемый v1:

- algorithm: `Ed25519`;
- новый key family: `product-truth-owner-control`;
- отдельный production `keyId`;
- public SPKI DER bytes + SHA-256 fingerprint pinned в server и worker release
  config;
- private key под внешней owner custody, лучше hardware-backed либо macOS
  Keychain на owner-only машине;
- 64-byte detached signature;
- domain separator:
  `SSCC_PRODUCT_TRUTH_COMMAND_AUTHORITY_V1\0`;
- key никогда не используется для Walmart new-SKU, Listing Integrity,
  ChannelMAX или других модулей.

Одного SHA/confirmation token недостаточно: signature проверяется над точными
canonical message bytes.

### 4.3 Owner signature требуется не для каждого read

| Класс | Примеры | Gate |
|---|---|---|
| `READ_ONLY` | doctor, readiness, status, report | authenticated Catalog RBAC + worker identity |
| `ARTIFACT_PLAN` | census capture, manifest compile, migrations plan, backfill-plan, plan | authenticated Catalog RBAC; output только immutable, execution authority отсутствует |
| `DB_WRITE` | migrations apply, backfill-apply | external owner signature exact plan/target/release |
| `METERED_EXECUTE` | execute, допустимый resume | external owner signature + exact permit + budget ceilings + fresh balance evidence |
| `FORBIDDEN` | implicit all, BJ's, arbitrary script, marketplace publish/delist/reprice/purchase | никогда не admitted этим control plane |

`resume` допускается только для exact interrupted run, когда Product Truth engine
сам доказывает безопасную boundary. `ambiguous` terminal и не превращается в
новую command автоматически.

## 5. Где хранить control-plane state

### 5.1 Не менять exact-eight Product Truth schema

Product Truth operational tables остаются в канонической Product Truth DB.
Web-command envelope и custody относятся к SS Command Center, поэтому живут в
основной SSCC DB в отдельной migration family.

### 5.2 Рекомендуемые SSCC tables

#### `ProductTruthControlCommand`

Одна строка = один exact CLI invocation intent.

- `commandId` — immutable UUID/CUID;
- `schemaVersion`;
- `commandKind` — enum из закрытого allowlist;
- `gateClass` — `READ_ONLY | ARTIFACT_PLAN | DB_WRITE | METERED_EXECUTE`;
- `status` — state machine из §6;
- `idempotencyKey` — unique hash exact request;
- `requestedByUserId`, `requestedAt`;
- exact `engineReleaseId`, `engineCommitSha`, `engineTreeSha`,
  `executableTreeSha`;
- exact `environment`, `databaseTargetFingerprint`, `manifestSha256`;
- nullable exact `runId`, `planSha256`, `approvalId`;
- artifact IDs для request/plan/approval/permit/balance/result/index;
- `ownerKeyId`, `ownerSignatureSha256`, `ownerAuthorizedAt`,
  `ownerAuthorizationExpiresAt`;
- worker lease owner/token hash/expiry/heartbeat;
- `attempts`, где mutation-capable command имеет абсолютный max `1`;
- `executionStartedAt`, `executionBoundary`;
- terminal `exitCode`, `outcome`, `errorCode`;
- created/updated timestamps.

Нельзя хранить raw shell command. Exact argv строится только из `commandKind` и
типизированных artifact references после повторной верификации.

#### `ProductTruthControlArtifact`

- `artifactId`;
- `commandId`;
- `role` — закрытый enum;
- `mediaType`;
- `content` — exact bytes;
- `byteSize`;
- `sha256`;
- `createdAt`;
- `createdByPrincipal`;
- unique `(commandId, role, sha256)`;
- unique content-addressed locator;
- DB triggers запрещают `UPDATE`, `DELETE`, `REPLACE`.

Для v1 рекомендуется хранить bounded JSON/text/binary artifacts прямо как
append-only bytes в DB. Это уже используемый в проекте pattern
`ChannelMaxAgentEvidence` и не зависит от публичного R2 bucket. Artifact больше
настроенного hard limit блокируется, а не выносится молча в public storage.

Private R2 можно добавить позже только отдельным gate: private bucket, no public
URL, content-addressed new-key-only PUT, server-side GET, повторное hash
verification и DB-pinned object version/ETag. Текущий public image bucket не
является допустимой custody.

#### `ProductTruthControlEvent`

- immutable sequence per command;
- type/source/timestamp;
- canonical payload bytes + SHA;
- previous event hash + event hash;
- DB triggers запрещают mutation/delete и enforce chain advance.

События: requested, artifacts_validated, awaiting_owner, owner_verified,
admitted, claimed, heartbeat, execution_boundary, artifact_received,
succeeded, failed, ambiguous, cancelled_before_execution.

## 6. State machine

```text
DRAFT
  → VALIDATING
  → BLOCKED
  → AWAITING_OWNER          (DB_WRITE / METERED_EXECUTE)
  → ADMITTED
  → CLAIMED
  → RUNNING
  → SUCCEEDED
  → FAILED
  → AMBIGUOUS
```

Допустимые дополнительные terminal transitions:

- `DRAFT|VALIDATING|AWAITING_OWNER|ADMITTED → CANCELLED`;
- `CLAIMED → ADMITTED` только если lease истёк **до** execution boundary и
  durable evidence доказывает zero attempt;
- `CLAIMED|RUNNING → AMBIGUOUS`, если boundary неизвестна;
- `RUNNING → ADMITTED` запрещено;
- `AMBIGUOUS → ADMITTED|RUNNING` запрещено;
- любой terminal state immutable.

`attempts` увеличивается атомарно в той же транзакции, где фиксируется
`execution_boundary`. Сетевой/provider/DB mutation после этой точки никогда не
повторяется автоматически.

## 7. Canonical command envelope

```json
{
  "schemaVersion": "product-truth-control-command/1.0.0",
  "commandId": "<immutable id>",
  "commandKind": "<allowlisted enum>",
  "gateClass": "<class>",
  "engine": {
    "releaseId": "<exact>",
    "commitSha": "<64/40-char release binding>",
    "treeSha": "<exact>",
    "executableTreeSha256": "<exact>"
  },
  "target": {
    "environment": "<exact>",
    "databaseTargetFingerprint": "<sha256>",
    "manifestSha256": "<sha256>"
  },
  "artifacts": [
    {
      "role": "<allowlisted role>",
      "sha256": "<sha256>",
      "byteSize": 123
    }
  ],
  "authority": {
    "ownerKeyId": "<null for read-only>",
    "issuedAt": "<canonical UTC>",
    "expiresAt": "<bounded canonical UTC>",
    "nonce": "<single use>"
  },
  "claims": {
    "noImplicitScope": true,
    "noMarketplaceMutation": true,
    "ambiguousNeverReplay": true
  }
}
```

Canonical JSON имеет exact keys, order, UTF-8/LF и no-extra-key validation.
Owner подписывает:

```text
domain_separator || canonical_command_bytes
```

Подпись command admission не заменяет внутренние Product Truth approval/permit
artifacts. Она связывает и аутентифицирует их exact SHA как один web command.

## 8. Admission API

Будущие routes, пока технически отсутствуют:

- `POST /api/catalog/product-truth/commands` — создать typed request;
- `POST /api/catalog/product-truth/commands/:id/artifacts` — exact bounded bytes;
- `POST /api/catalog/product-truth/commands/:id/authorization` — detached owner
  signature/envelope;
- `POST /api/catalog/product-truth/commands/:id/cancel` — только до execution;
- `GET /api/catalog/product-truth/commands/:id` — status/events/artifact index;
- worker-only `claim`, `heartbeat`, `boundary`, `artifact`, `complete`.

Каждый POST требует Catalog RBAC, CSRF/origin protection и idempotency key.
Worker routes требуют отдельный machine identity; user session не принимается.

Default behavior:

- env отсутствует/partial → routes fail closed до DB read/write;
- mode `OFF` → mutation routes не зарегистрированы либо отвечают deterministic
  unavailable;
- mode `ADMISSION_ONLY` → можно подготовить artifacts, но worker claim запрещён;
- mode `ACTIVE` → только после schema, trust root, worker release и owner
  activation artifact.

Ни один mode не разрешает marketplace publish/delist/reprice/purchase.

## 9. Worker contract

Worker — отдельный долгоживущий процесс, не Vercel request и не LLM.

Перед claim:

1. проверяет собственный frozen release/commit/tree/executable manifest;
2. предъявляет отдельную machine identity;
3. объявляет точный allowlist command kinds;
4. получает не более одной команды и short lease.

Перед execution:

1. повторно hash-проверяет все artifacts;
2. повторно проверяет Product Truth owner signature, expiry и nonce;
3. проверяет target fingerprint/manifest/release;
4. проверяет внутренние plan/approval/permit/budget bindings;
5. строит argv из typed fields;
6. вызывает Node/npm через `spawn(executable, argv, {shell:false})`;
7. пишет durable execution boundary до первого разрешённого effect;
8. не передаёт secrets в stdout, event metadata или UI.

После execution:

1. один раз забирает новые output files;
2. проверяет expected names, no symlink, size и hash;
3. загружает exact bytes в immutable custody;
4. фиксирует exit code и Product Truth run status;
5. `exit 0` не считается success без terminal report/artifact index;
6. неизвестный outcome становится `AMBIGUOUS`;
7. удаление временных файлов допустимо только после durable custody receipt.

Recommended host для v1 — отдельный always-on worker на контролируемой машине
(например iMac через `launchd`) с pinned clean checkout. Он не использует Claude
Code для программирования или принятия решений: Claude Code остаётся допустимым
ручным оператором CLI до активации worker, а затем worker исполняет тот же frozen
контракт.

## 10. Activation sequence

### Stage A — schema/contracts, no worker (`IMPLEMENTED_CERTIFIED_RUNTIME_OFF`)

- SSCC migration для command/artifact/event tables;
- canonical parsers, Ed25519 verifier, state machine;
- trigger/adversarial tests;
- runtime hardcoded `OFF`;
- production effects: zero.

Владелец одобрил этот ограниченный Stage A 2026-07-26; реализация завершена в
commit `fc98be84cdb6c909e0d5a6db45f8b6570e01bcde` (tree
`37a706c362201e46c6401756fc0b0347995f9199`). Product Truth `451/451`, TypeScript,
targeted ESLint, Prisma validate, production build и diff-check прошли. Runtime
hardcoded `OFF`: production migration apply, trust-root enrollment, worker claim,
provider calls/spend и marketplace actions не выполнялись. Stage B требует нового
owner gate.

### Stage B — `ADMISSION_ONLY`

- owner enrolls отдельный Product Truth public trust root;
- UI генерирует signing request и принимает detached signature;
- admitted artifacts видимы, claim endpoint всё ещё закрыт;
- доказываются replay/tamper/expiry/key-domain failures.

### Stage C — local no-spend worker

- worker release pinning;
- только `doctor`, `status`, `report`, offline plan/readiness;
- local/fake target;
- crash/lease/ambiguous/artifact custody tests;
- никаких provider credentials.

### Stage D — production read-only worker

- exact production target;
- только read/artifact-plan commands;
- отдельный owner activation;
- результаты сравниваются с ручным sealed CLI.

### Активированный production no-spend bridge — 2026-07-28

Bundle Factory Walmart demand fallback реализован только для bounded
`doctor → plan` участка:

- release:
  `product-truth-web-control-2026-07-28-r6`;
- release commit:
  `61501b563dc1dbe8eee0463d9a8271d5a7db04d1`;
- Git tree:
  `47a992982ace124611bfab4b40b1cdac0b86dbb8`;
- executable tree SHA-256:
  `a4e54535024f4e85a3b6176a775a13ea8c728582cd5253bd1cd8ec3b90dc2b96`;
- Stage A migration SHA-256:
  `16ddaf8baa8c00c7a54d7eea5e9680bbba947dc28afe899931f6a345e4db0e0b`;
- authoritative Phase 1 manifest v3 SHA-256:
  `94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`;
- production Product Truth target fingerprint:
  `57ff2af9adb3e963dbaf944c047130132dcd9cbb2e35ed789d6100b0f7e30003`.

Clean-checkout evidence: Product Truth `512/512`, Bundle Factory UI `3/3`,
TypeScript, focused ESLint и production build = `PASS`. Worker до
первого HTTP request доказывает clean checkout, exact commit/tree и производный
SHA-256 executable tree; activation confirmation связывает stage, release,
commit, tree, executable digest, target и manifest.

Production deployment `dpl_6CJbXNB7zpBJ754aoXdGBSPS6Lh8` имеет статус
`Ready` и назначен на `salutemsolutions.info`. Runtime активен только как
`PRODUCTION_READ_ONLY`; отдельный launchd worker читает только allowlisted
`DOCTOR` и `RUN_PLAN`. Production postcheck доказал:

- Stage A control custody применён к exact production target;
- worker pinned к r5 и после полного batch остаётся active;
- pre/post claim HTTP `200`, `claim:null`;
- Campbell's batch `ptbfw-cdc58a911597fd5e37e6afac`:
  `5/5 DOCTOR SUCCEEDED`, `5/5 RUN_PLAN SUCCEEDED`,
  status `AWAITING_OWNER`;
- финальный r6 postcheck `ptbfw-cf8ea0764938f9754fdbe4fb`:
  `1/1 DOCTOR SUCCEEDED`, `1/1 RUN_PLAN SUCCEEDED`, final claim `null`;
- provider calls, Product Truth business writes и Walmart actions = `0`.

Эта активация не реализует и не разрешает `execute`, `resume`, provider calls,
paid spend, Product Truth business writes или marketplace actions. Для реального
сбора данных после `plan` остаётся отдельный Stage F money/permit gate.

### One-click exact Walmart enrichment — BF-W3

BF-W3 реализует Stage F не как общий standing permit, а как отдельный exact
owner decision для каждого показанного quote:

1. сервер восстанавливает только successful immutable DOCTOR/RUN_PLAN artifacts;
2. quote перечисляет каждый exact target, missing fields и потолок
   `2.5 + 3.5 × jobs` prepaid credits;
3. браузер по клику передаёт exact quote/envelope локальному
   `127.0.0.1:47321` owner agent;
4. agent принимает только exact HTTPS origin, release/commit/tree/executable,
   target/manifest, quote SHA и все plan SHA; private key остаётся encrypted
   outside repository и открывается Login Keychain;
5. server проверяет detached Ed25519 signature против pinned public trust root
   и только затем переводит `AWAITING_OWNER → ADMITTED`;
6. pinned worker выполняет один balance probe и максимум один
   Oxylabs-query + один Unwrangle-detail на target, concurrency `1`;
7. Если current read-contract уже выбирает полный exact-variant content,
   detail call пропускается, а исходное balance evidence остаётся действующим
   для следующего sequential job в пределах freshness window. Если detail
   реально вызван, response обязан дать fresh next-balance evidence.
   Missing/stale evidence останавливает следующие jobs без дополнительного
   probe/spend;
8. `resume` и automatic replay в этом batch отсутствуют. Возможный unknown
   paid outcome становится terminal `AMBIGUOUS`;
9. результат не разрешает Walmart publication. После success Bundle Factory
   только повторяет canonical readiness и возвращается к обычному Generate.

Каждый worker heartbeat может нести sealed progress schema: batch, item `X/N`,
current run/title, exact stage, completed/stopped counters, provider calls/units
и observation timestamp. Server связывает progress с exact `EXECUTE` command и
сохраняет его в append-only event chain. Owner status читает последний sealed
event, показывает heartbeat freshness и не создаёт command/retry при refresh.

Owner authority не находится на Vercel и не подменяется паролем, hash-only
подтверждением либо общим сообщением «разрешаю всё». Реальным money gate является
только click по показанному exact quote и его detached Ed25519 signature.

Production activation 2026-07-28:

- release `product-truth-web-control-2026-07-28-r7`, commit
  `2e12419221665926aaa44881f2ec5692a2a7cf42`, tree
  `91cc801e7b3e8c15b64d3af5fb2b898362d6af8f`, executable SHA-256
  `28360067b9891a61c5c0ea8f7c836e939e0e29cdc53b7041aa7ec6820399d8f7`;
- deployment `dpl_7Qv2gde7DXRmg977gEz8FiC9n7PD` = `Ready`,
  `salutemsolutions.info` назначен production alias;
- отдельный owner key enrolled вне repository через encrypted PKCS8 и Login
  Keychain; owner public-key SHA-256
  `6d410aeb1f4fa947b9f85d9ff5f0adaa77270967e4635019271b8a5d940417b5`;
- runtime `PRODUCTION_OWNER_GATED_METERED`, loopback owner-agent и clean pinned
  launchd worker active;
- no-spend Campbell's batch `ptbfw-f464598c22650c76c631c239` завершил
  `5/5 DOCTOR` и `5/5 RUN_PLAN`, status `AWAITING_OWNER`; exact quote
  `ptq-6f91025cbbd87e2654e4d2c86dab3619` имеет ceiling `20` prepaid provider
  credits;
- smoke claims: provider calls не начаты, metered execution не admitted,
  Product Truth business writes и Walmart mutations `0`.

Production recovery 2026-08-01:

- owner Retry на Campbell's fail-closed до создания command с
  `WEB_CONTROL_CONFIG_INVALID`: поздняя `PRODUCTION_READ_ONLY` activation
  сохранила прежние три owner trust-root variables, а общий runtime запрещал
  даже полностью валидный public key вне общего metered stage;
- release `product-truth-web-control-2026-08-01-r8`, commit
  `4a9e761aabd3f8cf10973d02197068345b7cae54`, tree
  `143b1f045d8e1cd4c8acbc03700c46903a263d65`, executable SHA-256
  `992c55c0a825c4537ebc5b3b171fd8c1156f41277222a8d08559a503f9823d46`
  разделяет две authority: shared base остаётся `PRODUCTION_READ_ONLY`, а
  Walmart paid lane включается только отдельным exact
  `PRODUCT_TRUTH_WALMART_ENRICHMENT_CONFIRMATION`, привязанным к тем же
  release/target/manifest и owner public-key SHA;
- read-only runtime может хранить полный проверенный public trust root, но его
  `metered_execution=false`; только Walmart overlay возвращает
  `metered_execution=true`. Partial key, wrong confirmation или любой drift
  по-прежнему fail-closed;
- deployment `dpl_7Sf145ugwQhYLErkiizRamBpDC1T` = `READY`, aliases включают
  `salutemsolutions.info`; pinned launchd worker и loopback owner-agent
  переведены на exact r8 checkout и работают;
- certification: Product Truth `521/521`, focused Walmart collection `8/8`,
  TypeScript, ESLint и production build = `PASS`; production env loader доказал
  base active/read-only, Walmart overlay active/metered и worker overlay
  active/metered; owner loopback OPTIONS = `204`, worker после запуска не
  создал новых error log bytes;
- authenticated browser в текущем runtime отсутствовал, поэтому реальный owner
  click не заявлен как выполненный. Provider calls, Product Truth business
  writes и Walmart mutations в recovery-проверке не запускались.

Production reliability recovery 2026-08-01 (r11):

- r8/r9 evidence подтвердил три независимых дефекта control-plane: volatile
  timestamp входил в command identity и допускал duplicate admission; status
  смешивал rows разных releases; стандартный remote transaction/API heartbeat
  был короче честного production doctor/plan;
- r11 привязал idempotency к logical batch/job, ввёл exact-release read boundary
  и bounded remote transaction/heartbeat window. При потере heartbeat worker
  выполняет terminal complete path и не оставляет вечный `RUNNING`; retry/replay
  автоматически не запускается;
- production ledger уже содержал девять canonical append-only migrations, их
  bytes совпали с release; schema apply и business-data backfill не выполнялись;
- exact release `product-truth-web-control-2026-08-01-r11`, commit
  `97ffabce993256c8eb8012abb5154a09419ba94d`, tree
  `35ffa5b8ef127615867e119e32046dcaacec54e9`, executable SHA-256
  `d8f04ef7ee226e3de55ab49cce5082efce55e7f671c040d9043ca043e71e3223`;
  deployment `dpl_EFbFw1ddDCAFLLWVoP9yaVSkMWaG` = `READY` и назначен на
  `salutemsolutions.info`;
- clean production batch `ptbfw-14e44dd192718b33ff8b0bb2`: `5/5 DOCTOR` и
  `5/5 RUN_PLAN` succeeded, `AWAITING_OWNER`, exact quote
  `ptq-b32ff65d283f474ba4ffaf7ccbd2a352`, ceiling `20` prepaid provider credits,
  five actions. `EXECUTE=0`, provider spend, Product Truth business writes и
  Walmart mutations `0`;
- certification: Product Truth `524/524`, focused Walmart collection `11/11`,
  TypeScript, focused ESLint и production build `PASS`.

Это no-spend reliability evidence внутри уже consumed G2b. Оно не заменяет и не
создаёт approval на exact quote или provider spend.

Во время production-калибровки releases r1–r4 fail-closed выявили canonical
temp-path, operational JSON для doctor/plan и concurrent heartbeat completion.
r5 сериализует in-flight heartbeat до completion; текущая regression suite
закреплена в `519/519`. Незавершённые calibration commands остаются immutable audit evidence
и не replay.

### Exact owner gate для bounded no-spend activation

Один комбинированный gate ниже разрешает не несколько денежных действий, а
только последовательную проверяемую активацию служебного no-spend пути. При
любой ошибке переход останавливается; Stage F не открывается.

```text
Разрешаю G2b для release 8178f519: применить только служебную Stage A migration
к основной SSCC production DB и последовательно проверить ADMISSION_ONLY,
local no-spend worker и PRODUCTION_READ_ONLY только для doctor и plan.
Разрешаю отдельный worker token и чистый pinned worker. Не разрешаю execute,
resume, provider calls, paid spend, Product Truth business writes или любые
Walmart/marketplace actions.
```

Gate consumed 2026-07-28. Exact r5 evidence и остающиеся закрытыми boundaries
зафиксированы выше и в [[product-truth-owner-gates]].

### Stage E — owner-gated DB writes

- только отдельный signed migration/backfill command;
- fresh backup, preview, approval и target fingerprint;
- no provider spend.

### Stage F — owner-gated metered canary

- отдельный exact canary plan;
- new owner signature;
- provider permit, balance evidence, ceilings/reserve floor;
- один target, один attempt;
- canary не разрешает wave.

Каждый stage имеет отдельный activation artifact. Переход не автоматический.

## 11. Acceptance gates

Фаза 4 не может стать `✅`, пока тестами не доказано всё:

1. partial/OFF config делает zero DB/network/process calls;
2. произвольный command/argv/env/path/URL отклоняется;
3. wrong key/domain/signature/bytes/hash/expiry/nonce/release/target/manifest
   отклоняются до claim;
4. DB update/delete/replace immutable artifacts/events запрещены;
5. duplicate request идемпотентен, changed bytes конфликтуют;
6. одновременно claim выигрывает один worker;
7. expired pre-boundary lease можно безопасно вернуть;
8. post/unknown-boundary lease становится terminal ambiguous;
9. worker вызывает только exact argv и `shell=false`;
10. artifact upload fail не превращает unknown execution в retry;
11. exit 0 без exact report/index блокируется;
12. provider permit/budget denial происходит до adapter/network;
13. BJ's, clubs без отдельного gate, implicit/all scope запрещены;
14. no-spend E2E воспроизводит CLI result byte-for-byte;
15. UI никогда не утверждает, что RBAC click равен owner signature.

## 12. Owner decision

Рекомендуемый exact выбор:

1. **Architecture:** отдельные SSCC command/artifact/event tables; существующий
   Product Truth operational ledger не дублировать.
2. **Owner auth:** новый отдельный Ed25519 Product Truth key family; private key
   только под owner custody.
3. **Artifact custody v1:** append-only bytes в основной SSCC DB; public R2 не
   использовать.
4. **Worker v1:** отдельный pinned iMac/`launchd` worker; Vercel не исполняет CLI.
5. **Activation:** Stage A → B → C; после каждого stage отдельная проверка и
   owner gate. Production read/write/spend не разрешать этим design approval.

Фраза, которая разрешает только реализацию Stage A:

```text
Разрешаю Product Truth Web Operations Stage A по
product-truth-web-operations-control-plane.md: отдельная SSCC schema/contracts/tests,
отдельный Product Truth Ed25519 domain, runtime hardcoded OFF. Не разрешаю
production activation, worker claim, DB apply, provider calls, paid spend или
marketplace actions.
```

Если owner не принимает один из пяти пунктов, Codex сначала обновляет этот
decision packet; реализацию не начинает молча.
