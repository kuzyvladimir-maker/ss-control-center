# Walmart new-SKU engine — строгий runbook оператора

> **Операционный контракт v1.23, актуализирован 2026-07-29.** Этот документ подчинён
> [[product-catalog-architecture]], [[donor-catalog-execution-roadmap]],
> [[enrichment-division-of-labor]], [[product-truth-operator-runbook]],
> [[product-truth-consumer-cutover]] и [[product-truth-release-scope]]. Он описывает
> исполнение уже готового Walmart new-SKU engine. Сам по себе runbook не разрешает
> платный evidence run, production migrations, публикацию listing или расширение
> pilot.

## Текущий certified release

Текущий operator runtime:
`release-artifacts/walmart-new-sku-pilot-engine-2026-07-29-v33/release`.

- engine SHA-256:
  `fe76e6378a48c024f464d44a71ca7ebb88a7ffa1fb61c7f24eca1fcf37872946`;
- manifest SHA-256:
  `2593cd462ee1fdc2a46ab87bfdc4f672a45e6a6a68d7aa8221cd8356ce85127f`;
- certificate SHA-256:
  `806c75a69fbab9d05f9e1f38a2e3396ff90592cf4b35f731386af548a84c6f1f`.

Все releases до v33 не используются для нового execution. V26–v32 остаются
историческими audit artifacts. V33 включает прежний template-aware contract,
исправленный exact output path в `doctor` и shelf-stable classification для
`Crackers`, полный owner request и Pack of 8; frozen verification прошёл Product
Truth `519/519`, focused Walmart/Bundle Factory `108/108`, source TypeScript и
production build. Release v33 сам по себе не снимает production
gates: publication-rights evidence для count-accurate exact-source images, exact
staged-SKU/UPC checks, account/category evidence и каждый live SKU требуют своих
candidate-bound решений.
Template-aware contract выражает выбранный владельцем account-scoped Walmart
shipping template, exact customer charge, item/ship split, referral с landed total,
один `SKU_TEMPLATE_MAP` feed и обязательную post-publish association verification.
Текущие шесть owner previews по решению владельца используют free shipping. Канон:
[[walmart-new-sku-shipping-price-strategy]].
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

### 2.0. Точный pilot snapshot от 2026-07-27

Product Truth больше не является blocker этого pilot: exact Target content для
`RITZ Bits Cheese Sandwich Crackers Lunch Snacks - 8.8oz` активирован для donor
`75422f18-e3d2-4c62-ae62-7287aaa75119`, canonical variant
`cpv1:ba797cefb49f7b2bba2d45357619561ccd50d436466d8f8d95a9c147070194a9`
и observation
`pco:68af1a929a86d09772b7c10067c39e441e4d1358378980e0eae8ce4b8992d59e`.
Контент содержит exact title, UPC `00044000035457`, ingredients, allergens,
nutrition, shelf-stable category и 20 exact Target image URLs. Activation receipt:
`ss-control-center/data/walmart-new-sku-engine/candidates/20260727T133113Z-ritz-direct-target-content-activation/receipt.json`,
SHA-256
`bdbfb3b2103c65b894e63ff58841aaf8ae6e3efee54e403af917e7c2eade8aa1`.

V32 выполнил два независимых production
`doctor → plan → stage --mode apply-internal`. Это внутренние Bundle Factory drafts и
UPC reservations; Walmart не изменён:

- Pack of 2: wave `WM-PILOT-20260727-b305eb4f`, candidate
  `wm-e241c5c8317dc0b5`, SKU `WM-5861-AF0E`, UPC `756441906004`, item price
  target from the accepted owner preview `$33.13`, plan SHA
  `afb04afa75e203e49fea81f0668caccecdc8795f951765f94be8f13e1d48aaae`,
  stage SHA
  `f31fd5d46b6133ca398035913e32f0aa02d7e50360b73f32ce07e0ba6e70c97c`;
- Pack of 3: wave `WM-PILOT-20260727-a3d70341`, candidate
  `wm-753c7be4172d0da9`, SKU `WM-E031-D5C4`, UPC `756441906011`, item price
  target from the accepted owner preview `$40.36`, plan SHA
  `e6db2d2c675fb51dd790f04b2cd927056487f96976c2a7500833dac06a65db53`,
  stage SHA
  `b467491c2b0250d2e7697bceb7256486baedfb25ac39b86a7a652bffe923fc3a`.

