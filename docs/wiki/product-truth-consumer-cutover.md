# Product Truth — план подключения четырёх потребителей

> **Статус:** канонический технический cutover-plan, 2026-07-19.
>
> Подчинён [[product-catalog-architecture]] и
> [[donor-catalog-execution-roadmap]]. Этот документ не разрешает production
> migration, paid enrichment, публикацию, repricing, delist или purchase.

## 1. Цель и честный текущий статус

Одна версия товарной правды должна обслуживать четыре потребителя:

1. Bundle Factory;
2. Listing Improvement;
3. Unit Economics;
4. Procurement.

Каноническая программная граница —
`ss-control-center/src/lib/sourcing/product-truth-read-contract.ts`. Для существующего
listing она принимает только точный scope `(channel, positive storeIndex, raw SKU)`,
явный `asOf`, freshness policy и SHA-256 authoritative Phase 1 manifest. Для нового
SKU до появления listing scope используется catalog-first projection
`readProductTruthNewSkuView` из того же versioned boundary.

На дату этого документа production cutover остаётся **0 из 4**. Безопасный Walmart
new-SKU pilot уже читает Product Truth, но один pilot path не означает перевод всего
Bundle Factory. Остальные runtime-контуры всё ещё содержат legacy reads или вообще не
подключены. Это нельзя переименовывать в readiness.

Первый production consumer теперь имеет отдельный, но ещё не активированный runtime
SHADOW path: `GET /api/economics/product-truth-shadow`. Он не меняет ответ
`/api/economics/skus`, не участвует в расчёте прибыли и по умолчанию строго `OFF`.
Server-controlled activation должна одновременно пройти exact owner artifact SHA,
confirmation, expiry, `mode=SHADOW`, consumer subset `UNIT_ECONOMICS`, manifest SHA и
вычисленный из фактического DB URL target fingerprint. Отдельный Bearer access token
обязателен и проверяется до открытия DB. Только после этого endpoint читает
последовательную manifest-bound страницу до 100 scopes и выпускает compare-only
diagnostics. Наличие кода не является owner activation и не меняет счётчик `0/4`.

Exact listing scope должен поступить из
`phase1-authoritative-scope-manifest/v3`. Manifest policy фиксирует
`phase1-scope-builder-policy/1.1.0`, embedded canonical
`phase1-connected-store-census/v1`, census content/capture SHA, disposition schema и
SHA-256 canonical owner dispositions, derived connected-store scopes и exact raw report
bytes. Competing manual denominator запрещён. Эти hashes защищают локальные входы от
незаметного изменения, но не доказывают marketplace custody; authoritative
Amazon/Walmart exports и реальный owner-attested scope census пока не получены.

## 2. Общий закон cutover

```text
authoritative Phase 1 manifest
  → exact registered listing scope
  → immutable recipe/content/offer/cost evidence
  → versioned Product Truth snapshot
  → consumer-specific projection
  → shadow comparison
  → owner-approved activation
  → enforced read with no legacy fallback
```

Обязательные свойства общей границы:

- listing identity всегда включает channel и positive storeIndex;
- snapshot привязан к точному authoritative manifest SHA-256 и DB target fingerprint;
- `FACT`, `ESTIMATE`, `UNSOURCEABLE`, `INVALID` и `MISSING` не смешиваются;
- новый `UNSOURCEABLE` никогда не воскрешает старую положительную стоимость;
- exact content не зависит от price tier, но price proxy не может стать content truth;
- manual accounting cost не превращается в retailer buy option;
- отсутствие данных создаёт blocker/единую exact-need queue, а не локальный scraper;
- `SHADOW` только сравнивает, `ENFORCED` запрещает legacy fallback;
- activation read-only и отдельно запрещает publish/delist/reprice/purchase;
- один consumer не может включить другой consumer неявно.

До authoritative manifest, применения migrations, backfill и полного readiness-report
режим `ENFORCED` должен быть технически недостижим. Отсутствие валидного owner activation
artifact означает `OFF`, а не implicit shadow или fallback.

## 3. Доказанный аудит текущих bypasses

### 3.1. Bundle Factory

Безопасный образец уже есть в
`src/lib/bundle-factory/walmart-new-sku-engine-runtime.ts`: он использует
`readProductTruthNewSkuView` и повторно проверяет evidence перед действием.

