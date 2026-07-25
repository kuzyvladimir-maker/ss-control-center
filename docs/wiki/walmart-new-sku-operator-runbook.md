# Walmart new-SKU engine — строгий runbook оператора

> **Операционный контракт v1.17, актуализирован 2026-07-23.** Этот документ подчинён
> [[product-catalog-architecture]], [[donor-catalog-execution-roadmap]],
> [[enrichment-division-of-labor]], [[product-truth-operator-runbook]],
> [[product-truth-consumer-cutover]] и [[product-truth-release-scope]]. Он описывает
> исполнение уже готового Walmart new-SKU engine. Сам по себе runbook не разрешает
> платный evidence run, production migrations, публикацию listing или расширение
> pilot.

## Текущий certified release

Текущий operator runtime:
`release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23/release`.

- engine SHA-256:
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`;
- manifest SHA-256:
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`;
- certificate SHA-256:
  `cc5603d8d56421c151b92b5a6726c1cf10c3dfa52732614763cde6dc6fec9242`.

Все releases до v23 не используются для нового execution. v20 остаётся историческим
certificate старой бизнес-экономики. v21 остановлен frozen QA из-за короткого
description, v22 superseded до certificate после исправления TypeScript-контракта.
Release v23 сам по себе не снимает production gates: fresh exact Product Truth,
rights-cleared count-accurate images, exact staged-SKU/UPC checks и каждый live SKU
требуют своих exact решений.
Claude Code не исполняет owner/Codex-only Product Truth schema apply.

## 1. Роль Claude Code

Claude Code — **оператор готового движка, а не разработчик**. Единственная разрешённая
точка входа для этого workflow:

```bash
npm run walmart:new-sku -- <doctor|plan|stage|rotate-upc|certify|dry-run|approve|apply|verify> ...
npm run walmart:new-sku:release -- verify ...
```

Команды выполняются только из корня уже выданного и успешно проверенного frozen
release — `/ABSOLUTE/RELEASE/release`. Mutable `ss-control-center` остаётся
owner/Codex workspace и не является operator runtime. Единственное отдельное
исключение — prerequisite `TARGETED_WALMART_EVIDENCE`: его exact команды выполняются
из собственного verified frozen Product Truth release по правилам
[[product-truth-operator-runbook]]. Claude Code может:

- вызвать команду с exact путями и значениями, которые дал движок;
- прочитать JSON-результат и выполнить его exact `next_argv` либо соответствующее
  POSIX-safe отображение `next_command`;
- заполнить только сгенерированные `certification-input-*.json`,
  `policy-review-input-*.json` или `buyer-evidence-*.json` фактами из реально
  проверенных evidence; для certification evidence движок заполняет SHA-256 и byte
  size, а для buyer evidence — единственное существующее digest-поле
  `rawEvidence.artifact.sha256`;
- остановиться и передать владельцу/Codex точную ошибку и пути к артефактам.

Claude Code запрещено:

- редактировать engine, runtime, validators, policy knowledge base, tests, Prisma
  schema, migrations, lifecycle tables, triggers или approval contracts;
- писать вспомогательный код или заменять отсутствующий шаг собственным shell-скриптом,
  SQL, `curl`, прямым Walmart API call, Prisma command или ручной записью в DB;
- применять production migration или backfill, включая owner/Codex-only
  `npm run walmart:new-sku:schema -- ...`;
- придумывать evidence, выставлять положительные флаги «по умолчанию», копировать
  данные соседнего вкуса/размера или превращать price proxy в content truth;
- менять sealed JSON, SHA-256, SKU, UPC, candidate key, store index, payload или
  artifact binding после их создания;
- обходить owner gate, подтверждать действие от имени владельца или подставлять
  выдуманный `actor`;
- создавать или «дополнять» внешний owner permit и запускать `apply --mode live`
  без отдельного решения владельца на exact doctor/apply-preview/approval/payload;
- запускать `owner-permit-request`, `owner-permit-assemble`,
  `walmart:new-sku:owner-signer`, `walmart:new-sku:preview-data` или `release freeze`:
  эти команды
  принадлежат owner/Codex release lane; оператор может только проверить уже выданный
  frozen release командой `release verify`;
- создавать schedule/cron, бесконечный цикл, implicit scope, массовую публикацию либо
  партии 15–20 SKU. Текущий release допускает максимум два pilot SKU, но только по
  одному SKU на отдельный doctor/plan;
- повторять `apply --mode live` после timeout, transport error или любого
  `marketplace_mutated: "UNKNOWN_CHECK_LIFECYCLE"`;
- делистить, репрайсить, менять min/max, создавать закупку или выполнять другие
  marketplace/procurement mutations.

Ошибка CLI не разрешает чинить движок на месте. Оператор останавливается; изменение
кода делает Codex/разработчик отдельно, после чего новая версия снова проходит
сертификацию.

## 2. Текущая граница production readiness

Последний read-only production `doctor` подтвердил:

- Walmart credentials для store 1 настроены; health/приём публикаций должны быть
  отдельно подтверждены свежим runtime evidence;
- в управляемом UPC-пуле доступно 13 055 кодов с валидной контрольной цифрой и
  сохранённым acquisition/owner provenance;
- legacy `gs1_validated` был импортирован из CSV-поля `check_digit_valid` и **не
  является доказательством текущей проверки реестра GS1**;
- текущий adapter — full item setup `MP_ITEM`
  `5.0.20260501-19_21_29-api` с live Get Spec;
