# Product Truth Control Center — план постоянного внедрения

> **Статус:** active implementation board, owner direction 2026-07-19; сверено
> 2026-07-27.
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
  а не прежний ложный двухчасовой failure gate. Frozen v21
  `0378f158…df56a` (`157/157`) параллельно закрывает compiler gap: обычная
  one-SKU attribute lane теперь не может менять активный variant-group key и
  возвращает `VARIANT_GROUP_REPAIR_REQUIRED`. Frozen v22
  `5af7bc87…5846b81` (`162/162`) добавляет только narrow single-member
  group-aware fallback, доказанный полным ITEM v6 population и теми же fresh
  live/spec bytes; один SKU, один primary, один POST maximum, zero retry.
  Ordinary v18 feed после полного шестичасового SLA доказанно не опубликовал
  атрибуты и закрыт fresh Qualification `FAIL`; все нецелевые поля остались
  PASS. V22 group-aware payload `e29c3947…353a` был отправлен ровно один раз:
  feed `18C646C459EA512FA3901FDEDE289A71@AX8BBgA` = `PROCESSED`,
  `1/1 SUCCESS`, retry `0`. Первая fresh Qualification =
  `PENDING_PROPAGATION`; scheduled rereads дали тот же честный результат при
  PASS всех нецелевых facets. Final Qualification at
  `2026-07-28T04:45:10Z`, after the exact SLA boundary, is `FAIL`: buyer PDP
  still shows `Count=1` and omits Flavor, Count per pack and Multipack
  quantity. Receipt SHA `c8a6110a…add53f`; no factual gallery or successor pool
  was created. The next action is a targeted attribute-update contract replan,
  not another blind POST. The completed monitor's accidental launchd keepalive
  job was removed.
- [x] Refresh the Walmart Listing Integrity census and controlled pool after
  sync `2026-07-28T06:00:01Z`: `3566` SKU / `2644 PUBLISHED` / `3471 ACTIVE`,
  census file SHA `f5b08a01…92226d`, plan file SHA `74ed37e7…19f0b7`.
  Pool `controlled-pool-c2a1c74507029bf12380`, file SHA
  `99cd89b2…e72a9`, contains `14 repair-ready` / `1190 source-required` from
  `1204` candidates and excludes unresolved `FaisalX-2768` quarantine without
  marking it repaired. Historical remediation `ok=1` remains non-authoritative;
  only three cases have fresh Qualification PASS and factual galleries.
- [ ] Complete the next Product Truth consumer canary `FaisalX-1140`.
  Product Truth identifies Pepperidge Farm Farmhouse Hearty White Bread,
  Pack of 4; the reviewed Walmart diff changes only description, bullets, MAIN
  and gallery. Frozen Listing Integrity v26 `e5e8bfbb…250ae91` passed
  `186/186` and accepts the exact v25 execution as its only Qualification
  predecessor. Walmart accepted exactly one POST as feed
  `18C689CE7F4F50BCBC0E931360F8D73F@AX8BBwA`; current state is
  `APPLIED_PROPAGATING / FEED_NOT_TERMINAL`. Only GET-only continuation is
  allowed. The consumer remains incomplete until fresh Qualification PASS and
  a factual gallery prove the Product Truth target, publication and indexing.
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
- [x] Получить exact owner approval для plan `ae810cb1…5360e` на пять listings,
  max `17.5` run units и reserve floor `15000`.
- [x] Старый plan истёк до использования отдельного probe gate; pre-network
  check сохранил provider calls/units и production writes на `0`.
- [x] Бесплатно перевыпустить тот же target set и ceilings: replacement plan
  `bca2decb…6413c`, request `3ee96292…c83`, target set `f7284014…c2ab`,
  expiry `2026-07-29T17:27:40Z`; plan-time DB/provider calls `0`.
- [x] Получить объединённый exact owner gate для replacement plan и balance
  probe с заявленным combined ceiling `18.5`.
- [x] Выполнить один Target Search balance probe без retry. Provider вернул
  HTTP `200` и balance `99692.5`, но live tariff оказался `2.5`, а не
  разрешённым `1`. Evidence `9c385650…1a6f`; provider calls `1`, actual units
  `2.5`, canonical/marketplace/business writes `0`. Основной run fail-closed
  не запускался, потому что его worst-case `17.5` дал бы combined `20.0` >
  approved `18.5`.
- [x] Исправить локальный Target Search tariff guard на `2.5`, добавить
  regression test и пересертифицировать Product Truth: `489/489`.
- [ ] Получить один amended combined owner gate: признать consumed `2.5`,
  разрешить максимум один fresh evidence-only probe `2.5` только если stale
  и основной unchanged plan `17.5`; cumulative ceiling `22.5`. Plan
  `bca2decb…6413c` действует до `2026-07-29T17:27:40Z`.