Обе proposed цены используют free shipping и owner formula: goods + `$1.50` packaging +
`$8.78` seller label + `15%` referral, при target contribution margin `30%`.
Stage ещё не запечатывает цену: exact cents входят в certification только вместе с
fresh template/comparable/cost evidence.
Fresh Walmart reads нашли exact Product Type `Snack Crackers` в current spec
`5.0.20260501-19_21_29-api`; `Crackers` как Product Type отклонён Get Spec и не
используется. Выбранный pilot template — active free `Default Template`, ID
`202402999000149568`, normalized snapshot SHA
`b009dc3f7d7eeba2ece251d8743cb6f404e1f2c86a19fbcf5d5ebc7fa0d84a1b`.
Перед certification template/account reads повторяются, потому что mutable Walmart
настройки нельзя подменять датированным snapshot.

UPC reservations истекают `2026-07-28T13:52:56.990Z` и
`2026-07-28T13:55:59.720Z`. Если цепочка не дошла до следующего валидного state до
этих timestamps, оператор не исправляет JSON и не назначает UPC вручную: он следует
новому `doctor` и exact recovery path, который выдаст движок. `rotate-upc` допустим
только после exact SPEC evidence `MP_ITEM_MATCH`, а не просто из-за expiry.
Doctor receipts этого stage-run истекают `2026-07-27T14:22:08.353Z` и
`2026-07-27T14:23:56.721Z`; после этих timestamps они только audit evidence. Любой
дальнейший gate, которому нужен fresh doctor, создаёт новый receipt в новом пути.

До `certify --mode seal-evidence` остаются только реальные внешние evidence:
Seller Center health + ingestible-products privilege, resale/image rights,
актуальная registry/assignment authority для каждого UPC, physical packed
measurements, country of origin с label/manufacturer evidence, expiration/lot SOP,
fulfillment center/lag и fresh policy/recall review. Их запрещено считать
подтверждёнными на основании устного разрешения «делай всё».

Owner-only preview/readiness gallery version 9:
`https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`, source commit
`d5daebe4e01161335416dabc4d5e717a9cd976d4`.

Последний production `doctor` подтвердил:

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
- полный свежий all-status ITEM catalog и точное mirror-соответствие являются
  обязательным duplicate/recipe/SKU/UPC guard нового SKU. Они не являются product
  donor: товар, контент и допустимый вариант по-прежнему берутся только из Product
  Truth. Перед certification движок дополнительно делает point-in-time проверки
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
- exact canonical Walmart candidate для RITZ существует и два bounded pilot draft
  уже staged; другие owner-preview товары не являются автоматически canonical
  candidates и не расширяют pilot scope.

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
3. ⛔ Исторический owner decision
   `owner-chat:2026-07-23:product-truth-donor-only-exact-sku-upc-preflight`
   отменял обязательный полный ITEM v6 seller-catalog gate. Product source — только
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
   Старый one-shot ITEM v6 executor остаётся только audit evidence и не исполняется.
   **Этот пункт superseded текущей основной целью чата:** successor reissue-v2 может
   выполнить ровно один externally authorized report-create POST; full all-status
   seller catalog снова обязателен как отдельный duplicate guard, но никогда не как
   донорский источник товара или контента.

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
одну связанную publication operation: один `MP_ITEM` submit и один
`SKU_TEMPLATE_MAP` submit для того же SKU и exact выбранного template. ITEM v6 report
request и catalog activation не запускаются.
Подпись одного domain нельзя переиспользовать в другом. Перед live listing POST
владелец видит точные SKU, UPC,
item payload, shipping-template association payload, fulfillment center, store и
действие «один листинг + одна его template-привязка» и подтверждает именно эти bytes.

Готовый owner-only offline signer находится в mutable Codex workspace:
`scripts/walmart-new-sku-owner-signer.mjs`. Он:

- не содержит Walmart credentials, DB/provider/model/network клиентов;
- не требует от владельца придумывать, вводить или хранить пароль и ничего
  секретного не печатает;
- создаёт зашифрованный private key только во внешней owner-custody директории вне
  repository, а случайный machine secret сохраняет в macOS login Keychain;