- Product Truth evidence schema успешно применена в production: exact plan v3,
  8/8 migrations applied/tracked, schema SHA
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`;
  authoritative cross-channel Phase 1 manifest и full business-data backfill ещё не
  выполнены, но являются отдельным Product Truth Platform track, а не blocker одного
  Walmart pilot candidate при использовании sealed `TARGETED_WALMART_EVIDENCE`;
- полный all-status ITEM v6 source и mirror существующих seller listings **не являются
  входом или blocker нового SKU**. Товар, контент и допустимый вариант берутся только
  из Product Truth. Перед certification движок делает point-in-time проверки только
  exact staged seller SKU и выделенного UPC;
- post-Product-Truth lifecycle v3 применён schema-only в production:
  `MarketplaceSubmissionAttempt`, `WalmartBuyerPublicationEvidence`, duplicate
  active-attempt fence, historical two-SKU cap и immutable buyer-evidence contract
  готовы; activation report SHA
  `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`,
  schema after
  `c54877cb6cf9cb2e823092a739bc078a11af1e4102a6d1c650ee200e23c3dbeb`;
- общий production Ed25519 owner-control public key автоматически создан, проверен
  реальным `doctor` и pinned в current immutable release;
- в production ещё нет canonical Walmart candidate. Узкий
  `TARGETED_WALMART_EVIDENCE` source lane реализован, его focused/integration code
  и финальные buyer-evidence seal bytes входят в выданный persistent frozen release;
  paid Oxylabs/Unwrangle calls этим lane не выполнялись.

Поэтому наличие кода, schema и зелёных тестов не равно разрешению на live pilot.
До live pilot остаются candidate-bound evidence/certification и отдельное разрешение
на exact первый Walmart POST; Claude Code не создаёт эти разрешения. Full
cross-channel manifest/backfill продолжается
отдельно и не подменяется targeted lane. На каждом запуске
фактическим источником состояния является новый `doctor`,
а не этот датированный snapshot.

`UPCPool.gs1_validated` нельзя самостоятельно превращать в результат GS1 lookup.
Движок использует существующий owner-approved pool, проверяет формат/checksum,
provenance, доступность, уникальную reservation fence и lifecycle, но certification
дополнительно требует свежий exact-UPC registry artifact: registrant должен совпадать
с pool owner, проверяемый brand — с exact Product Truth brand, а authority — с exact
seller-account fingerprint. UPC исключается или переводится только самим движком по
доказанному outcome.

### 2.1. Production schema bootstrap — не задача Claude Code

До первого pilot нужны следующие owner/Codex-only activation gates:

1. ✅ Канонический Product Truth activation применил ровно восемь migrations из
   [[donor-catalog-execution-roadmap]] по exact plan v3. Authoritative Phase 1
   manifest/backfill остаётся отдельным platform track; один pilot candidate обязан
   получить exact Product Truth через targeted lane и не ждёт full denominator.
2. ✅ После Product Truth apply создан и применён **новый** Walmart publish lifecycle plan
   против post-Product-Truth schema: plan SHA
   `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`,
   `eligibleForApply=true`, `blockers=[]`. После понятного owner approval lifecycle
   activation применил только
   `20260719003000_walmart_publish_lifecycle_safety` через
   `npm run walmart:new-sku:schema -- plan|apply`. Актуальный activation contract —
   version 3; ledger неизменно хранит certification SHA вместе с exact payload,
   seller-account fingerprint, idempotency key и owner-permit bindings. Старые
   version-2 plan/approval artifacts не применяются.
   Отдельная local rehearsal на копии production backup доказала exact migration
   compatibility, `integrity_check=ok`, FK violations `0`, 10/10 lifecycle objects,
   immutable receipt/Prisma history и fail-closed second-plan blocker
   `MIGRATION_ALREADY_ACTIVATED`. Active-attempt fence, historical two-SKU cap и
   buyer-evidence/attempt-SKU binding также сработали на backup-shaped schema.
   Summary SHA —
   `3bc021833bd9a1c049e7ba38be46a57ea532b077b65150c12ab31515475ee9ef`.
   Local approval был привязан только к temporary copy. Production approval
   `owner-chat-20260723-walmart-repeat-publish-protection` отдельно разрешил ровно
   schema-only apply; transaction завершилась `applied`, report SHA
   `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`.
   Apply сам проверил обязательные schema objects, Prisma history и immutable receipt
   до commit. Backfill, provider/Walmart calls и listing publication = `0`.
3. ✅ Owner decision
   `owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight`
   отменил обязательный полный ITEM v6 seller-catalog gate. Product source — только
   Product Truth/донорский справочник. Doctor запечатывает point guard текущего
   business seller account; certification обязана получить authenticated exact SKU
   `404` и exact UPC `SPEC` search для staged bytes. Полный seller catalog, recipe
   scan и `WalmartReport` для этого workflow не запрашиваются и не активируются.
   Release v11 исключил legacy all-status seller-catalog binding из
   active plan/doctor/certification/runtime types и валидаторов: старый artifact
   теперь fail-closed отклоняется, а не просто остаётся неиспользованным.
   Release v12 дополнительно удалил ручной canonical identity input:
   `EVIDENCE_VERIFIED_BOOTSTRAP` выводит conservative identity из sealed donor bytes
   и требует fresh exact Walmart proof до canonical write.
   Подготовленный one-shot ITEM v6 executor остаётся только audit evidence и не
   исполняется.

Все activation-контуры используют свой fresh sealed plan, отдельный внешний approval,
exact target/schema/source/migration SHA, drift/preflight checks, транзакционный
rollback и immutable receipt. Они не auto-adopt частичную или
неучтённую schema. Их наличие в repository не доказывает production deployment.
Claude Code не запускает эти команды и не редактирует approval template; при schema
blocker он останавливается и передаёт результат владельцу/Codex.

Legacy catalog activation code и отдельный signing domain сохранены для аудита старого
контракта, но не входят в этот operator workflow. Их наличие не является задачей,
prerequisite или разрешением на ITEM v6 request/activation.

Планы нельзя одобрять «пакетом». Product Truth exact plan v3 уже применён 8/8 и
закрыт. Pre-Product-Truth lifecycle plan SHA
`25d7c29a9136fe579011296e27430b53ac2c94b390b530dfe33685541c228ef0`
остаётся только diagnostic evidence. Новый post-Product-Truth schema-only lifecycle
plan был создан read-only в
`data/walmart-new-sku-engine/activation/20260723T015030Z-walmart-lifecycle-plan-v3`:
plan SHA `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`,
migration SHA `d46c10fbf1e1c30071cf162a3c5f0cebb31954b76e844a8d4d4df610d065641e`,
`eligibleForApply=true`, `blockers=[]`, duplicate active UPC reservations `0`.
2026-07-23 он был применён одной production transaction по отдельному schema-only
approval. Report:
`data/walmart-new-sku-engine/activation/20260723T053000Z-walmart-lifecycle-apply-v3`,
SHA `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`,
schema after
`c54877cb6cf9cb2e823092a739bc078a11af1e4102a6d1c650ee200e23c3dbeb`.
Approval не разрешал и не выполнил backfill, report/provider calls, key enrollment
или Walmart POST. Исторический понятный review:
`data/walmart-new-sku-engine/activation/OWNER_REVIEW_20260723T015030Z_WALMART_LIFECYCLE.md`.

Для этого plan создан новый self-contained production backup
`data/walmart-new-sku-engine/activation/backups/20260722T224444Z`: portable SHA
`6e69911d1ab83f77545c9fa5789d35e29f11cd434a25b24d2f03e3fdef952526`, manifest SHA
`84c3b2bfdf625bf5a0b9a40534aab2de590eece79a6f51309f1c054547fa8f02`,
`integrity_check=ok`, FK violations `0`. Local plan на автономном файле воспроизвёл
production schema/queue/writer/migration/contract hashes. Точная `backupReference`
записана в non-authorizing owner template и review packet
`data/walmart-new-sku-engine/activation/OWNER_REVIEW_20260722T224200Z.md`.
Исторический backup от 2026-07-19 остаётся только архивным evidence. Apply повторно
проверяет schema/queue/writer drift и выполняет все восемь migrations атомарно;
ошибка до commit откатывает всю транзакцию.

### 2.1.1. Ровно один Product Truth gap перед pilot

Если после schema activation кандидат по-прежнему отсутствует, его нельзя собирать из
mutable legacy rows, ручного SQL или нового scraper. Допустим только frozen
`TARGETED_WALMART_EVIDENCE` workflow из [[product-truth-operator-runbook]]:

- `EXISTING_EXACT` связывает уже подтверждённый exact alias;
- `EVIDENCE_VERIFIED_BOOTSTRAP` связывает full-row bytes одного legacy
  `DonorProduct` и одного direct first-party Walmart `DonorOffer`; движок сам
  детерминированно выводит conservative identity из exact brand, полного post-brand
  title signature и нормализованного размера. Ручной identity-файл и техническая
  owner attestation запрещены. Owner approval разрешает только exact metered plan,
  бюджет и provider permit;
- bootstrap не пишет до fresh exact search и transactionally не может выйти за этот
  donor/offer и максимум один canonical variant/decision. Search обязан независимо
  подтвердить item ID, URL, Walmart.com first-party seller, полный identity token set,
  размер и base-unit pack;
- абсолютный budget: один Oxylabs Walmart query (`1` unit) и один Unwrangle detail
  (`2.5` units), ZIP `33765`, price TTL `24h`, минимум два exact images, wall clock
  `180000 ms`;
- OFF, clubs, BJ's, fanout, replay, publish, delist, reprice и purchase выключены.
  Existing complete exact content можно переиспользовать только со свежей ценой и
  только пока detail receipt не существует.

Claude Code выполняет только engine-generated doctor→plan→execute/resume/status/report
из frozen Product Truth CLI и exact emitted argv. Он не создаёт identity, не пишет код/
SQL и не вызывает API вручную. Каждый donor требует отдельные owner approval, metered
permit и balance evidence. Source lane локально проходит focused/integration проверки,
а его exact bytes входят в сертификат release ниже. Этот факт не является разрешением
на paid spend: owner approval, metered permit и balance evidence по-прежнему обязательны.

### 2.1.2. Одноразовая настройка понятной кнопки подтверждения владельца

`Ed25519 owner permit` в пользовательском смысле — не новая бизнес-сущность и не
дополнительное согласование. Это техническая защита, не позволяющая Claude Code,
скрипту или повторному процессу выдать текстовую фразу за разрешение владельца.
Система один раз создаёт защищённый Walmart owner-control key. Key сохраняет три
исторически разделённых signing domains, но текущий new-SKU workflow использует только
один MP_ITEM submit; ITEM v6 report request и catalog activation не запускаются.
Подпись одного domain нельзя переиспользовать в другом. Перед live listing POST
владелец видит точные SKU, UPC,
payload, store и действие «не более одной публикации» и подтверждает именно эти bytes.

Готовый owner-only offline signer находится в mutable Codex workspace:
`scripts/walmart-new-sku-owner-signer.mjs`. Он:

- не содержит Walmart credentials, DB/provider/model/network клиентов;
- не требует от владельца придумывать, вводить или хранить пароль и ничего
  секретного не печатает;
- создаёт зашифрованный private key только во внешней owner-custody директории вне
  repository, а случайный machine secret сохраняет в macOS login Keychain;
- показывает exact one-SKU summary до подписи;
- отклоняет delist/reprice/purchase/schedule, больше одного POST, другой store,
  изменённый request/hash и любой расширенный scope;
- выдаёт только 64-byte detached signature, которую owner/Codex-only assembly заново
  проверяет против pinned public key и всех engine artifacts.

Одноразовая инициализация уже выполнена автоматически owner/Codex release lane:

```bash
npm run walmart:new-sku:owner-signer -- init \
  --custody-dir=/Users/vladimirkuznetsov/.ss-command-center-owner/walmart \
  --key-id=walmart-owner-control-2026-01

