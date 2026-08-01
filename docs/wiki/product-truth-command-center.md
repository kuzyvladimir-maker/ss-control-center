# Product Truth Control Center — план постоянного внедрения

> **Статус:** active implementation board, owner direction 2026-07-19; сверено
> 2026-07-28.
>
> **Верхний канон:** [[product-catalog-architecture]]. Порядок бизнес-gates:
> [[donor-catalog-execution-roadmap]]. Operator safety:
> [[product-truth-operator-runbook]]. Consumer cutover:
> [[product-truth-consumer-cutover]]. Release boundary:
> [[product-truth-release-scope]]. Matcher evidence:
> [[product-truth-matcher-replay-v2]]. Web operations design:
> [[product-truth-web-operations-control-plane]]. Owner decisions:
> [[product-truth-owner-gates]].
>
> Этот документ не разрешает paid/provider calls, Turso writes, migrations,
> marketplace mutations, publication, repricing, delist или purchase. Он является
> живым планом превращения готового инженерного контура в постоянный модуль SS
> Command Center.

---

## 1. Конечная цель

Встроить единый Product Truth Platform в существующий верхнеуровневый модуль
`Catalog`, чтобы он постоянно, независимо от чатов и каналов продаж:

1. хранил канонические товары, варианты, фасовки и exact content evidence;
2. связывал каждый Amazon/Walmart listing с точным SKU recipe;
3. показывал локальные first-party offers, цены, наличие и COGS provenance;
4. управлял единой enrichment queue, sealed runs, бюджетами и review;
5. отдавал один versioned read-contract четырём consumers — Bundle Factory,
   Listing Improvement, Unit Economics и Procurement;
6. исполнял утверждённую работу durable server worker-ом, а не ручным чатом Claude,
   browser loop или длинным Vercel request;
7. оставлял LLM/vision только программным инструментом identity/content work и
   исключений, а не оператором каждого прогона.

`Walmart Growth` и `Amazon Growth` остаются channel-specific consumers. Они не владеют
каталогом и не создают собственный retailer sourcing.

### Walmart new-SKU consumer proof — 2026-07-27

Bundle Factory Walmart branch доказала canonical read boundary на реальном pilot
candidate без seller-listing catalog и без собственного retailer-harvest:

- donor `75422f18-e3d2-4c62-ae62-7287aaa75119` связан с canonical variant
  `cpv1:ba797cefb49f7b2bba2d45357619561ccd50d436466d8f8d95a9c147070194a9`;
- exact Target content observation
  `pco:68af1a929a86d09772b7c10067c39e441e4d1358378980e0eae8ce4b8992d59e`
  активирован production receipt SHA
  `bdbfb3b2103c65b894e63ff58841aaf8ae6e3efee54e403af917e7c2eade8aa1`;
- Walmart new-SKU release v32 прочитал этот exact content и создал два независимых
  sealed plans/stages: pack-of-2 `WM-5861-AF0E` /
  `afb04afa…aaae` / `f31fd5d4…c97c`, pack-of-3 `WM-E031-D5C4` /
  `e6db2d2c…db53` / `b467491c…fc3a`;
- оба stage зарезервировали owner-pool UPC во внутренней lifecycle DB, но не меняли
  Walmart. Content readiness доказана независимо от оставшихся mutable
  price/account/category/rights/physical-package evidence.

Это consumer-specific proof, а не уменьшение Phase 1 denominator и не замена
authoritative cross-channel manifest/backfill.

---

## 2. Целевая архитектура

```text
SS Command Center
└── Catalog / Product Truth (control plane)
    ├── canonical read-only APIs
    ├── plan / approval / budget / run controls
    ├── durable Product Truth worker
    └── Product Truth database + immutable evidence
        └── versioned read-contract
            ├── Bundle Factory
            ├── Listing Improvement (Amazon/Walmart Growth)
            ├── Unit Economics
            └── Procurement
```

Matcher replay является release/certification surface, а не ежедневной кнопкой
обогащения. Listing audit/generation/apply являются consumer workflows поверх Product
Truth, а не функциями matcher replay.

---

## 3. Правило статусов

- `✅` — завершено и проверено;
- `🔄` — выполняется сейчас;
- `⬜` — ещё не начато;
- `⛔` — остановлено на owner gate или внешнем обязательном входе.

Одновременно активна только одна фаза. После каждого принятого milestone обновляются
этот board, [[task-registry]] и чатовый чек-лист.

Все независимые owner approvals и точные phrases ведутся только в
[[product-truth-owner-gates]], чтобы Codex/Claude не создавали конкурирующие prompts.

---

## 4. Фазовый execution plan

### ✅ Phase 0 — Canonical project board и безопасная исходная точка

- [x] Зафиксировать конечную цель и положение Product Truth внутри `Catalog`.
- [x] Зафиксировать обязательный протокол видимого прогресса в `AGENTS.md`.
- [x] Подтвердить текущие Git `HEAD`, branch и dirty-worktree boundary.
- [x] Сопоставить frozen v2.2 release с постоянным Git tree file-by-file.
- [x] Зафиксировать no-spend implementation sequence и Phase 1 materialization gate.
- [x] Обновить Wiki-Brain и подтвердить ноль broken links.

**Exit:** существует проверяемая карта release → permanent tree; ни один чужой diff
не перезаписан; следующий шаг имеет точный scoped file list.

### ✅ Phase 1 — Permanent engine materialization

- [x] Материализовать актуальный Product Truth source в постоянном Git:
  current base `main 9f59ecbd61df726d8b7b3ef95a60f66cddf376c0` содержит matcher
  `canonical-product-match/1.2.1`, read-contract `3.2.0`, runner, schema и tests.
- [x] Проверить current `HEAD` из отдельного fresh clone: `npm ci`,
  Product Truth `429/429`, CLI help `13/13`, Prisma validate и targeted ESLint —
  `PASS`.
- [x] Подтвердить, что старый integration bundle от 2026-07-19 больше не является
  import candidate: он предшествует matcher `1.2.1` и не должен откатывать current
  source.
- [x] Включить root `AGENTS.md` и все уже связанные из Wiki канонические Product
  Truth/Walmart runbooks в узкий docs-only candidate от current `HEAD`.
- [x] Получить на candidate Wiki-Brain `0` broken links, clean diff и новый
  checksum-bound recovery bundle.
- [x] Rebase implementation на current `main 9f59ecbd` и выполнить read-only
  dirty-worktree preflight всех 35 paths: committed intersection `0`; `10`
  byte-equal, `9` candidate-only, `11` exact earlier candidate revisions и `5`
  divergent owner files.
- [x] Собрать reconciled `r4`, сохранив полный 744-строчный owner task registry,
  три более свежих Walmart 2026-07-25 документа и merged `AGENTS.md`; shared
  worktree не менялся.
- [x] Проверить exact reconciled branch: Product Truth `444/444`, TypeScript,
  targeted ESLint, production build и Wiki-Brain (`0` orphan, `0` broken links)
  — `PASS`. Build сохранил только два уже известных unrelated Walmart/NFT и Sharp
  warning.
- [x] Получить owner decision G1 на локальный import без push/deploy/production:
  подтверждено 2026-07-26.
- [x] Собрать `r5` поверх current shared base
  `af403b1ffbbfa7c039935824c8b9cd8bd59aa99e`, сохранив семь более свежих owner
  документов. Новый schema-probe из shared base выявил пять одинаковых падений
  одного устаревшего fake-client; fake приведён к read-only probe contract.
- [x] Повторить no-hardlink clean-checkout certification: `npm ci`, Product Truth
  `445/445`, TypeScript, targeted ESLint, production build, Wiki-Brain (`0` orphan,
  `0` broken links) и `git diff --check` — `PASS`.
- [x] Импортировать exact certified `r5` в shared local `main` через два
  recovery-stash только пересекающихся release paths; unrelated dirty worktree не
  изменён. Imported commit `df1e6600ef3a38ba402b5785ac7ed4ef1a3597a2`,
  tree `a74a45697a88509478ecf1750995194c9b7c0e6c`.
