# Product Truth operational runner — runbook оператора

> **Операционный контракт v1.5, 2026-07-20.** Этот runbook подчинён
> [[product-catalog-architecture]] и [[donor-catalog-execution-roadmap]]. Он описывает,
> как оператор исполняет уже готовый движок, но не даёт разрешения на production,
> платный прогон или изменение бизнес-данных. Каждый такой запуск по-прежнему требует
> соответствующий owner gate.
>
> Перед передачей этого workflow Claude Code обязательно выполнить Git boundary и
> clean-checkout acceptance из [[product-truth-release-scope]]. Зелёный dirty
> worktree не считается переданным операторским движком.

## 1. Назначение и граница роли

Разрешённый операторский контур Product Truth состоит только из готовых npm-команд:

```bash
npm run product-truth:census -- ...
npm run product-truth:manifest -- ...
npm run product-truth:migrations -- <plan|apply|recover-report> ...
npm run product-truth -- <doctor|backfill-plan|backfill-apply|readiness|plan|execute|resume|status|report> ...
node /ABS/FROZEN-VERIFIER/verify-and-run-matcher-replay.mjs <sealed-v2.2-args>
```

`matcher-replay` является единственным исключением из обычного npm-entrypoint:
финальный v2.2 operator handoff запускается только через sealed runtime wrapper из
§4.0.3. Direct `npm run product-truth -- matcher-replay` и direct runner запрещены,
потому что сами по себе не доказывают exact runtime и восемь provenance inputs.

**Claude Code здесь только оператор готового CLI.** Он может проверить готовность,
создать sealed plan из уже переданных входов, исполнить явно утверждённый run,
посмотреть статус и сохранить отчёт. Он не проектирует, не дописывает и не чинит
движок во время операционного прогона.

Claude Code запрещено:

- редактировать runner, matcher, source routing, queue, harvest, ledger, migrations,
  schema, plan/approval contracts или тесты;
- подменять отсутствующий операторский шаг собственным скриптом, SQL, `curl`, браузером,
  API-вызовом или ручным retailer-harvest;
- использовать `scripts/cogs-enrich-batch.ts` или любой другой legacy COGS/enrichment
  entrypoint;
- придумывать scope, расширять список SKU, использовать `--all`, implicit scope,
  ambient `DATABASE_URL` или «обработать всё оставшееся»;
- менять budget ceilings, reserve floor, provider operations, source policy либо
  создавать owner approval от имени владельца;
- использовать BJ's при любых условиях; Sam's Club/Costco разрешены только в отдельном
  owner-approved club budget bucket с `allowClubs=true` и exact retailer list, а в
  обычном canary/wave остаются выключенными;
- обходить plan SHA, authoritative manifest, exact DB fingerprint, approval,
  confirmation, fresh balance evidence, ledger или immutable artifact directory;
- автоматически публиковать, делистить, репрайсить/min-max, создавать корзину,
  заказывать или покупать товар;
- для `TARGETED_WALMART_EVIDENCE` самостоятельно выбирать/исправлять canonical
  identity, редактировать engine-generated request/plan либо подменять связанный
  legacy donor/offer. Owner-proposed identity приходит отдельным внешним exact-файлом;
  Claude Code только передаёт его путь готовому `doctor`.

Если CLI или входные артефакты не позволяют продолжить, Claude Code фиксирует точную
ошибку и передаёт её владельцу/Codex. **Ошибка не является разрешением редактировать
движок.** Изменения кода выполняются отдельно разработчиком, проходят тесты и только
после этого новая версия снова передаётся оператору.

## 2. Кто готовит входы

До передачи run оператору владелец/Codex должны подготовить:

1. Canonical owner-attested `phase1-connected-store-census/v1`: Amazon slots 1–5 и
   каждый явно поддерживаемый Walmart slot перечислены как `CONNECTED`,
   `NOT_CONNECTED` или `UNRESOLVED`; capture связан SHA-256 с sanitized Store-directory
   и deployment-config snapshots. Любой `UNRESOLVED`, отсутствующий слот или конфликт
   блокирует authoritative scope.
2. Authoritative `phase1-authoritative-scope-manifest/v3` на grain
   `(channel, positive storeIndex, raw SKU)` с нулём blockers. Его policy должна
   фиксировать `builderPolicyVersion=phase1-scope-builder-policy/1.3.0`, embedded census
   и его content/capture SHA, disposition schema, `dispositionInputSha256`,
   `requiredScopesSha256` и `contentSha256` exact bytes каждого report. Required scopes
   выводятся только из census; ручной competing denominator запрещён. Локальный hash не
   заменяет доказательство, что reports реально получены из Amazon/Walmart и покрывают
   все подключённые scopes.
3. Exact plan-request с явными listing keys, новым `runId`, сроком действия, source
   policy, provider ceilings, reserve floor и wall-clock limit.
4. Явное решение owner gate о canary/wave и бюджете.
5. После `plan` — canonical owner approval, связанную с точным `plan.sha256`, target
   fingerprint, permit и свежим balance evidence.
6. Exact execution confirmation из approval и sealed plan.
7. Точный DB URL и имя env-переменной, в которой уже находится auth token. Секрет
   нельзя помещать в URL, аргумент команды, лог или артефакт.

Для узкого `TARGETED_WALMART_EVIDENCE` дополнительно нужны один exact
`DonorProduct.id`, поисковая строка именно этого варианта, новый `runId`, expiry не
дальше 24 часов и owner-approved Unwrangle reserve floor. Если eligible donor ещё не
имеет exact alias, `doctor` сам выводит консервативную identity из sealed
brand/title/size bytes и сразу создаёт request. Ручной identity-файл,
`--canonical-identity` и техническая аттестация владельца запрещены. Внешнее решение
владельца требуется только для точного metered plan, бюджета и provider permit.