npm run walmart:new-sku:owner-signer -- doctor \
  --custody-dir=/Users/vladimirkuznetsov/.ss-command-center-owner/walmart
```

Результат `doctor`: `OWNER_CONTROL_READY`; key id
`walmart-owner-control-2026-01`; public fingerprint
`ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a`.
В repository закрепляется только public key. Private key остаётся во внешней
custody, machine secret — в macOS Keychain, Claude Code не получает доступа ни к
одному из них. Создание ключа само по себе не разрешает migration или Walmart POST.

После owner preview exact signing request сначала проверяется без подписи:

```bash
npm run walmart:new-sku:owner-signer -- inspect \
  --custody-dir=/ABSOLUTE/PRIVATE/PATH/OUTSIDE/REPOSITORY \
  --request=/ABSOLUTE/PATH/owner-permit-request.json \
  --expect-request-sha256=<EXACT_REQUEST_FILE_SHA256>
```

Только если summary принят, владелец повторяет выданный `required_confirmation`:

```bash
npm run walmart:new-sku:owner-signer -- sign \
  --custody-dir=/ABSOLUTE/PRIVATE/PATH/OUTSIDE/REPOSITORY \
  --request=/ABSOLUTE/PATH/owner-permit-request.json \
  --expect-request-sha256=<EXACT_REQUEST_FILE_SHA256> \
  --out=/ABSOLUTE/PRIVATE/PATH/OUTSIDE/REPOSITORY/pilot-1-signature.bin \
  --confirm=<EXACT_REQUIRED_CONFIRMATION_FROM_INSPECT>
```

Signer является инструментом owner/Codex release lane, а не новой командой
оператора. Claude Code не запускает `init`, `doctor`, `inspect` или `sign` и не
читает owner custody или macOS Keychain.

### 2.2. Frozen runtime release

Codex создаёт финальный content-addressed runtime snapshot только после окончания всех
изменений движка. Freeze находится на отдельной release-authority поверхности:

```bash
npm run walmart:new-sku:release:freeze -- \
  --source-root /ABSOLUTE/PATH/ss-control-center \
  --out /ABSOLUTE/NEW/RELEASE-DIRECTORY
```

Snapshot включает точные bytes `src`, `scripts`, `prisma/migrations`, Prisma schema,
package manifests/lockfile, `tsconfig`, sealed `AGENTS.md`/`CLAUDE.md` operator
bootstrap и **ограниченное транзитивное runtime-замыкание зависимостей** под
`node_modules`. В замыкание копируются полные установленные package roots, включая
фактически нужные Prisma runtime assets; весь рабочий `node_modules` не копируется.
Descriptor `walmart-new-sku-source-release/3.3.0`, frozen manifest
`walmart-new-sku-frozen-source-release/2.2.0` и dependency policy
`walmart-new-sku-runtime-dependency-closure/1.3.0` связывают package
name/version/root, каждый файл и каталог, SHA-256, byte size, exact mode, topology,
платформу Node и architecture. Frozen closure содержит exact Prisma CLI runtime и
корневой `prisma.config.ts`, поэтому certification выполняется только из frozen
release без обращения к mutable workspace; npm `.bin` shims намеренно не входят.

Ambient `.env`, application `data`, `.DS_Store` metadata и посторонние package roots
в snapshot не входят; exact exclusion списка `.DS_Store` запечатан в descriptor, а
его появление внутри frozen topology отклоняется verifier. Symlink и special files
запрещены. Это **не** утверждение, что выполнен content-level secret scan: manifest
честно фиксирует `embedded_secret_scan_performed: false`.
Release root, каталоги и файлы переводятся в read-only modes, а verifier отклоняет
добавление, удаление, byte/mode/topology drift, подложенный `.env`, dependency drift
или запуск на другой platform/architecture. Snapshot является консервативной Walmart
runtime tamper boundary, а не переопределением Git release Product Truth из
[[product-truth-release-scope]].

Граница намеренно содержит широкий audited source tree и поэтому не является
физической shell-sandbox: manifest фиксирует `broad_source_boundary: true` и
`operator_surface_isolated: false`. Роль Claude Code ограничена allowlist-командами
этого runbook и read-only release договорно и организационно. Если требуется защита
от намеренно враждебного shell-оператора, нужен отдельный OS/container command
allowlist; текущий release этого не заявляет.

Release custodian/Codex заранее готовит **самостоятельно запускаемый** snapshot с
sealed dependency closure. Claude Code не устанавливает и не обновляет зависимости
по собственной инициативе и не использует зависимости исходного workspace.
Перед operator run он переходит именно в выданный read-only source root и проверяет
snapshot. `<EXACT_ENGINE_RELEASE_SHA256>` передаётся trusted release channel; Claude
Code не вычисляет ожидаемое значение из проверяемых bytes:

```bash
cd /ABSOLUTE/RELEASE/release
npm run walmart:new-sku:release -- verify \
  --release-root /ABSOLUTE/RELEASE/release \
  --manifest /ABSOLUTE/RELEASE/release-manifest.json \
  --manifest-sha /ABSOLUTE/RELEASE/release-manifest.sha256 \
  --expected-engine-release-sha <EXACT_ENGINE_RELEASE_SHA256>