- [ ] После fresh balance evidence собрать exact plan-bound permit/confirmation
  и выполнить один sealed execute.
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

- [ ] Standing-policy canary 5–10 exact listings, concurrency 1.
- [ ] Machine quality/spend/idempotency acceptance canary → bounded wave.
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
- изменение pinned Product Truth provider budget policy за её текущие границы;
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

### 🔄 Фаза BF-W2 — Web→worker implementation

- [x] strict batch/job contracts и deterministic idempotency;
- [x] append-only command/artifact/event admission поверх Stage A custody;
- [x] separately authenticated, allowlisted, `shell:false` no-spend worker;
- [x] Bundle Factory launch/status UI и readiness recheck;
- [x] offline/local certification без provider calls, production DB writes или
  Walmart actions: Product Truth `506/506`, targeted integration/safety
  `51/51`, UI route `2/2`, TypeScript, focused ESLint и production build =
  `PASS`; provider calls, production writes и Walmart actions = `0`.

---

## 9. G7 production canary closeout — 2026-07-28

Immutable closeout:
`ss-control-center/data/audits/product-truth-g7-closeout/20260728T194500Z/g7-closeout.json`,
SHA-256 `c73aff010a5db3139f7674acefc52426dd9ca741e656e4866dcd00a16d771a4c`.

- [x] ✅ Exact five-listing listing-scope canary выполнен и сохранён. Первый run
  остановил дефект отсутствующего `REJECT matchTier`; после исправления
  replacement run честно завершил все пять listings как `terminal_gap`.
- [x] ✅ Targeted exact-item canary выполнен без retry: Fritos, GOYA и Popeye
  получили fresh local first-party price observations; Mott's был отклонён как
  `inStock=false`; Glory не прошёл бесплатный bootstrap preflight
  `TITLE_BRAND_NOT_FOUND`.
- [x] ✅ Unwrangle live tariff закреплён как `2.5` units и для search, и для
  Walmart detail. Фактический полный G7 расход: `19` provider calls /
  `32.5` provider units (`Oxylabs 10`, `Unwrangle 22.5`), последний
  наблюдавшийся Unwrangle balance `99672.5`.
- [x] ✅ Повторы отсутствовали; clubs/BJ's/marketplace writes/price-inventory
  changes/delist/consumer activation/procurement = `0`.
- [x] ✅ Lease bug закрыт: targeted lease теперь `8 min` при sealed wall clock
  `6 min`; Popeye orphaned control-run транзакционно reconciled в
  `ambiguous` по уже закрытым receipts, без нового provider call.
- [x] ✅ Полная Product Truth certification после исправлений: `508/508`.
- [x] ✅ Fresh post-canary bridge audit выполнен: bridge plan SHA
  `d644d6ba…ae55`, `5935` listings, `20` already canonical,
  `71` identity-only write candidates, `5844` quarantine.
- [ ] ⬜ G7 не может переходить в следующую paid wave: bootstrap создаёт
  conservative donor-title canonical variants, которые у Fritos/GOYA/Popeye
  не совпадают со structured listing-component variants. Bridge правильно
  возвращает `CANONICAL_DONOR_VARIANT_CONFLICT`.
- [ ] 🔄 Следующая инженерная граница —
  `LISTING_BOUND_TARGETED_BOOTSTRAP`: exact listing scope/target variant должен
  быть sealed в plan и независимо подтверждён fresh exact retailer evidence
  текущим strict matcher. Старые paid receipts не replay и не перепривязываются
  вручную.

### Listing-bound bootstrap v1.4 — local certification 2026-07-28

- [x] ✅ Request/plan contract поднят до `1.4.0`; новый
  `LISTING_BOUND_BOOTSTRAP` требует exact `listingKey + componentIndex`.
- [x] ✅ Target canonical variant теперь строится только из уже импортированной
  `SkuShippingData.productIdentity` конкретного scope/component. Retailer/donor
  title служит строгим доказательством, но больше не определяет раскладку
  `productLine/flavor/form`.
- [x] ✅ Sealed binding включает byte-exact full rows
  `ProductTruthListingScope`, `SkuShippingData`, `SkuComponent`, их общий SHA-256
  и exact donor link. Любой drift блокируется до provider boundary.
- [x] ✅ Старый `EVIDENCE_VERIFIED_BOOTSTRAP` остаётся читаемым только как
  исторический artifact, но новый исполняемый plan из него не строится:
  `TARGETED_EVIDENCE_UNBOUND_BOOTSTRAP_RETIRED`.
- [x] ✅ Regression воспроизводит прежний duplicate-ID defect и доказывает, что
  listing-bound ID равен target ID листинга.
