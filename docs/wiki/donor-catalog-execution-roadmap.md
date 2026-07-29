# Donor Reference Catalog — execution roadmap

> **Статус:** active program plan, owner direction confirmed 2026-07-18.
>
> **Каноническая цель и неизменяемые правила:** [[product-catalog-architecture]].
> Этот файл — изменяемый план исполнения: порядок, gates, метрики и текущие решения.
> Он не переопределяет канон.
>
> Подробный доказанный аудит четырёх runtime consumers и последовательность их
> безопасного переключения: [[product-truth-consumer-cutover]].

---

## 1. Program objective

Построить единый Product Truth Platform — фундамент для Bundle Factory/создания новых
листингов, Listing Improvement, Unit Economics и Procurement. Сначала он должен
авторитетно покрыть каждый живой Amazon- и Walmart-listing, связать его с точным рецептом
SKU, локальными retailer offers и source-backed content. После этого каталог управляемо
расширяется за пределы текущего ассортимента кампаниями по бренду, группе/категории,
ретейлеру и demand-driven запросам.

Две бизнес-фазы:

1. **Phase 1 — Current Business Coverage:** Amazon + Walmart live catalog first.
2. **Phase 2 — Systematic Expansion:** brand/group/category/retailer campaigns.

Перед ними обязательна техническая **Phase 0 — Truth & Spend Safety**, потому что
массовый платный прогон на текущих matcher/queue/harvest semantics закрепит ошибки и
может повторно сжечь бюджет.

---

## 2. Правила выполнения программы

1. Сначала исправляем бесплатные code/data-contract проблемы; потом тратим кредиты.
2. Paid batch запускается только с явным owner-approved лимитом и hard stop в коде.
3. Каждый batch имеет dry-run plan, canary, checkpoint, resume и фактический отчет spend.
4. Exact content identity важнее coverage; wrong variant хуже честного unresolved.
5. Price proxy и content donor — разные роли и разные ссылки/evidence.
6. Все действия сначала read-only/shadow; публикация, delist, repricing и purchase —
   отдельные approval gates.
7. Runtime truth проверяется в Turso и live marketplace APIs, не в локальном `dev.db`.
8. Текущий dirty worktree и чужие изменения сохраняются; program work идет изолированно.

---

## 3. Phase 0 — Truth & Spend Safety (без массового enrichment)

### 0A. Зафиксировать канон и точки входа для агентов

Deliverables:

- [[product-catalog-architecture]] — единственный owner canon;
- этот roadmap;
- mandatory pointers в `AGENTS.md`, `CLAUDE.md`, Wiki index и mission control;
- старые спецификации явно подчинены канону.

Exit gate:

- следующий Codex/Claude, заходящий в sourcing/Bundle Factory/listings/economics/
  procurement, получает обязательную ссылку на канон;
- Wiki-Brain не показывает новых broken links/orphans.

### 0B. Создать единый Product Identity / Variant Matcher

Нужно заменить разрозненные subset и ad-hoc token gates одним pure/testable matcher.

Матчер должен учитывать:

- exact UPC/GTIN, когда он относится к правильной базовой единице;
- canonical brand и aliases;
- product line/form/type;
- flavor и конфликтующие modifiers;
- amount + `unitMeasure`;
- base unit против multipack/case;
- whole-word tokens, punctuation, compounds, singular/plural;
- SEO/claim tokens, которые не должны автоматически создавать false reject.

Один matcher используется в:

- retailer escalation `strictHit`;
- cost readback;
- content donor selection;
- gallery/image QC preflight;
- recipe linking.

Обязательные regression sets:

- hard negatives: соседний вкус, Zero/Diet/Original/XXTRA, cup/bowl, puffs/crunchy;
- positives с разным retailer SEO;
- `oz`/`ct`/`ml` unit conflicts;
- все 386 `VARIANT_MISMATCH` в shadow mode;
- контрольная выборка ранее `GEN_OK`.

Exit gate:

- измерены precision и false-reject на golden set;
- matcher fail-closed для content, но допускает явно типизированные price estimates;
- правильный кандидат не теряется из-за SQL `LIMIT 5` до semantic filtering.

### 0C. Разделить content truth и price evidence

Нужно формализовать минимум:

- `contentDonorProductId` — exact-only;
- `priceEvidenceDonorProductId` — exact/cross-size/sibling;
- `costTier` / `matchTier` — enum, не один boolean;
- provenance matcher version, source URL, capturedAt, ZIP/store;
- estimate никогда не попадает в content views.

Sibling flavor может помогать оценить цену, но не может давать фото, ingredients,
nutrition, description или generated listing facts.

Exit gate:

- единый read-contract показывает exact content readiness отдельно для каждого компонента,
  независимо от `FACT/ESTIMATE/UNSOURCEABLE` price outcome;
- price-only evidence физически не может быть прочитано как content source.

### 0D. Починить harvest lifecycle и budget control

Добавить durable state:

- `detailHarvestStatus`;
- `detailHarvestAttempts`;
- `detailHarvestedAt`;
- `nextHarvestAt`;
- `lastHarvestError`;
- source capability / terminal-partial semantics.

Нужны:

- atomic claim до network call;
- максимум попыток и transient backoff;
- Target-only/content-unsupported terminal state;
- ISO-consistent timestamps;
- global Unwrangle floor + per-run credit cap;
- dry-run и disabled-by-default flag;
- никакого автоматического paid-vision fallback при free-only policy;
- стоимость запроса по retailer/platform, измеренная реальным delta, а не комментарием.

Exit gate:

- повторный cron tick не выбирает terminal rows;
- low/unknown balance означает ноль платных вызовов;
- canary 5 donors concurrency 1 не превышает заявленный cap;
- `reference-harvest-worker` не возвращается в расписание до прохождения тестов.

### 0E. Унифицировать очередь и сделать resumable repair runner

Сейчас `Setting.enrich_priority_skus` и `EnrichmentJob` — разные механизмы, а очередь
1 458 состоит из уже costed SKU и не обслуживается uncosted sweep.

Нужен один durable job contract:

- target SKU/variant + exact need (`identity`, `content`, `offer`, `price-refresh`);
- reason/status/priority;
- dedup key;
- attempts/checkpoint/result;
- estimated and actual credits;
- acknowledgement/terminal outcome;
- resume after interruption;
- no implicit club search without budget.