```

Любое добавление, удаление, изменение bytes/mode, manifest, sidecar или ожидаемого SHA
останавливает run. Claude Code не чинит и не перезамораживает release.
Все следующие команды этого runbook выполняются из того же
`/ABSOLUTE/RELEASE/release`: `doctor` повторно хеширует именно текущий working tree до
подключения к DB или Walmart.

После выпуска certification authority является immutable release certificate с exact
executed focused Walmart engine command, отдельной
`scripts/__tests__/walmart-new-sku-engine.integration.test.ts` командой и
`npm run test:product-truth-certification` на тех же frozen bytes. Этот runbook не
закрепляет hardcoded totals: число тестов меняется вместе с suite и не заменяет command,
exit status, artifact hashes и independent review.

Актуальный operator release выдан:

- directory:
  `/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23`;
- engine SHA-256:
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`;
- manifest SHA-256:
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`;
- certificate SHA-256:
  `cc5603d8d56421c151b92b5a6726c1cf10c3dfa52732614763cde6dc6fec9242`.

Release read-only, self-verify прошёл; Product Truth certification — `429/429`,
Walmart unit/security regression непосредственно из persistent frozen release прошёл
с exit `0`, frozen fake-live integration на том же exact engine SHA — `3/3`.
Интеграция доказала ровно один fake feed POST,
receipt-bound buyer seal → `BUYER_VERIFIED/LIVE`, replay без второго POST и
отдельный blocked-doctor diagnostic, который нельзя использовать как receipt.
Новый release фиксирует owner commercial contract: contribution margin `30%` после
goods, packaging, seller shipping label и Walmart referral `15%`; exact Walmart
comparable остаётся warning, а не внутренним hard reject. Официальный Walmart pricing
risk при этом не исчезает. Release разрешает исполнение frozen CLI, но не снимает
production owner gates и не разрешает `apply --mode live`. Certificate decision:
`ENGINE_RELEASED_OWNER_PREVIEW_READY_LIVE_PILOT_REMAINS_OWNER_GATED`.

## 3. Общие правила одного pilot

1. Exact scope: один Walmart account (`--store-index 1`) и ровно один candidate в
   каждом sealed doctor/plan. Второй pilot SKU требует нового doctor и нового plan
   после принятия первого; release-wide cap по-прежнему равен двум SKU.
2. Одна candidate проходит всю цепочку последовательно. Не запускать две live apply
   параллельно.
3. Product Truth читается только через canonical versioned read-contract. Mutable
   `DonorProduct`, legacy view или marketplace listing не заменяют его.
   Exact immutable observations и price freshness повторно читаются на certification,
   dry-run, approval и apply; поздний revoke/drift блокирует workflow.
4. Content разрешён только от exact variant. Другая фасовка может быть price evidence,
   но не источником title, facts, nutrition или изображений.
5. Каждый sealed output/receipt — immutable evidence. Сгенерированные TODO/null
   worksheets являются единственным временно редактируемым исключением до штатного
   seal-шага. Новый sealed результат пишется в новый путь; старый файл не удаляется,
   не переименовывается и не перезаписывается.
6. Секреты уже должны находиться в окружении (`TURSO_DATABASE_URL` либо
   `DATABASE_URL`, `TURSO_AUTH_TOKEN` и Walmart credentials). Не помещать token/secret
   в команду, JSON, лог, заметку или screenshot.
7. После успешной команды считать полем-источником `next_argv`: это точный массив
   аргументов без shell-интерпретации. `next_command` — POSIX-shell-safe отображение
   тех же аргументов для копирования. Разрешено заменить только показанные placeholders
   (`<operator>`, `<owner>`) реальной identity; нельзя склеивать собственную команду.
8. SHA-256 берётся только из JSON-вывода движка. Его нельзя перепечатывать по памяти,
   сокращать или вычислять другим скриптом.
9. `next_argv: null` и `next_command: null` означают остановку. Любая ошибка, blocker
   или неожиданное расхождение также означает остановку, а не импровизацию.
10. Dry-run receipt и owner approval действуют максимум 30 минут. Stage reservation
    действует 24 часа. При истечении engine должен fail closed; оператор создаёт новый
    штатный receipt/approval только после review, а не меняет timestamps.
11. Release-wide cap — ровно два distinct Walmart SKU. Он проверяется runtime и
    DB-trigger/index по immutable pilot slots `1`/`2`, а не только размером одной wave.
12. Внешний owner permit v2 — отдельный Ed25519-signed authority artifact после
    apply-preview. Hash-only v1 всегда отвергается. Поле `next_command: null` перед
    этим gate означает буквальную остановку Claude Code.

Рекомендуемая структура артефактов одного pilot находится во внешнем абсолютном
записываемом каталоге, а не внутри read-only frozen release:

```text
<ABSOLUTE_WRITABLE_ARTIFACT_ROOT>/walmart-new-sku-engine/waves/<wave-id>-<plan-hash>/
  doctor-<timestamp>-<hash>.json
  plan.json
  stage-<candidate>-<hash>.json
  upc-rotation-<candidate>-<hash>.json       # только если была rotation
  certification-input-<candidate>.json
  policy-review-input-<candidate>.json
  certification-input-sealed-<candidate>.json
  evidence/<kind>-<hash>.<ext>
  certification-<candidate>-<hash>.json
  certification-<candidate>-<hash>-receipt.json
  dry-run-<candidate>-<hash>.json
  approval-<candidate>-<hash>.json
  apply-preview-<hash>.json
  owner-permit-template-<candidate>-<hash>.json
  owner-permit-request-<candidate>-<hash>.json # owner/Codex-only
  owner-signature-<hash>.bin                   # вне operator workspace
  owner-permit-<candidate>-<hash>.json       # только внешний owner/Codex gate
  apply-live-<hash>.json                     # только после owner gate
  verify-<hash>.json
  buyer-evidence-<candidate>-<attempt>-<receipt12>.json          # editable TODO worksheet
  buyer-evidence-sealed-<candidate>-<attempt>-<receipt12>.json   # engine-sealed NEW output
```

## 4. Полная цепочка команд

Ни один пример ниже не является owner approval. Значения в угловых скобках должны
быть заменены exact значениями текущего run.

### 4.1. `doctor` — обязательный read-only gate

```bash
npm run walmart:new-sku -- doctor \
  --store-index 1 \
  --limit 1 \
  --pack-count <EXACT_PACK_COUNT_2_OR_3> \
  --zip 33765 \
  --as-of <EXACT_ISO_UTC_TIMESTAMP> \
  --max-price-age-hours 24 \
  --expected-engine-release-sha <EXACT_ENGINE_RELEASE_SHA256> \
  --release-manifest /ABSOLUTE/RELEASE/release-manifest.json \
  --release-manifest-sha /ABSOLUTE/RELEASE/release-manifest.sha256 \
  --out /ABSOLUTE/NEW/PATH/doctor.json
