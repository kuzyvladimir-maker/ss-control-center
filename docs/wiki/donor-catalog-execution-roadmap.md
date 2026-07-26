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
- 🟢 operational runner и CLI исполняют только sealed plan/approval/DB target:
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
- 🟡 единственный replacement report-create принят Walmart: request
  `019f9f34…319a`, HTTP `200`; повторный create запрещён. Первые 20 poll вернули
  `RECEIVED`, затем Walmart вернул `429 REQUEST_THRESHOLD_VIOLATED`. Standing
  read-only owner direction отменяет per-report confirmation для утверждённого
  scope; continuation читает только существующий request. Permanent cadence fix
  `bdc7cb46` меняет poll на `30s × 40`, suite `227/227`;
- 🟡 будущий v1 at-most-once будет технически доказан только внутри одной intact local
  session/custody root и не имеет distributed consumption ledger. Quarantined session
  нельзя переиспользовать как этот root;
- 🟢 2026-07-23 owner-approved exact v3 schema activation выполнена один раз: 8/8
  migrations применены и tracked в production Turso, обе migration ledgers ready,
  independent post-commit plan имеет `blockers=[]`; schema after SHA-256 =
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`;
- 🟡 P0 продолжается на data/cutover gates: schema готова, но authoritative Phase 1
  manifest v3, business-data backfill, runtime scope readiness и отдельный
  owner-approved provider canary ещё не выполнены;
- 🟡 production schema transaction = `1`; business-data backfill, paid provider calls,
  marketplace mutations и consumer activation не выполнялись. Consumer cutover на
  единый read-contract равен **0 из 4**; legacy views/tables не являются
  доказательством production readiness;
- 🟡 три ранее захваченных Amazon
  `GET_MERCHANT_LISTINGS_ALL_DATA` reports скачаны read-only: store1 = 1563 строк,
  store3 = 514, store5 = 0; report-create calls = 0, exact bytes связаны SHA-256.
  Owner decision 2026-07-26 закрыл scope: store1/store3 Amazon и store1 Walmart
  остаются `IN_SCOPE`; store2/store4/store5 Amazon исключены как currently blocked
  до successor census. Authoritative census sealed: 6 required scopes, 0 blockers,
  content SHA `ca0380c4…cdeda3`; два технически `UNRESOLVED` scope сохранены в
  denominator и закрываются только явным owner exclusion. Authoritative Walmart
  `ITEM_CATALOG` v6 отсутствует: bounded GET-only probe видел только v2. Final
  report-bound disposition v3, Phase 1 manifest v3 и последующие gates ждут G4;
- ⚪ paid/provider canary, платный gap enrichment и любой иной платный Product Truth
  run не запускались.

До authoritative manifest, owner-gated backfill, runtime scope verification,
отдельного provider canary и consumer cutover Phase 0 не считается завершённой.
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
содержать policy `phase1-scope-builder-policy/1.1.0`, embedded canonical
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
   `EVIDENCE_VERIFIED_BOOTSTRAP` внешний owner approval разрешает только exact
   metered plan, бюджет и provider permit; он не является доказательством identity.
   До canonical write свежий Walmart search обязан независимо подтвердить item ID,
   URL, first-party seller, полный identity token set, размер и base-unit pack.
3. Hard cap одного run: Oxylabs Walmart query ≤ `1` call/`1` unit, Unwrangle Walmart
   detail ≤ `1` call/`2.5` units, ZIP `33765`, price TTL `24h`, минимум `2` exact
   images, wall clock ровно `180000 ms`, concurrency `1`.
4. OFF, clubs, BJ's, fanout, automatic replay, publish, delist, reprice и purchase
   запрещены. Существующий complete exact content разрешён только при fresh price и
   пока detail receipt не существует. После начала detail старый content не может
   закрыть outcome и paid call не replay.

Каждый target требует отдельные owner approval, exact two-provider permit, fresh
Unwrangle balance evidence и immutable output directories. Claude Code только выполняет
frozen CLI и emitted `next_argv`; код, SQL и ручные API запрещены. Source lane
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
5. 🟡 **Authoritative Phase 1 scope** — census/manifest builders и реальные sanitized
   production configuration snapshots готовы. Read-only live verification доказала
   Amazon US participation store1/store3, отсутствие credentials store4, отсутствие
   US participation store5 и HTTP 403 Sellers API для store2. Остаются owner
   disposition для store2, owner attestation, Walmart/Amazon reports и scope
   dispositions, затем manifest v3 замораживается на
   `(channel, positive storeIndex, raw SKU)`.
6. 🟡 **Production schema/backfill/cutover** — Turso schema activation завершена и
   сертифицирована 8/8. Authoritative manifest v3, business-data backfill/readiness и
   перевод всех четырёх consumers не выполнены; consumer cutover = 0.
7. ⚪ **Budget proposal** — прогноз по источникам, cheap-first plan, explicit owner gate.
8. ⚪ **Canary** — 5–10 SKU с жестким лимитом и ручной проверкой.
9. ⚪ **Controlled waves** — только после успешного canary и отдельного approval.
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