Exit gate:

- каждый queued SKU имеет понятный следующий action;
- повторный запуск не повторяет completed paid work;
- можно безопасно обработать 5, 50 или весь scope одним runner с одинаковой логикой.

### 0F. Data integrity и историчность

Исправить:

- orphan `SkuComponent → DonorProduct` links при UPC merge/cleanup;
- atomic запись recipe + cost result;
- уникальность listing identity на `(channel, positive storeIndex, raw SKU)`;
- readiness всех компонентов, а не одной строки bundle;
- сохранение cost periods и offer observations вместо удаления истории;
- фактическое значение gallery completeness (`>=1` не равно full gallery);
- required structured fields variant/line/flavor/form/confidence.

Exit gate:

- ноль orphan recipe links;
- любой cost имеет воспроизводимый recipe/evidence;
- readiness вычисляется на уровне полного SKU;
- historical rows не уничтожаются refresh-операцией.

### Phase 0 implementation checkpoint — 2026-07-19

Статусы ниже описывают **локальный dirty worktree**, а не Turso/Vercel runtime:

- 🟢 локально реализованы strict variant matcher, независимые оси exact content truth и
  price/COGS evidence, immutable observations/provenance, append-only cost history,
  versioned Product Truth read-contract и **8 ordered migrations** в owner-gated
  migration planner;
- 🟢 operational runner и CLI исполняют только sealed plan/standing authorization/DB target:
  concurrency 1, exact listing-scope queue, максимум одна попытка, distributed hard
  budget ledger, atomic queue/item terminalization, checkpoint/resume, crash recovery
  без replay неопределённого результата и immutable hash-bound report/artifact index;
- 🟢 в исходниках реализован и локально сертифицирован sealed one-donor lane
  `TARGETED_WALMART_EVIDENCE` с режимами `EXISTING_EXACT` и
  `EVIDENCE_VERIFIED_BOOTSTRAP`. Lane связывает один существующий donor, один direct
  first-party Walmart offer и одну exact identity. Для legacy donor движок сам
  выводит консервативную identity из sealed brand/title/size bytes; ручной owner
  identity-файл запрещён. Bootstrap не может писать до свежего exact search и
  транзакционно ограничен одним variant/decision без создания новых donor/offer.
  Focused/integration и полный локальный suite прошли; платный execution не запускался.
  Для handoff всё равно обязателен exact clean-release tree/checksum;
- 🟢 legacy batch entrypoint выведен из эксплуатации; Claude Code остаётся оператором
  команд doctor/plan/execute/resume/status/report и не создаёт движок заново для wave;
- 🟢 четыре consumer runtime-контура проаудированы; локально добавлены manifest-bound
  set-based read до 100 exact listing scopes, единый gateway и owner-sealed staged
  activation `OFF/SHADOW/ENFORCED` без legacy/per-listing fallback. Реальный cutover
  остаётся 0/4 до authoritative manifest, migrations, backfill и shadow evidence;
- 🟢 Unit Economics получил первый отдельный production SHADOW path: runtime
  fail-closed сверяет owner activation с фактическим DB fingerprint, denominator
  cursor-page и полный partition inventory идут только из manifest-bound registry, а
  compare report обнаруживает omitted/untyped/cross-scope legacy cost и status/value
  drift. Legacy и canonical reads имеют один target, `asOf` и read transaction;
  отдельный Bearer token проверяется до DB. Endpoint по умолчанию `OFF`, не меняет
  legacy economics output и не означает activation;
- 🟢 локальный Phase 1 builder выпускает только
  `phase1-authoritative-scope-manifest/v3`: policy version, canonical owner-disposition
  input, полный required-scope census и точные байты каждого report связаны отдельными
  SHA-256. Zero-blocker artifact всё равно не доказывает marketplace custody без
  реально полученных Amazon/Walmart exports;
- 🟢 schema gate fail-closed проверяет canonical evidence/listing-scope/harvest/metered/
  operational schema. Отдельный backfill-readiness planner работает только в режиме
  `READ_ONLY_NO_PAID_PLAN`, считает scope/data/writer/receipt/integrity blockers и не
  применяет migrations, не пишет данные и не вызывает provider;
- 🟢 legacy Listing Improvement containment локально hard-retired Amazon repricer,
  remediation/auto-improve, Growth advisor/optimizer/bulk apply/enqueue/drain/rollback
  и snapshot restore, а Jackie MCP `listings_update` сделан preview-only. Walmart
  remediation worker, generated-image apply и remediation enqueue POST также
  hard-retired; опасные schedules удалены. Это не cutover соответствующих consumers;
- 🔴 repo-wide paid/mutation containment ещё не доказан: Bundle Factory publish и UPC
  self-heal, A+ factory, content-generation/tick и audit vision fallback остаются
  active business flows без Product Truth-bound owner action/budget artifact. Их нельзя
  вызывать из Product Truth operator workflow; нужны отдельные gates/cutover patches;
- 🟢 transitional Unit Economics остаётся raw-SKU/non-authoritative, но теперь
  fail-closed: newest `NULL/UNSOURCEABLE` не воскрешает older positive, а неизвестная
  COGS возвращает nullable `BLOCKED`, не прибыль с нулевой себестоимостью;
- 🟢 certification suite обновлён для operational/crash/budget invariants; количество
  тестов здесь намеренно не фиксируется и должно браться из последнего полного прогона
  на актуальном worktree;
- 🟢 Gate 1 owner/operator packet сохранён в
  `release-artifacts/product-truth-gate1-2026-07-19/`: rejected templates,
  machine-readable blockers, provisional evidence inventory и локальный census
  `--prepare-owner-attestation` для canonical capture bytes/hash. Owner artifacts v1
  остаются hash-bound под внешней custody, а не digitally signed;
- 🟡 ambiguous Walmart ITEM create-attempt остаётся без авторитетного disposition:
  неизвестный параллельный процесс выполнил один read-only list GET, canonical chain
  завершилась `PAGINATION_INCOMPLETE`, а поздние конфликтующие
  `CAPTURED`/`ABSENCE_ONLY` files признаны недоверенными. RequestId не принят, create
  POST не повторялся; session и reconciliation code quarantined read-only. См.
  `ss-control-center/docs/WALMART_ITEM_RECONCILIATION_PROVENANCE_INCIDENT_2026-07-19.md`;