- [x] ✅ Первый read-only production preflight выявил до provider boundary
  отдельный multi-word brand defect: canonical hash намеренно token-sorted, но
  donor title proof обязан сохранять исходную фразу `Pepperidge Farm`. Исправление
  использует byte-bound raw listing identity только для matcher proof и не меняет
  canonical ID. Provider spend и production writes = `0`.
- [x] ✅ TypeScript = PASS; unit `14/14`; executor integration `11/11`; полный
  Product Truth suite `512/512`.
- [x] ✅ Три ошибочно привязанных pilot donor aliases не менялись и остаются
  quarantined append-only history; их receipts не replay.
- [x] ✅ Superseding clean frozen release:
  commit `a5debaf7540e…`, tree `a47aa03d5674…`, TypeScript PASS,
  Product Truth `512/512`, clean checkout.
- [x] ✅ Повторный production `doctor → plan` для untouched
  `walmart:1:FaisalX-1177` прошёл read-only: `0` provider calls, `0` DB writes;
  listing-bound plan SHA `4e8524d7332c…`.
- [x] ✅ Exact owner-money gate consumed один раз: fresh balance probe `2.5`
  units + working run `3.5`, retry `0`, cumulative `6`.
- [x] ✅ Canary terminal fail-closed:
  `AMBIGUOUS / UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`. Search
  сохранил exact price/decision evidence; неполный detail не стал content truth.
- [x] ✅ Fresh bridge postcheck `77c7cc9a…ffd5c` выполнен read-only и выявил
  same-donor graph conflict между `FaisalX-1176` и `FaisalX-1177`; aggregate
  остаётся `20 canonical / 71 identity-only / 5844 quarantine`.
- [x] ✅ Contract `1.5.0` теперь seals весь authoritative same-donor listing
  graph и блокирует разные derived variant IDs до provider boundary.
  TypeScript PASS; unit `15/15`; integration `12/12`; полный suite `514/514`.
- [x] ✅ Clean frozen release `1.5.0` выпущен: commit
  `eaf68d8ce04da6b514ac2f876a60894e734665ac`, tree
  `9ea153248d6dac701f952694aca2f84a412e69b9`; sparse clean checkout:
  TypeScript PASS, Product Truth `514/514`, worktree clean.
- [x] ✅ Новый untouched collision-free donor graph выбран read-only:
  `walmart:1:FaisalX-1828`, donor `a3ee205c-fab4-4e2f-bdce-cea91fe79555`,
  Walmart item `16940511`; doctor request SHA `bb110908…fa3d`, plan
  `2cfea49a…0070`, provider calls/production writes `0`.
- [ ] 🔄 Plan `2cfea49a…0070` не исполняется: анализ первого canary доказал,
  что Unwrangle вернул полезные exact facts, но all-or-nothing writer откатил
  весь detail только из-за `ALLERGENS_MISSING; STORAGE_MISSING`.
- [ ] ⬜ Новый paid canary возможен только для нового sealed plan; terminal
  `4e8524d7…a05d` никогда не replay.

### Exact field snapshot v1.6 — local correction 2026-07-28

- [x] ✅ Production `DonorHarvestState.lastError` первого canary прочитан
  read-only: detail содержал сохраняемые факты, единственные blocking gaps —
  `ALLERGENS_MISSING` и `STORAGE_MISSING`.
- [x] ✅ Exact retailer detail больше не теряется целиком: writer сохраняет
  append-only `exact_field_snapshot_v2`, byte-hashes всех полей и явный
  `_missingFields`; отсутствующие facts и их field source остаются `null`.
- [x] ✅ Полный `exact_complete_v1`, новый field snapshot и старый
  `legacy_materialized_bridge` остаются exact-identity captures. Search
  `retailer_search_partial` исключён из canonical content readers.
- [x] ✅ Walmart new-SKU pilot по-прежнему fail-closed применяет собственные
  requirements, включая allergens и shelf-stable classification. Field snapshot
  не является разрешением publish.
- [x] ✅ Targeted evidence workflow теперь может честно завершить paid attempt
  как `COMPLETED / EXACT_FIELD_SNAPSHOT_CAPTURED_WITH_KNOWN_GAPS`, сохранив
  price + exact content fields и не выдавая их за Walmart pilot candidate.
- [x] ✅ TypeScript PASS; focused production-like suite `43/43`; полный
  shared-worktree Product Truth suite `516/516`; Wiki-Brain `0` orphan /
  `0` broken links.
- [x] ✅ Clean release `1.6.0`: commit
  `a2675452ec07cf06475f7d7c9d80ad5050f72a8c`, tree
  `e7b409485351a5d85411032adcaebf7e842aabc9`, engine release
  `288d348a…df84`; clean TypeScript PASS и Product Truth `516/516`.