Историческая Walmart ITEM v6 reconciliation session остаётся quarantined read-only:
неизвестный параллельный процесс добавил read-only GET и конфликтующие поздние
`CAPTURED`/`ABSENCE_ONLY` artifacts поверх terminal `PAGINATION_INCOMPLETE`. Её final,
permit bytes и custody root запрещено использовать для source compile или replay.

Отдельный successor gate уже потреблён владельцем/Codex: один shared OAuth transport
создал request `019f9f34-9bad-7390-b236-341290db319a`, затем только continuation GET-ами
довёл его до `READY`, скачал и скомпилировал exact ITEM v6 bytes. Второй create не
выполнялся. Этот завершённый G4 не является повторно используемым разрешением на
report-create. Любая будущая replacement-сессия снова требует нового exact gate и
собственной immutable custody chain.

Оператор не дополняет эти входы «по здравому смыслу». Отсутствующий или противоречивый
вход — fail closed.

### Граница доверия owner artifacts в Product Truth v1

Поля `authority="OWNER"` и `approvedBy="owner"`, SHA-256 sidecars, exact binding
checks и deterministic confirmation tokens подтверждают только каноническую форму,
целостность байтов, scope/time binding и freshness переданного artifact. Они не
являются цифровой подписью и не аутентифицируют его автора.

Census attestations, scope dispositions, migration/backfill approvals, metered-run
approvals и consumer activations создаются вне workspace Claude Code, остаются под
custody владельца и передаются оператору как неизменяемые bytes с независимо
сообщённым SHA-256. Claude Code может только использовать их. `authoritative`,
`validated`, `sealed`, `owner-sealed` и `owner-approved` в Product Truth v1 означают
«проверено относительно externally owner-custodied inputs», а не «криптографически
аутентифицировано владельцем». До выбора и pinning отдельного Product Truth trust root
нельзя переносить сюда тестовый или Walmart signing key и нельзя заявлять техническую
owner authentication.

Для `EVIDENCE_VERIFIED_BOOTSTRAP` owner approval не является identity attestation.
Он разрешает только конкретный metered plan, бюджет и provider permit. Exact identity
доказывает сам движок: сначала детерминированная conservative identity из sealed
legacy bytes, затем обязательное свежее независимое Walmart evidence до canonical
write. Approval другого plan SHA не переносит разрешение на расход или execution.

## 3. Неизменяемые свойства одного listing-scope run

Один run жёстко связан со следующими значениями:

- `runId` и mode (`CANARY` или `WAVE`);
- полный canonical manifest и его SHA-256;
- упорядоченный exact target set;
- DB target fingerprint;
- source policy и provider ceilings;
- owner `approvalId`, permit, balance evidence и execution confirmation;
- максимум одна попытка на listing и concurrency 1;
- запрет publish/delist/reprice/purchase.

Нельзя заменить один из этих элементов «эквивалентным» файлом или другим URL. Нельзя
перенести approval на другой plan, run, DB или wave. Content и price/COGS проверяются
независимо; price estimate не становится content truth.

### 3.1. Неизменяемые свойства `TARGETED_WALMART_EVIDENCE`

Targeted plan содержит ровно один уже существующий donor и ровно один его direct
first-party Walmart offer. Он фиксирует режим identity:

- `EXISTING_EXACT` — canonical variant и immutable exact decision уже существуют;
- `EVIDENCE_VERIFIED_BOOTSTRAP` — до run нет canonical alias/decision; движок
  детерминированно выводит conservative identity из exact brand, полного post-brand
  title signature и нормализованного размера. Identity вместе с full-row legacy
  donor/offer bytes, Walmart numeric item ID и нормализованным product URL sealed в
  request/plan.

Общие hard limits: ZIP `33765`, price TTL `86400000 ms` (`24h`), минимум `2` exact
gallery images, wall clock ровно `180000 ms`, concurrency `1`, максимум одна попытка.
Provider ceilings неизменяемы: Oxylabs `query` — максимум `1` call и `1` unit;
Unwrangle Walmart `detail` — максимум `1` call и `2.5` units с утверждённым reserve
floor. OFF, clubs, BJ's, fanout, automatic replay, publish, delist, reprice и purchase
запрещены.

Bootstrap не может записать canonical variant/decision до свежего exact Oxylabs
search. Transaction scope guard разрешает максимум один variant, один decision и
материализацию только выбранного product; новый или другой donor/offer, alias conflict
и любой identity drift откатывают transaction. Существующий complete exact content
можно переиспользовать только после свежего price evidence и только если detail receipt
для run ещё отсутствует. Если detail attempt уже начат, старый content не превращает
его в успех и detail не replay.

## 4. Команды

### 4.0. Подготовка authoritative denominator, schema и backfill

#### 4.0.1. `product-truth:census` — trusted connected-store census

До owner attestation оператор может только локально подготовить exact canonical
capture bytes и их SHA-256. Этот режим не читает/создаёт owner-файл и не объявляет
результат authoritative:

```bash
npm run product-truth:census -- \
  --prepare-owner-attestation \
  --as-of 2026-07-19T12:00:00.000Z \
  --capture /ABS/sanitized-connected-store-capture.json \
  --store-directory-snapshot /ABS/store-directory.snapshot \
  --deployment-config-snapshot /ABS/deployment-config.snapshot \
  --out-dir /ABS/artifacts/connected-store-attestation-preflight-NEW
```

Exit 0 здесь означает только `ATTESTATION_READY`: ноль non-attestation blockers,
immutable normalized `*.capture.json` и exact `captureSha256`. Владелец лично
проверяет эти bytes и создаёт отдельный attestation, связанный с этим hash.