- 🟢 отдельный Walmart source-evidence/reissue engine заменён one-token successor:
  exact historical-window absence GET, conditional create POST и continuation
  используют один OAuth transport. Commit `c8cb50fe…1826` прошёл no-hardlink clean
  checkout `227/227`; frozen bundle `09e108c1…2ffca`, manifest
  `5ce2ec88…ea94f`. Quarantined `ABSENCE_ONLY` не используется как свежая
  authorization; runtime guard сам fail-closed проверяет exact absence перед POST;
- 🟢 актуальный frozen operator closure сохранён в
  `release-artifacts/product-truth-operational-closure-2026-07-19/`: третья patch-дельта
  применяется только поверх exact predecessor tree из release README и даёт новый
  external checksum-bound executable tree. Clean tree прошёл полный Product Truth suite, targeted stress,
  source-release tests, help/Prisma smokes и checksum verification. Gate 1 packet
  перепривязан к этому executable tree и заново прошёл SHA256SUMS verification;
- 🟢 единственный replacement report-create принят Walmart: request
  `019f9f34…319a`, HTTP `200`, затем достиг `READY` continuation-only GET-ами;
  повторный create не выполнялся. Final cadence `59f25201` = `180s × 9`.
  Raw ZIP SHA `fa858d5c…c56d`, decoded CSV SHA `07de74f3…fb1`; complete catalog
  `5236` rows, из них `3891 PUBLISHED`, `734 SYSTEM_PROBLEM`,
  `611 UNPUBLISHED`, malformed/duplicate/conflict = `0`. Production parser
  `cfb41078` прошёл clean Walmart report suite `229/229`;
- 🟡 будущий v1 at-most-once будет технически доказан только внутри одной intact local
  session/custody root и не имеет distributed consumption ledger. Quarantined session
  нельзя переиспользовать как этот root;