- [x] Повторить certification в shared tree: Product Truth `445/445`, targeted
  ESLint и Wiki-Brain (`0` orphan, `0` broken links) — `PASS`. Exact clean commit
  ранее прошёл TypeScript и production build. Глобальный `tsc` dirty shared tree
  отдельно выявил две ошибки в параллельных незакоммиченных Walmart-файлах
  (`validator-walmart-product-truth.ts`, `walmart-new-sku-engine-runtime.ts`);
  Product Truth paths их не изменяют. Push и deploy не выполнялись.

**Exit:** воспроизводимый permanent tree содержит готовый engine и проходит тот же
или более строгий certification set без `/private/tmp`.

**Historical artifact — DO NOT IMPORT:** commit `9b194a219423dfa580b4e95e4d992bf1f03282bb`,
tree `88f58b50412783108369076bf94651475154af09`, bundle SHA-256
`b1645c73c13cdbd56442da6906e59b2c1f27bf92fa3a5cb8880cdf13c4f52275`.
Он остаётся доказательством старой интеграции v2.2, но superseded текущим matcher
`1.2.1` и сегодняшним Git `HEAD`.

### ✅ Phase 2 — Canonical read-only backend

- [x] Создать authenticated Product Truth API boundary без direct legacy joins:
  `/api/catalog/product-truth/[view]`, Catalog RBAC и server-side module guard.
- [x] Overview: exact manifest denominator, partitions и readiness четырёх
  consumers из read-contract `3.2.0`.
- [x] Products/variants: immutable canonical identity, pack, exact content,
  source URL/hash/run/approval/receipt provenance и latest retailer observations.
- [x] SKU recipes: exact listing scope → component × quantity через canonical
  batch snapshots, без raw-SKU fallback.
- [x] Offers/COGS: typed `FACT/ESTIMATE/UNSOURCEABLE/MISSING/INVALID`, locality,
  freshness, first-party/source details и independent content/price axes.
- [x] Runs/blockers/spend/artifacts: read-only projections sealed run/items,
  operational queue, metered budgets/receipts и artifact/report hashes.
- [x] Добавить API contract tests, RBAC и no-provider/no-mutation assertions:
  семь новых tests, включая real canonical schema integration всех четырёх views
  и adversarial write-SQL rejection.
- [x] Проверить exact candidate: Product Truth certification `436/436`, TypeScript,
  targeted ESLint и production `npm run build` — `PASS`. Build сохранил два
  существовавших unrelated Turbopack/NFT warning для Walmart shadow path и
  duplicate Sharp runtime; они не относятся к Product Truth API.

**Exit:** UI может получить все canonical projections без mutable `DonorProduct`,
bare-SKU `SkuCost`, paid calls или data writes.

### ✅ Phase 3 — Catalog / Product Truth UI

- [x] Сохранить один grantable/sidebar module `Catalog`; использовать Product Truth
  subtitle. Старые role keys `cogs`/`reference-catalog` больше не отображаются как
  отдельные permissions, но дают backward-compatible доступ к `Catalog`.
- [x] Вкладки: Overview, Products, SKU Recipes, Offers & COGS, Queue & Runs,
  Quality Review, Consumer Readiness.
- [x] Перевести `/catalog`, `/reference-catalog` и `/cogs` на canonical APIs:
  два старых URL сохранены как UI aliases, но больше не вызывают legacy
  `/api/catalog-status`, `/api/cogs/catalog` или `/api/reference-catalog`.
- [x] Удалить ложные legacy cron assumptions и мёртвую Enrich-кнопку из всех трёх
  Catalog UI surfaces.
- [x] Показывать exact content provenance, offer URL/locality/freshness,
  `FACT/ESTIMATE/UNSOURCEABLE/MISSING/INVALID`, blockers, run/approval/receipt,
  budgets и immutable artifact hashes без false green.
- [x] Зафиксировать default-OFF/runtime-invalid состояния, read-only boundary и
  независимость data readiness от consumer activation.
- [ ] Добавить deep links из Walmart/Amazon Growth, Economics и Procurement
  после их staged consumer adapters; текущие legacy consumers не объявлены
  canonical до Phase 6.
- [x] Проверить candidate: Product Truth `437/437`, UI safety `8/8`,
  TypeScript/targeted ESLint и production build `PASS`. Первый sandbox build
  упал только на запрещённой загрузке Google Fonts; exact rerun с network access
  прошёл. Сохранились два unrelated pre-existing Walmart NFT/Turbopack warning.

**Exit:** read-only UI честно отображает Product Truth и не предлагает запрещённый
legacy execution path.

### 🔄 Phase 4 — Default-OFF operations control plane (Stage A complete; later stages gated)

- [x] Отобразить authenticated `Doctor → Plan → Owner Approval → Execute →
  Status/Resume → Report` workflow и точный status каждого шага.
- [x] Показывать durable Product Truth run/items, exact scope, queue state,
  provider ceilings, receipts/spend, blockers, event-chain/report/artifact hashes.
- [x] Держать web `Execute`, retry/replay и self-asserted owner approval
  технически отсутствующими, а runtime — default `OFF`.
- [x] Провести completion/threat audit и зафиксировать canonical design в
  [[product-truth-web-operations-control-plane]]: существующий Product Truth
  operational ledger не дублируется; отдельный SSCC web-command bridge использует
  content-addressed append-only artifacts, отдельный Product Truth Ed25519 domain,
  typed allowlist и pinned long-running worker.
- [x] Доказать, что ChannelMAX/Walmart patterns можно использовать только как
  инженерные примитивы lease/heartbeat/ambiguity и Ed25519 verification; их
  tables, keys, permits и authority не переносятся в Product Truth.
- [x] Реализовать Stage-A custody boundary: отдельная SSCC migration family для
  durable command/artifact/event tables, append-only triggers, exact event chain и
  guarded state/attempt boundary. Migration существует только как проверенный
  локальный artifact и не применена к production DB.
- [x] Выбрать рекомендуемую permanent boundary для owner decision: bounded
  append-only artifact bytes в основной SSCC DB, новый отдельный Product Truth
  Ed25519 trust root/private owner custody и pinned iMac/`launchd` worker. Это
  design decision, а не activation; public image R2 и Vercel request запрещены.
- [x] Реализовать Stage-A локальный admission contract: canonical exact-byte
  envelope, typed allowlist, отдельный Product Truth Ed25519 verifier/domain,
  expiry/key-family checks, `ambiguous=no replay`, immutable terminal states и
  new-output-only artifact semantics. Production trust root и web route отсутствуют.
- [x] Сертифицировать Stage A: Product Truth `451/451`, TypeScript, targeted ESLint,
  Prisma validate, production build и `git diff --check` — `PASS`. Code commit
  `fc98be84cdb6c909e0d5a6db45f8b6570e01bcde`, tree
  `37a706c362201e46c6401756fc0b0347995f9199`.
- [ ] Stage B `ADMISSION_ONLY`: только после нового owner gate; enrollment public
  trust root и UI signing request, но всё ещё без worker claim.
- [ ] Stage C+: отдельный pinned worker и последующие read/write/metered stages —
  только по самостоятельным owner gates.

**Exit:** UI не ослабляет sealed plan, approval, budget ledger или mutation gates;
локальный no-spend smoke полностью воспроизводим.

**Текущий статус:** G2 Stage A завершён локально 2026-07-26 с runtime hardcoded
`OFF`. Ни route, ни worker claim, ни process/network/database runtime не созданы.
Production migration apply, enrollment production key, provider calls/spend и
marketplace actions не выполнялись и не разрешены. До отдельного Stage-B/C gate
готовый CLI из [[product-truth-operator-runbook]] остаётся единственным execution
entrypoint.

### ⛔ Phase 5 — Production data foundation

- [x] Реализовать в current source matcher release `1.2.1` с version + implementation
  SHA + release-manifest SHA и протащить tuple через exact-eight schema, writers,
  COGS и read-contract `3.2.0`.
- [x] Исторический frozen Walmart pilot release v3 выпущен и затем заменён current
  immutable release `walmart-new-sku-pilot-engine-2026-07-23-v23`: Product Truth
  `429/429`, frozen fake-live `3/3`, engine SHA
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`,
  manifest SHA
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`.
- [x] После полностью откатившегося Turso direct-PRAGMA incident исправить только
  transaction compatibility check и доказать committed production writes = `0`.