```bash
npm run product-truth:census -- \
  --as-of 2026-07-19T12:00:00.000Z \
  --capture /ABS/sanitized-connected-store-capture.json \
  --owner-attestation /ABS/owner-census-attestation.json \
  --store-directory-snapshot /ABS/store-directory.snapshot \
  --deployment-config-snapshot /ABS/deployment-config.snapshot \
  --out-dir /ABS/artifacts/connected-store-census-NEW
```

Команда работает только с локальными sanitized files, проверяет exact source bytes и
owner attestation, не читает credentials/DB/marketplace и не делает network calls.
Результат authoritative только при полном перечислении supported slots и нуле blockers.
Текущий v1-контракт проверяет hash/identity/time и `authority="OWNER"`, но не
криптографическую подпись. Поэтому custody заполненного attestation остаётся внешним
обязательным доказательством; Claude Code не создаёт и не изменяет этот файл.

#### 4.0.2. `product-truth:manifest` — authoritative live-listing scope

```bash
npm run product-truth:manifest -- \
  --as-of 2026-07-19T12:00:00.000Z \
  --census /ABS/connected-store-census-NEW/phase1-connected-store-census.json \
  --disposition /ABS/owner-scope-disposition.json \
  --amazon store1=/ABS/amazon-store1-all-listings.tsv \
  --walmart store1=/ABS/walmart-store1-item-catalog.csv \
  --out-dir /ABS/artifacts/phase1-manifest-NEW
```

`--amazon`/`--walmart` повторяются для каждого census-required `IN_SCOPE` store.
Legacy `--required-amazon`/`--required-walmart` запрещены: denominator нельзя сузить
флагом. Команда локальная, пишет immutable JSON/CSV/census/checksum bundle и выходит 2,
если manifest blocked.

#### 4.0.3. `matcher-replay` — offline сертификация matcher

```bash
node '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/verify-and-run-matcher-replay.mjs' \
  --manifest '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/runtime-manifest.v2.2.claude-operator.json' \
  --expected-manifest-sha256 2927749ae03fc563175682afae83f96bfe037cd383c0530cce6929e9df812d11 \
  --expected-wrapper-sha256 7022edca836d0bb563a21bf7d0dd66a321c951d8fb97de652e084a98d6669dfc \
  --engine-root '/private/tmp/product-truth-matcher-consensus-v22.f2xgHH/repo/ss-control-center' \
  --source-artifact '/Users/vladimirkuznetsov/SS Command Center/ss-control-center/_gen_enriched_state.json' \
  --corpus '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/corpus.json' \
  --review-a '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/review-a.json' \
  --review-b '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/review-b.json' \
  --blind-task '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/prepared-v21-final/review-task-a.json' \
  --frozen-blind-review-a '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reviews/codex-review-a/review-a-decision.json' \
  --frozen-blind-review-b '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reviews/codex-review-b/review-b-decision.json' \
  --reconciliation-map '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/reconciliation-v21-final/canonical-adjudication-map.json' \
  --out '/Users/vladimirkuznetsov/SS Command Center/release-artifacts/product-truth-matcher-adjudication-2026-07-19/replay-v22-post-blind-consensus-claude-operator'
```

Это **единственная** команда текущего matcher handoff. Wrapper не принимает passthrough
args и до runner проверяет clean exact commit
`78e0664908cd37c3746a311084f4826a031b3658`, tree
`7a2eb1a6bbc0886fec33898268db3036e240aa22`, runtime source hashes, sealed manifest и
восемь immutable inputs: raw source, corpus, post-blind acceptance A/B, original blind
task, frozen blind review A/B и reconciliation map. Superseded v2.1 и pre-map-fix v2.2
runtimes fail closed. Preflight failure возвращает `78` и не создаёт output.

Exit 0 допустим только для полного `PASS_FULL`: общий `certification=PASS`, semantic
matcher `PASS`, evidence `COMPLETE`, full-corpus truth `PASS` и ноль unresolved.
Qualified partial либо недостаточный denominator возвращает exit 2 и общий
`certification=FAIL`, даже если semantic matcher на resolved rows имеет `PASS`.
Unresolved rows всегда `BLOCKED_FROM_MATCHER`; operator не сокращает результат до
«Gate 1 passed». При любом exit 2 Claude Code сохраняет immutable report/index,
останавливается и не меняет engine/corpus/reviews.

Codex уже выполнил отдельный sealed manifest на тех же bytes: report SHA-256
`29aa05aaf8590fe09905e3b85f4d55f4dcc46e01a9b92cdec59deaf47e4fa8d5`, index SHA-256
`2bffe77e99c1a943e85ff7295226876528ba6bfa00362d14d68da073113cc937`, semantic
`304/304 PASS`, quarantine `300 resolved / 86 unresolved`, golden `2 cases / 4
comparisons PASS`, only blocker `UNRESOLVED_EVIDENCE_PRESENT`. Ожидаемый результат
Claude-команды такой же: exit `2`, evidence `PARTIAL`, full truth `BLOCKED`.

V2.2 честно фиксирует `POST_BLIND_RECONCILED_CONSENSUS`: обе acceptance имеют
`priorExposure=true` и `blindAgreementClaimed=false`; исходное blind comparison равно
`80 exact / 181 structural disagreement with same semantic result / 127 semantic
disagreement`. Это не два независимых согласованных blinded review.

Этот historical replay runtime навсегда остаётся на literal matcher version `1.2.0`.
Current operational source от 2026-07-22 использует отдельный matcher release
`canonical-product-match/1.2.1`, SHA точных implementation bytes и SHA release
manifest; read-contract `3.2.0` отвергает persisted `1.2.0`, неполные и mismatched
tuples. Это не разрешает production writes: они остаются закрыты до отдельного
owner-approved exact-eight migration/backfill и consumer cutover release. Offline
operator replay остаётся exact commit/tree/source-hash bound и не обновляется in place.