- 🟢 2026-07-23 owner-approved exact v3 schema activation выполнена один раз: 8/8
  migrations применены и tracked в production Turso, обе migration ledgers ready,
  independent post-commit plan имеет `blockers=[]`; schema after SHA-256 =
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`;
- 🟡 P0 продолжается на data/cutover gates: schema, authoritative Phase 1 manifest
  v3 и exact G5 scope apply готовы. `ProductTruthListingScope` verified
  `5935/5935`. Две отдельные no-paid legacy bridge transactions материализовали
  `19` exact-content listings (`5` canary + `14` graph-aware wave), `105/105`
  canonical rows; оба postcheck = `ALREADY_APPLIED`, partial/FK violations = `0`.
  Full-denominator readiness: Bundle Factory `19 ready`, Listing Improvement
  `19 ready`, Unit Economics `19 UNSOURCEABLE`, Procurement `0 ready`;
  остальные `5916` scopes ещё не materialized. Fresh canonical-aware bridge
  audit `a97497ca…6cd7` показывает `19 ALREADY_CANONICAL`, `0` новых
  content-complete no-paid candidates, `82` identity-only и `5834` quarantine,
  поэтому уже записанные строки больше не предлагаются повторно. Provider canary
  и cutover ещё не выполнены;
- 🟡 production schema transaction = `1`, scope-only apply transaction = `1`,
  no-paid content transactions = `2`; paid provider calls, marketplace
  mutations и consumer activation не выполнялись. Consumer cutover на единый
  read-contract равен **0 из 4**; legacy views/tables не являются доказательством
  production readiness;
- 🟢 fresh Amazon `GET_MERCHANT_LISTINGS_ALL_DATA` reports повторно захвачены
  GET-only для текущего snapshot: store1 = `1571` строк, SHA
  `b3839047…d5e14`; store3 = `502`, SHA `51e331ed…5842`; report-create calls = `0`.
  Owner decision 2026-07-26 закрыл scope: store1/store3 Amazon и store1 Walmart
  остаются `IN_SCOPE`; store2/store4/store5 Amazon исключены как currently blocked
  до successor census. Authoritative census sealed: 6 required scopes, 0 blockers,
  successor content SHA `0230d7bf…ab6dd`; два технически `UNRESOLVED` scope
  сохранены в denominator и закрыты только явным owner exclusion. Final
  report-bound disposition v3 и authoritative manifest v3 готовы: `5935` live
  listings, `3` exact reports, `0` blockers, canonical SHA
  `94359db1…9062c`. G5 plan `162b2dbd…53cf78` read-only подтвердил exact
  denominator, `5935` scope imports, `5935` artifact-only review tasks, обе ledgers
  ready и ноль plan-time writes/provider calls. По отдельному owner approval
  scope-only apply завершён `APPLIED`: `5935/5935` вставлены и verified,
  missing/conflict/unexpected/writer/FK = `0`, cost/legacy/provider/paid/
  marketplace/procurement effects = `0`;
- ⚪ paid/provider canary, платный gap enrichment и любой иной платный Product Truth
  run не запускались.

До отдельного provider canary и consumer cutover Phase 0 не считается
завершённой. Standing policy разрешает только collision-free no-paid wave
`≤100` rows после fresh `READY_TO_APPLY`. Snapshot/plan `1.3.0` отделяет outer
marketplace UPC от base-unit identity и поддерживает два независимых immutable
пути: live-image barcode и generic direct-Target content. После `FaisalX-1148`
generic Target lane выполнил ровно два GET без retry: Arnold `12973001` дал
exact evidence, Iberia `80838482` не содержал allergen warning и остался
fail-closed. Standing wave для `FaisalX-1228` вставила `7/7` rows; postcheck =
`ALREADY_APPLIED`. Full readiness теперь `21` content-ready /
`21 UNSOURCEABLE`, `5914` missing, Procurement `0`. Full certification
`487/487`. Новых бесплатных Target content-only candidates нет; paid/provider
работа по остальным gaps требует отдельного G7. Локальный exact G7 proposal
`df3da159…65b88` уже готов: пять collision-free Walmart listings, worst-case
ceiling `17.5` provider units, calls/writes `0`. Recommended review values
материализованы canonical offline planner-ом без provider/DB calls: exact plan
`ae810cb1…5360e`, пять listings, ceiling `17.5`, reserve floor `15000`,
expiry `2026-07-28T12:39:07Z`; plan-time DB/provider calls `0`. G7 execution
получил exact owner approval на неизменные run ceilings. Fresh remote doctor
прошёл, но execution остаётся fail-closed до отдельно разрешённого свежего
Unwrangle balance probe: free endpoint отсутствует, cache пуст, старый receipt
stale; фактический spend пока `0`. После balance evidence всё ещё обязательны
plan-bound permit и confirmation.
Old plan `ae810cb1…5360e` истёк до использования probe gate и не потратил
кредиты. Его byte-new offline replacement `bca2decb…6413c` сохраняет exact
target set `f7284014…c2ab`, те же ceilings/запреты и действует до
`2026-07-29T17:27:40Z`; plan generation снова имела DB/provider calls `0`.
Старые approval bytes не переносятся.
Combined gate для replacement был получен. Единственный Target Search balance
probe без retry дал HTTP `200`, balance `99692.5`, но списал `2.5` units вместо
заявленного `1`. Evidence `9c385650…1a6f`; canonical и marketplace writes `0`.
Основной run не запускался, потому что `2.5 + 17.5` превысило exact combined
ceiling `18.5`. Target tariff guard исправлен на `2.5`, Product Truth
certification `489/489`. Plan всё ещё current; следующий единый gate должен
покрыть consumed `2.5`, при необходимости один fresh `2.5` probe и unchanged
main ceiling `17.5`, cumulative maximum `22.5`.
Успешная активация schema сама по себе не означает content/price readiness или
разрешение marketplace actions.

---

## 4. Phase 1 — каталог всего, что уже продается на Amazon и Walmart

### 1A. Авторитетная инвентаризация live scope

Каноническая grain одной строки live scope:

```text
(channel, storeIndex > 0, raw SKU)
listingKey = channel:storeIndex:rawSku
```

`raw SKU` сохраняется без нормализующего слияния. Одинаковая строка SKU в разных
каналах или store/account scopes — разные listings. Дедуплицировать позже разрешено
canonical product variants и recipes, но не исходные строки authoritative manifest.
Нулевая/неизвестная account scope, duplicate exact listingKey или конфликт mapping
должны fail closed и блокировать consumer cutover. Повтор raw SKU в разных точных
listing scopes остаётся видимым diagnostic collision, но это две независимые записи:
их нельзя автоматически merge, dedupe или исключать.

Получить live snapshots из channel APIs:

- все активные/published Walmart SKU;
- все активные Amazon listings по подключенным stores/marketplaces;
- channel listing ID/ASIN, title, images, quantity/pack claims, status;
- positive `storeIndex`, точный raw SKU и source/report provenance каждой строки;
- явные owner dispositions для подключённых store scopes; повтор raw SKU в разных
  точных listing scopes сохраняется как диагностический collision, но не объединяется;

Каждая строка scope получает lifecycle status:

- `NOT_STARTED`;
- `IDENTIFIED`;
- `RECIPE_CONFIRMED`;
- `CONTENT_READY`;
- `OFFER_READY`;
- `ECONOMICS_READY`;
- `REVIEW_REQUIRED`;
- `UNRESOLVED` / `UNSOURCEABLE`.

Success metric: 100% live listings находятся в authoritative manifest именно на grain
`(channel, positive storeIndex, raw SKU)` и имеют явный status; отсутствие данных,
неполный marketplace report или collision — видимое блокирующее состояние, а не
пропавшая или молча слитая строка.

Canonical artifact этой стадии — `phase1-authoritative-scope-manifest/v3`. Он обязан
содержать policy `phase1-scope-builder-policy/1.3.0`, embedded canonical
`phase1-connected-store-census/v1`, SHA-256 census content/capture, canonical owner
disposition input, derived required scopes и exact raw bytes каждого Amazon/Walmart
report. Ручной competing denominator запрещён. Manifest нельзя считать authoritative
только потому, что локальный builder не нашёл blockers: до freeze отдельно
подтверждаются marketplace происхождение reports, полный owner-attested census и owner
dispositions.

### 1B. Reverse resolution и recipes

Для каждого live SKU:

1. Получить authoritative channel title/images/attributes.
2. Переиспользовать подтвержденный identity cache, если matcher version актуальна.
3. Определить single/multipack/mixed bundle.
4. Построить точный `variant × qty` recipe.
5. Exact-link существующие catalog variants.
6. Поставить только реальные gaps в enrichment queue.

Success metric: у каждого resolved listing полный рецепт; bundle не считается ready,
если не подтверждён **каждый** его компонент.

### 1C. Бесплатное переиспользование и gap plan

Перед сетью:

- дедуп catalog variants/offers;
- переиспользовать свежие exact facts;
- использовать OFF и другие бесплатные источники по UPC;
- составить gap report по полям и источникам;
- рассчитать forecast платных запросов по retailer/platform;
- clubs/дорогие tiers вынести в отдельный budget bucket.

Owner gate: утвердить конкретный credit ceiling и reserve floor.

#### 1C.1. Targeted Walmart evidence для одного exact gap

Если Walmart new-SKU pilot упирается в отсутствие ровно одного canonical candidate,
можно использовать только sealed `TARGETED_WALMART_EVIDENCE` lane из
[[product-truth-operator-runbook]]. Это не сокращает authoritative Phase 1 denominator
и не разрешает партию:

1. `doctor` создаёт request из exact DB bytes одного `DonorProduct` и одного его direct
   first-party Walmart `DonorOffer`. Для eligible legacy donor движок сам
   детерминированно выводит консервативную canonical identity из sealed brand,
   полного post-brand title signature и нормализованного размера. Ручной
   `--canonical-identity`, owner-review/template и ручная техническая аттестация
   владельца не используются.
2. `plan` повторно сверяет target/schema/release/migration и exact donor graph. Для
   `EVIDENCE_VERIFIED_BOOTSTRAP` pinned standing authorization разрешает только
   exact metered plan, бюджет и provider permit; она не является доказательством identity.
   До canonical write свежий Walmart search обязан независимо подтвердить item ID,
   URL, first-party seller, полный identity token set, размер и base-unit pack.
3. Hard cap одного run: Oxylabs Walmart query ≤ `1` call/`1` unit, Unwrangle Walmart
   detail ≤ `1` call/`2.5` units, ZIP `33765`, price TTL `24h`, минимум `2` exact
   images, wall clock ровно `180000 ms`, concurrency `1`.
4. OFF, clubs, BJ's, fanout, automatic replay, publish, delist, reprice и purchase
   запрещены. Существующий complete exact content разрешён только при fresh price и
   пока detail receipt не существует. После начала detail старый content не может
   закрыть outcome и paid call не replay.

Каждый target требует exact automatic standing authorization, two-provider permit,
fresh Unwrangle balance evidence и immutable output directories. Claude Code только
выполняет frozen CLI и emitted `next_argv`; owner prompt, код, SQL и ручные API
запрещены. Source lane
реализован, но его final focused/integration certification ещё не завершена; до неё
платный target run не разрешён.

### 1D. Canary enrichment

Порядок:

1. 5–10 SKU, включая single, multipack, mixed bundle, dry и frozen.
2. Concurrency 1.
3. Дешевые/уже оплаченные источники сначала; clubs выключены.
4. До/после: balance, network calls, variants created, exact matches, content fields.
5. Ручной визуальный/фактический review каждого результата.

Canary проходит только если:

- нет wrong-variant content;
- actual spend не превышает cap;
- повторный run идемпотентен;
- every fact имеет provenance;
- terminal/partial rows не вращаются повторно.

### 1E. Production waves

После canary:

- waves 25 → 50 → 100 → controlled remainder;
- checkpoint и reconciliation после каждой волны;
- stop при budget anomaly, match regression или source degradation;
- дорогие Sam's/Costco passes — отдельно по high-value unresolved SKU и отдельному
  owner-approved club budget; BJ's запрещён;
- flagged/unsourceable не делистятся автоматически.

После каждой wave фиксируются:

- unique SKU/variants completed;
- exact/estimate/unresolved;
- content completeness;
- local offer freshness;
- credits by source;
- duplicates/orphans;
- matcher false accepts/rejects.

### 1F. Phase 1 completion gate

Phase 1 считается завершенной, когда:

- все live Amazon/Walmart listings входят в authoritative scope на grain
  `(channel, positive storeIndex, raw SKU)`; duplicate exact listingKey или конфликт
  scope mapping блокирует manifest, а повтор raw SKU между разными точными scopes
  остаётся видимым неблокирующим диагностическим фактом;
- каждый SKU имеет подтвержденный recipe или явный unresolved reason;
- каждый recipe component имеет exact content donor или блокируется от content use;
- доступные локальные offers содержат ZIP/store, first-party, price, pack, stock status,
  URL и observedAt;
- product acquisition cost и его tier объяснимы;
- full COGS отделена от bare product cost;
- data freshness SLA и refresh queue работают;
- нет orphan links и silent partial readiness.

---

## 5. Активация четырех потребителей после Phase 1

### Bundle Factory

- catalog-first donor pool;
- recipe-first variation planner;
- channel adapters для Amazon/Walmart/eBay/TikTok/site;
- exact content provenance;
- pre-publication economics and policy gates.

### Listing Improvement

- audit текущих Amazon/Walmart listings против exact recipe/facts;
- prioritized remediation queue;
- generated text/graphics отделены от source facts;
- owner approval перед bulk apply.

### Unit Economics

- optimized pack purchasing cost;
- packaging/ice/cold-chain layer;
- fees/shipping/ads/returns layer;
- historical cost periods;
- rollups SKU → order → channel → business.

### Procurement MVP

Первый read-only MVP:

```text
order line → SKU recipe → inventory shortage → local offer combinations → buy plan
```

Он должен показать что/сколько/где/по какой цене купить и почему выбран этот pack mix.
Создание carts или purchase остается отдельной будущей mutation phase.

---

## 6. Phase 2 — системное расширение каталога

После покрытия текущего бизнеса запускаются enrichment campaigns.

### Типы кампаний

- **Brand:** весь релевантный ассортимент бренда.
- **Group/category:** soups, breads, snacks, frozen breakfast и т.д.
- **Retailer:** локально доступный ассортимент Walmart/Publix/Target; Sam's/Costco
  только отдельной owner-approved club campaign. BJ's запрещён.
- **Demand:** товары с высоким спросом, margin или bundle potential.

### Campaign contract

Локальный pure/sealed контракт уже зафиксирован в
`ss-control-center/src/lib/sourcing/product-truth-expansion-campaign.ts`. Он связывает
authoritative Phase 1 completion proof, exact dimension/scope, ZIP 33765, first-party
routes, provider ceilings/reserve floors, campaign dedup snapshot и append-only
checkpoint chain. `READY` в этом артефакте не разрешает execution или spend: внешний
campaign registry, durable lock, owner budget activation и runtime ещё не созданы.

Каждая кампания содержит:

- цель и ограниченный scope;
- ZIP/store/retailer coverage;
- source capability matrix;
- expected unique variants/packs;
- budget ceiling и reserve floor;
- dedup/matcher version;
- content completeness target;
- checkpoint/resume;
- stop conditions;
- final spend/quality report.

Новый вариант становится `CATALOG_READY` только после identity/content/evidence gates.
Оффер может быть stale или unavailable, не делая подтвержденные product facts ложными.

---

## 7. Постоянный operating model

После двух фаз работают отдельные refresh cadences:

- identity/UPC/product content — медленно, по версии товара и TTL;
- price/stock/local availability — быстро;
- source failures — backoff/circuit breaker;
- actual procurement receipts — strongest price/local-availability evidence;
- nightly/weekly integrity checks — orphan links, duplicates, stale offers, incomplete SKU;
- budget dashboard — spend by source/campaign/result.

Главные KPI:

- live SKU scope coverage;
- exact recipe coverage;
- exact content donor coverage;
- full content completeness;
- local offer coverage/freshness;
- economics-ready coverage;
- procurement-ready coverage;
- matcher precision/false-reject rate;
- catalog reuse ratio (сколько SKU используют один подтвержденный variant);
- credits per newly confirmed variant и per refreshed offer.

---

## 8. Текущий план этого чата

1. 🟢 **Документация и routing** — канон, roadmap и mandatory-read pointers закреплены.
2. 🟢 **Provisional read-only baseline** — исторический pre-migration snapshot сохранён
   в [[product-truth-baseline-2026-07-18]]; он не заменяет authoritative Phase 1 reports.
3. 🟢 **Phase 0 implementation** — no-spend engine suite реализован локально: trusted
   census, manifest v3 policy 1.1.0, strict matcher/replay CLI, schema/migration gates,
   owner-gated immutable scope backfill, full-denominator readiness, sealed operational
   runner, budget ledger и hard retirement legacy mutation routes. Полная glob-based
   Product Truth certification зелёная; paid/network/production actions не выполнялись.
4. 🟡 **Matcher Gate 1 / v2.2 offline release готов** — honest
   `POST_BLIND_RECONCILED_CONSENSUS` engine заморожен на commit
   `78e0664908cd37c3746a311084f4826a031b3658`, tree
   `7a2eb1a6bbc0886fec33898268db3036e240aa22`; focused `23/23`, полный Product Truth
   suite `432/432`. Восемь immutable inputs и exact runtime проверяются sealed
   wrapper. Codex replay: semantic `304/304 PASS`, golden `2 cases / 4 comparisons`,
   quarantine `300 resolved / 86 UNRESOLVED_EVIDENCE`, only blocker
   `UNRESOLVED_EVIDENCE_PRESENT`, exit `2`. Исходный blind comparison сохранён как
   `80 exact / 181 structural-same-semantic / 127 semantic disagreement`; обе final
   acceptance имеют `priorExposure=true`, `blindAgreementClaimed=false`.
   `MATCHER_CORPUS_NOT_CANONICAL` закрыт. Полный Gate 1 truth остаётся открыт только
   для 86 evidence gaps; отдельный production blocker — literal matcher version
   `1.2.0`, требующий version/provenance migration и consumer cutover. Claude запускает
   только одну sealed wrapper-команду из [[product-truth-operator-runbook]]; paid queue
   не разрешена.
5. 🟢 **Authoritative Phase 1 scope** — fresh Amazon store1/store3 и complete
   Walmart ITEM v6 связаны с owner disposition и successor census. Manifest v3
   заморожен на `(channel, positive storeIndex, raw SKU)`: `5935` live listings,
   `0` blockers, SHA `94359db1…9062c`.
6. 🟡 **Production schema/backfill/cutover** — Turso schema activation завершена и
   сертифицирована 8/8; authoritative manifest v3 готов. Sealed G5 scope apply
   завершён `APPLIED`: `5935/5935` exact scopes verified, без cost/legacy/provider/
   paid/marketplace/procurement effects. Последующие existing-evidence waves
   исчерпали все automatic legacy candidates без нового каталога и без provider
   spend. Fresh state: `754 canonical / 5181 quarantine / 0 automatic write
   candidates`, `804` canonical components. Full-denominator readiness
   `5935/5935`: Bundle Factory/Listing Improvement `100`, Unit Economics
   `10 FACT / 748 UNSOURCEABLE / 5177 MISSING`, Procurement `10`. Existing
   Bundle Factory recipe evidence recovered `16` Amazon listings / `51`
   components and byte-bound Publix URL size evidence recovered another `18`
   Walmart recipes without a parallel catalog or provider spend. Следующий
   независимый шаг — исчерпать оставшиеся бесплатные listing-identity и
   component-graph evidence lanes, затем повторить fail-closed
   rematch/materialization. Consumer cutover = 0.
7. ⚪ **Budget proposal** — прогноз по источникам и cheap-first standing-policy plan.
8. ⚪ **Canary** — 5–10 SKU с жёстким лимитом и machine acceptance.
9. ⚪ **Controlled waves** — только после успешного canary и automatic bounded authorization.
10. ⚪ **Consumer activation** — Unit Economics, Listing Improvement, Bundle Factory
    catalog-first и Procurement read-only MVP через один read-contract.
11. ⚪ **Phase 2 campaign engine** — управляемое brand/group/retailer/demand expansion.

Исторический owner gate на migration plan закрыт exact v3 activation 2026-07-23;
его approval не разрешает backfill, provider calls или marketplace writes.
Pre-Product-Truth Walmart lifecycle SHA
`25d7c29a9136fe579011296e27430b53ac2c94b390b530dfe33685541c228ef0`
остаётся только diagnostic evidence: после Product Truth нужен новый lifecycle plan и
отдельное owner decision. Этот gate не разрешает targeted provider calls, backfill или
Walmart publication.

### Сейчас запрещено без отдельного решения владельца

- запуск очереди 1 458;
- возвращение harvest cron;
- массовый delist 843;
- массовое Amazon min/max/repricing на текущем bare/stale cost snapshot;
- дорогой club sweep;
- автоматическая публикация или закупка.

---

## 9. Решения владельца по gates

Владимир утверждает:

- budget ceiling и reserve floor платного batch;
- переход canary → production waves;
- delist/repricing/publish decisions;
- включение нового retailer/source с риском блокировки;
- Procurement mutations (cart/order/purchase).

Code-quality, read-only audits, tests, shadow replays и безопасные schema/code fixes
внутри утвержденной архитектуры выполняются до этих gates без расхода платных кредитов.

---

## 10. G7 canary — фактический результат 2026-07-28

G7 закончен как диагностический production canary, но **не** как готовность к
массовому enrichment. Канонический closeout SHA:
`c73aff010a5db3139f7674acefc52426dd9ca741e656e4866dcd00a16d771a4c`.

1. Generic listing-scope runner после исправления `UNSOURCEABLE matchTier` завершил
   пять scopes как честные gaps и не угадал точные товары.
2. Exact-item lane подтвердил fresh identity/price для Fritos `49909665`, GOYA
   `30856904` и Popeye `10312200`; exact detail во всех трёх не имел явных
   `ALLERGENS` и `STORAGE`, поэтому full content не выпущен.
3. Mott's `2918451132` был `out of stock`, detail не вызывался. Glory `10532985`
   не прошёл machine bootstrap title proof, provider spend = `0`.
4. Фактический расход всего G7: `32.5` provider units / `19` calls. Retry,
   club/BJ's и marketplace mutations отсутствовали.
5. Canary выявил и закрыл lease/wall-clock mismatch; certification = `508/508`.
6. Canary выявил открытый архитектурный blocker: donor-title bootstrap и
   structured listing target строят разные canonical variant IDs. До
   `LISTING_BOUND_TARGETED_BOOTSTRAP` следующая paid wave запрещена: ручной alias,
   rebind или перенос price/content через конфликтующий variant недопустим.

Следующий порядок:

- ✅ реализовать и сертифицировать listing-bound plan/request contract без provider
  calls и без изменения уже сохранённых evidence;
- ✅ доказать offline positive/negative fixtures для
  flavor/form/productLine/size/multi-word brand;
- ✅ выпустить и повторно сертифицировать clean frozen release;
- ✅ провести новый read-only production `doctor → plan` на frozen release;
- ✅ выполнить single-SKU provider canary после exact money gate;
- ✅ выполнить fresh full-denominator bridge postcheck;
- ✅ выпустить contract `1.5.0` с same-donor graph guard и выбрать новый
  collision-free candidate read-only;
- ✅ заменить all-or-nothing detail rollback на exact field snapshot с
  consumer-specific readiness и выпустить clean contract `1.6.0`;
- ✅ заменить per-plan chat approval на pinned standing authority и
  сертифицировать `balance-probe → authorize`: TypeScript + `519/519`;
- ✅ выпустить clean release `bc98d341…6fc12`, byte-new plan
  `d9f1ffaf…ad21` и выполнить successor canary без owner prompt: terminal
  `COMPLETED`, combined spend `6`, retry `0`;
- ✅ подтвердить full-denominator postcheck `5935/5935`: exact donor
  variant/price/partial content сохранены, но target listing ещё не имеет
  independent canonical recipe/COGS и остаётся identity-only;
- ✅ canonical listing recipe и typed COGS независимо материализованы из
  сохранённых evidence: `10 FACT / 0 ESTIMATE / 93 UNSOURCEABLE`, provider
  spend `0`; full-denominator readiness остаётся `5935/5935`;
- ✅ systemic partition исчерпывающе разложил все `5833` quarantine listings
  по восьми взаимоисключающим primary lanes; report SHA
  `48c6c87e…6e4d2`, provider/DB/marketplace effects `0`;
- ✅ unique exact existing-catalog rematch и bounded no-paid waves
  материализовали ещё `51` listings, включая пять четырёхкомпонентных bundles;
  final automatic-candidate count = `0`;
- ✅ fresh Bundle Factory recipe-evidence recovery materialized `16` Amazon
  listings / `51` exact components from existing `ChannelSKU → MasterBundle →
  BundleComponent` graphs; exact GTIN and integer retail-package arithmetic are
  mandatory, while two fractional-package graphs remain quarantined;
- ✅ clean release `f0dba2b3…8bae`, tree `679438f3…05b6`, TypeScript and Product
  Truth certification `570/570`; paid/provider/retailer/marketplace/consumer/
  procurement effects `0`;
- ✅ release `aa567439`, tree `9f42f2b3…c3735`, fail-closed parent-brand-prefix
  recovery: `27` listings moved from component-graph to donor-link research,
  no automatic match or canonical write; clean-checkout TypeScript, ESLint and
  Product Truth certification `572/572`;
- ✅ release `e3257f13`, tree `840efb8d…c9ef`, byte-bound standard first-party
  Publix URL size recovery; clean-checkout TypeScript, ESLint and Product Truth
  certification `575/575`;
- ✅ two bounded standing-policy waves materialized `18` additional Walmart
  recipes with typed `UNSOURCEABLE` because saved prices are stale; no paid,
  provider, marketplace, consumer or procurement effects;
- ✅ fresh full-denominator state: `754 canonical / 5181 quarantine / 0
  automatic candidates`, `804` canonical components. Readiness:
  Bundle Factory/Listing Improvement `100`, Unit Economics
  `10 FACT / 748 UNSOURCEABLE / 5177 MISSING`, Procurement `10`;
- ✅ remaining automatic no-paid evidence исчерпан: fresh bridge сохраняет
  `0 automatic candidates`; unresolved rows не повышаются до truth без новых
  доказательств;
- ✅ Campbell's и Pepperidge Farm получили по одному bounded provider lifecycle
  и оба закрыты terminal `AMBIGUOUS`, retry `0`, без detail/canonical/
  marketplace writes; общий расход каждого lifecycle `3.5` units;
- ✅ structured Walmart brand parsing исправлен без изменения canonical matcher:
  observed title остаётся неизменным, exact token-equal `general.brand`
  используется только в versioned comparison evidence, mismatch fail-closed;
  clean release `48788374`, tree `6462f400…4890`, Product Truth `575/575`,
  TypeScript и clean-worktree PASS;
- ✅ targeted standing `doctor` теперь требует canonical listing/component
  binding и не выпускает заведомо ineligible unbound plan; clean release
  `39474394`, tree `fd53fc74…6580`, Product Truth `575/575`, TypeScript PASS;
- ✅ Glory Honey Carrots выполнен один раз с exact canonical binding и
  terminalized `AMBIGUOUS` на token-sorted multi-word brand phrase; combined
  spend `3.5` units, retry/detail/canonical/marketplace writes `0`, replay
  запрещён; execution report `0c44d4a3…62e`;
- ✅ existing-exact title proof теперь восстанавливает исходный порядок
  multi-word brand только из hash-bound decision evidence и только при
  неизменном canonical variant ID. Clean release `38997655`, tree
  `973dea2d…d5c0`, shared Product Truth `579/579`, clean checkout `576/576`,
  TypeScript PASS; canonical matcher `1.2.1` не изменён;
- ✅ Pepperidge Farm Swirl Cinnamon выполнен один раз с exact canonical
  binding. Content lane terminalized `AMBIGUOUS` на incomplete detail, retry
  `0`; combined lifecycle spend `6` units. При этом exact Walmart first-party
  price `$3.57`/unit для item `10452822`, ZIP `33765`, сохранён отдельным
  immutable observation `doo:80dffa…06d2`;
- ✅ бесплатный canonical COGS reconcile распространил сохранённую exact цену
  на восемь существующих recipes `FaisalX-229/231/232/233/234/235/236/237`.
  Plan `2adac05b…0413`, apply `b1a490e0…cf15`: `24` append-only rows,
  `8 FACT`, provider/marketplace calls `0`;
- ✅ новый full-denominator readiness `ad145926…9659` подтверждает
  `5935/5935` reconciled, Bundle Factory/Listing Improvement `100`,
  Unit Economics `18 FACT / 3 ESTIMATE / 740 UNSOURCEABLE / 5174 MISSING`,
  Procurement `18`. Content completeness и price/COGS outcome остались
  независимыми;
- ✅ следующий highest-impact target Cheez-It Original 21 oz был sealed для
  пяти single-component recipes. Plan `96181a7f…5856`; единственный Oxylabs
  query terminalized `AMBIGUOUS` на missing target token. Total lifecycle spend
  `3.5` units, retry/detail/canonical/marketplace writes `0`, replay запрещён;
- ✅ rejected provider rows теперь сохраняют имена missing/unexplained title
  tokens в terminal diagnostic, не меняя matcher или verdict. Release
  `87b50d71`, tree `11ea7895…0a9`, clean Product Truth `576/576`, TypeScript и
  targeted ESLint PASS;
- ✅ highest-impact untouched donor Lay's Dill Pickle Party Size 12.5 oz
  выполнен один раз с exact canonical binding
  `walmart:1:FaisalX-812 / component 0`. Plan `65460f79…85e4`; terminal
  outcome `COMPLETED / EXACT_FIELD_SNAPSHOT_CAPTURED_WITH_KNOWN_GAPS`,
  execution report `43039a5a…2845`, retry `0`. Exact first-party price,
  UPC/галерея и partial content сохранены независимо; ingredients, allergens и
  storage остаются явными content gaps. Combined lifecycle spend `6` units;
- ✅ бесплатный canonical COGS reconcile распространил сохранённую exact цену
  на четыре shared recipes `FaisalX-812/813/814/815`. Plan
  `318f9c36…95db`, preflight `READY_TO_APPLY`, apply
  `9a1e91f2…a548`: `12` append-only rows, `4 FACT`, provider/marketplace calls
  `0`;
- ✅ full-denominator readiness `ede2ccef…3997` подтверждает `5935/5935`
  reconciled, Bundle Factory/Listing Improvement `100`, Unit Economics
  `22 FACT / 3 ESTIMATE / 736 UNSOURCEABLE / 5174 MISSING`, Procurement
  `22`. Content gaps не были повышены до complete и не уничтожили price truth;
- ✅ sales-priority ranking выбрал Glory Foods Seasoned Mustard Greens 27 oz:
  три convertible recipes и `$486.47` в доступном `sales180`. Exact canonical
  run выполнен один раз для `walmart:1:RizwanX-3236 / component 0`; plan
  `ce974bef…e278`, retry `0`, combined spend `6` units;
- ✅ content detail terminalized `AMBIGUOUS /
  UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`, replay запрещён, но
  exact Walmart search независимо сохранил first-party price observation
  `doo:7883ceda…75d1`. Multi-word `Glory Foods` brand path прошёл production
  identity gate; incomplete content не был повышен до truth;
- ✅ бесплатный canonical reconcile plan `28e3a989…b47e`, apply
  `8b9e8be3…243c` добавил `9` append-only rows и `3 FACT` для
  `RizwanX-3235/3236/3237`. Readiness `0497687d…1339` подтверждает
  `25 FACT / 3 ESTIMATE / 733 UNSOURCEABLE / 5174 MISSING`, Procurement
  `25`, denominator `5935/5935`;
- 🔄 выполнить следующий untouched one-attempt Phase 1 target через standing
  authority; отдельно сохранить successful content/price evidence, materialize
  только доказанные данные в существующие canonical recipe/typed COGS и снова
  обновить полный denominator.

Статус 2026-07-28 после исправления:

- ✅ listing-bound request/plan `1.4.0` реализован; unbound bootstrap retired;
- ✅ exact scope/shipping/component full-row binding и strict donor-title proof
  проверяются до provider boundary;
- ✅ duplicate canonical ID regression добавлен;
- ✅ первый read-only production preflight до provider boundary выявил
  multi-word brand defect (`Pepperidge Farm` в raw listing против
  token-sorted canonical brand); provider spend и production writes = `0`;
- ✅ title proof теперь использует byte-bound raw listing identity, а canonical
  variant ID остаётся неизменным; regression добавлен;
- ✅ TypeScript, unit `14/14`, integration `11/11`, полный suite `512/512`;
- ✅ clean release commit `a5debaf7540e…`, tree `a47aa03d5674…`, повторная
  clean-checkout certification `512/512`;
- ✅ production read-only plan `4e8524d7332c…` sealed для одного untouched
  listing-bound candidate, provider calls/DB writes `0`;
- ✅ provider canary consumed combined `6` units (`2.5` balance probe + `3.5`
  working run), retry `0`; terminal outcome
  `UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`, неполный detail не стал
  content truth;
- ✅ postcheck `77c7cc9a…ffd5c` выявил, что тот же donor обслуживает два листинга
  с разной legacy field partition, поэтому single-listing binding недостаточен;
- ✅ request/plan `1.5.0` и listing binding `1.1.0` теперь byte-exact seals весь
  authoritative same-donor graph и блокирует mismatch до spend; TypeScript,
  unit `15/15`, integration `12/12`, полный suite `514/514`;
- ✅ clean release commit `eaf68d8ce04da6b514ac2f876a60894e734665ac`,
  tree `9ea153248d6dac701f952694aca2f84a412e69b9`, clean TypeScript и
  `514/514`;
- ✅ collision-free read-only successor preflight построил plan
  `2cfea49acdd5b8d5150efda8e258baff75c4431a8bbb8e5e76ee88ac1fe00070`
  для `walmart:1:FaisalX-1828`, provider calls/production writes `0`;
- ✅ read-only production diagnosis доказал точную причину первого canary:
  оплаченный Unwrangle detail был откатан только из-за
  `ALLERGENS_MISSING; STORAGE_MISSING`;
- ✅ local contract `1.6.0` сохраняет exact observed fields как
  `exact_field_snapshot_v2`, перечисляет known gaps, не материализует partial
  в mutable donor projection и не ослабляет Walmart publish requirements;
  TypeScript PASS, focused production-like suite `43/43`, полный shared-worktree
  suite `516/516`, Wiki-Brain `0/0`;
- ✅ clean `1.6.0` release: commit `a2675452ec07cf06475f7d7c9d80ad5050f72a8c`,
  tree `e7b409485351a5d85411032adcaebf7e842aabc9`, engine
  `288d348a…df84`, TypeScript PASS, `516/516`;
- ✅ новый read-only request `f39e5075…92b1` и plan `04f27fd7…f7ae`
  построены для `walmart:1:FaisalX-1828`, provider calls/DB writes `0`;
- ⛔ canary ждёт нового exact plan-bound gate максимум на combined `6` units;
  старый successor plan `2cfea49a…0070` superseded и не исполняется, terminal
  canary не replay.