- [x] ✅ Новый production `doctor → plan` выполнен read-only для
  `walmart:1:FaisalX-1828`: request `f39e5075…92b1`, plan
  `04f27fd7…f7ae`, provider calls/DB writes `0`, expires
  `2026-07-29T22:30:00Z`.
- [x] ✅ Per-plan chat approval отменён owner direction 2026-07-28. Pinned
  standing policy `7b7bcc99…3eb0` сохраняет exact plan, provider ceilings,
  reserve floor `15000`, no retry/clubs/BJ's/marketplace/business actions.
- [x] ✅ Runtime `balance-probe → authorize` реализован без `--approval`/`--confirm`
  со стороны владельца. Balance permit резервируется в distributed ledger до
  HTTP и сохраняет receipt; TypeScript и полный Product Truth `519/519` PASS.
- [x] ✅ Standing-authority clean release выпущен: commit
  `bc98d341ee3dbe79a709e4dd3bf68661c1e6fc12`, tree
  `6eaed9761863dcf6596d67402b1d8ecfc441fe5d`, engine
  `805431de…b355`; clean `npm ci`, TypeScript, Prisma, Wiki-Brain и
  Product Truth `519/519` PASS.
- [x] ✅ Byte-new production `doctor → plan` выполнен read-only: request
  `50483a90…3389`, plan `d9f1ffaf…ad21`, provider calls/DB writes `0`.
- [x] ✅ Первый standing-authority canary завершён без owner prompt:
  balance probe `1 × 2.5`, working run `Oxylabs 1 × 1` +
  `Unwrangle 1 × 2.5`, total `6` units, retry `0`; outcome
  `COMPLETED / EXACT_FIELD_SNAPSHOT_CAPTURED_WITH_KNOWN_GAPS`.
- [x] ✅ Exact variant decision, fresh price observation и
  `exact_field_snapshot_v2` сохранены для Sunkist; snapshot содержит `6`
  images и честные gaps `allergens`/`storageTemp`. Marketplace/business
  mutations, clubs/BJ's, activation и procurement = `0`.
- [x] ✅ Full-denominator postcheck: `5935/5935` reconciled; bridge audit
  `15e96a44…525c`, readiness `84c6c72c…bd00`. Listing
  `walmart:1:FaisalX-1828` остаётся
  `IDENTITY_ONLY_CANONICALIZATION_CANDIDATE`: donor truth сохранён, но
  canonical listing recipe/COGS ещё не материализованы, а недостающие content
  facts не выдумываются.
- [x] ✅ Canonical listing recipe и typed COGS независимо материализованы из
  уже сохранённых exact variant/price/content evidence: `10 FACT`, `93
  UNSOURCEABLE`, provider calls `0`; content readiness не зависит от COGS.
- [x] ✅ Старые планы `2cfea49a…0070` и `04f27fd7…f7ae` superseded и никогда
  не исполняются.

---

## 10. Canonical recipe / saved COGS checkpoint — 2026-07-29

- [x] ✅ Existing Product Truth catalog reused in place; no parallel catalog was
  created. Authoritative denominator remains `5935/5935`.
- [x] ✅ Canonical recipe reconciliation produced `103` typed economic outcomes.
  Fresh full-denominator readiness after saved-price promotion:
  `FACT 10 / ESTIMATE 0 / UNSOURCEABLE 93 / MISSING 5832 / INVALID 0`;
  Procurement is ready for the same `10` listings, while Bundle Factory and
  Listing Improvement retain their independent `22` content-ready listings.
- [x] ✅ Ten fresh exact local first-party observations were promoted
  append-only from saved evidence only: `10 SkuCost + 10
  SkuComponentEvidence + 10 SkuCostListingScopeLink`. Apply report SHA-256
  `edbb8d578938ffb96a0127715b965dc04371611a72d9eb74f3f9221bde452eaf`;
  postcheck is `ALREADY_APPLIED`.
- [x] ✅ Readiness report SHA-256
  `bab117ffc4a58d3fd34fa7f099e8e7d4d02f71ebb21bb3c0c0f22e626601fcec`,
  payload SHA-256
  `fd077a3dccc7d39841441d0ed8f383af7ca3ec60044a09c9d993c0f98ea7430e`.
- [x] ✅ Saved canonical price graph was exhausted before any new spend:
  six eligible current non-club observations cover exactly the ten FACT
  listings; the other `93` recipes have neither another FACT nor a typed
  ESTIMATE under the current matcher, locality and 48-hour policy.