- показывает exact one-SKU summary до подписи;
- отклоняет delist/reprice/purchase/schedule, больше одного submit каждого
  разрешённого feed type, другой store,
  изменённый request/hash и любой расширенный scope;
- выдаёт только 64-byte detached signature, которую owner/Codex-only assembly заново
  проверяет против pinned public key и всех engine artifacts.

Тот же signer принимает отдельный domain
`WALMART_ITEM_V6_CATALOG_ACTIVATE`. В этом режиме он независимо разрешает только
атомарную store-scoped замену `WalmartCatalogItem` и diagnostic `WalmartReport` из
exact sealed all-status source. Он fail-closed отклоняет любые Walmart/provider
calls, listing publish/delist, reprice или purchase. Catalog approval не может быть
использован как publication permit, и наоборот.

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
  `/Users/vladimirkuznetsov/SS Command Center/release-artifacts/walmart-new-sku-pilot-engine-2026-07-29-v33`;
- engine SHA-256:
  `fe76e6378a48c024f464d44a71ca7ebb88a7ffa1fb61c7f24eca1fcf37872946`;
- manifest SHA-256:
  `2593cd462ee1fdc2a46ab87bfdc4f672a45e6a6a68d7aa8221cd8356ce85127f`;
- certificate SHA-256:
  `806c75a69fbab9d05f9e1f38a2e3396ff90592cf4b35f731386af548a84c6f1f`.

Release read-only, self-verify прошёл; frozen Product Truth certification —
`519/519`, focused Walmart/Bundle Factory regression — `108/108`.
Source TypeScript и production build прошли до freeze; frozen root намеренно
не включает TypeScript dev dependency.
Production read-only account probe дополнительно разобрал все `11` active store1
templates; free = `3`, Walmart writes/DB writes/paid-provider calls = `0`.
Интеграция доказала ровно один fake `MP_ITEM` POST и один связанный
`SKU_TEMPLATE_MAP` POST,
exact association read-back, receipt-bound buyer seal → `BUYER_VERIFIED/LIVE`,
replay без дополнительных POST и
отдельный blocked-doctor diagnostic, который нельзя использовать как receipt.
Новый release фиксирует owner Image Truth contract: exact variant/package artwork
не ниже `99%`, generative package redraw и added overlay запрещены, multipack
показывает ровно sealed `N`, source/output/unit SHA-256 связаны, MAIN целится в
`95%` длинной стороны и допускается только в диапазоне `90–97%` с белым краем.
Image rights остаётся отдельным gate. Одновременно release сохраняет owner commercial
contract: contribution margin `30%` после goods, packaging, seller shipping label и
Walmart referral `15%` с landed total. Free template оставляет всю required total в
item price; платный template вычитается из item price без изменения required total.
Exact Walmart comparable остаётся warning, а не внутренним hard reject. Официальный
Walmart pricing risk при этом не исчезает. Release разрешает исполнение frozen CLI,
но не снимает production owner gates и не разрешает `apply --mode live`.
Certificate decision:
`PRODUCTION_TEMPLATE_COMPATIBLE_ENGINE_RELEASED_OWNER_PREVIEW_READY_LIVE_PILOT_REMAINS_OWNER_GATED`.

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
12. Внешний owner permit v3 — отдельный Ed25519-signed authority artifact после
    apply-preview. Hash-only v1 и item-only permit v2 всегда отвергаются. Поле
    `next_command: null` перед этим gate означает буквальную остановку Claude Code.
13. Shipping template выбирает владелец в Bundle Factory после Walmart account.
    Оператор переносит только сохранённый exact template snapshot в созданный
    certification worksheet и не выбирает «лучший» template сам. Перед sealing
    engine требует fresh active status, exact store index, rate scenarios и snapshot
    hash. Для текущих шести preview owner selection — free shipping.

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
  --pack-count <EXACT_PACK_COUNT_1_TO_500> \
  --zip 33765 \
  --as-of <EXACT_ISO_UTC_TIMESTAMP> \
  --max-price-age-hours 24 \
  --expected-engine-release-sha <EXACT_ENGINE_RELEASE_SHA256> \
  --release-manifest /ABSOLUTE/RELEASE/release-manifest.json \
  --release-manifest-sha /ABSOLUTE/RELEASE/release-manifest.sha256 \
  --item-report-catalog-source /ABSOLUTE/PATH/FRESH-all-status-catalog.json \
  --expected-item-report-catalog-source-sha256 <EXACT_FILE_SHA256> \
  --out /ABSOLUTE/NEW/PATH/doctor.json
