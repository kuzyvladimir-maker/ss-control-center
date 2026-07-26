# Product Truth Web Operations Control Plane

> **Статус:** `DESIGN_READY / RUNTIME_OFF / OWNER_DECISION_REQUIRED`.
>
> **Дата:** 2026-07-25.
>
> **Верхний канон:** [[product-catalog-architecture]]. Daily operator contract:
> [[product-truth-operator-runbook]]. Implementation board:
> [[product-truth-command-center]].
>
> Этот документ является design/decision packet. Он **не** выдаёт owner approval,
> не активирует web execution, не создаёт production trust root, не запускает
> provider, не расходует credits и не изменяет marketplace.

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

### Stage A — schema/contracts, no worker (`OWNER_APPROVED_IN_PROGRESS`)

- SSCC migration для command/artifact/event tables;
- canonical parsers, Ed25519 verifier, state machine;
- trigger/adversarial tests;
- runtime hardcoded `OFF`;
- production effects: zero.

Владелец одобрил этот ограниченный Stage A 2026-07-26. G1 завершён, Stage A
переведён в работу. Approval не включает production migration apply, trust-root
enrollment, worker claim, provider calls/spend или marketplace actions.

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