- [x] Построить свежий exact-eight migration plan v3; plan SHA
  `96b675ac71344a4ded72e51cbe9d4b880139d7d5dd288e67895b8f87924b1d7f`,
  `canApply=true`, `blockers=[]`. Наличие plan/frozen release не означает, что
  production schema уже активирована.
- [x] Выпустить owner-attested connected-store census по решению 2026-07-26:
  Amazon store1/store3 и Walmart store1 в scope; Amazon store2/store4/store5
  исключены как blocked до successor census. Authoritative census содержит все 6
  required scopes, включая два честных `UNRESOLVED`, и 0 blockers; owner scope
  receipt sealed в evidence commit `e129060e`.
- [x] Получить authoritative Walmart ITEM v6 report через sealed G4 workflow,
  выпустить exact report-bound `phase1-scope-disposition/v3` и заморозить manifest v3.
  Единственный create request `019f9f34…319a` достиг `READY` continuation-only
  GET-ами; второй create не выполнялся. Raw ZIP SHA `fa858d5c…c56d`, decoded CSV
  SHA `07de74f3…fb1`, полный каталог `5236` rows: `3891 PUBLISHED`,
  `734 SYSTEM_PROBLEM`, `611 UNPUBLISHED`, malformed/duplicate/conflict = `0`.
  Final cadence `59f25201` ограничен `180s × 9`. Production-schema parser
  `cfb41078` и manifest policy `9090580e` прошли clean suites `229/229` и
  `453/453`. Fresh GET-only Amazon captures: store1 `1571` rows, store3 `502`
  rows, report-create calls `0`. Authoritative
  `phase1-authoritative-scope-manifest/v3` policy `1.3.0` содержит `5935` live
  listings, `6` required scopes, `3` exact reports, `0` blockers; canonical
  SHA-256 `94359db1…9062c`.
- [x] Подготовить exact Turso migration plan и остановиться на owner gate; reserved
  `approvalId` внутри plan не является решением владельца.
- [x] Снять свежий self-contained backup exact target перед owner gate: portable SHA
  `6e69911d1ab83f77545c9fa5789d35e29f11cd434a25b24d2f03e3fdef952526`,
  `integrity_check=ok`, FK violations `0`; local verification воспроизводит exact
  production schema/queue/writer hashes.
- [x] На отдельной локальной копии этого backup выполнить full activation rehearsal:
  `8/8` applied/tracked, schema after `8c9fc783…d511`, 128/128 compatibility rows,
  cancellations `0`, FK violations `0`, integrity `ok`, postcheck blockers `[]`.
  Summary SHA `1afd1b5cf83ff80be5d381e040c75d8847e8630eb5b8ec83f5d9224a99821225`;
  local-only syntactic gate target-bound и не может разрешить production.