```

`--as-of` обязателен, должен быть canonical ISO UTC, не находиться в будущем и на
момент запуска быть не старше 15 минут. Для первой проверки `--limit` всегда `1`;
значения `2` и `3` разрешены только для `--pack-count`.

Doctor принимает абсолютные пути только к `release-manifest.json` и его SHA sidecar.
Флаги `--item-report-catalog-source` и
`--expected-item-report-catalog-source-sha256` запрещены. Doctor сверяет release до
DB/Walmart access, читает Product Truth и запечатывает seller-scoped point guard.
Receipt schema — `walmart-new-sku-doctor-receipt/1.7.0`.

Продолжать разрешено только когда одновременно:

- `ready_for_plan: true`;
- `infrastructure_ready_for_pilot: true`;
- `ready_for_live_apply: false` — `doctor` принципиально не подменяет собой sealed
  certification, fresh dry-run, owner approval и apply-preview review;
- `blockers: []`;
- `store.configured: true`;
- `product_truth.schema_ready: true`;
- `publish_lifecycle.canonical_schema_ready: true`;
- `duplicate_guard.mode: "EXACT_SKU_AND_UPC_PREFLIGHT_ONLY"`,
  `full_seller_catalog_required: false` и непустые `binding_id`, `body_sha256`;
- `upc_pool.available > 0`,
  `available_with_legacy_checksum_flag_and_provenance > 0` и
  `duplicate_draft_reservations: 0`;
- `doctor_receipt_written: true` и валидный `doctor_receipt_sha256`.

Legacy pool flag никогда не снимает certification blocker
`PRODUCT_IDENTIFIER_REGISTRY_BRAND_AND_SELLER_AUTHORITY`. Любой schema blocker
передаётся владельцу/Codex; оператор не запускает migration.

Doctor receipt живёт максимум 30 минут и связан с exact seller fingerprint, DB target,
полным schema hash, item-spec version и успешным authenticated read-only exact UPC GET.
Если цепочка заняла дольше, после apply-preview получить новый doctor receipt в новый
путь; старый timestamp не исправлять.

Если current canonical candidate отсутствует, v23 дополнительно возвращает
`product_truth.commercial_discovery` версии
`walmart-new-sku-commercial-discovery/1.1.0`. Это бесплатный provisional screen
существующего донорского Product Truth, а не listing truth:

- он не читает каталог наших Walmart listings и не делает provider calls;
- Walmart разрешён как источник закупки; Amazon, BJ's, Sam's и Costco не могут стать
  source в обычном pilot;
- pack-of-2/3 проверяются отдельно с goods, packaging `$1.50`, seller shipping label
  `$8.78`, referral `15%` и target contribution margin `30%`;
- exact Walmart comparable создаёт
  `ABOVE_EXACT_COMPARABLE_WARNING`, но не отклоняет candidate внутри движка;
  внешний Walmart Pricing Rule всё равно может снять offer или ограничить Buy Box;
- content donor, procurement offer и Walmart comparable обязаны иметь один physical
  size; cross-size merge блокируется;
- candidate остаётся
  `SHORTLIST_ONLY_REQUIRES_FRESH_EXACT_EVIDENCE`, не может войти в `plan` и требует
  targeted Product Truth evidence после отдельного budget gate.

Production diagnostics v20 от 2026-07-23 зафиксировали результат старой политики
`20% + 125% ceiling` и являются только историей; использовать их как current decision
запрещено. По owner contract v23 локальный sealed Product Truth projection для RITZ
даёт pack-of-2 `$33.13` и pack-of-3 `$40.36` при exact `30%` contribution margin.
Это owner preview, а не fresh production doctor receipt и не разрешение публикации.
Если свежий v23 doctor не находит canonical candidate, оператор останавливается при
`NO_CURRENT_CANONICAL_PILOT_CANDIDATES` и следует `next_command: null`.

Если `doctor` запущен с `--out`, при этой остановке v23 не создаёт запрошенный
green doctor receipt. Вместо него рядом создаётся
`<имя>.blocked.json` схемы `walmart-new-sku-doctor-diagnostic/1.0.0` с exact
blockers, SHA-256 и `next_argv: null`, `next_command: null`. Этот diagnostic
никогда не принимается `plan` как receipt. Production pack-of-2 diagnostic:
`ss-control-center/data/walmart-new-sku-engine/doctor/20260723T065153Z-v20-pack2-doctor.blocked.json`,
SHA `57b1f71e551f52d21b9df883cba1fffc33e74c68f2f9a405c95cc1e76929496a`;
pack-of-3:
`ss-control-center/data/walmart-new-sku-engine/doctor/20260723T065231Z-v20-pack3-doctor.blocked.json`,
SHA `b2f0b1ef376329b51211d3d87c58447ec26f7113ebc32d59b030ed91f63ca5eb`.

### 4.2. `plan` — sealed read-only plan ровно на один candidate

Для каждого pilot plan разрешено только `--limit 1`. После полной проверки первого SKU
владелец может разрешить второй, но он начинается с нового frozen-release-bound doctor
и отдельного plan; старый receipt/plan повторно не используется.

```bash
npm run walmart:new-sku -- plan \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --store-index 1 \
  --limit 1 \
  --pack-count <EXACT_PACK_COUNT> \
  --zip 33765 \
  --as-of <SAME_EXACT_ISO_UTC_TIMESTAMP> \
  --max-price-age-hours 24 \
  --out /ABSOLUTE/NEW/PATH/plan.json
```

`plan` не резервирует UPC, не пишет application DB, не вызывает paid provider и не
меняет Walmart. Он исключает candidate keys, уже staged прежней wave. Проверить
`candidate_count`, `rejected`, `plan_sha256`, `wave_id` и exact candidate scope.

Plan обязан иметь schema `walmart-new-sku-plan/1.7.0`, быть связан с exact fresh doctor
receipt `1.7.0`, тем же seller-scoped exact-identifier guard и содержать ровно одного
candidate. Иная schema или попытка увеличить
`--limit` блокирует workflow; второй release slot не делает один plan двухкандидатным.

Команда `stage` обязана содержать exact `--candidate <candidate_key>` из sealed
`plan.json`. Нельзя подставлять donor/SKU, которого нет в плане.

### 4.3. `stage` — preview, затем внутренняя reservation UPC

Preview:

```bash
npm run walmart:new-sku -- stage \
  --plan /ABSOLUTE/PATH/plan.json \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --candidate <EXACT_CANDIDATE_KEY> \
  --mode preview
```

Проверить `internal_database_mutated: false`, `marketplace_mutated: false` и preview.
Затем выполнить exact `next_command` с реальным оператором и полным plan SHA:

```bash
npm run walmart:new-sku -- stage \
  --plan /ABSOLUTE/PATH/plan.json \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --candidate <EXACT_CANDIDATE_KEY> \
  --mode apply-internal \
  --actor <REAL_OPERATOR_IDENTITY> \
  --confirm <EXACT_PLAN_SHA256>
```

Эта команда создаёт внутренний draft и резервирует ровно один доступный UPC. Walmart
не изменяется. Сохранить `stage-*.json`, `stage_sha256`, proposed SKU, UPC и reservation
expiry. Не назначать другой UPC вручную.

### 4.4. `rotate-upc` — только доказанный exact `MP_ITEM_MATCH`

Это **не обычный шаг для каждого UPC**. Его вызывают только если fresh Walmart catalog
SPEC search доказал, что staged UPC уже принадлежит ровно одному существующему
`MP_ITEM_MATCH`, и engine остановил full-item certification. При `NO_MATCH` или
`MP_ITEM` full setup rotation не нужна. Ambiguous response блокирует workflow.

Read-only preview:

```bash
npm run walmart:new-sku -- rotate-upc \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-OLD.json \
  --mode preview
```

Preview делает case-sensitive UPC search с `responseFormat=SPEC`, но не меняет DB или
Walmart. Продолжать можно только при unambiguous exact match. Затем exact
`next_command`:

```bash
npm run walmart:new-sku -- rotate-upc \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-OLD.json \
  --mode apply-internal \
  --actor <REAL_OPERATOR_IDENTITY> \
  --confirm <EXACT_CURRENT_ROTATION_CONFIRMATION_SHA256>
```

Перед транзакцией engine повторно читает SPEC proof. Старый UPC атомарно получает
`RETIRED` с disposition `FUTURE_MP_ITEM_MATCH`; он не помечается `INVALID` и не
теряется. Следующий checksum-valid UPC резервируется тому же draft, создаются новый
stage и immutable rotation receipt. Walmart не изменяется.

После rotation использовать **только новый stage**. Старый certification input больше
не подходит: заново выполнить `certify --mode template` и получить bindings к новому
`stage_sha256`.

### 4.5. `certify` — template, evidence seal, structural preview, internal apply

Сгенерировать входной template:

```bash
npm run walmart:new-sku -- certify \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-CURRENT.json \
  --mode template \
  --out /ABSOLUTE/NEW/PATH/certification-input.json