```

`--as-of` обязателен, должен быть canonical ISO UTC, не находиться в будущем и на
момент запуска быть не старше 15 минут. Для первого publish pilot `--limit` всегда
`1`; `--pack-count` принимает точное целое количество от `1` до `500`, включая
owner-requested Pack of 8.

Doctor принимает абсолютные пути к `release-manifest.json`, его SHA sidecar и к
свежему byte-pinned all-status seller catalog source. Оба catalog-флага обязательны;
source, DB mirror, account/credential scope и связанный `WalmartReport` должны точно
совпасть и быть не старше 24 часов. Doctor сверяет release до DB/Walmart access,
читает Product Truth и запечатывает полный catalog guard плюс staged SKU/UPC
point guard. Receipt schema — `walmart-new-sku-doctor-receipt/1.8.0`.

Продолжать разрешено только когда одновременно:

- `ready_for_plan: true`;
- `infrastructure_ready_for_pilot: true`;
- `ready_for_live_apply: false` — `doctor` принципиально не подменяет собой sealed
  certification, fresh dry-run, owner approval и apply-preview review;
- `blockers: []`;
- `store.configured: true`;
- `product_truth.schema_ready: true`;
- `publish_lifecycle.canonical_schema_ready: true`;
- `duplicate_guard.mode: "FULL_ALL_STATUS_CATALOG_AND_EXACT_IDENTIFIER_PREFLIGHT"`,
  `full_seller_catalog_required: true`, `all_statuses_included: true` и непустые
  `binding_id`, `body_sha256`;
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

Если current canonical candidate отсутствует, v33 дополнительно возвращает
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
запрещено. По owner contract v33 локальный sealed Product Truth projection для RITZ
даёт pack-of-2 `$33.13` и pack-of-3 `$40.36` при exact `30%` contribution margin.
Это owner preview, а не fresh production doctor receipt и не разрешение публикации.
Если свежий v33 doctor не находит canonical candidate, оператор останавливается при
`NO_CURRENT_CANONICAL_PILOT_CANDIDATES` и следует `next_command: null`.

Если `doctor` запущен с `--out`, при этой остановке v33 не создаёт запрошенный
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

Plan обязан иметь schema `walmart-new-sku-plan/1.8.0`, быть связан с exact fresh doctor
receipt `1.8.0`, тем же full all-status seller-catalog authority и содержать ровно одного
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
`walmart-new-sku-certification-input/1.8.0`, certification
`walmart-new-sku-certification/1.12.0`, structured policy evidence
`walmart-new-sku-policy-review-evidence/1.2.0`, policy snapshot
`walmart-us-prepublication/2026-07-26.1`, а embedded prepublication contract —
`walmart-prepublication-evidence/1.2.0`. Doctor receipt и plan имеют версии
`walmart-new-sku-doctor-receipt/1.8.0` и `walmart-new-sku-plan/1.8.0`; внешний permit
— `walmart-new-sku-owner-permit/3.0.0`.

Каждый image row дополнительно содержит exact output/source/unit SHA-256,
`construction_method`, `generative_model_used=false`,
`package_artwork_unchanged=true`, `added_graphics_or_text_overlay=false`,
`exact_variant_identity_match_bps>=9900`, отдельные `IMAGE_TRUTH` и `IMAGE_RIGHTS`
evidence refs. Для homogeneous multipack количество
`rendered_unit_source_sha256s` обязано быть равно sealed pack count. Оператор не
подменяет это ручным утверждением и не использует сгенерированный дизайн упаковки.

Каждый операторский факт заполняется только exact evidence, реально предоставленным
или проверенным для этого варианта/SKU:

- цена, packaging/shipping costs и shipping-in-price;
- свежий не старше семи дней exact-variant comparable с линейной нормализацией
  candidate/comparable pack counts; proposed customer total обязан математически
  совпадать с `item price + exact customer shipping charge`. Положительная стоимость
  seller shipping label является отдельным cost; referral считается с landed total.
  Цена обязана давать не менее `3000 bps` contribution margin после goods,
  packaging, shipping label и category-correct referral для каждого разрешённого
  template scenario. При одинаковых speed/coverage/total free shipping является
  default; paid shipping требует exact experiment/exception disposition по
  [[walmart-new-sku-shipping-price-strategy]].
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

Это единственный путь, который может отправить связанную пару: multipart `MP_ITEM`
feed, затем один `SKU_TEMPLATE_MAP` feed для того же SKU, выбранного template ID и
fulfillment center. Нельзя вызывать endpoints напрямую. До первого POST engine
выполняет свежий Get Spec, payload replay, проверку exact association payload,
approval/Ed25519 permit fence, current engine-release hash, release-wide two-slot cap
и durable submission-attempt fence. Permit v3 подписывает hashes обоих payload.
Подпись повторно проверяется непосредственно перед `/feeds`; обычный callback либо
самостоятельно вычисленный SHA POST не разрешает.

Сохранить `apply-live-*.json`, оба request/payload hash, оба correlation/feed ID и
durable attempt ID. Feed `ACCEPTED` или `PROCESSED` ещё не означает, что listing
`LIVE` или что template association уже распространилась.

### 4.10. `verify` — lifecycle и buyer-visible proof

Сразу после live apply и затем штатно по `next_command`:

```bash
npm run walmart:new-sku -- verify \
  --certification /ABSOLUTE/PATH/certification.json