Mass/studio path пока не переведён:

- `studio-engine.ts` и `donor-pool.ts` строят pool/COGS из mutable `DonorProduct` и
  embedded offers;
- `content-pipeline.ts` читает mutable title/bullets/description/ingredients/nutrition;
- `image-pipeline.ts`, `cooler-hero.ts` и `composite-image.ts` могут выбирать изображения
  из donor/sibling pool;
- `donor-dedup.ts` связывает content choice с дешёвой ценой и может схлопывать разные
  product lines по flavor;
- `validation/promote-draft.ts` и draft UI повторно читают legacy donor fields.

Cutover: generic catalog browse/search → sealed new-SKU Product Truth view → draft с
canonical variant/content/price observation bindings → повторный exact read перед
promotion. Любой drift блокирует promotion. Sibling flavor/size не может давать image,
ingredients, nutrition или описание.

### 3.2. Listing Improvement

Legacy Walmart remediation был наиболее опасным bypass:

- `walmart/optimizer-filter.ts` и `walmart/multipack/remediate.ts` выводят pack из bare
  SKU / latest `SkuCost`;
- `walmart/multipack/attributes.ts` берёт facts из mutable `RetailPrice`;
- `walmart/multipack/generate-main.ts` строит image pool из `RetailPrice`;
- remediation транзитивно вызывает `sourcing/enrich.ts` и `resolve-donor.ts`, то есть
  параллельный paid sourcing, а затем способен отправить marketplace feed.

Автоматический `/api/cron/walmart-remediation-worker` теперь hard-retired: route
возвращает `410`, не импортирует enrichment/Walmart/feed code и не может быть оживлён
старым env-флагом. Это containment, а не consumer cutover: legacy builder остаётся
исходным risk/evidence code и не может использоваться как аварийный fallback.

Две другие mutation-поверхности также hard-retired: generated-image apply route и
remediation enqueue `POST` возвращают `410`; read-only remediation audit `GET` остаётся
доступен, а legacy mutation controls в UI отключены. Старый endpoint, прямой queue insert
или вызов feed-кода не являются допустимым обходом. Эти tombstones уменьшают runtime
risk, но Listing Improvement всё равно не считается переведённым на Product Truth.

Amazon legacy Growth execution также локально изолирован: remediation и auto-improve
cron удалены и hard-retired; advisor, optimizer apply, bulk enqueue/drain, rollback и
history `restoreSnapshot` возвращают `410`, сохраняя read-only preview/status/history.
Jackie MCP `listings_update` теперь default-preview и fail-closed отвергает
`dry_run=false` до credential/network access. Legacy engine modules остаются только
evidence/test code и не являются fallback.

Это всё ещё не repo-wide marketplace-write gate. Bundle Factory publish/republish и
scheduled UPC self-heal, Amazon A+ factory, content generation/tick и audit vision
fallback остаются отдельными active business flows. Их текущая session/RBAC,
`approvalConfirmed=true`, `apply=true` или cron-secret boundary не заменяет exact
Product Truth snapshot и отдельный owner action/budget artifact. До отдельного cutover
Product Truth operator их не вызывает, а Listing Improvement/Bundle Factory остаются
`OFF`.

Cutover: preview = diff live channel state против
`snapshot.views.listingImprovement`. Plan хранит contract version, manifest hash,
listingKey, `asOf`, recipe/component IDs, canonical variants, content observation IDs и
полный hash. Перед apply выполняется новый exact read; drift, missing component или
not-ready означает SKIP + idempotent exact-need queue, ноль provider/feed/PATCH calls.

### 3.3. Unit Economics и repricing

`economics/cogs.ts` пока читает `SkuCost` по голому SKU, поэтому view явно маркируется
`LEGACY_UNSCOPED_TRANSITIONAL` и не является authoritative. Fail-open дефекты уже
локально закрыты: первая newest row теперь окончательна даже при NULL/UNSOURCEABLE,
а `economics/resolve-sku.ts` возвращает nullable `BLOCKED` вместо прибыли с COGS=0.
Это не заменяет exact listing-scope cutover.