- [x] После отдельного owner approval применить ровно восемь migrations одной
  production transaction и сертифицировать target: `8/8` applied/tracked, schema
  after SHA-256
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`,
  post-commit `blockers=[]`.
- [x] После migration certification и authoritative manifest v3 построить exact
  read-only backfill plan. G5 plan `162b2dbd…53cf78` на exact denominator `5935`
  содержит `5935` immutable scope imports и `5935` artifact-only review tasks,
  canonical cost recomputes/provider calls/DB writes = `0`; обе migration ledgers
  ready, writer activity/FK violations = `0`. Additive shared-database drift принят
  только в режиме `PROTECTED_PRODUCT_TRUTH_SCHEMA` при exact 8/8 migrations и exact
  `ProductTruthListingScope` write surface. Clean checkout `0fdbc0c9`, Product Truth
  `454/454`, TypeScript и ESLint pass.
- [x] По отдельному owner approval выполнить exact scope-only `backfill-apply`:
  status `APPLIED`, inserted/exact manifest scopes = `5935/5935`, missing,
  conflicting, unexpected, active writers и FK violations = `0`; canonical cost
  recomputes, legacy promotions, provider/paid calls и marketplace/procurement
  mutations = `0`. Post-apply read-only readiness reconciled `5935/5935`, но все
  четыре consumers остаются blocked на
  `CURRENT_SCOPED_SKU_COST_MISSING`; cutover = `0/4`.
- [x] Построить отдельный no-paid evidence-bound canonical materialization bridge
  поверх уже удерживаемых `DonorProduct`/`DonorOffer`/`SkuComponent`/`SkuCost`, не
  создавая третий каталог и не выполняя повторный enrichment. Read-only audit
  сохранил полный source snapshot SHA `e13cd87b…03e8` и bridge plan SHA
  `27b1d6ae…2360`: из `5935` exact listing scopes только `20` имеют полный exact
  content, `0` имеют цену, проходящую текущую 24-hour policy.
- [x] Первый owner-approved canary plan v1 `c6996af9…9bbd` остановился внутри
  единой transaction на production-only
  `PRODUCT_CONTENT_OBSERVATION_METERED_RECEIPT_INVALID`: legacy observation
  ошибочно наследовал имя metered provider без исторического receipt. Transaction
  полностью rollback; повторный read-only preflight доказал exact-existing `0`,
  absent `35`, FK violations `0`.
- [x] Исправить provenance без фабрикации receipt: apply-plan v1.1 записывает
  canonical materialization route `legacy-materialized-bridge`, а original
  `Oxylabs`/`Unwrangle`/`BlueCart` сохраняет внутри immutable source binding.
  Regression использует `oxylabs` и все восемь production migrations; полный
  Product Truth suite = `468/468`, targeted ESLint = `PASS`.
- [x] Пересобрать новый exact five-graph plan SHA `ba899ce9…fae3d`, maximum DB
  rows `35`, provider/paid/retailer/marketplace/procurement calls = `0`, consumer
  cutover = `false`. Новый read-only production preflight
  `ae64cdd6…be6db` подтвердил `READY_TO_APPLY`, absent rows `35`,
  exact-existing `0`, FK violations `0`.
- [x] По новому exact owner gate применить только plan `ba899ce9…fae3d` как
  5-SKU content canary одной transaction. Status `APPLIED`, inserted rows `35`,
  donor identity transitions `5`, FK violations `0`; apply-report SHA
  `49568cd4…2e15`. Независимый postcheck SHA `28e8254e…9a18` подтвердил
  `ALREADY_APPLIED`, exact-existing `35`, absent `0`.
- [x] Выполнить полный read-only readiness denominator `5935/5935` после canary:
  Bundle Factory ready `5`, Listing Improvement ready `5`, Unit Economics
  `UNSOURCEABLE 5`, Procurement ready `0`; остальные `5930` scope остаются без
  canonical materialization. Report SHA `27d83878…2dfa`, provider calls и DB
  writes `0`, consumer cutover остаётся `0/4`.
- [x] Проверить оставшиеся `15` content-only candidates перед повторным apply.
  Они не являются пятнадцатью независимыми графами: найдено `8` donor/variant
  групп и один fail-closed collision — один College Inn donor для `FaisalX-3816`
  претендует на другой canonical variant, чем `FaisalX-3814/3815`. Старый
  fixed-five контракт для этой волны запрещён.
- [x] Реализовать graph-aware legacy bridge wave contract v2: explicit scope
  `1–50`, unique variant/decision/donor/content rows материализуются один раз,
  listing cost/evidence/scope links остаются раздельными, row ceiling считается
  из фактического graph fanout. `donor → multiple canonical variants` блокирует
  выпуск плана; provider/paid/retailer/marketplace/procurement calls и consumer
  cutover остаются `0`. Shared-graph, collision, idempotency и atomic rollback
  regression прошли; полный Product Truth suite `470/470`, TypeScript, targeted
  ESLint, CLI help и diff-check = `PASS`.
- [x] Построить fresh read-only production snapshot/bridge plan: snapshot SHA
  `0f0b0d48…c4ed`, bridge plan SHA `1f5f90a7…5b5c`, `5935` listings,
  `20` content-only candidates, DB/provider/paid/retailer writes/calls = `0`.
  Первые `5` уже materialized; `FaisalX-3816` исключён из auto-write из-за
  donor→multiple-variant collision.
- [x] Выпустить immutable graph-aware wave v2 для `14` бесконфликтных listings /
  `7` unique donor-content graphs: plan `367ffc2f…0354`, maximum DB rows `70`,
  paid/provider/marketplace/procurement calls/actions = `0`. Fresh production
  read-only preflight `07706ccf…d72c` = `READY_TO_APPLY`, absent `70`,
  exact-existing `0`, donor transitions `7`, FK violations `0`.
- [x] Exact owner gate на plan `367ffc2f…0354` получен и зафиксирован approval
  artifact SHA `3a7c6f36…1033`. Fresh pre-send preflight
  `73b7456d…bc37` повторно дал `READY_TO_APPLY`.
- [x] Graph-aware wave применена одной transaction: status `APPLIED`, inserted
  `70/70`, donor transitions `7`, FK violations `0`; apply report
  `38ddef90…9284`. Independent postcheck `43bb2207…0262` =
  `ALREADY_APPLIED`, exact-existing `70`, absent `0`.
- [x] Full-denominator readiness после wave reconciled `5935/5935`: Bundle
  Factory и Listing Improvement `19 ready`, Unit Economics
  `19 UNSOURCEABLE` / `5916 missing`, Procurement `0 ready`; report
  `014770f0…c644`, provider calls/DB writes `0`, cutover `0/4`.
- [x] Владелец установил standing no-paid policy для будущих collision-free
  canonical materialization waves максимум `100` DB rows после fresh
  `READY_TO_APPLY` preflight. Policy artifact SHA `0ede5d62…2696`; paid/provider,
  marketplace/listing, price/inventory, delisting, consumer activation и
  procurement остаются за отдельными owner gates.
- [x] Встроить standing-policy verifier в wave engine: exact policy bytes/SHA,
  production target, manifest, ceiling `≤100`, collision checks и fresh
  `READY_TO_APPLY ≤15 min` fail closed проверяются до transaction. Exact approval
  остаётся альтернативным однократным режимом. Targeted `21/21`, TypeScript,
  targeted ESLint и полный Product Truth suite `477/477` = `PASS`.
- [x] Устранить повторное обнаружение уже записанных legacy scopes. Snapshot/plan
  `1.1.0` теперь читает exact-confirmed donor bindings и latest scoped component
  evidence, классифицирует полный совпадающий граф как `ALREADY_CANONICAL`, а
  partial/cross-variant state — как quarantine. Fresh read-only production audit:
  source SHA `95f247db…0e3c`, plan SHA `a97497ca…6cd7`, index SHA
  `46c7412c…008`. Из `5935`: `19 ALREADY_CANONICAL`, `0` новых
  content-complete no-paid candidates, `82` identity-only, `5834` quarantine.
  `FaisalX-3816` теперь явно блокируется
  `CANONICAL_DONOR_VARIANT_CONFLICT`; writes/provider/paid/retailer calls = `0`.
- [x] Повысить bridge snapshot/plan до `1.2.0` и отделить seller outer UPC от
  manufacturer UPC базовой упаковки: UPC листинга разрешён как component identity
  только для explicit single-unit scope. Для multipack `FaisalX-1148` exact
  base-unit GTIN `00014100070931` доказан barcode из live gallery, buyer PDP
  quantity `2` и exact Target item `17189284`. Direct Target HTML evidence SHA
  `5e6cc668…a254`, raw HTML SHA `2636f1aa…844b`; один бесплатный retailer GET,
  provider/paid/model/database/Walmart writes = `0`.
- [x] Материализовать `FaisalX-1148` по standing policy: apply plan
  `972848ee…706b`, fresh preflight `READY_TO_APPLY`, `1` listing / maximum `7`
  rows. Apply вставил `7/7`, donor transition `1`; independent postcheck
  `300236be…43d9` = `ALREADY_APPLIED`. Fresh canonical-aware audit source
  `e07ac33b…0a33`, plan `c2c7f466…80f1` показывает `20 ALREADY_CANONICAL`.
  Historical apply report имел inverted operator timestamps; canonical rows
  отдельно verified, а engine теперь отклоняет future/inverted timestamps до
  write transaction.
- [x] Передать exact Product Truth `FaisalX-1148` в Listing Integrity без
  competing catalog: buyer-facing дефекты ограничены description/bullets и MAIN.
  Reviewed MAIN `d5f5a7d9…35858` детерминированно пересобирается из exact
  single-unit source `8d70a272…55c00`, signed blind Qualification = `PASS`,
  gallery неизменна. Frozen release v14 `e9bc8e4f…dbc00e`, manifest
  `438fcf4d…fa1d1`, clean suite `146/146`; one-SKU feed завершён
  `SUCCEEDED`, fresh frozen Qualification = 14/14 `PASS`, factual gallery =
  20/20 `PASS`. Mass apply остаётся закрыт.
- [x] Передать exact Product Truth `FaisalX-2768` в Listing Integrity без
  competing catalog: buyer-visible text уже однозначно задаёт Golden Mushroom
  Soup, Quantity of 4; exact attributes-only payload ограничен `flavor`,
  `count`, `countPerPack`, `multipackQuantity` и достиг terminal successful feed.
  Frozen v20 read-only Qualification = `PENDING_PROPAGATION`, потому что buyer
  PDP ещё показывает старые attributes; текст, все изображения, публикация и
  индексация сохранены. V20 использует опубликованную Walmart шестичасовую SLA,
  а не прежний ложный двухчасовой failure gate. До buyer PASS разрешён только
  fresh no-write reread.
- [x] Повторить full-denominator readiness: `5935/5935` reconciled, Bundle
  Factory и Listing Improvement `20 ready`, Unit Economics `20 UNSOURCEABLE` /
  `5915 missing`, Procurement `0`; report `5c56c425…e92b`, provider calls и
  writes `0`, cutover `0/4`.
- [x] Построить read-only priority/budget forecast оставшихся gaps. Из `82`
  identity-only listings: `48` donor groups, из них `41` collision-free groups /
  `64` listings и `7` collision groups / `18` listings. Source map safe groups:
  `31` Walmart/Oxylabs, `8` legacy Walmart/BlueCart route и `2`
  Target/Unwrangle. Консервативный provider ceiling всей safe выборки = `99.5`
  credits, но это не approval. Старая очередь `1458` не является canonical
  execution scope и не может запускаться вслепую.
- [x] Обобщить бесплатный bounded direct-Target content evidence lane:
  donor/offer/GTIN/Target-item/URL/freshness/raw-HTML/artifact SHA и safety
  counters проверяются fail closed; evidence разрешено только после
  `STRICT_TITLE_MATCH=EXACT_IDENTITY`, а apply хранит отдельный
  `directTargetContentEvidenceSha256`. Snapshot/plan повышены до `1.3.0`,
  apply plan до `2.1.0`, content observation до `1.3.0`. Полный Product Truth
  suite `487/487`, TypeScript и ESLint = `PASS`.
- [x] Выполнить ровно два бесплатных first-party Target GET для двух safe donor
  groups, без retry. Arnold item `12973001` дал exact evidence SHA
  `1fd29173…c7988`, raw HTML `d7bebfde…6f69`; Iberia item `80838482` не содержит
  явного allergen warning, поэтому evidence не выпущен и два listings остались
  identity-only с единственным blocker `ALLERGENS`.
- [x] Материализовать `walmart:1:FaisalX-1228` по standing policy. Fresh audit
  source `7b50ae07…9e601`, bridge plan `9a0d5980…ee7ed`; apply plan
  `91181832…0a069`, `1` listing / максимум `7` rows; preflight
  `16527f8a…cf35` = `READY_TO_APPLY`. Apply report
  `869eebaa…b9ca5` = `APPLIED`, `7/7`, donor transition `1`; independent
  postcheck `5705560d…07cc5` = `ALREADY_APPLIED`.
- [x] Fresh canonical-aware audit после wave: source `487e1681…6204`, plan
  `b2907179…fded`, `21 ALREADY_CANONICAL`, `0` новых бесплатных content-only
  candidates, `81` identity-only, `5833` quarantine. Full readiness report
  `cac37257…44192`: `5935/5935`, Bundle Factory и Listing Improvement
  `21 ready`, Unit Economics `21 UNSOURCEABLE` / `5914 missing`, Procurement
  `0`; provider calls/DB writes `0`, cutover `0/4`.
- [ ] Для оставшихся identity/content/price gaps требуется отдельный G7
  paid/provider plan либо новое authoritative бесплатное first-party evidence;
  прямых Target content-only candidates больше нет.
- [x] Подготовить exact G7 proposal без provider calls. Переиспользуется
  canonical `doctor → plan → execute`, новый движок не создан. Proposal
  `df3da159…65b88` выбирает `5` unique collision-free Walmart graphs,
  разные missing-field профили и worst-case ceiling `17.5` units
  (`5` Oxylabs query + `12.5` Unwrangle detail). Это не plan/permit/approval.
- [x] Зафиксировать recommended review inputs: maximum `17.5` provider units
  и Unwrangle reserve floor `15000`. Они не являются owner approval.
- [x] Материализовать эти inputs в offline unapproved request и
  canonical plan: plan `ae810cb1…5360e`, target set `f7284014…c2ab`,
  expiry `2026-07-28T12:39:07Z`, max `17.5` units, reserve floor `15000`.
  Plan generation имела DB connections/provider calls `0`; automatic
  publish/delist/reprice/purchase = `false`.
- [ ] Получить exact owner approval для plan `ae810cb1…5360e`, затем только
  fresh balance evidence + plan-bound permit/confirmation и execute.
- [ ] Закрывать 86 `UNRESOLVED_EVIDENCE` только authoritative evidence.

**Exit:** production schema доказана отдельно от локального кода; authoritative
manifest и exact sales-listing scope импортированы. Business-data materialization,
readiness и four-consumer cutover остаются отдельными owner-gated этапами; consumed
schema/scope approvals их не разрешают.

### ⬜ Phase 6 — Staged consumer cutover

- [x] Реализовать pure, hash-bound adapters всех четырёх consumers без DB,
  process, provider или network surface:
  `product-truth-consumer-adapters.ts`, `7/7` adversarial tests.
- [x] Повысить только consumer gateway до `1.1.0` и пронести exact recipe
  variant/quantity binding для Procurement inventory; frozen read-contract
  `3.2.0` не изменён.
- [x] Unit Economics — typed basis и существующий default-OFF SHADOW adapter;
  `UNSOURCEABLE`/missing остаются `null`, repricing не разрешён.
- [x] Procurement — pure demand/inventory/factual-pack plan только для review;
  unknown inventory блокирует, estimate/manual не являются buy evidence.
- [x] Listing Improvement — exact-content truth seed для будущего preview;
  live diff/apply отсутствуют.
- [x] Bundle Factory — exact-content draft seed; draft/content/image/publish
  отсутствуют.
- [ ] Подключить consumers к их business runtime по одному после authoritative
  manifest/readiness: `OFF → SHADOW → ENFORCED`, без legacy fallback.
- [ ] Для каждого consumer выпустить отдельный activation artifact и evidence window.

**Exit:** четыре consumers читают единый snapshot без legacy fallback. Publish,
reprice, delist и purchase остаются отдельными owner action gates.

### ⬜ Phase 7 — Controlled operation и Phase 1/2

- [ ] Owner-approved canary 5–10 exact listings, concurrency 1.
- [ ] Ручная проверка quality/spend/idempotency и отдельное решение canary → wave.
- [ ] Waves `25 → 50 → 100 → controlled remainder`.
- [ ] Завершить Phase 1 для всего live Amazon/Walmart assortment.
- [ ] Запустить Phase 2 campaigns по brand/category/retailer/demand.
- [ ] Ввести постоянные freshness, integrity и budget dashboards.

**Exit:** Product Truth является постоянным operating system четырёх бизнес-модулей,
а не разовым batch или chat-owned script.

---

## 5. Owner gates, которые план не обходит

Отдельное подтверждение Владимира требуется перед:

- materialization publish/merge в общий Git remote, если затрагивается shared branch;
- Turso migration apply и backfill writer;
- paid/provider canary или любой wave;
- включением Sam's/Costco; BJ's запрещён;
- consumer `ENFORCED` activation;
- publish/apply/delist/reprice/min-max/cart/order/purchase.

Read-only audits, scoped local code, tests, docs, offline fixtures, local no-spend
smokes и shadow adapters выполняются до этих gates.

---

## 6. Текущая исходная точка

На старте productization (историческая исходная точка):

- permanent repository: `main`, `HEAD=origin/main=f0889fb3bf40e284da15d70c3058ec6a4a45c271`;
- shared worktree содержит многочисленные параллельные modified/untracked files,
  поэтому механический patch/apply в нём запрещён;
- matcher v2.2 frozen engine доказан отдельно, но executable handoff зависит от
  временного `/private/tmp` checkout;
- canonical read-contract, operational store/runner/ledger и safety contracts уже
  существуют в локальной implementation closure;
- current Walmart/Product Truth source от 2026-07-23 использует matcher release
  `1.2.1` с полным immutable provenance tuple; current read-only operator release
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23` проходит Product
  Truth `429/429`, frozen Walmart unit/security с exit `0` и fake-live `3/3`;
  его engine SHA —
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`, manifest SHA —
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`;
- существующий Catalog UI остаётся legacy: direct mutable reads, устаревшие cron
  assumptions и видимая Enrich form при tombstoned POST;