- [x] ✅ A post-promotion audit regression was found and fixed. Legacy audit no
  longer joins a current recipe to a later cost through equal `runId` /
  `approvalId`; product identity provenance remains independent from COGS
  provenance. Fresh read-only bridge audit restored `102` already-canonical
  listings / `102` components and `5833` quarantined listings. Source SHA-256
  `75931071d885c59425c7b6a652ac57a9845e24c492e5765d8cbb9fbb291b152f`;
  plan SHA-256
  `45b1d14be7122d993f968e7e8202e9734c43b243c5212f4e97b73007b8938462`.
- [x] ✅ Quarantine partition is deterministic, source-byte-bound and
  exhaustive: all `5833` quarantined listings are assigned to exactly one
  primary work lane without a database write, provider call or marketplace
  mutation. The sealed report SHA-256 is
  `48c6c87e1cce2db7a306f15b3b0c04c375b74e68325bd46e55385000f416e4d2`;
  artifact-index SHA-256 is
  `07e89126880041758d4a53f804f372b6b0c484b7179365f00a4d94747a87414f`.
- [x] ✅ Primary lane denominator:
  `CANONICAL_INTEGRITY_CONFLICT 157`,
  `LISTING_IDENTITY_RECOVERY 899`,
  `COMPONENT_GRAPH_RECOVERY 284`,
  `DONOR_LINK_RECOVERY 800`,
  `EXACT_DONOR_OFFER_ENRICHMENT 33`,
  `PRICE_ONLY_PROXY_RESEARCH 21`,
  `RETAILER_IDENTITY_RESEARCH 3639`,
  `OTHER_QUARANTINE 0`. These are priority lanes, not truth mutations.
- [x] ✅ Clean-checkout release commit
  `8f8b39282feeb764ef1fec3b89cf8caf295f5864`, tree
  `aeb5649fbc173b3ad33e872d0de96b01403d5714`: Product Truth `535/535`,
  TypeScript, Prisma, diff and clean-worktree checks pass.
- [x] ✅ Existing-catalog unique exact rematch was added without changing legacy
  links or creating a parallel catalog. Ambiguous matches, canonical binding
  conflicts and legacy-link conflicts remain quarantined. Clean release
  `628a569c9637b49dcefbbe7597ca12da9a654478`, tree
  `8c8a8650a7854428513549dd77bd156ca0fba73b`; certification `541/541`.
- [x] ✅ Four bounded no-paid waves materialized `46` one-component listings
  from existing exact donors: `331` inserted rows, `9` exact existing rows,
  every postcheck `ALREADY_APPLIED`. Provider/retailer calls and marketplace
  mutations were `0`.
- [x] ✅ Multi-component recipe contract `3.6.0` now atomically materializes a
  complete contiguous bundle recipe, per-component evidence and one typed COGS
  outcome. Clean release `86cc42b3`, tree
  `3ab97506004572a290c6488f9fbdda784c0593f6`; Product Truth `542/542`,
  TypeScript, ESLint, Prisma, diff and clean-worktree checks pass.
- [x] ✅ The final five exact four-component bundles were applied in one standing
  no-paid wave: plan SHA `99e93cfe…cad3e`, preflight
  `READY_TO_APPLY`, `99` inserted rows, apply report SHA
  `f53ae007…a3399`, postcheck `ALREADY_APPLIED`. Provider/paid/marketplace/
  consumer/procurement effects were `0`.
- [x] ✅ Fresh full-denominator state is now `154 canonical / 5781 quarantine /
  0 automatic write candidates`. Readiness `5935/5935`: Bundle Factory and
  Listing Improvement `32 ready`; Unit Economics `10 FACT / 0 ESTIMATE /
  145 UNSOURCEABLE / 5780 MISSING / 0 INVALID`; Procurement `10 ready`.
  Readiness report SHA `835a9242…bcc74`.
- [x] ✅ Fresh exhaustive partition report SHA `23034993…de9` assigns all
  `5781` remaining listings: integrity `160`, listing identity `754`,
  component graph `406`, donor link `741`, exact donor offer `69`, price proxy
  `18`, retailer identity `3633`, other `0`.
- [ ] 🔄 Current phase: recover listing identity and component graphs from
  already-held authoritative channel/catalog evidence, then rerun the same
  fail-closed rematch/materialization loop. No provider spend is implied.
- [ ] ⬜ After materially higher recipe/COGS coverage, run canonical backfill
  readiness and four-consumer SHADOW comparison. Consumer ENFORCED activation
  remains outside this checkpoint.

### Phase 1 reconciliation continuation — 2026-07-29

- [x] ✅ Сохранён один каталог: legacy evidence повторно оценён и материализован
  через append-only `ProductTruthListingRecipe`/typed COGS, без создания третьей
  базы и без consumer activation.
- [x] ✅ После бесплатных bounded waves full-denominator audit содержит
  `5935` authoritative listings: `671` canonical, `5264` fail-closed quarantine,
  `0` оставшихся automatic no-paid candidates. Canonical components `686`;
  quarantine components `5828`.