```

Команда создаёт **два** fail-closed template: указанный
`certification-input-*.json` и соседний `policy-review-input-*.json`. Разрешено
редактировать только их поля `TODO`/`null`; deterministic bindings, refs, candidate,
SKU, UPC, store, plan/stage hashes и обязательные policy source/domain IDs не меняются.
Версии этого контракта: certification input
`walmart-new-sku-certification-input/1.6.0`, certification
`walmart-new-sku-certification/1.8.0`, structured policy evidence
`walmart-new-sku-policy-review-evidence/1.2.0`, policy snapshot
`walmart-us-prepublication/2026-07-23.4`, а embedded prepublication contract —
`walmart-prepublication-evidence/1.2.0`. Doctor receipt и plan имеют версии
`walmart-new-sku-doctor-receipt/1.7.0` и `walmart-new-sku-plan/1.7.0`; внешний permit
— `walmart-new-sku-owner-permit/2.0.0`.

Каждый операторский факт заполняется только exact evidence, реально предоставленным
или проверенным для этого варианта/SKU:

- цена, packaging/shipping costs и shipping-in-price;
- свежий не старше семи дней exact-variant comparable с линейной нормализацией
  candidate/comparable pack counts; proposed customer total обязан математически
  совпадать с item price, customer shipping charge равен нулю, положительная стоимость
  shipping label включена в item price; цена обязана давать не менее `3000 bps`
  contribution margin после goods, packaging, shipping label и `1500 bps` referral.
  Превышение exact comparable — обязательный warning для owner review, но не
  внутренний hard reject; внешний Walmart Pricing Rule остаётся отдельным риском;
- минимум MAIN и distinct secondary image, exact depicted component/count, immutable
  Product Truth observation IDs, права на изображения и review time;
- все public image URLs проходят engine-owned full-byte GET/decode: query-free HTTPS
  JPEG/PNG, без redirect/private target, не больше 5 MB, квадратные и не меньше
  2200×2200; тот же полный image set повторно проверяется непосредственно перед POST;
- реально измеренные shipping weight/dimensions;
- Walmart product type, country of origin с evidence, public attributes и evidence;
- fulfillment center и lag плюс отдельный sealed факт: inventory принадлежит seller,
  direct retailer fulfillment/competitor packaging/promotional inserts отсутствуют,
  а lag выше двух дней имеет действующее исключение;
- fresh seller Health & compliance evidence и exact category approval для ingestible goods;
- текущий structured policy review по всем одиннадцати обязательным поверхностям: account
  publish eligibility, category preapproval, condition/resale rights, food labeling,
  product claims, product-detail content/images, product identifier/duplicates,
  recall/safety, shipping/fulfillment, pricing competitiveness и
  territory/legal/sanctions;
- свежий official recall check;
- brand/resale rights, condition и expiration/lot procedure;
- свежий exact-UPC registry artifact, где registrant совпадает с pool owner,
  `aligned_brand` совпадает с Product Truth brand, а seller-authority review связан с
  exact seller-account fingerprint.

`policy-review-input-*.json` обязан содержать свежую реальную human/owner review,
ровно 14 pinned official source URL и одиннадцать mandatory findings. Решение
`PROHIBITED`, `UNRESOLVED`, `BLOCKED`, неполный checklist, чужой candidate/stage,
неподтверждённый required approval или placeholder блокируют certification.
Сохранить canonical JSON: UTF-8, отступ 2 пробела, один завершающий newline и без
duplicate keys; произвольное переформатирование тоже fail closed.

Поля двух templates должны совпадать буквально: `walmart.product_type` равен
`POLICY_REVIEW.binding.product_type`; `prepublication.sku_policy_review.reviewed_at`
равен `POLICY_REVIEW.reviewed_at` и `captured_at` policy evidence artifact. Каждая
category approval совпадает по exact `scope`, `status`, `verified_at` и `evidence_ref`;
для ingestible SKU finding `REQUIRES_APPROVAL` допустим только после фактического
`APPROVED` evidence на обязательный scope. Freshness gates: seller account health —
не старше 1 часа, structured SKU policy review — 7 дней, official recall check —
не старше 24 часов.

Машинно разбирается именно structured `POLICY_REVIEW` JSON. Приложенные raw
seller-health, category-approval, recall и brand-rights файлы защищены byte hash,
provenance и freshness binding, но движок не превращает их произвольное содержимое в
независимое юридическое заключение. Поэтому реальная human/owner проверка обязательна;
одиннадцатидоменный gate — необходимый prepublication screen, а не гарантия отсутствия всех
возможных нарушений или будущих изменений правил Walmart.

Каждый используемый `evidence_ref` обязан иметь ровно одну строку в
`evidence_artifacts[]`: exact `kind`, нормализованный абсолютный локальный `path`,
`captured_at` и, когда применимо, `source_url`. SHA-256 и фактический `byte_size`
оператор **не вычисляет и не вписывает вручную**. После заполнения templates он
выполняет только exact `next_argv`, выданный движком:

```bash
npm run walmart:new-sku -- certify \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-CURRENT.json \
  --evidence /ABSOLUTE/PATH/certification-input.json \
  --mode seal-evidence \
  --out /ABSOLUTE/NEW/PATH/certification-input-sealed.json
```

`seal-evidence` не читает DB/Walmart и не сертифицирует товар. Он повторно проверяет
exact plan/stage/draft и POLICY_REVIEW binding, затем открывает каждый evidence file
через no-follow, требует regular single-link file, проверяет read race, заполняет
**только** `evidence_artifacts[].sha256` и `.byte_size` и пишет новый immutable output.
Подмена plan/stage/candidate/policy bytes, symlink, hardlink, missing/empty/oversized
file или изменение во время чтения блокируют шаг.

Preview и internal certification ещё раз открывают файлы с no-follow, хешируют
реальные bytes и отвергают missing, orphan, duplicate, kind mismatch, placeholder,
size/SHA mismatch и read race.

Нельзя оставлять placeholder, использовать query-bearing image URL, соседний вариант,
неподтверждённый claim, выдуманный screenshot/ref или автоматически выставлять
`APPROVED`, `CLEAR`, `published`, `buyable`.

Structural preview:

```bash
npm run walmart:new-sku -- certify \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-CURRENT.json \
  --evidence /ABSOLUTE/PATH/certification-input-sealed.json \
  --mode preview
```

Он проверяет структуру и выдаёт exact `certification_input_sha256`; Walmart/DB не
изменяются. Затем exact `next_command`:

```bash
npm run walmart:new-sku -- certify \
  --plan /ABSOLUTE/PATH/plan.json \
  --stage /ABSOLUTE/PATH/stage-CURRENT.json \
  --evidence /ABSOLUTE/PATH/certification-input-sealed.json \
  --mode apply-internal \
  --actor <REAL_OPERATOR_IDENTITY> \
  --confirm <EXACT_CERTIFICATION_INPUT_SHA256>
```

Engine заново доказывает Product Truth bindings, reservation/assignment, Walmart
catalog outcome, current `MP_ITEM` item spec, payload schema, quantity/identity,
unit economics, imagery rights и prepublication compliance. Walmart calls здесь
read-only; internal certification state записывается. Успех создаёт два связанных
артефакта: `certification-*.json` и `certification-*-receipt.json`.

Если catalog check показывает exact `MP_ITEM_MATCH`, не менять feed type и не обходить
ошибку: вернуться к пункту 4.4. Если ответ неоднозначен или любой evidence stale/
missing, остановиться.

### 4.6. `dry-run` — полный replay и live Get Spec без feed POST

```bash
npm run walmart:new-sku -- dry-run \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json
```

Команда повторяет validators и live Get Spec, сверяет exact payload hash и создаёт
sealed `dry-run-*.json`. Она не отправляет feed и не меняет Walmart. Продолжать только
при `validation_status: PASSED`, `live_get_spec_valid: true` и exact совпадении
`payload_sha256`.

С этого момента dry-run receipt живёт 30 минут. Не откладывать approve/apply и не
менять certification input, code, adapter или payload.

### 4.7. `approve` — owner preview и payload-bound internal approval

Preview:

```bash
npm run walmart:new-sku -- approve \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --mode preview
```

Владелец проверяет exact SKU, UPC, product facts, изображения, цену/economics,
fulfillment, policy evidence и payload SHA. Только владелец разрешает запись approval.
После его решения выполнить exact `next_command`:

```bash
npm run walmart:new-sku -- approve \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --mode apply-internal \
  --actor <REAL_OWNER_IDENTITY> \
  --confirm <EXACT_DRY_RUN_RECEIPT_SHA256>
```

Это payload-bound внутренняя approval и immutable `approval-*.json`, но ещё не
Walmart publish и **не является внешним разрешением live POST**. Approval действует
30 минут и не переносится на другой payload,
receipt, SKU, UPC, candidate или account.

### 4.8. `apply --mode preview` — последний немутирующий preflight

```bash
npm run walmart:new-sku -- apply \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --approval /ABSOLUTE/PATH/approval.json \
  --mode preview