Отдельный SHADOW adapter теперь сравнивает legacy результат с
`snapshot.views.unitEconomics` на точном `(channel, storeIndex, raw SKU)`. Denominator
берётся из immutable `ProductTruthListingScope` с exact manifest SHA, а не из mutable
price cache: поэтому видимы и `LEGACY_SCOPE_OMITTED`, и повторное использование одного
raw-SKU cost между store scopes. Диагностика отдельно классифицирует untyped cost,
missing scope link, cross-scope evidence, status/value mismatch, canonical blocker и
неразделённый `totalCost` без factual `productCost`. Суммы сравниваются в целых центах;
`ESTIMATE` не повышается до FACT, а UNKNOWN/UNSOURCEABLE/MISSING/INVALID не получают
числового fallback.

Legacy price universe, legacy `SkuCost`, scope links и Product Truth projections
читаются одним fingerprint-bound libSQL client внутри одной caller-owned read
transaction и с одним `asOf=readAt`. Future rows исключаются; полные timestamp ties
разрешаются детерминированно по `id DESC`. Поэтому report не может склеить Prisma из
одной базы с Product Truth из другой или хэшировать torn cross-time comparison.

`reprice/reprice-engine.ts` повторяет raw-SKU/latest-positive закон; при отсутствии cost
имеет fallback floor `$1`. Runtime route hard-retired, удалён из Vercel cron и больше
не импортирует engine/SP-API/Telegram; старые flags/query не могут его оживить. Сам
engine оставлен только как legacy evidence/test code. Catalog COGS API и coverage stats
также считают raw SKU, а не exact listingKey.

Cutover:

- exact snapshot projection возвращает typed `EconomicsCostBasis`;
- product acquisition берётся отдельно от packaging/ice/shipping/fees/ads/returns;
- `ESTIMATE` показывается только как оценка;
- `UNSOURCEABLE`, `INVALID` и `MISSING` дают nullable economics/blocker, а не прибыль с
  нулевой себестоимостью;
- repricing разрешён только для valid `FACT` и полного margin-floor stack отдельным
  owner action gate; `$1` и older-positive fallback удаляются;
- coverage denominator — authoritative listingKey manifest.

### 3.4. Procurement

Текущий Procurement UI — execution board по Veeqo, а не catalog-first planner.
`orders-procurement.ts` строит cards из order lines, для Amazon делает best-effort
SP-API listing calls, а pack size UI выводит regex/Claude из title. Store priority —
ручная mutable таблица. В этом контуре нет чтения Product Truth, inventory allocation,
shortage или offer-combination optimizer.

Первый безопасный MVP остаётся read-only:

```text
order line
  → exact channel/store/SKU scope
  → recipe component demand × order quantity
  → explicit inventory allocation or UNKNOWN blocker
  → fresh factual local offers
  → deterministic pack/store combination plan
```

Estimate и manual cost остаются review/accounting evidence и не могут войти в auto buy
plan. Unknown inventory не равен нулю. Cart/order/purchase и существующие Veeqo bought/
partial mutations не входят в planner activation.

## 4. Общий gateway и масштаб чтения

Нельзя подключать Economics к 4–5 тысячам отдельных вызовов текущего per-listing reader:
каждый вызов проверяет schema, открывает transaction и выполняет зависимые запросы.
Runtime gateway читает set-based chunks максимум по 100 точных listing keys:

1. одна schema/contract проверка;
2. exact listing scopes и manifest provenance;
3. текущий `SkuCost` для каждого listingKey на `asOf`, включая NULL/UNSOURCEABLE;
4. все `SkuComponentEvidence` выбранных costs + canonical variants;
5. текущие exact content observations;
6. выбранные и latest eligible offer observations;
7. сборка теми же pure validators, что использует одиночный reader.

Одиночный и batch reader не должны иметь две копии policy logic. SQL retrieval можно
разделить, но assembly/validation/ranking обязаны быть общими. Любое расхождение snapshot
для одного listing между single и batch — release blocker.

Для runtime SHADOW denominator используется cursor-page по immutable registry:
manifest SHA, channel, storeIndex, limit и cursor валидируются до SQL; строка registry
повторно проверяется на deterministic listingKey, key version, authoritative
registration kind и manifest schema v3. Cursor обязан принадлежать тому же exact
channel/store. Mutable Amazon/Walmart cache может участвовать только как сравниваемый
legacy input и не способен уменьшить Product Truth denominator.