- exact восемь Turso schema migrations применены и сертифицированы; authoritative
  Phase 1 manifest v3 готов (`5935` live listings, `0` blockers);
  `ProductTruthListingScope` содержит exact `5935/5935`, но business-data
  materialization не выполнялась;
  consumer cutover `0/4`; paid Product Truth run не выполнялся.

Следовательно, Phase 1 начинается только после точной release-materialization карты;
UI не соединяется напрямую с legacy endpoints или CLI.

Текущая execution-точка 2026-07-26: G1 импортирован и сертифицирован; G2 Stage A
реализован и сертифицирован с runtime hardcoded `OFF`; G3 owner scope/census sealed;
G4 и G4.5 закрыты exact Walmart ITEM v6 и authoritative manifest v3. Единственный
conditional create request `019f9f34…319a` достиг `READY`; повторный create не
выполнялся. Fresh Amazon store1/store3 и Walmart store1 reports связаны с manifest
SHA `94359db1…9062c`; denominator = `5935`, blockers = `0`. G5 read-only plan
`162b2dbd…53cf78` доказал `5935` scope imports, `5935` artifact-only review tasks,
writers/FK blockers `0` и любые plan-time writes/calls `0`. По отдельному owner gate
scope-only apply завершён `APPLIED`: inserted/exact scopes = `5935/5935`, missing,
conflict, unexpected, writers и FK violations = `0`; cost/legacy/provider/paid/
marketplace/procurement effects = `0`. Full-denominator read-only readiness
reconciled `5935/5935`, но четыре consumers имеют `0 ready` из-за
`CURRENT_SCOPED_SKU_COST_MISSING`; cutover остаётся `0/4`. No-paid bridge поверх
существующего каталога завершён и сертифицирован `468/468`. V1 canary transaction
полностью rollback на production metered-receipt guard; исправленный provenance
прошёл все восемь production migrations. Exact v1.1 5-SKU plan
`ba899ce9…fae3d` применён по отдельному owner gate: `35/35` exact canonical rows,
partial/FK violations `0`. Full readiness reconciled `5935/5935`: Bundle Factory
и Listing Improvement `5 ready`, Unit Economics `5 UNSOURCEABLE`, Procurement
`0 ready`; остальные `5930` ещё не materialized. Consumer activation, paid run и
marketplace actions этим gate не разрешались и остаются выключены.

---

## 7. Phase 0 release-materialization audit

Проверенный Git boundary:

```text
current main commit:  f0889fb3bf40e284da15d70c3058ec6a4a45c271
current main tree:    3be379c5…
common ancestor:      9caf9e7eb914f1db2cf919b08570e85d1e1e9513
frozen final commit:  78e0664908cd37c3746a311084f4826a031b3658
frozen final tree:    7a2eb1a6bbc0886fec33898268db3036e240aa22
```

Frozen release ушёл от общего предка на 24 commits, current main — на четыре
параллельных commits. Exact 242-path comparison показал:

| Scope | Byte-exact | Different | Missing |
|---|---:|---:|---:|
| committed `HEAD` | 192 | 41 | 9 |
| фактический shared worktree | 202 | 38 | 2 |

Два отсутствующих runtime-файла в worktree:

```text
ss-control-center/src/lib/sourcing/product-truth-matcher-replay-v2.ts
ss-control-center/src/lib/sourcing/__tests__/product-truth-matcher-replay-v2.test.ts
```

Девять отсутствующих в committed `HEAD` включают эти два файла и семь canonical
Product Truth docs/root instruction files, которые уже существуют как untracked
owner-worktree content. Прямой adjacent bundle неприменим: current Git не содержит
его prerequisite commit `4a0b1350…`.

Изолированная merge simulation current `f0889fb3` + frozen `78e06649` доказала общий
ancestor и выявила ровно 26 intentional conflict paths. Конфликты сосредоточены в:

- package/schema и Product Truth runner/matcher/contracts/tests;
- mixed canonical docs/AGENTS;
- параллельном Walmart source/reissue workstream.

Поэтому Phase 1 выполняется только в standalone clean clone/branch:

1. fetch полной frozen branch с сохранением 24-commit ancestry;
2. один `--no-commit --no-ff` merge;
3. file-by-file resolution: Product Truth later semantics + current-main unrelated
   work, без wholesale `ours`/`theirs` на mixed files;
4. полный clean certification;
5. новый integrated commit/tree и checksum-bound release packet;
6. никакого merge/push в shared branch без отдельного owner decision.

Это no-spend/local-only sequence. Он не открывает Turso/provider/marketplace gates.

---

## 8. Bundle Factory Walmart demand fallback — 2026-07-28

### ✅ Фаза BF-W1 — канонический request boundary

- Один exact `DonorProduct` с одним direct first-party Walmart offer образует
  ровно один `TARGETED_WALMART_EVIDENCE` workflow.
- Одна owner-facing кнопка может подготовить максимум пять независимых jobs, но
  не превращает их в multi-target provider run: concurrency и attempts каждого
  job остаются `1`, automatic replay запрещён.
- Первый автоматический участок ограничен no-spend
  `doctor → plan`; он не вызывает providers, не пишет marketplace и не создаёт
  второй каталог.
- Каждый будущий `execute` должен отдельно связать exact one-donor plan, fresh
  balance evidence, provider permit и owner authority. Общая команда `делай`
  разрешает реализацию default-OFF кода и тестов, но не заменяет этот money gate.
- После успешного execution Bundle Factory обязан повторно читать canonical
  Product Truth readiness. Продолжение Walmart Generate допустимо только при
  `enough_ready=true` и отсутствии отдельного engine capability gap.

### ✅ Фаза BF-W2 — Web→worker no-spend production activation

- [x] strict batch/job contracts и deterministic idempotency;
- [x] append-only command/artifact/event admission поверх Stage A custody;
- [x] separately authenticated, allowlisted, `shell:false` no-spend worker;
- [x] Bundle Factory launch/status UI и readiness recheck;
- [x] final clean release
  `product-truth-web-control-2026-07-28-r6`,
  commit `61501b563dc1dbe8eee0463d9a8271d5a7db04d1`, Product Truth
  `512/512`, Bundle Factory UI `3/3`, TypeScript, focused ESLint и production
  build = `PASS`;
- [x] production deployment `dpl_6CJbXNB7zpBJ754aoXdGBSPS6Lh8` = `Ready`,
  runtime `PRODUCTION_READ_ONLY`, pinned launchd worker active;
- [x] Campbell's E2E batch `ptbfw-cdc58a911597fd5e37e6afac`:
  `5/5 DOCTOR SUCCEEDED`, `5/5 RUN_PLAN SUCCEEDED`, итог
  `AWAITING_OWNER`; provider calls, metered execution, Product Truth business
  writes и Walmart actions = `0`;
- [x] r6 postcheck `ptbfw-cf8ea0764938f9754fdbe4fb`:
  `1/1 DOCTOR SUCCEEDED`, `1/1 RUN_PLAN SUCCEEDED`, final claim `null`;
- [x] heartbeat/completion race закрыта сериализацией in-flight heartbeat;
  r1–r4 calibration commands сохранены без replay как immutable evidence.

### ✅ Фаза BF-W3 — one-click exact enrichment quote

- [x] один экран показывает exact products, missing fields, balance-probe,
  Oxylabs query `≤1.0`, Unwrangle detail `≤2.5` и суммарный ceiling
  `2.5 + 3.5 × jobs` prepaid provider credits; unsupported USD conversion
  запрещён;
- [x] один click может подписать только все отдельно перечисленные exact
  one-donor targets через отдельный Product Truth Ed25519 trust root;
- [x] private key хранится вне repository в encrypted PKCS8 и открывается
  macOS Login Keychain; Vercel/server/worker/browser получают только public key
  либо detached signature;
- [x] `Approve` создаёт append-only OWNER_APPROVAL, `Decline` оставляет
  terminal `CANCELLED` до spend;
- [x] paid worker выполняет один initial balance probe, затем jobs
  последовательно; следующая job требует balance evidence из предыдущего
  detail response; missing/stale evidence останавливает batch без второго
  probe;
- [x] `maxAttemptsPerJob=1`, `automaticReplay=false`, `marketplaceMutations=0`;
  unknown paid outcome сохраняется как terminal `AMBIGUOUS`;
- [x] успешный batch повторно читает canonical readiness и только при
  `enough_ready=true` и нулевом capability gap продолжает исходный Walmart
  Generate;
- [x] UI восстанавливает batch/request/shipping selection после reload и
  показывает approval/execution audit;
- [x] certification: Product Truth `519/519`, Walmart/Bundle Factory focused
  `18/18`, TypeScript, ESLint и production build = `PASS`;
- [x] final clean release
  `product-truth-web-control-2026-07-28-r7`: commit
  `2e12419221665926aaa44881f2ec5692a2a7cf42`, tree
  `91cc801e7b3e8c15b64d3af5fb2b898362d6af8f`, executable SHA-256
  `28360067b9891a61c5c0ea8f7c836e939e0e29cdc53b7041aa7ec6820399d8f7`;
- [x] external owner key enrolled через encrypted PKCS8 + macOS Login
  Keychain; public trust root SHA-256
  `6d410aeb1f4fa947b9f85d9ff5f0adaa77270967e4635019271b8a5d940417b5`;
- [x] production deployment `dpl_7Qv2gde7DXRmg977gEz8FiC9n7PD` =
  `Ready`, alias `salutemsolutions.info`, runtime
  `PRODUCTION_OWNER_GATED_METERED`, pinned owner-agent и worker active;
- [x] no-spend E2E batch `ptbfw-f464598c22650c76c631c239`:
  `5/5 DOCTOR SUCCEEDED`, `5/5 RUN_PLAN SUCCEEDED`, status
  `AWAITING_OWNER`; exact quote
  `ptq-6f91025cbbd87e2654e4d2c86dab3619`, maximum `20` prepaid provider
  credits; `provider_calls_may_have_started=false`,
  `metered_execution_admitted=false`, Walmart mutations `0`.

Граница BF-W3: она обогащает только уже существующий exact `DonorProduct` с
direct first-party Walmart offer. `matched_variants=0` означает отдельную Phase 2
demand-expansion campaign. Такой новый donor нельзя незаметно создать тем же
quote: production campaign registry/runtime всё ещё отсутствует и остаётся
отдельным blocker, а consumer только показывает честную границу.

### ✅ Фаза BF-W4 — полный owner request и Pack of 8

- [x] Удалены устаревшие owner-facing лимиты `1–2 listings` и `Pack of 2/3`:
  Bundle Factory сохраняет точные числа из prompt/structured fields и блокирует
  только реальное расхождение между ними.
- [x] Запрос `5 listings × Pack of 8` детерминированно раскладывается на пять
  независимых one-listing work items. Это orchestration boundary, а не
  разрешение массового Walmart apply; каждый live POST по-прежнему требует
  собственные canonical evidence и owner permit.
- [x] Deterministic Walmart content, commercial discovery, owner preview и
  exact-pixel compositor принимают Pack of 8. Main image содержит ровно восемь
  копий exact donor package image после connected-white-background cutout;
  generative redraw и выдуманный packaging design запрещены.
- [x] Certification: request/parser, full Walmart new-SKU and Bundle Factory
  focused suite `108/108`; Product Truth `519/519`; TypeScript, focused ESLint
  и production build `PASS`. Build сохранил только существующее duplicate-Sharp
  runtime warning.