```

Проверить `marketplace_mutation_requested: false`, payload/approval bindings и
`apply-preview-*.json`. Engine также создаёт pending
`owner-permit-template-*.json`, но он содержит TODO/null и ничего не разрешает.
Ожидаемый результат — `next_command: null`. Claude Code обязан остановиться и передать
владельцу/Codex approval, preview, новый doctor receipt, template и exact hashes.

Если первому doctor receipt уже больше нескольких минут, выполнить пункт 4.1 ещё раз
с новым `--out`. Владелец/Codex вне operator lane проверяет exact SKU, candidate,
payload, seller, pilot slot и immutable artifacts. Затем Codex формирует единственные
разрешённые bytes для внешнего signer:

```bash
npm run walmart:new-sku:owner -- owner-permit-request \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --approval /ABSOLUTE/PATH/approval.json \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --apply-preview-receipt /ABSOLUTE/PATH/apply-preview.json \
  --permit-id <UNIQUE_OWNER_PERMIT_ID> \
  --pilot-slot <1_OR_2> \
  --actor <REAL_OWNER_IDENTITY> \
  --decision-ref <ABSOLUTE_OWNER_DECISION_URI> \
  --out /ABSOLUTE/NEW/PATH/owner-permit-request.json
```

Внешний signer подписывает decoded `signing_message_base64` и возвращает ровно 64 raw
Ed25519 bytes. Private key никогда не попадает в repository, frozen release или
operator runtime. Codex проверяет и запечатывает permit:

```bash
npm run walmart:new-sku:owner -- owner-permit-assemble \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --approval /ABSOLUTE/PATH/approval.json \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --apply-preview-receipt /ABSOLUTE/PATH/apply-preview.json \
  --owner-permit-request /ABSOLUTE/PATH/owner-permit-request.json \
  --detached-signature /ABSOLUTE/PATH/owner-signature.bin \
  --out /ABSOLUTE/NEW/PATH/owner-permit.json
```

Обе команды имеют `next_command: null`, не меняют DB/Walmart и сообщают
`private_key_accessed: false`. Assembly заново проверяет все bindings и pinned public
key. Подпись покрывает exact action/environment, engine release, SKU/UPC/payload,
seller/store/DB, doctor, approval, preview, pilot slot, expiry и запрет
delist/reprice/purchase/schedule. Claude Code не запускает эти команды, не подписывает
permit и не может заменить trust root.

`engine_release_sha256` — source-release `3.3.0` digest полного `src`, `scripts`,
`prisma/migrations`, Prisma schema, package manifests/lockfile, `tsconfig` и sealed
operator bootstrap. Symlink в этих деревьях блокирует digest. Любое изменение файла
после doctor требует нового doctor/preview/permit. `TEST_FIXTURE_ONLY` key/body имеют
отдельный authority domain; production mutation transport принимает только
`PRODUCTION` permit.

### 4.9. `apply --mode live` — единственная Walmart mutation

Требуются одновременно:

- нулевые blockers свежего `doctor`;
- `infrastructure_ready_for_pilot: true` свежего `doctor` (сам boolean
  `ready_for_live_apply` остаётся `false`, пока exact artifact chain проверяет команда
  `apply`);
- действующие dry-run receipt и approval;
- ручная проверка apply preview;
- свежий sealed doctor receipt на тот же seller/DB/schema/spec;
- внешний owner permit, связанный с **exact** SKU/candidate/payload/approval,
  doctor receipt, apply-preview receipt и pilot slot;
- соблюдение общего pilot cap 1–2 SKU.

Только после этого:

```bash
npm run walmart:new-sku -- apply \
  --certification /ABSOLUTE/PATH/certification.json \
  --certification-receipt /ABSOLUTE/PATH/certification-receipt.json \
  --dry-run-receipt /ABSOLUTE/PATH/dry-run.json \
  --approval /ABSOLUTE/PATH/approval.json \
  --doctor-receipt /ABSOLUTE/PATH/FRESH-doctor.json \
  --apply-preview-receipt /ABSOLUTE/PATH/apply-preview.json \
  --owner-permit /ABSOLUTE/PATH/owner-permit.json \
  --mode live \
  --actor <REAL_OWNER_IDENTITY> \
  --confirm <EXACT_OWNER_PERMIT_SHA256>
```

Это единственный путь, который может отправить multipart `MP_ITEM` feed. Нельзя
вызывать endpoint напрямую. До POST engine выполняет свежий Get Spec, payload replay,
approval/Ed25519 permit fence, current engine-release hash, release-wide two-slot cap
и durable submission-attempt fence. Подпись повторно проверяется непосредственно
перед `/feeds`; обычный callback либо самостоятельно вычисленный SHA POST не разрешает.

Сохранить `apply-live-*.json`, request/payload hashes, correlation/feed IDs и durable
attempt ID. Feed `ACCEPTED` или `PROCESSED` ещё не означает, что listing `LIVE`.

### 4.10. `verify` — lifecycle и buyer-visible proof

Сразу после live apply и затем штатно по `next_command`:

```bash
npm run walmart:new-sku -- verify \
  --certification /ABSOLUTE/PATH/certification.json
```

`verify` не отправляет feed. Он опрашивает seller state, reconciles durable lifecycle и
создаёт `verify-*.json`. Listing считается `LIVE` только когда seller state
`PUBLISHED/ACTIVE` связан с exact SKU/item и есть свежая immutable buyer-page evidence.

Если CLI создаёт `buyer-evidence-*.json`, оператор вручную открывает exact public PDP,
доказывает exact SKU/item ID, опубликованность и реальную buyability, сохраняет
неизменяемый screenshot/artifact и заполняет только TODO/null observation-поля и его
нормализованный абсолютный локальный путь. Pending template всегда содержит
null/false/TODO, а не положительные факты. Оператор не меняет `engineBinding`,
certification/SKU/attempt/item/source fields или `rawEvidence.artifact.sha256`, не
добавляет `byte_size` и не вычисляет digest вручную. `capturedAt` и
`rawEvidence.binding.captured_at` должны быть одним exact canonical ISO UTC timestamp;
значения `exactSkuMatch`, `exactItemIdMatch`, `published`, `buyable`, rendered/
availability/add-to-cart и observer заполняются только по реально наблюдавшемуся PDP.

Первый `verify --mode status` запечатывает `verify-*.json` и связывает worksheet с его
SHA-256. Receipt schema `walmart-new-sku-verify-receipt/1.1.0` также связывает exact
certification SHA, payload SHA, seller-account fingerprint, deterministic idempotency
key и submission attempt ID. Повторный initial verify выпускает новую receipt-bound
пару с другим `<receipt12>` в имени; нельзя смешивать receipt/worksheet от разных
вызовов. Если ранее записанное evidence перестало проходить freshness или другой
buyer gate, следующий non-LIVE verify выпускает новую refresh-пару; старый sealed
artifact не редактируется. После заполнения выполнить только выданный `next_argv`, который создаёт новый
sealed buyer artifact:

```bash
npm run walmart:new-sku -- verify \
  --certification /ABSOLUTE/PATH/certification.json \
  --verify-receipt /ABSOLUTE/PATH/verify-INITIAL.json \
  --buyer-evidence /ABSOLUTE/PATH/buyer-evidence-TEMPLATE.json \
  --mode seal-evidence \
  --out /ABSOLUTE/NEW/PATH/buyer-evidence-SEALED.json
```

`seal-evidence` не читает DB/Walmart, не вызывает provider и не сертифицирует
buyability самостоятельно. Он проверяет exact certification и immutable verify
receipt, channel/SKU/attempt/item/source binding, canonical JSON без duplicate keys,
30-минутную freshness, single-link/no-follow/race-safe screenshot bytes и отсутствие
artifact/input/output alias. Он меняет только `rawEvidence.artifact.sha256` и пишет
только новый output. Затем выполнить его exact `next_argv`:

```bash
npm run walmart:new-sku -- verify \
  --certification /ABSOLUTE/PATH/certification.json \
  --verify-receipt /ABSOLUTE/PATH/verify-INITIAL.json \
  --buyer-evidence /ABSOLUTE/PATH/buyer-evidence-SEALED.json \
  --mode status