#### 4.0.4. `product-truth:migrations` — sealed schema activation

Read-only plan:

```bash
npm run product-truth:migrations -- plan \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --run-id EXACT_MIGRATION_RUN_ID \
  --approval-id RESERVED_OWNER_APPROVAL_ID \
  --out /ABS/artifacts/migration-plan-NEW
```

Owner-gated apply использует emitted `plan.json`/SHA, отдельный canonical owner
approval/SHA, exact V2 confirmation и новый report directory:

```bash
npm run product-truth:migrations -- apply \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --plan /ABS/migration-plan-NEW/plan.json \
  --plan-sha /ABS/migration-plan-NEW/plan.sha256 \
  --approval /ABS/migration-owner-approval.json \
  --approval-sha /ABS/migration-owner-approval.sha256 \
  --confirm 'APPLY_PRODUCT_TRUTH_MIGRATIONS_V2:EXACT_BOUND_VALUES' \
  --out /ABS/artifacts/migration-report-NEW
```

Claude Code не создаёт approval и не вычисляет замену «по смыслу»: exact token выдаётся
владельцем из bound plan/approval/target. Apply атомарен и сверяет schema/queue/writer
drift до записи. Успешный apply также создаёт в том же новом каталоге
`migration-certification.json` и `migration-certification.sha256`; следующий шаг
backfill обязан проверять именно эту пару вместе с sealed migration report, а не
принимать вручную составленную certification.

Если DB transaction была committed, но процесс завершился до записи filesystem
report/certification, единственный разрешённый recovery — read-only экспорт из
immutable `ProductTruthMigrationActivationReceipt` тем же sealed plan и в новый
несуществующий каталог:

```bash
npm run product-truth:migrations -- recover-report \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --plan /ABS/migration-plan-NEW/plan.json \
  --plan-sha /ABS/migration-plan-NEW/plan.sha256 \
  --out /ABS/artifacts/migration-report-recovered-NEW
```

`recover-report` не применяет SQL и не заменяет owner approval. Команда требует exact
durable receipt для plan SHA, повторно проверяет target, canonical eight-migration
release, activation-engine SHA, current exact schema и обе immutable ledgers, после
чего byte-exact восстанавливает `report` и `migration-certification`. Missing receipt,
schema/release drift или существующий output directory блокируют recovery; Claude Code
не повторяет `apply` и не собирает отчёт вручную.

#### 4.0.5. `backfill-plan` / `backfill-apply`

```bash
npm run product-truth -- backfill-plan \
  --manifest /ABS/phase1-manifest.json \
  --migration-certification /ABS/migration-report-NEW/migration-certification.json \
  --migration-certification-sha /ABS/migration-report-NEW/migration-certification.sha256 \
  --migration-report /ABS/migration-report-NEW/report.json \
  --migration-report-sha /ABS/migration-report-NEW/report.sha256 \
  --plan-id EXACT_BACKFILL_PLAN_ID \
  --expires-at 2026-07-20T12:00:00.000Z \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABS/artifacts/backfill-plan-NEW
```

`backfill-plan` подключается read-only и повторно доказывает canonical migration
set, обе migration ledgers и schema continuity. Exact full-database fingerprint
используется, когда shared schema не менялась. Если после Product Truth activation
общая БД получила отдельно управляемые additive surfaces, допустим только
`PROTECTED_PRODUCT_TRUTH_SCHEMA`: exact 8/8 migration definitions/receipts плюс
exact table/index/trigger set единственной backfill write surface
`ProductTruthListingScope`. Любой иной blocker или дополнительный/изменённый объект
на write surface останавливает plan. Sealed full live fingerprint повторно
проверяется до и внутри будущей write transaction. После отдельного owner approval:

```bash
npm run product-truth -- backfill-apply \
  --plan /ABS/backfill-plan-NEW/plan.json \
  --plan-sha /ABS/backfill-plan-NEW/plan.sha256 \
  --manifest /ABS/phase1-manifest.json \
  --approval /ABS/backfill-owner-approval.json \
  --approval-sha /ABS/backfill-owner-approval.sha256 \
  --confirm 'APPLY_PRODUCT_TRUTH_BACKFILL_V1:EXACT_PLAN_SHA:EXACT_APPROVAL_ID' \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABS/artifacts/backfill-report-NEW
```

Apply импортирует только immutable authoritative listing scopes. Legacy COGS не
повышается до canonical truth; отсутствующие canonical outcomes становятся artifact-only
owner review tasks. Никакого автоматического cost recompute/provider call здесь нет.

#### 4.0.6. `readiness` — полный read-only отчёт четырёх consumers

```bash
npm run product-truth -- readiness \
  --manifest /ABS/phase1-manifest.json \
  --as-of 2026-07-19T12:00:00.000Z \
  --max-price-age-ms 86400000 \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABS/artifacts/readiness-NEW
```

Команда читает весь denominator через один versioned contract и даёт отдельные
Bundle Factory, Listing Improvement, Unit Economics и Procurement статусы. Она не
активирует consumers, не ставит jobs и не вызывает providers.

### 4.1. `doctor` — проверка готовности

Local:

```bash
npm run product-truth -- doctor \
  --url file:/ABSOLUTE/PATH/product-truth.sqlite
```

Remote:

```bash
npm run product-truth -- doctor \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --auth-token-env TURSO_AUTH_TOKEN
```