Каждая страница несёт полный registry inventory по всем manifest partitions и exact
scope count. Несуществующий manifest, отсутствующий channel/store partition или
синтаксически правильный, но несуществующий cursor блокируются вместо `PAGE_EMPTY`.
Текущая immutable registry допускает повторный импорт только тех же exact manifest
bytes; successor manifest с уже существующим listingKey честно блокируется. Для
постоянной истории следующих manifest потребуется отдельная immutable membership
таблица, а не перезапись Phase 1 registry.

## 5. Порядок безопасной активации

1. **Contract preparation:** manifest-bound read, activation contract, set-based gateway,
   Unit Economics SHADOW runtime/adapter и architectural no-bypass tests локально
   реализованы. Остальные consumer adapters ещё не подключены.
2. **Owner-gated schema:** применить ordered migrations к точному Turso target и
   подтвердить schema gate. Локальное наличие migration/schema tests не доказывает
   remote state.
3. **Authoritative scope:** получить полные Walmart `ITEM_CATALOG` и Amazon
   `GET_MERCHANT_LISTINGS_ALL_DATA` reports, полный connected-store census, owner
   dispositions и заморозить zero-blocker manifest v3.
4. **Backfill readiness:** read-only `READ_ONLY_NO_PAID_PLAN` связывает exact manifest,
   migration certification и DB target, затем показывает coverage, writer/receipt и
   integrity blockers. Он не выполняет backfill.
5. **Owner-reviewed backfill и verification:** отдельным writer-процессом выполнить
   воспроизводимый no-paid backfill, затем повторно доказать schema, exact scope и
   integrity на Turso.
6. **Readiness report:** на полном manifest посчитать для каждого listing и consumer
   ready/status/blockers; reconciliation count должен равняться denominator manifest.
7. **Shadow:** сравнить canonical и legacy outputs, но бизнес-ответ остаётся legacy;
   записать mismatch classes без provider calls.
8. **Owner activation по одному consumer:** sealed artifact связывает consumer set,
   contract version, manifest SHA, DB target fingerprint, expiry и read-only claims.
9. **Enforced:** canonical output становится единственным; blocker отображается как
   blocker, legacy fallback запрещён.
10. **Legacy retirement:** удалить executable imports/queries только после доказанного
   enforced window и rollback artifact. Старый paid sourcing нельзя оставлять как
   «аварийный fallback».

Рекомендуемый порядок consumer activation:

1. Unit Economics read-only;
2. Procurement read-only MVP;
3. Listing Improvement preview;
4. Bundle Factory catalog-first draft;
5. только затем отдельные mutation gates для repricing, listing apply/publish и purchase.

## 6. Минимальный certification set

- same raw SKU в разных channel/store scopes не пересекается;
- manifest mismatch блокирует все projections;
- latest UNSOURCEABLE побеждает older positive;
- exact content остаётся доступным при ESTIMATE/UNSOURCEABLE price;
- sibling flavor/size content hard-negative;
- mixed recipe требует готовности каждого компонента и точного qty;
- single и set-based batch дают byte-equivalent projection на одинаковом `asOf`;
- SHADOW не меняет consumer output и не вызывает provider;
- ENFORCED не допускает legacy fallback;
- gap создаёт один idempotent exact-need job и ноль provider/marketplace calls;
- preview/apply evidence drift блокирует действие;
- Economics не считает прибыль с COGS = 0 для unknown status;
- Procurement не использует estimate/manual/stale/3P/non-local offer;
- activation не может разрешить publish/delist/reprice/purchase.

## 7. Внешние блокеры, которые код не может объявить выполненными

- ordered migrations и backfill ещё не применены к Turso;
- schema gate/backfill-readiness не верифицированы на точном Turso target;
- authoritative Amazon/Walmart reports и final Phase 1 manifest v3 отсутствуют;
- полный set-based readiness report не построен;
- paid provider canary, иной платный Product Truth run и Phase 1 waves не запускались;
- owner activation artifacts для четырёх consumers не выданы;
- consumer cutover остаётся 0/4.

Следовательно, локальные зелёные тесты доказывают только готовность к следующему gate,
но не production readiness и не завершение Phase 1.