- [x] Production read-only Campbell's proof: `matched_variants=5`,
  `ready_variants=0`; все пять exact variants имеют единственный gap
  `FRESH_LOCAL_PRICE` и все `5/5` допустимы для existing one-donor targeted
  collector. Contract dry proof сохранил `listing_count=5`, `pack_count=8`,
  создал `5` independent jobs по `3.5` provider units максимум каждый,
  automatic paid execution `false`, marketplace mutation `false`. Existing
  owner quote ceiling для такой пятёрки остаётся `20` prepaid provider credits
  (`2.5` balance reserve + `5 × 3.5`).
- [x] Frozen operator release v33 выпущен из commit
  `b00aaf6ae84ab888bb04be0db54c85be2570e22a`: engine
  `fe76e6378a48c024f464d44a71ca7ebb88a7ffa1fb61c7f24eca1fcf37872946`,
  manifest
  `2593cd462ee1fdc2a46ab87bfdc4f672a45e6a6a68d7aa8221cd8356ce85127f`,
  certificate
  `806c75a69fbab9d05f9e1f38a2e3396ff90592cf4b35f731386af548a84c6f1f`;
  pre- и post-test self-verify `PASS`.
- [x] Production deployment `dpl_561wp4SR15HHGb7dPN8uB2U3NG43` =
  `READY`, alias `salutemsolutions.info`. No-spend HTTP postcheck главной
  страницы и `/bundle-factory/new` вернул штатный `307 → /login` для
  неавторизованного запроса; provider calls и Walmart mutations `0`.

BF-W4 не меняет live mutation authority: protected execution остаётся
последовательным, а marketplace publication не следует из размера owner request.

### ✅ Фаза BF-W5 — channel-specific Advanced и автоматический enrichment quote

- [x] Walmart `Advanced` отделён от Amazon/Uncrustables: house brand,
  Uncrustables image style, generative photo controls и per-request text-model
  selector не рендерятся и не отправляются в Walmart request. Server route
  входит в canonical Walmart branch до parsing/defaulting этих Amazon-only
  полей, поэтому они не могут повлиять на manufacturer brand или image truth.
- [x] Walmart `Advanced` оставляет только target margin; blank сохраняет
  owner default `30%`. UI явно фиксирует exact manufacturer brand и verified
  donor imagery без generative product redraw.
- [x] Устаревший, фактически неиспользуемый Bundle Factory model selector
  удалён. Text model теперь выбирается только центральным
  `src/lib/ai-models.ts`; live Anthropic Models API 2026-07-29 подтвердил
  `claude-opus-5`, и premium pin/Bundle Factory content generation переведены
  на этот ID после проверки migration boundary. Walmart deterministic content
  от LLM по-прежнему не зависит.
- [x] При exact existing donor data gap основной Generate автоматически
  запускает только no-spend preparation пяти независимых targeted collection
  plans. Лишняя owner-кнопка `Prepare collection plans` удалена; первый
  обязательный owner action — review и `Approve exact quote`. Retry остаётся
  только для честной infrastructure failure.
- [x] Certification: focused fallback/content `19/19`; полная Walmart/Studio
  regression `194/194`; Product Truth `519/519`; TypeScript, focused ESLint
  (0 errors, 2 pre-existing A+ warnings) и production build `PASS`.
- [x] Production deployment `dpl_3PPs9HP2xMAyQrueV3U1kSKADgky` = `READY`,
  alias `salutemsolutions.info`. No-spend HTTP postcheck:
  `/bundle-factory/new` штатно вернул unauthenticated `307 → /login`, а
  protected readiness API — `401`; provider calls и Walmart mutations `0`.
  Подключённая authenticated browser-сессия отсутствовала, поэтому visual
  postcheck не был ложно заявлен.

BF-W5 не авторизует provider spend или Walmart mutation. No-spend planning
может стартовать автоматически; paid enrichment начинается только после
external owner signature точного показанного quote.

### ✅ Фаза BF-W6 — donor-bound Walmart draft runtime и buyer review

- [x] `Generate` после readiness больше не создаёт frozen/manual handoff:
  route повторно читает Product Truth, фиксирует requested listing/pack count,
  выбранный Walmart account/template и margin, затем атомарно создаёт
  `GenerationJob` с отдельным immutable `GenerationWorkItem` для каждого exact
  canonical variant.
- [x] Walmart получает собственный channel engine внутри общего Bundle Factory.
  Он обрабатывает durable queue по одному item, имеет CAS claim, stale-lock
  recovery, максимум три попытки и recipe-level idempotency. Legacy Amazon
  Studio, Walmart API client и UPC pool в этой ветке недоступны.
- [x] Каждый draft перед записью повторно доказывает те же donor product,
  canonical variant, content observation и price observation. Mutable
  `DonorProduct` не является content/price truth; template snapshot защищён
  SHA-256 binding.
- [x] Economics использует exact unit COGS × pack count + `$1.50` packaging +
  `$8.78` outbound label, Walmart referral `15%` и owner-selected margin
  (default `30%`). Item price и buyer shipping рассчитываются по точному live
  template snapshot так, чтобы один customer landed total сохранял целевую
  маржу во всех активных rate scenarios.