`doctor` проверяет exact target и operational schema. Для remote обязательны и
`--allow-remote`, и явно названная env-переменная. CLI не читает DB URL из ambient env
и не печатает token. Отсутствующая migration/schema readiness блокирует исполнение;
оператор не применяет migration самостоятельно.

Schema gate и `product-truth-backfill-readiness/1.0.0` — разные доказательства.
Первый fail-closed проверяет наличие обязательных tables/columns/indexes/triggers/
foreign keys. Второй строит только read-only `READ_ONLY_NO_PAID_PLAN` для exact
manifest/migration certification/DB target и показывает coverage, активных writers,
unsettled receipts и integrity blockers. Readiness plan не применяет migrations, не
выполняет backfill и не является разрешением на `execute`. Если schema отсутствует,
оператор может продолжить только через отдельно owner-approved
`product-truth:migrations -- apply` из §4.0.4; ad-hoc migration/SQL запрещены.

#### 4.1.1. `doctor` — engine-generated targeted Walmart request

Этот режим используется только для одного заранее выбранного Walmart donor gap. Все
пути `--out` должны быть новыми и находиться вне read-only source root:

```bash
npm run product-truth -- doctor \
  --donor-product-id <EXACT_DONOR_PRODUCT_ID> \
  --query '<EXACT_QUERY_FOR_THIS_VARIANT>' \
  --run-id <NEW_EXACT_RUN_ID> \
  --expires-at <CANONICAL_ISO_UTC_NOT_MORE_THAN_24H> \
  --unwrangle-reserve-floor <OWNER_APPROVED_UNITS> \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/targeted-walmart-doctor-NEW-1
```

Команда делает только read-only DB inspection, ноль provider calls и ноль DB writes.
Она связывает DB target fingerprint, exact schema/migration set, текущий frozen source
release и exact donor graph. Допустим только один direct first-party Walmart offer с
`sellerName=Walmart.com`, numeric item ID и тем же нормализованным URL; pre-existing
detail-harvest lifecycle блокирует новый план.

Для `EXISTING_EXACT` команда переиспользует подтверждённый alias. Для eligible legacy
donor она в режиме `EVIDENCE_VERIFIED_BOOTSTRAP` сама выводит conservative identity
из sealed donor bytes. В обоих случаях команда записывает
`request.json`/`request.sha256` и выдаёт exact `next_argv` для plan. Любой
`--canonical-identity` отклоняется как retired input. Claude Code не редактирует
request и дальше использует только emitted `next_argv`.

### 4.2. `plan` — sealed plan

Обычный listing-scope plan строится offline из authoritative manifest:

```bash
npm run product-truth -- plan \
  --request /ABSOLUTE/PATH/canary-request.json \
  --manifest /ABSOLUTE/PATH/authoritative-phase1-manifest.json \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --out /ABSOLUTE/PATH/artifacts/canary-plan-NEW
```

В этом listing-scope режиме `plan` не подключается к DB и не вызывает провайдеров. Он
создаёт новый каталог:

- `plan.json`;
- `plan.sha256`;
- `approval-instructions.json`.

`--out` обязан указывать на **несуществующий** каталог с реальным, уже существующим
parent directory. CLI не перезаписывает артефакты. Если каталог уже существует,
нужно остановиться и выбрать новый путь, а не удалять/заменять старое доказательство.

После `plan` Claude Code не запускает `execute`, пока владелец не проверил exact scope,
источники, ceilings, reserve floor и не выдал canonical approval.

Targeted Walmart plan запускается только через exact `next_argv`, выданный предыдущим
`doctor`; `--manifest` для него запрещён:

```bash
npm run product-truth -- plan \
  --request /ABSOLUTE/PATH/targeted-walmart-doctor-NEW/request.json \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/targeted-walmart-plan-NEW
```

В отличие от listing-scope plan этот режим подключается **read-only**, заново сверяет
exact DB donor/offer bytes, отсутствие detail-harvest lifecycle, target/schema/
migration/release bindings и делает ноль provider calls/DB writes. Он также создаёт
`plan.json`, `plan.sha256` и `approval-instructions.json`. Для
`EVIDENCE_VERIFIED_BOOTSTRAP` instructions явно фиксируют machine-derived identity и
обязательное свежее exact Walmart evidence до canonical write. Owner approval
разрешает только exact metered plan. Plan нельзя исполнять без отдельного metered
approval, exact Oxylabs/Unwrangle permit, fresh Unwrangle balance evidence и exact
confirmation.

### 4.3. `execute` — один утверждённый run

```bash
npm run product-truth -- execute \
  --plan /ABSOLUTE/PATH/canary-plan-NEW/plan.json \
  --plan-sha /ABSOLUTE/PATH/canary-plan-NEW/plan.sha256 \
  --manifest /ABSOLUTE/PATH/authoritative-phase1-manifest.json \
  --approval /ABSOLUTE/PATH/canary-OWNER-approval.json \
  --confirm 'EXECUTE_PRODUCT_TRUTH_PLAN_V1:EXACT_PLAN_SHA:EXACT_APPROVAL_ID' \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/canary-execution-NEW
```

CLI до исполнения заново проверяет canonical bytes, plan SHA, полный manifest,
approval, confirmation, срок действия и DB fingerprint. Любое расхождение блокирует
run. Один listing обрабатывается за раз; завершённая/terminal работа не повторяется.

Финальный новый artifact directory содержит:

- `report.json` и `report.sha256`;
- `artifact-index.json` и `artifact-index.sha256`.

Хэши сохраняются и в durable run state. Отчёт считается доказательством только вместе
с exact plan, manifest и approval.

Для targeted Walmart plan manifest не передаётся:

```bash
npm run product-truth -- execute \
  --plan /ABSOLUTE/PATH/targeted-walmart-plan-NEW/plan.json \
  --plan-sha /ABSOLUTE/PATH/targeted-walmart-plan-NEW/plan.sha256 \
  --approval /ABSOLUTE/OWNER-CUSTODY/targeted-walmart-approval.json \
  --confirm 'EXECUTE_PRODUCT_TRUTH_PLAN_V1:EXACT_PLAN_SHA:EXACT_APPROVAL_ID' \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/targeted-walmart-execution-NEW
```

Перед первым paid call runner ещё раз проверяет frozen release, schema/migration set,
DB fingerprint, exact donor graph, owner approval/permit/balance, expiry и отсутствующий
harvest lifecycle. В bootstrap fresh exact search обязан пройти раньше любого canonical
write; transactional scope guard не позволяет выйти за один sealed donor/offer/
variant/decision. Любой incomplete/wrong-variant/non-local/3P outcome завершается
видимым blocker/terminal gap, а не синтезом или дополнительным источником.

### 4.4. `status` — состояние без изменения scope

```bash
npm run product-truth -- status \
  --run-id EXACT_RUN_ID \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --auth-token-env TURSO_AUTH_TOKEN
```

`status` показывает run/items/counts и spend ledger. Он не разрешает повторный запуск.
Оператор сохраняет точные terminal states, причины и фактический spend. Для targeted
lane результат также показывает единственный sealed evidence job и его receipt state.

### 4.5. `report` — проверяемый read-only отчёт

```bash
npm run product-truth -- report \
  --run-id EXACT_RUN_ID \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --auth-token-env TURSO_AUTH_TOKEN
```

Команда возвращает DB-derived inspection report с run, items, event chain и ledger.
Она не заменяет immutable execution artifacts и не создаёт разрешения на следующую
wave. Для targeted lane report обязан содержать реальную durable event chain и exact
donor/offer/identity/job bindings; пустой или восстановленный вручную список событий
не является evidence.

### 4.6. `resume` — только безопасно прерванный exact run

`resume` разрешён исключительно когда durable run имеет статус `interrupted` и CLI
может доказать отсутствие ambiguous paid outcome. Для listing-scope используются
**те же exact** plan, plan SHA, manifest, approval, confirmation и DB target, но новый
несуществующий output directory:

```bash
npm run product-truth -- resume \
  --plan /ABSOLUTE/PATH/canary-plan-NEW/plan.json \
  --plan-sha /ABSOLUTE/PATH/canary-plan-NEW/plan.sha256 \
  --manifest /ABSOLUTE/PATH/authoritative-phase1-manifest.json \
  --approval /ABSOLUTE/PATH/canary-OWNER-approval.json \
  --confirm 'EXECUTE_PRODUCT_TRUTH_PLAN_V1:EXACT_PLAN_SHA:EXACT_APPROVAL_ID' \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote \
  --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/canary-resume-NEW
```

Если plan/approval уже истекли, оператор не продлевает их и не создаёт замену. Нужны
ручная сверка и новое решение владельца.

Targeted resume использует те же exact artifacts, но без `--manifest`:

```bash
npm run product-truth -- resume \
  --plan /ABSOLUTE/PATH/targeted-walmart-plan-NEW/plan.json \
  --plan-sha /ABSOLUTE/PATH/targeted-walmart-plan-NEW/plan.sha256 \
  --approval /ABSOLUTE/OWNER-CUSTODY/targeted-walmart-approval.json \
  --confirm 'EXECUTE_PRODUCT_TRUTH_PLAN_V1:EXACT_PLAN_SHA:EXACT_APPROVAL_ID' \
  --url libsql://EXACT-DATABASE-HOST \
  --allow-remote --auth-token-env TURSO_AUTH_TOKEN \
  --out /ABSOLUTE/PATH/artifacts/targeted-walmart-resume-NEW
```

Он разрешён только когда durable lease/receipt chain доказывает единственный безопасный
неоткрытый следующий шаг. Уже закрытый search receipt переиспользуется; начатый,
settled или ambiguous detail call никогда не повторяется. `next_argv: null` означает
остановку и owner/Codex review.

## 5. Canary и production waves

Один `TARGETED_WALMART_EVIDENCE` run не является Phase 1 canary или wave и не разрешает
следующий donor. Для каждого следующего target нужны новый doctor/request/plan SHA,
новый budget approval/permit/balance evidence и новый immutable output chain. Ручная
owner identity attestation не используется. Его единственная цель — безопасно закрыть
один exact Product Truth gap; он никогда не публикует Walmart listing.

### Canary

Первый внешний прогон — отдельный `CANARY` на 5–10 exact listings с concurrency 1.
Набор должен включать single, multipack, mixed bundle, dry и frozen там, где они есть
в authoritative scope. Clubs выключены. После canary владелец вручную проверяет:

- отсутствие wrong-variant content;
- exact provenance и first-party offers;
- FACT/ESTIMATE/UNSOURCEABLE без подмены статусов;
- content completeness и terminal gaps;
- фактический spend против ceilings/reserve floor;
- отсутствие повторных paid attempts;
- plan/report/artifact hashes и event-chain integrity.

Canary не даёт автоматического разрешения на wave. Переход требует отдельного owner
gate.

### Waves

После принятого canary: 25 → 50 → 100 → controlled remainder. **Каждая новая wave —
новый независимый run** и требует:

- новый `runId` и exact request;
- новый `plan` directory и `plan.sha256`;
- новую owner approval/`approvalId`, balance evidence и confirmation;
- новый execution artifact directory;
- отдельную сверку spend/quality до следующей wave.

Нельзя переиспользовать canary approval или увеличивать старый target set. В v1 один
plan не содержит больше 100 targets; controlled remainder разбивается на новые waves.

## 6. Terminal states и правило no replay