```

Финальный status повторно открывает и хеширует screenshot, сверяет latest submission
attempt и, когда ID уже записан, текущий ChannelSKU item ID. Verify-specific poller
затем требует тот же active certification/payload/seller/idempotency/attempt binding
до первого Walmart GET и повторно в DB transaction перед lifecycle update; только
после exact attempt/SKU/item evidence он может подтвердить `LIVE`.

Успешное завершение pilot: `listing_status: LIVE`, buyer evidence verified, exact
attempt/SKU/item bindings и сохранённый verify receipt. Любой иной status остаётся
видимым незавершённым outcome.

## 5. Неопределённый POST и правило no retry

Если live apply завершился timeout/transport error, процесс упал после начала POST или
CLI вернул:

```json
{
  "marketplace_mutated": "UNKNOWN_CHECK_LIFECYCLE",
  "recovery_action": "Do not retry apply; run verify and inspect the durable submission attempt."
}
```

оператор обязан:

1. Не повторять `apply`, не создавать новый SKU/UPC и не запускать новый plan на ту же
   candidate.
2. Выполнить только `verify --certification ...`.
3. Сверить durable `MarketplaceSubmissionAttempt`, correlation/feed ID и seller state
   через результат готового engine.
4. Передать владельцу/Codex exact error, attempt ID, hashes и artifact paths.
5. Ждать явного recovery disposition. Текущий release **никогда** не разрешает новый
   POST для этого unknown attempt, даже если внешнее расследование предполагает, что
   первый запрос не был принят. Любой будущий POST возможен только через отдельно
   реализованный, reviewed и certified recovery release с новым exact owner gate; до
   его появления `next_command: null` остаётся окончательной остановкой.

`ambiguous` никогда не replay автоматически. Лучше оставить видимый pending/blocked
listing, чем создать двойной item или повторно использовать UPC.

## 6. Pilot review и запрет автоматического расширения

После первого SKU владелец и Codex проверяют:

- exact Product Truth variant/pack/count и отсутствие sibling content;
- UPC, SKU и catalog outcome;
- title, images, rights, country of origin и public attributes;
- price, margin, shipping/packaging и fulfillment;
- prohibited/restricted, category approval, recall, brand rights и expiration evidence;
- Walmart seller state, buyer PDP, buyability и immutable lifecycle chain;
- все plan/stage/certification/dry-run/approval/apply/verify hashes.

Только после принятия первого результата владелец может разрешить второй SKU через
новые doctor и plan. Pilot из двух успешных SKU **не разрешает** партии 15–20. Для
каждой следующей wave нужны отдельные review, owner gate и версия engine, которая явно
поддерживает такой cap. До этого запрещены schedule, loop и «взять следующие
автоматически».

## 7. Stop conditions и handoff

Немедленно остановиться при:

- любом `doctor.blockers[]`;
- schema/index/trigger/DB mismatch;
- plan, stage, payload, receipt, approval, owner permit или seller-account binding
  mismatch;
- expired reservation, dry-run receipt, approval или stale evidence;
- expired/stale doctor receipt, apply-preview drift или уже занятый pilot slot;
- untrusted/revoked owner key, invalid Ed25519 signature или engine-release drift;
- missing/placeholder/uninspectable evidence;
- exact `MP_ITEM_MATCH` без штатной rotation;
- ambiguous catalog response, wrong variant, wrong pack/count или image rights gap;
- prohibited/restricted/recall/brand/category/expiration uncertainty;
- unexpected POST, duplicate attempt, 429/rate-limit anomaly или unknown mutation state;
- просьбе расширить pilot, обойти owner gate или изменить engine.

Handoff владельцу/Codex содержит только безопасные данные:

- exact command без secrets;
- store index, wave ID, candidate key, SKU и UPC;
- plan/stage/certification/payload/dry-run/approval/doctor/apply-preview/permit/attempt
  hashes и IDs;
- error code/message и последний доказанный safe checkpoint;
- пути к immutable artifacts;
- рекомендуемый штатный `next_command`, если его дал engine.

Не включать auth tokens, client secrets, query strings с credentials или содержимое
`.env`.

## 8. Актуальные внешние источники Walmart

Engine, а не оператор, остаётся runtime authority по pinned spec/policy version. Эти
ссылки нужны для проверки evidence и понимания gates, но не разрешают прямой API call:

Список отражает текущий pinned eleven-domain screen, но не заявляет полноту всего
изменяемого policy universe Walmart. Reviewer обязан проверить актуальные официальные
страницы и остановиться при drift, новой применимой категории или неоднозначности.

- [Full Item Setup (`MP_ITEM`)](https://developer.walmart.com/us-marketplace/docs/create-a-new-item-full-item-setup)
- [Get Spec API](https://developer.walmart.com/us-marketplace/reference/getspec)
- [Item Search with `responseFormat=SPEC`](https://developer.walmart.com/us-marketplace/docs/item-search-for-the-walmart-catalog)
- [Item spec versioning](https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting)
- [Prohibited products policy](https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Prohibited%20products%20%26%20brands/Prohibited-products-policy%3A-overview?locale=en-US)
- [Food products policy](https://marketplacelearn.walmart.com/guides/Prohibited-Products-Policy%3A-Food-products)
- [Product claims policy](https://marketplacelearn.walmart.com/guides/prohibited-products-policy-product-claims)
- [Recalled products policy](https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-recalled-products)
- [Resold products policy](https://marketplacelearn.walmart.com/guides/prohibited-products-policy-resold-products)
- [Restricted and illegal products policy](https://marketplacelearn.walmart.com/guides/Prohibited-products-policy%3A-restricted-and-illegal-products)
- [Product details policy](https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-Detail-Page%3A-overview)
- [Product identifier policy](https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20setup/Choose-a-product-identifier)
- [Duplicate listings policy](https://marketplacelearn.walmart.com/guides/Policies%20%26%20standards/Product%20listings/duplicate-listings-policy?locale=en-US)
- [Image guidelines and requirements](https://marketplacelearn.walmart.com/guides/Item%20setup/Item%20content%2C%20imagery%2C%20and%20media/Product-detail-page%3A-Image-guidelines-%26-requirements?locale=en-US)
- [Account Health & compliance](https://marketplacelearn.walmart.com/guides/Getting%20started/Account%20settings/account-health-compliance-overview)
- [Selling privileges](https://marketplacelearn.walmart.com/guides/Getting%20started/Getting%20ready%20to%20sell/selling-privileges)
- [Shipping & fulfillment policy](https://marketplacelearn.walmart.com/guides/Seller%20Fulfillment%20Services/Shipping%20methods/Shipping-and-fulfillment-policy)
- [Pricing Rules](https://marketplacelearn.walmart.com/guides/Catalog%20management/Price%20management/Pricing-rules)

## 9. Короткий handoff для Claude Code

```text
Ты оператор готового Walmart new-SKU engine, не разработчик.
Работай только из выданного verified frozen release и сверяй его с externally pinned
expected release SHA.
Используй только npm run walmart:new-sku -- doctor|plan|stage|rotate-upc|certify|
dry-run|approve|apply|verify и точно следуй next_argv/next_command.
Не редактируй engine/tests/schema/migrations и не используй SQL/curl/direct API.
Не придумывай evidence и не обходи Product Truth, policy или owner approval.
Каждый doctor/plan ограничен одним SKU; release-wide pilot cap равен двум, а второй SKU
требует нового owner-gated прохода. Партии 15–20 и schedule пока запрещены.
Apply-preview всегда останавливает workflow; live требует свежий doctor receipt,
exact apply-preview receipt и отдельный external owner permit SHA.
Hash-only permit не является owner approval; production trust root обязан быть pinned
в reviewed release, а private signing key не может находиться у Claude Code.
Claude Code также не запускает walmart:new-sku:owner-signer
init|doctor|inspect|sign и не получает доступ к owner-custody directory или macOS
Keychain.
После ambiguous/unknown POST не retry: только verify и ручная reconciliation.
Buyer worksheet никогда не передавай прямо в status: сначала exact
verify --mode seal-evidence с выданным verify receipt, затем его exact next_argv.
При любом fail-closed состоянии остановись и передай artifacts владельцу/Codex.
```
