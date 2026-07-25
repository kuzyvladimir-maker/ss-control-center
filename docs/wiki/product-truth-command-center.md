# Product Truth Control Center — план постоянного внедрения

> **Статус:** active implementation board, owner direction 2026-07-19; сверено
> 2026-07-25.
>
> **Верхний канон:** [[product-catalog-architecture]]. Порядок бизнес-gates:
> [[donor-catalog-execution-roadmap]]. Operator safety:
> [[product-truth-operator-runbook]]. Consumer cutover:
> [[product-truth-consumer-cutover]]. Release boundary:
> [[product-truth-release-scope]]. Matcher evidence:
> [[product-truth-matcher-replay-v2]].
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

### ⛔ Phase 1 — Permanent engine materialization

- [x] Материализовать актуальный Product Truth source в постоянном Git:
  current `HEAD 12799d6431ec1a0dcfdd14e3d64af2367d457ac8` содержит matcher
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
- [ ] Остановиться на owner decision перед import/merge/push candidate в shared Git.

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

### ⛔ Phase 4 — Default-OFF operations control plane

- [x] Отобразить authenticated `Doctor → Plan → Owner Approval → Execute →
  Status/Resume → Report` workflow и точный status каждого шага.
- [x] Показывать durable Product Truth run/items, exact scope, queue state,
  provider ceilings, receipts/spend, blockers, event-chain/report/artifact hashes.
- [x] Держать web `Execute`, retry/replay и self-asserted owner approval
  технически отсутствующими, а runtime — default `OFF`.
- [ ] Создать durable command queue и исполнять долгую работу отдельным worker;
  browser только планирует,
  подтверждает и poll-ит состояние.
- [ ] Выбрать постоянное immutable artifact custody и pinned owner-authentication
  trust root. Текущий Product Truth v1 проверяет hashes/custody, но не
  криптографически аутентифицирует автора approval; обычная UI-кнопка не может
  безопасно расширить этот контракт.
- [ ] После отдельного design/owner gate реализовать authenticated command
  admission, сохранив `ambiguous=no replay`, terminal states,
  new-output-only semantics и sealed CLI parity.

**Exit:** UI не ослабляет sealed plan, approval, budget ledger или mutation gates;
локальный no-spend smoke полностью воспроизводим.

**Текущий blocker:** required durable web-command/artifact/trust boundary является
новой authority и schema/runtime surface. До отдельного owner решения Phase 4
честно остаётся `⛔`, а готовый CLI из [[product-truth-operator-runbook]] остаётся
единственным execution entrypoint.

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
- [ ] Получить owner-attested connected-store census и authoritative Amazon/Walmart
  reports; заморозить manifest v3.
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
- [ ] После migration certification и authoritative manifest v3 построить exact
  backfill plan; отдельный owner-reviewed no-paid apply и full-denominator readiness.
- [ ] Закрывать 86 `UNRESOLVED_EVIDENCE` только authoritative evidence.

**Exit:** production schema уже доказана отдельно от локального кода. Authoritative
manifest, business-data backfill и four-consumer readiness остаются отдельными
owner-gated этапами; consumed schema approval их не разрешает.

### ⬜ Phase 6 — Staged consumer cutover

- [ ] Unit Economics — `OFF → SHADOW → ENFORCED` read-only.
- [ ] Procurement — read-only shortage/pack/store plan.
- [ ] Listing Improvement — audit/preview, без автоматического apply.
- [ ] Bundle Factory — catalog-first draft, без автоматического publish.
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

На старте productization:

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
- exact восемь Turso schema migrations применены и сертифицированы; business-data
  backfill не выполнялся, authoritative Phase 1 manifest отсутствует;
  consumer cutover `0/4`; paid Product Truth run не выполнялся.

Следовательно, Phase 1 начинается только после точной release-materialization карты;
UI не соединяется напрямую с legacy endpoints или CLI.

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