| Состояние | Действие оператора |
|---|---|
| `completed` / item `done` | Сохранить artifacts и сверку; не повторять. |
| `completed` с `terminal_gap` | Считать gap честным terminal outcome; не вращать автоматически. |
| `interrupted` | Проверить `status`; `resume` только тем же exact run и пока approval current. |
| `blocked` | Остановиться; передать code/reason владельцу/Codex. |
| `failed` | Остановиться; никакого ручного retry или legacy-скрипта. |
| `ambiguous` | Немедленно остановиться; **никогда не replay автоматически**. |

`ambiguous` означает, что платная попытка или её settlement не могут быть доказаны
однозначно. Запрещены и `execute`, и `resume`, и новый план на те же targets до ручной
ledger/provider reconciliation и явного owner disposition. Принцип: лучше оставить
видимый gap, чем дважды списать кредит или записать противоречивую truth.

## 7. Stop conditions

Claude Code немедленно прекращает run/следующую wave и докладывает, если наблюдается:

- schema/manifest/plan/approval/fingerprint mismatch;
- expired plan, approval или stale/missing balance evidence;
- reserve-floor/budget rejection либо spend anomaly;
- wrong variant, sibling content или first-party/locality uncertainty;
- неожиданная club/BJ's/provider route;
- heartbeat/lease loss, unsettled receipt или `ambiguous`;
- попытка повторно использовать artifact directory;
- просьба применить publish/delist/reprice/purchase mutation.

Legacy Amazon repricer, remediation/auto-improve, Growth advisor/optimizer/bulk
apply/enqueue/drain/rollback, snapshot restore, Walmart remediation/generated-image
apply, COGS sweep, reference enrichment/harvest workers и manual enrichment/harvest
POST hard-retired; Jackie MCP `listings_update` только preview. Оператор не пытается
обойти tombstone прямым engine import, старым env-флагом, queue insert или feed/API
вызовом. Их retirement — containment, а не доказательство consumer cutover.

Unit Economics имеет отдельный read-only endpoint
`/api/economics/product-truth-shadow`, но отсутствие activation означает `OFF`.
Claude Code не создаёт и не выставляет следующие deployment secrets самостоятельно:

```text
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ENABLED
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACTIVATION_JSON
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACTIVATION_SHA256
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_CONFIRMATION
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MANIFEST_SHA256
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_DATABASE_TARGET_FINGERPRINT
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MAX_PRICE_AGE_MS
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_MAX_LISTINGS_PER_BATCH
PRODUCT_TRUTH_UNIT_ECONOMICS_SHADOW_ACCESS_TOKEN
```

Они выдаются только отдельным owner activation gate после migrations, backfill,
authoritative manifest и полного readiness report. Partial, expired, ENFORCED,
wrong-consumer, wrong-manifest или DB-fingerprint-drift config блокируется до DB read.
Bearer token длиной 32–512 exact characters обязателен до открытия DB. Один request
читает manifest inventory, legacy inputs, scope links и canonical projections одним
client, одним `asOf` и одной read transaction; отсутствующий manifest/partition или
выдуманный cursor fail-closed. SHADOW остаётся compare-only: legacy economics response
не меняется и никакого права на repricing/publish/purchase не возникает.

Пока отдельные gates не реализованы, оператор также не вызывает `/api/mcp`
`draft_publish`, Bundle Factory publish/republish или poll-pending self-heal, Amazon A+
POST, content generate/regenerate/tick либо audit vision scan. Это действующие legacy
business flows, а не часть готового Product Truth CLI; session/RBAC, boolean confirm и
cron secret не являются Product Truth owner action/budget artifact.

Оператор сообщает: exact command без секрета, `runId`, plan SHA, target fingerprint,
статус, error code, последний безопасный checkpoint, receipt IDs/statuses и пути к
неизменяемым артефактам. Auth token, provider secrets и URL query никогда не включаются.

## 8. Exit codes

- `0` — команда успешно завершилась; для matcher replay это только полный
  `PASS_FULL`, для execution — terminal `completed`.
- `2` — runner вернул blocked/partial/non-completed/interrupted outcome; требуется
  review. Matcher semantic `PASS` при unresolved evidence всё равно возвращает `2`.
- `78` — sealed matcher wrapper отклонил runtime, manifest, один из восьми inputs или
  output boundary до запуска runner; output не создаётся, retry/обход запрещён.
- `64` — неверная/неполная CLI-команда; scope не исполнялся.
- `1` — contract, artifact, schema, ledger или runtime failure; автоматического retry нет.

Ни один exit code сам по себе не разрешает следующую wave. Решение принимается по
durable status, ledger, artifacts и owner gate.

## 9. Короткий handoff для Claude Code

```text
Ты оператор, не разработчик Product Truth engine.
Используй только готовый Product Truth npm-контур из этого runbook:
product-truth:census, product-truth:manifest, product-truth:migrations
(только plan|apply|recover-report) и
product-truth doctor|backfill-plan|backfill-apply|readiness|plan|execute|resume|status|report.
Matcher replay v2.2 запускай только одной exact wrapper-командой из §4.0.3; direct
npm matcher-replay и scripts/product-truth-runner.ts запрещены.
Не редактируй код и не запускай legacy cogs-enrich-batch или собственные SQL/API calls.
Не расширяй exact scope, не используй --all/BJ's и не обходи approval/budget.
Sam's/Costco — только отдельный owner-approved club plan; обычный canary без clubs.
Не выполняй publish/delist/reprice/purchase.
Новый canary/wave = новый plan + owner approval + artifact directory.
Resume = только exact interrupted run; ambiguous никогда не replay.
TARGETED_WALMART_EVIDENCE = ровно один sealed donor + один direct first-party Walmart
offer. Запускай только engine-generated doctor→plan→execute/resume/status/report.
Не создавай canonical identity вручную: для eligible legacy donor её консервативный
вариант выводит движок, а свежий exact Walmart search обязан подтвердить его до записи.
Owner approval разрешает только exact metered plan, бюджет и provider permit.
Не используй OFF/clubs/BJ's/fanout; один query + один detail — абсолютный максимум.
При любом fail-closed состоянии остановись и передай доказательства владельцу/Codex.
```