- [x] ✅ Quarantine разбит на непересекающиеся рабочие lanes:
  integrity conflict `317`, listing identity `731`, component graph `399`,
  donor link `700`, exact-offer enrichment `45`, price proxy `17`, retailer
  identity research `3055`.
- [x] ✅ Исправлен standing-provider contract для `EXISTING_EXACT`: metered
  refresh теперь допускается только с immutable binding к текущему
  `ProductTruthListingRecipeComponent` и authoritative manifest. Mutable legacy
  `SkuComponent` не является scope truth; unbound exact plans остаются
  ineligible.
- [x] ✅ Production read-only Campbell's proof:
  `walmart:1:RizwanX-4182`, donor
  `50a9f252-1224-4710-b518-b0eec7675cd3`; doctor/request
  `fde57669…4345`, plan `f302cfb1…e542`, provider calls/DB writes `0`.
  Offline standing verifier подтвердил canonical-recipe binding
  `1.0.0` и manifest `94359db1…9062c`.
- [x] ✅ Сертификация исправления: focused `19/19`, TypeScript, targeted ESLint
  и полный Product Truth suite `556/556` — `PASS`.
- [ ] 🔄 Выполнить single-target bounded enrichment этим plan после clean
  release, затем materialize полученное price/content evidence в связанные
  recipes/typed COGS без marketplace/business mutations.
- [ ] ⬜ Повторять только для доказанных gap targets; каждый terminal outcome
  возвращать в full-denominator audit и не replay автоматически.

### ✅ Bundle Factory recipe evidence recovery — 2026-07-29

- [x] ✅ Existing `ChannelSKU → MasterBundle → BundleComponent` graphs are now
  read-only evidence inputs to the same Product Truth legacy bridge; no new
  catalog, retailer harvest or provider path was created.
- [x] ✅ Recovery is limited to exact Amazon manifest identity, exact
  manufacturer GTIN, unique existing `DonorProduct`, contiguous component
  graph and integer retail-package arithmetic. Two `12 consumer units / 10
  count donor` graphs remain quarantined instead of inventing `1.2` packages.
- [x] ✅ Apply contract `3.8.0` byte-binds every Bundle Factory component and
  detects source drift before canonical writes. Clean release commit
  `f0dba2b325543506d15ac3b79582343e28158bae`, tree
  `679438f3c3efa7bf76e2902659e734762171605b`; TypeScript and Product Truth
  certification `570/570` pass from an exact clean checkout.
- [x] ✅ Canary plus six bounded collision-free standing-policy waves
  materialized all `16` eligible Amazon recipes and `51` exact components.
  Shared-donor graphs were re-snapshotted between waves; paid/provider/
  retailer/marketplace/consumer/procurement effects were all `0`.
- [x] ✅ Final full-denominator bridge state:
  `736 canonical / 5199 quarantine / 0 automatic write candidates`,
  `786` canonical components. Snapshot SHA `eb6698a4…1119`; plan SHA
  `073c220d…1e96`.
- [x] ✅ Fresh readiness remains axis-separated:
  Bundle Factory and Listing Improvement `100 ready`; Unit Economics
  `10 FACT / 0 ESTIMATE / 730 UNSOURCEABLE / 5195 MISSING / 0 INVALID`;
  Procurement `10 ready`. Report SHA `b07db195…05a5`; provider calls and
  database writes `0`.
- [x] ✅ Fresh quarantine partition SHA `32007dae…c9ce` assigns all `5199`
  remaining listings: integrity `382`, listing identity `710`, component graph
  `395`, donor link `692`, exact donor offer `45`, price proxy `17`, retailer
  identity research `2958`, other `0`.
- [x] ✅ Legacy bridge `1.9.0` now preserves an unlinked bundle component's
  parent brand only when that brand is the exact whole-token prefix of the
  saved component product. A conflicting linked donor remains authoritative
  and cannot be overridden. This reclassified `27` listings from component
  graph recovery to donor-link recovery without creating a match or canonical
  write: component graph `368`, donor link `719`, all other lanes unchanged.
  Partition SHA `3c5d4403…9dab`; bridge snapshot SHA `1fefc600…c46`; automatic
  candidates `0`.
- [x] ✅ Clean release commit `aa567439`, tree `9f42f2b3…c3735`; exact clean
  checkout passed TypeScript, ESLint and Product Truth certification `572/572`.
  Provider, retailer, marketplace, consumer and procurement effects were `0`.
- [ ] 🔄 Current phase: exhaust the remaining no-paid listing-identity and
  component-graph evidence lanes before any new provider spend.