- [x] Main image строится только из exact donor package pixels: connected white
  background удаляется до композиции, artwork не перерисовывается, а число
  копий равно pack count (включая Campbell's Pack of 8). Image fetch принимает
  только HTTPS raster assets с approved Walmart/Salsify/Scene7/brand CDN,
  проверяет каждый redirect и держит жёсткий лимит `25 MiB`.
- [x] После batch completion владелец получает список всех drafts и отдельную
  Walmart buyer-page preview для каждого: gallery, title, price, shipping,
  landed total, bullets, description, ingredients/allergens/nutrition и exact
  observation evidence. Preview не содержит publish/UPC mutation controls.
- [x] Request diagnosis теперь допускает до `500` owner-requested drafts и
  сканирует exact Product Truth catalog постранично; прежняя скрытая отсечка
  первых `1000` строк удалена.
- [x] Local certification: focused Walmart/Studio queue, preview, shipping,
  content and image suite `61/61 PASS`; TypeScript, targeted ESLint и production
  build `PASS`. Реальные Campbell's content observations используют approved
  hosts `i5.walmartimages.com`, `images.salsify.com`, `target.scene7.com`.
- [x] Release commit `d8ccc86da…` развёрнут production deployment
  `dpl_9UpAYGAVR4KtjjzYyiFcZnYcesVX` = `READY`, aliases включают
  `salutemsolutions.info`. No-spend HTTP postcheck: `/`,
  `/bundle-factory/new` и новый review route штатно вернули `307 → /login`,
  protected readiness API — `401`. Provider spend, UPC reservation и Walmart
  mutations равны `0`.
- [ ] Authenticated visual postcheck не заявлен: подключённая browser session в
  текущем Codex runtime отсутствовала; первый owner run остаётся визуальным
  acceptance этой поверхности, а не техническим разрешением на publication.

BF-W6 закрывает существующие exact donors. Если `matched_variants=0`, Bundle
Factory обязан создать demand-expansion request в едином Product Truth Platform;
собственный retailer scraper или второй каталог запрещены. Исполнение такого
Phase 2 запроса остаётся platform gate до доказанного завершения глобальной
Phase 1, но это не ограничение количества Walmart drafts и не относится к
Campbell's, где exact donors уже существуют.

### ✅ Фаза BF-W7 — recovery кнопки подготовки enrichment plan

- [x] Production failure `The Product Truth collection control configuration is
  invalid. No command was created.` локализован до server admission: shared
  `PRODUCTION_READ_ONLY` runtime конфликтовал с сохранённым полным owner public
  trust root; prompt, Pack of 8 и Campbell's donor readiness причиной не были.
- [x] Shared read-only и Walmart paid authority разделены. Base runtime может
  проверить и удерживать public key, но не получает spend authority. Отдельный
  exact Walmart confirmation связан с release/commit/tree/executable,
  database target, manifest и owner public-key fingerprint; partial/stale/wrong
  binding остаётся fail-closed.
- [x] Approval API использует только Walmart overlay, worker claim включает
  `EXECUTE` только при валидном overlay; no-spend doctor/plan продолжает работать
  от base runtime. Exact quote click и detached local Ed25519 signature остаются
  единственным money gate.
- [x] Release `product-truth-web-control-2026-08-01-r8`: commit
  `4a9e761aabd3f8cf10973d02197068345b7cae54`, tree
  `143b1f045d8e1cd4c8acbc03700c46903a263d65`, executable
  `992c55c0a825c4537ebc5b3b171fd8c1156f41277222a8d08559a503f9823d46`;
  deployment `dpl_7Sf145ugwQhYLErkiizRamBpDC1T` = `READY` и production alias
  обновлён.
- [x] Pinned worker и owner-agent установлены из exact r8 checkout; оба launchd
  services `running`, owner loopback preflight `204`, worker token совпадает с
  production hash и новых worker errors после запуска нет.
- [x] Certification: Product Truth `521/521`, focused collection UI/contract
  `8/8`, TypeScript, ESLint, local и Vercel production build = `PASS`.
- [ ] Authenticated owner Retry остаётся единственным visual smoke: управляемая
  browser session в Codex runtime отсутствовала. Этот click разрешает только
  no-spend plan preparation; показанный exact quote требует отдельного owner
  подтверждения до provider spend.

### ✅ Фаза BF-W8 — production reliability recovery collection batch

- [x] Повторный owner click больше не создаёт дубли: command identity и
  idempotency привязаны к logical batch/job, а не к изменяемому timestamp.
  Read/status path фильтрует команды по exact current release, поэтому
  незавершённые r8/r9 rows остаются immutable audit evidence и не меняют статус
  successor batch.
- [x] Runtime приведён к уже применённой production control-ledger schema:
  append-only migration history из девяти записей совпадает byte-for-byte;
  новая migration и Product Truth business-data mutation не потребовались.
- [x] Remote transaction/heartbeat window расширен только для bounded control
  operations. Потеря heartbeat теперь переводит текущую команду в явный
  terminal failure через complete path, а не оставляет вечный `RUNNING` и не
  вызывает автоматический replay.
- [x] Release `product-truth-web-control-2026-08-01-r11`: commit
  `97ffabce993256c8eb8012abb5154a09419ba94d`, tree
  `35ffa5b8ef127615867e119e32046dcaacec54e9`, executable SHA-256
  `d8f04ef7ee226e3de55ab49cce5082efce55e7f671c040d9043ca043e71e3223`;
  deployment `dpl_EFbFw1ddDCAFLLWVoP9yaVSkMWaG` = `READY`, production alias
  `salutemsolutions.info`, pinned launchd worker и owner-agent работают из
  exact sparse checkout.
- [x] Чистый Campbell's batch `ptbfw-14e44dd192718b33ff8b0bb2` доказал ровно
  `5/5 DOCTOR SUCCEEDED` и `5/5 RUN_PLAN SUCCEEDED`, общий status
  `AWAITING_OWNER`; quote `ptq-b32ff65d283f474ba4ffaf7ccbd2a352`
  имеет ceiling `20` prepaid provider credits и `5` independent actions.
  `EXECUTE=0`, provider spend, Product Truth business writes и Walmart
  mutations `0`.
- [x] Certification: Product Truth `524/524`, focused Walmart collection
  `11/11`, TypeScript, focused ESLint и production build = `PASS`.

BF-W8 не является денежным approval. Следующий допустимый owner action — только
review и approval exact quote в UI; до него enrichment не стартует.

### 🔄 Фаза BF-W9 — Campbell's execution recovery и Walmart duplicate guard

- [x] После owner approval exact quote production `EXECUTE` был claimed, но
  old worker получил `/start HTTP 409 (P2028)` до execution boundary.
  `attempts=0`, `executionStartedAt=null`; provider spend, canonical business writes
  и Walmart mutations равны `0`.
- [x] `startProductTruthNoSpendCommand` переведён на remote-safe atomic batch
  transaction; start идемпотентен, expired zero-attempt command не claimable
  и отображается terminal. Status группирует immutable retries по logical
  run и показывает exact error владельцу.
- [x] Fresh successor ITEM v6 source дал `5 235` rows во всех seller statuses.
  Owner-signed activation атомарно заменила `WalmartCatalogItem(store)`
  и связанный diagnostic `WalmartReport`; receipt `ACTIVE`, `row_count=5235`,
  повторный plan = `NOOP_ALREADY_ACTIVE`. Это duplicate guard, не новый
  donor catalog.
- [x] Исправленная ветка прошла Product Truth `527/527`, Walmart
  unit/contract `41/41`, native owner/report `27/27`, frozen fake-live `3/3`,
  TypeScript, ESLint и production build.
- [x] Exact r12 server/worker release активирован; Campbell's owner-approved
  execution выполнил initial balance probe и первый exact Walmart price query.
  Protected wall-clock потребовал safe resume только distinct not-started
  detail boundary; повторного Oxylabs query не было.
- [x] Первый товар завершён terminal `AMBIGUOUS` с
  `UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`: Unwrangle detail был
  успешен как provider call, но content snapshot честно заблокирован на
  `ALLERGENS_MISSING; STORAGE_MISSING`. Ledger: первый item `3.5` credits,
  initial balance probe `2.5`, total `6.0`; candidate/business projection и
  Walmart mutations `0`. `next_command=null`, retry этого run запрещён.
- [x] Root cause: existing exact Campbell's content уже был выбран из Target
  legacy bridge и readiness не хватало только `FRESH_LOCAL_PRICE`, но targeted
  reuse ошибочно ограничивался old `sourceApi='unwrangle'` с exact Walmart URL.
  Контракт исправлен: pre-plan content любого channel разрешён только для того
  же exact donor/canonical variant/variant decision и только если current
  versioned read-contract повторно выбирает его с ingredients, nutrition,
  allergens и gallery gates. Price proxy/content mixing по-прежнему запрещены.
- [x] Worker сохраняет исходное fresh balance evidence, когда item завершён
  exact price + preexisting content без detail call; следующие sequential jobs
  не блокируются ложной ошибкой missing next-detail balance.
- [x] Добавлен durable owner progress: product `X/N`, title, exact stage,
  percentage, completed/stopped, provider credits, heartbeat freshness,
  timestamp и human terminal reason. Progress связан с exact `EXECUTE` command,
  пишется в append-only events и восстанавливается после browser refresh.
- [x] Локальная certification новой ветки: Product Truth `530/530`, focused
  Walmart/Bundle Factory `193/193`, TypeScript, changed-files ESLint и
  production build `PASS`.
- [x] Exact r13 server/worker release выпущен: commit
  `093fc4f151955e69979063aef22194b53e06950c`, tree
  `43fe5c3056644b707c5f40c69956da7a5a58a391`, executable SHA-256
  `7dc9941759c5bfa01bfc7e73ba471159ca61859f04ae1c9e3172c03f614dd54d`.
  Production deployment `dpl_5vLPKQMJ77GAbeBDME9SvfPJsJcf` = `READY` и
  назначен на `salutemsolutions.info`; clean pinned launchd worker и loopback
  owner-agent работают из exact r13 checkout, owner preflight = `204`.
- [ ] Повторить Campbell's `5 × Pack of 8` через новый exact quote до
  enrichment и пяти owner-review drafts. Terminal batch
  `ptbfw-14e44dd192718b33ff8b0bb2` не retry/replay. Никакой Walmart
  publication до отдельного SKU-bound gate.
- [x] Первый r13 successor batch `ptbfw-e9e9310dcf4fbbcc33585dc3`
  доказал ещё один no-spend admission defect: четыре exact plans завершились,
  но первый doctor честно остановился
  `TARGETED_EVIDENCE_PRIOR_HARVEST_STATE_FORBIDDEN`, потому что candidate
  discovery повторно выбрал donor с уже существующим detail-harvest lifecycle.
  Provider calls/spend и marketplace mutations этого doctor равны `0`.
- [x] Candidate discovery приведён к first-attempt-only runner boundary:
  до admission он read-only проверяет exact
  `donorProductId + unwrangle:walmart + retailerProductId`, пропускает любой
  prior lifecycle и продолжает искать untouched exact donor. Production
  catalog dry check: `20` matched, использованный donor исключён, следующие
  `5` кандидатов найдены; provider calls `0`.