Связано: [[product-catalog-architecture]], [[donor-catalog-execution-roadmap]],
[[enrichment-division-of-labor]], [[reference-catalog-engine]].

## 10. Текущий внешний статус на 2026-07-26

Этот runbook описывает проверенный engine contract и точную текущую execution-точку,
а не завершённый production cutover. Историческая reconciliation session остаётся
quarantined после provenance incident; её поздний конфликтующий `ABSENCE_ONLY`
не авторитетен и не переиспользовался. Successor G4 завершён: единственный create
request `019f9f34-9bad-7390-b236-341290db319a` достиг `READY` continuation-only
GET-ами, второй create не выполнялся. Final cadence commit `59f25201` ограничивает
polling до `180s × 9`; production ITEM v6 parser commit `cfb41078` прошёл clean
Walmart report suite `229/229`. Raw ZIP SHA
`fa858d5ca65616627acb4578097861c6abcd42fad8332d2f0378ff59baa9c56d`,
decoded CSV SHA `07de74f3302ae80970d8f31be9d9ff716d91d379ddddfdbffe5706b44acfefb1`;
complete catalog содержит `5236` rows (`3891 PUBLISHED`, `734 SYSTEM_PROBLEM`,
`611 UNPUBLISHED`) и ноль malformed/duplicate/conflict.
Fresh Amazon store1/store3 reports захвачены GET-only без report-create. Final
report-bound disposition и `phase1-authoritative-scope-manifest/v3` policy `1.3.0`
готовы: `5935` live listings, `6` required scopes, `3` exact reports, `0` blockers;
canonical manifest SHA
`94359db196ec3bc73c964edce7a88df56e5e1942fc0ba9824670034609e9062c`.
Exact v3 schema activation выполнена один раз: 8/8 migrations applied/tracked,
обе migration ledgers ready, post-commit plan `blockers=[]`, schema after SHA-256
`8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`.
Canonical business-data materialization не выполнялась. G5 read-only
`backfill-plan` создан из clean checkout `0fdbc0c9`: plan
`162b2dbd…53cf78`, `5935` scope imports, `5935` artifact-only review tasks,
обе ledgers ready, writers/FK blockers `0`, canonical cost recomputes/provider
calls/DB writes `0`. По отдельному exact owner approval scope-only
`backfill-apply` завершён `APPLIED`: inserted/exact manifest scopes =
`5935/5935`, missing/conflicting/unexpected/writers/FK = `0`, canonical cost
recomputes, legacy promotions, provider/paid calls и marketplace/procurement
mutations = `0`. Full-denominator read-only readiness reconciled `5935/5935`,
но все четыре consumers имеют `0 ready` на
`CURRENT_SCOPED_SKU_COST_MISSING`; cutover = `0/4`. Этот consumed approval не
разрешает no-paid canonical materialization apply, activation или платный run.
Реальный
386-case corpus v2.2 собран и offline replay выполнен, но 86 cases остаются
`UNRESOLVED_EVIDENCE`; Unit Economics SHADOW runtime локально готов, но owner activation
не выдан и consumer cutover равен 0/4; paid provider canary или иной платный Product
Truth run не запускался.

Matcher v2.2 frozen runtime — commit
`78e0664908cd37c3746a311084f4826a031b3658`, tree
`7a2eb1a6bbc0886fec33898268db3036e240aa22`; focused `23/23`, полный suite `432/432`.
Codex sealed replay подтвердил semantic `304/304 PASS`, golden `2 cases / 4
comparisons`, `300 resolved / 86 unresolved` и единственный blocker
`UNRESOLVED_EVIDENCE_PRESENT`. `MATCHER_CORPUS_NOT_CANONICAL` закрыт, но полный Gate 1
truth остаётся BLOCKED. Historical replay остаётся на `1.2.0`; current operational
source уже выпускает полный matcher provenance tuple `1.2.1`, но production decision
writes по-прежнему заблокированы до authoritative manifest/backfill и consumer
cutover. Schema approval уже consumed и не является разрешением на эти действия.
Claude исполняет только untouched sealed
wrapper manifest из §4.0.3; очередь 1 458 не разрешена.

`TARGETED_WALMART_EVIDENCE` с `EXISTING_EXACT` и
`EVIDENCE_VERIFIED_BOOTSTRAP` выпущен в current immutable Walmart release v23:
`release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23`, engine SHA
`94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`,
manifest SHA
`7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`,
certificate SHA
`cc5603d8d56421c151b92b5a6726c1cf10c3dfa52732614763cde6dc6fec9242`.
Полный Product Truth suite `429/429`, Walmart unit/security с exit `0` и frozen
fake-live `3/3` прошли. Повторная release verification 2026-07-25 подтвердила exact
engine/manifest и отсутствие marketplace/DB mutation. Полный seller catalog не
является входом new-SKU lane: перед certification нужны только точечные
authenticated проверки exact staged SKU и exact UPC. Oxylabs/Unwrangle calls этим
lane не выполнялись; provider spend требует отдельного точного owner budget gate.
Все старые targeted request/plan/approval artifacts для
`OWNER_ATTESTED_BOOTSTRAP`, а также v20 commercial diagnostics, остаются diagnostic
only и не могут исполняться.