### ✅ Byte-bound Publix URL package-size recovery — 2026-07-29

- [x] ✅ Legacy bridge `1.10.0` may recover a missing retail-package size only
  from one standard first-party direct Publix offer whose HTTPS host is exactly
  `delivery.publix.com` and whose final URL segment byte-equals the saved
  `retailerProductId`. An unbound URL, club source, absent source API, or more
  than one size remains quarantined.
- [x] ✅ Authoritative Walmart report base title must still equal exactly one
  existing donor base title; report brand, donor brand, canonical variant and
  integer outer-pack arithmetic remain mandatory. The URL supplies size
  evidence only and never supplies title identity or a current price.
- [x] ✅ Clean release commit `e3257f13`, tree `840efb8d…c9ef`; exact clean
  checkout passed TypeScript, ESLint and Product Truth certification `575/575`.
- [x] ✅ Read-only production audit found `18` listing candidates across `9`
  exact donors. Two bounded standing-policy waves (`9 + 9`) passed fresh
  `READY_TO_APPLY` preflights and finished `APPLIED`; maximum planned database
  rows were `81` and `55`. Provider, paid, retailer, marketplace, consumer and
  procurement effects were `0`.
- [x] ✅ Fresh bridge state is `754 canonical / 5181 quarantine / 0 automatic
  candidates`, with `804` canonical components. Snapshot SHA
  `7c844d09…1b6a`; bridge-plan SHA `5938a863…b623`.
- [x] ✅ Full-denominator readiness remains axis-separated:
  Bundle Factory/Listing Improvement `100 ready`; Unit Economics
  `10 FACT / 0 ESTIMATE / 748 UNSOURCEABLE / 5177 MISSING / 0 INVALID`;
  Procurement `10 ready`. Report SHA `0d4e4229…3977`; all `5935/5935`
  listings reconciled.
- [x] ✅ Fresh quarantine partition SHA `ca7b10a7…0100`: integrity `381`,
  listing identity `708`, component graph `368`, donor link `718`, exact donor
  offer `45`, price proxy `17`, retailer identity research `2944`, other `0`.
- [x] ✅ Remaining automatically materializable no-paid evidence is exhausted:
  the fresh bridge still reports `0` automatic write candidates. The unresolved
  denominator now requires either new exact evidence or independent review; it
  is not silently converted into truth.

### ✅ Structured Walmart brand evidence hardening — 2026-07-29

- [x] ✅ Campbell's Mushroom and Pepperidge Farm Whole Wheat were each executed
  once through the bounded standing-authority workflow. Both outcomes are
  terminal `AMBIGUOUS`, retry `0`, Unwrangle detail calls `0`, canonical writes
  `0`, marketplace/business mutations `0`. Each lifecycle consumed one
  `2.5`-unit balance probe plus one `1`-unit Oxylabs query.
- [x] ✅ Campbell's stopped on
  `TITLE_UNEXPLAINED_CANDIDATE_TOKEN`; balance evidence SHA
  `af42eeec…3c4d`, execution report SHA `eef98d4c…48c4`.
  Pepperidge stopped on explicit out-of-stock evidence plus
  `TITLE_BRAND_NOT_FOUND`; balance evidence SHA `2809d47f…37b2`, execution
  report SHA `8ecb6362…cb93`. Neither terminal target is replayable.
- [x] ✅ Root cause of the Pepperidge title rejection was isolated in the
  adapter: Oxylabs exposes the retailer's structured `general.brand`
  independently from `general.title`, while the parser previously discarded
  the brand field.
- [x] ✅ The fix preserves the observed title byte-for-byte and permits only an
  exact token-equal structured brand in a separately versioned comparison
  title (`walmart-structured-brand-title/1.0.0`). A conflicting brand rejects;
  size, pack, flavor, form, first-party, locality, stock and unexplained-token
  gates remain unchanged.
- [x] ✅ Canonical matcher `1.2.1` and its pinned source SHA
  `2108b5af…ac8bb` remain unchanged; no migration or matcher-replay contract
  changed. Release commit `4878837412d9ebe611b67cd5e0e997727eb7cc76`,
  tree `6462f4000a6d0bfa281be8d5b6bf85a7e2454890`; exact clean checkout passed
  Product Truth `575/575`, TypeScript and clean-worktree verification.
- [x] ✅ Standing `doctor` now requires an exact
  `listingKey + componentIndex` for every targeted run, matching the standing
  verifier instead of producing an unusable unbound plan. Release
  `394743946bd434fc8e4086216fa82d31c1abd721`, tree
  `fd53fc74f8469ffc465be0ae483cd8d9ec791658`; clean Product Truth
  `575/575` and TypeScript passed.