```

`verify` не отправляет feed. Он опрашивает seller state, read-only
`POST /v3/items/associations`, reconciles durable lifecycle и создаёт
`verify-*.json`. Listing считается `LIVE` только когда seller state
`PUBLISHED/ACTIVE` связан с exact SKU/item, Walmart вернул exact выбранные template ID
и fulfillment center и есть свежая immutable buyer-page evidence. Пока association
распространяется, статус остаётся `PENDING`, а engine выдаёт только безопасный
повторный `verify`.

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
SHA-256. Receipt schema `walmart-new-sku-verify-receipt/1.2.0` также связывает exact
certification SHA, payload SHA, seller-account fingerprint, deterministic idempotency
key, submission attempt ID и exact shipping-template association outcome. Повторный initial verify выпускает новую receipt-bound
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

## 10. Bundle Factory Product Truth enrichment fallback

До `walmart:new-sku doctor` Bundle Factory может обнаружить, что exact donor
существует, но ему не хватает обязательного content/price evidence. Тогда web UI
может выполнить готовый BF-W3 workflow:

```text
readiness → no-spend doctor → no-spend plan → displayed exact quote
→ local owner click/signature → sequential enrichment → readiness recheck
→ original Generate
```

Это не Walmart listing publication и не часть `apply --mode live`. Claude Code
не редактирует BF-W3, не подписывает quote, не получает owner key/Keychain и не
запускает provider adapter напрямую. При `AMBIGUOUS`, `FAILED` либо
`next_command: null` автоматического retry нет.

Во время paid execution UI обязан показывать durable progress, а не одно слово
`ENRICHING`: текущий товар `X/N`, точное название, этап (`balance`, exact Walmart
price, exact content, Product Truth reconciliation), completed/stopped counts,
фактически использованные provider credits, timestamp и freshness worker
heartbeat. Refresh браузера восстанавливает эти данные из append-only control
events; он не создаёт новый run и не разрешает replay.

Product Truth content является channel-independent. Если current versioned
read-contract уже выбирает полный exact-variant content, созданный до sealed
plan (например Target или manufacturer evidence), BF-W3 может после fresh exact
Walmart price завершить товар без Unwrangle detail. Content observation всё
равно обязан принадлежать exact donor/canonical variant/variant decision и
пройти ingredients, nutrition, allergens и gallery gates. Price proxy либо
соседний вариант никогда не становится content truth.

Этот progress/reuse contract активирован production release
`product-truth-web-control-2026-08-01-r13` (commit `093fc4f151955e69979063aef22194b53e06950c`,
deployment `dpl_5vLPKQMJ77GAbeBDME9SvfPJsJcf`). Он не меняет operator boundary:
старый terminal batch не retry, новый exact quote требует отдельного owner click,
а Walmart publication остаётся отдельным SKU-bound gate.

Если readiness даёт `matched_variants=0`, BF-W3 exact-product quote неприменим:
нужна отдельная owner-gated Phase 2 demand-expansion campaign. Нельзя создавать
параллельный consumer catalog или использовать legacy retailer harvest как
скрытый fallback.