- [x] ✅ Glory Honey Carrots donor
  `7d8ce205-152c-46ee-a904-af92e1d2560e` was executed once with canonical
  binding `walmart:1:RizwanX-3049 / component 0`. Balance evidence SHA
  `a8bd3233…55b7e`; execution report SHA `0c44d4a3…62e`. Terminal outcome is
  `AMBIGUOUS`, retry/detail/canonical/marketplace writes `0`; combined spend is
  `3.5` units (`2.5` balance + `1` Oxylabs).
- [x] ✅ The Glory rejection exposed a second deterministic multi-word-brand
  defect: canonical identity stores a sorted token key (`foods glory`) while
  exact title proof needs the original phrase (`Glory Foods`). Existing-exact
  title comparison now restores the hash-bound
  `decisionEvidenceJson.targetIdentity.brand` only after rebuilding to the same
  canonical variant ID. Contradictory evidence stays fail-closed; observed
  title and matcher `1.2.1` remain unchanged.
- [x] ✅ Release `389976551979528ac169fc67341446a263e0e19a`, tree
  `973dea2d65e79b0d4ca4dd064282ad7c6fe8d5c0`: shared Product Truth
  `579/579`, exact clean checkout `576/576`, TypeScript and clean-worktree
  checks pass.
- [x] ✅ Pepperidge Farm Swirl Cinnamon donor
  `702af605-b9ed-45b0-a979-f1aa6d034816` was executed once with exact
  canonical binding `walmart:1:FaisalX-229 / component 0`. The content lane
  terminalized `AMBIGUOUS` on
  `UNWRANGLE_RECEIPT_WITHOUT_EXACT_COMPLETE_CANDIDATE`; retry `0`, marketplace
  mutations `0`. The lifecycle consumed `6` units total (`2.5` balance probe +
  `1` Oxylabs query + `2.5` Unwrangle detail). Execution report SHA
  `48463bf2…7542`.
- [x] ✅ The successful exact first-party Walmart search evidence was retained
  independently from the incomplete content result: observation
  `doo:80dffa…06d2`, item `10452822`, ZIP `33765`, price `$3.57`, direct
  Walmart first-party and in stock. It supplies price truth only; no partial
  content observation was fabricated.
- [x] ✅ Zero-paid canonical COGS reconciliation propagated that saved exact
  price through all eight existing recipes `FaisalX-229/231/232/233/234/235/
  236/237`. Plan SHA `2adac05b…0413`; fresh preflight `READY_TO_APPLY`; apply
  inserted `24` append-only rows for `8` `FACT` costs, report SHA
  `b1a490e0…cf15`; provider and marketplace calls `0`.
- [x] ✅ Full-denominator read-only readiness report SHA
  `ad145926…9659` proves `5935/5935` reconciled. Bundle Factory and Listing
  Improvement remain `100 ready`; Unit Economics is now
  `18 FACT / 3 ESTIMATE / 740 UNSOURCEABLE / 5174 MISSING / 0 INVALID`;
  Procurement is `18 ready`. All eight Cinnamon listings independently read
  as Unit Economics `FACT` and Procurement `READY`.
- [x] ✅ Highest immediate-COGS-impact untouched target was selected from the
  current canonical graph: Cheez-It Original 21 oz donor
  `fce8b1aa-529e-46dd-af3a-c39a57d14e7e`, bound to
  `walmart:1:FaisalX-4464 / component 0` and shared by five single-component
  recipes. Doctor and plan were read-only; plan SHA `96181a7f…5856`.
- [x] ✅ The one permitted provider attempt terminalized `AMBIGUOUS` because
  the Oxylabs title lacked at least one required target token. Execution report
  SHA `36d8a694…1a19`; total lifecycle spend `3.5` units (`2.5` balance +
  `1` Oxylabs), retry/detail/price/content/canonical/marketplace writes `0`.
  The target is not replayable.
- [x] ✅ Official current Walmart title and the legacy exact title both pass
  the unchanged matcher locally, so the paid response cannot be relabelled
  without its exact rejected title. The selector now records deterministic
  `MISSING_TARGET_TOKENS(...)` and
  `UNEXPLAINED_CANDIDATE_TOKENS(...)` diagnostics for every future rejected
  provider row, without weakening any verdict gate.
- [x] ✅ Observability release `87b50d7161a27d744833b7444d9f841a911e7691`,
  tree `11ea78955ab60828aebdd14dabcc6f17d08de0a9`: focused `16/16`,
  full Product Truth `576/576`, TypeScript and targeted ESLint pass in the
  exact clean tree.
- [ ] 🔄 Select the next highest-impact untouched exact Phase 1 target and
  repeat the bounded one-attempt standing-authority lifecycle. Persist
  successful content and price evidence on their independent axes, then
  propagate only verified evidence through the existing canonical graph.

