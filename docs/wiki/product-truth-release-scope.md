# Product Truth — release scope и clean-checkout gate

> **Статус 2026-07-19:** канонический release boundary для передачи готового
> движка Claude Code. Подчинён [[product-catalog-architecture]],
> [[donor-catalog-execution-roadmap]] и [[product-truth-operator-runbook]].
>
> Этот документ не разрешает Turso migrations, paid calls, marketplace mutations
> или consumer activation. Он отвечает только на вопрос: «какой код обязан попасть
> в Git и что должно пройти в чистом checkout, прежде чем называть движок
> переданным исполнителю».

> **Current continuation 2026-07-26:** исторический `NO-GO` ниже описывает исходный
> handoff 2026-07-19, а не текущий permanent candidate. Reconciled `r5` собран
> поверх shared base `af403b1ffbbfa7c039935824c8b9cd8bd59aa99e` с сохранением
> более свежих owner-документов. No-hardlink clean checkout прошёл Product Truth
> `445/445`, TypeScript, targeted ESLint, production build, Wiki-Brain `0/0` и
> diff-check. Exact final commit/tree/bundle hashes хранятся в соседнем
> checksum-bound release artifact; до локального import G1 остаётся
> `APPROVED_IN_PROGRESS`. Это не разрешает push/deploy/production.

> **Актуализация:** третья frozen closure имеет exact tree
> `a1616dc605e474e6c70065d199b6b5c3aefc9805`. Поверх неё собирается отдельная
> adjacent дельта Unit Economics SHADOW: default-OFF, owner-config-bound,
> Bearer-protected и compare-only. Она не меняет consumer cutover `0/4` и не разрешает
> production/paid/mutation действия. Exact новый tree, test counts и checksum должны
> браться только из соседнего release artifact после clean-checkout certification, а
> не из исторических чисел ниже.

> **Matcher replay adjacent release v2.2:** финальный offline boundary — commit
> `78e0664908cd37c3746a311084f4826a031b3658`, tree
> `7a2eb1a6bbc0886fec33898268db3036e240aa22`, required base
> `4a0b1350a938287c6158be0c6d8dff26c140dd95`. Clean checkout прошёл focused
> `23/23`, полный Product Truth suite `432/432`, Prisma/ESLint/diff checks и exact
> patch/bundle materialization. Release лежит в
> `release-artifacts/product-truth-matcher-consensus-v22-release-2026-07-19/`.
> Он вводит честный eight-input `POST_BLIND_RECONCILED_CONSENSUS` и sealed runtime
> wrapper; старые v2.1 direct-runner packets запрещены. Codex wrapper replay подтвердил
> semantic `304/304 PASS`, golden `2 cases / 4 comparisons`, `300 resolved / 86
> unresolved`, но full truth остаётся `BLOCKED`. Эта adjacent delta не заменяет полный
> operational closure и не разрешает production/paid/mutation actions.

## 1. Текущий verdict

Локальный shared worktree проходит Product Truth certification **361/361**, но Git
handoff сейчас **NO-GO**:

- `origin/main`/`HEAD` на момент аудита: `9caf9e7eb914f1db2cf919b08570e85d1e1e9513`;
- runtime closure: 54 локальных TypeScript-файла + 8 фиксированных SQL migrations;
- unresolved local imports: 0;
- 34 runtime-файла, все пять entrypoints, восемь SQL migrations и весь certification
  suite отсутствуют в Git index;
- 10 runtime-файлов изменены, но не закоммичены;
- `package.json` и `prisma/schema.prisma` содержат смешанные параллельные изменения.

Следовательно, зелёный текущий workspace доказывает локальное поведение, но чистый
clone из `origin/main` пока не может выполнить ни одну Product Truth operator command.

### Изолированный release-candidate audit

Из `HEAD` `9caf9e7e` собран отдельный clean-clone candidate только по boundary этого
документа, без Walmart new-SKU, Listing Integrity и Uncrustables workstreams. Он
содержит core engine, отдельный Bundle Factory adapter и отдельный Gate 1/operator
hardening commit. Его актуальные commit/tree/patch hashes хранятся вне самого patch в
`release-artifacts/product-truth-2026-07-19/README.md`, чтобы release tree не зависел
циклически от собственного hash. Clean candidate проходит:

- Product Truth certification: **361/361**;
- help-smoke всех 13 operator commands;
- `prisma validate` и targeted Product Truth ESLint;
- Wiki-Brain: 998 статей, 0 сирот, 0 битых ссылок;
- `git diff --check`.

При сборке clean candidate были обнаружены и добавлены в closure три ранее неявных
asset: `scripts/probe-walmart-buyer-pdp.ts`, metered containment в
`src/lib/walmart/multipack/donor.ts` и Bundle Factory compatibility facade. Это
доказывает воспроизводимость точного release contents, но не меняет verdict для
`origin/main`: локальные candidate commits ещё не опубликованы, поэтому операторский
Git handoff из общего репозитория остаётся **NO-GO**.

Проверенный patch-series сохранён локально в
`release-artifacts/product-truth-2026-07-19/product-truth-release.patch.gz`; его exact
SHA-256, commit IDs и certified tree записаны в соседнем README и sidecar. Публикация
отдельной GitHub-ветки не выполнена: она требует явного owner approval; `main` не
затрагивался.

Последний hardening добавляет отдельный `--prepare-owner-attestation` census preflight,
который выдаёт canonical capture bytes/hash без самосоздания owner attestation,
документирует внешнюю custody вместо ложного заявления о цифровой подписи и включает
fail-closed Gate 1 operator packet. Walmart reconciliation относится к отдельному
source-capture boundary и не подмешивается в Product Truth core patch. Единственная
live session там quarantined после provenance incident; поздний конфликтующий
`ABSENCE_ONLY` не является допустимым evidence.

## 2. Обязательные entrypoints

В release обязаны целиком войти:

```text
ss-control-center/scripts/product-truth-runner.ts
ss-control-center/scripts/product-truth-backfill-writer.ts
ss-control-center/scripts/product-truth-migration-plan.ts
ss-control-center/scripts/build-phase1-connected-store-census.ts
ss-control-center/scripts/build-phase1-scope-manifest.ts
```

В `ss-control-center/package.json` отдельными hunk должны присутствовать только эти
Product Truth команды:

```text
product-truth
product-truth:census
product-truth:manifest
product-truth:migrations
test:product-truth-certification
test:product-truth-safety
test:product-truth-economics
```

Нельзя вместе с ними автоматически захватывать `walmart:new-sku`, Walmart Listing
Integrity scripts или `ajv`: это отдельные workstreams.

## 3. Канонический migration set

Release содержит ровно восемь Product Truth migrations в этом порядке:

```text
20260718230000_product_truth_queue_v2
20260718233000_donor_harvest_lifecycle
20260718234500_product_truth_evidence_provenance
20260719000000_metered_budget_ledger
20260719001000_product_truth_metered_evidence_link
20260719002000_product_truth_listing_scope
20260719003000_product_truth_queue_listing_scope
20260719004000_product_truth_operational_run
```

`20260719003000_walmart_publish_lifecycle_safety` не является частью этого release и
не может быть подмешан в Product Truth migration approval.

## 4. Кодовый boundary

### Новое ядро — whole-file

Целиком входят все Product Truth/identity/evidence/lifecycle/budget/read-contract
модули в `ss-control-center/src/lib/sourcing/`, созданные этим потоком:

```text
canonical-cost-selection.ts
canonical-product-match.ts
canonical-product-variant.ts
cost-evidence-policy.ts
donor-harvest-executor.ts
donor-harvest-lifecycle.ts
donor-harvest-seed-plan.ts
donor-harvest-store.ts
metered-budget-contract.ts
metered-budget-store.ts
metered-call-guard.ts
metered-provider-call.ts
oxylabs-walmart-product-calibration.ts
phase1-connected-store-census.ts
phase1-scope-manifest.ts
price-evidence-policy.ts
product-truth-*.ts
```

Также входят `src/lib/economics/product-truth-profit-guard.ts`, его тест и все файлы
`src/lib/sourcing/__tests__/`. Certification fixtures являются частью gate, а не
временными локальными файлами.

### Изменённый runtime — whole-file после review

В release нужны Product Truth изменения в существующих sourcing-файлах:

```text
cogs-engine.ts                  donor-catalog.ts
enrich.ts                       enrichment-queue.ts
gemini-vision.ts                identify.ts
openclaw-fetch.ts               own-brand-costs.ts
oxylabs-fetch.ts                resolve-donor.ts
retail-fetch.ts                 service-health.ts
vision.ts
```

`execute/resume` имеет lazy runtime closure за пределами sourcing namespace. Его
нельзя потерять при статической упаковке:

```text
src/lib/amazon-sp-api/{auth,client,listings,sellers}.ts
src/lib/veeqo/{client,product-image}.ts
src/lib/shipping/dates.ts
src/lib/image-gen/codex-worker.ts
src/lib/text-gen/claude-text-worker.ts
src/lib/ai-models.ts
```

### Phase-0 containment

Hard tombstones, удаление cron schedules, metered wrappers и quarantine markers во
всех затронутых legacy COGS/sourcing scripts входят в release. Иначе чистый checkout
снова получит обход готового owner-gated runner. В частности обязательны retired
routes для COGS sweep, reference enrichment/harvest, Amazon repricer, Amazon legacy
Growth remediation/auto-improve/apply/enqueue/drain/rollback и Walmart remediation,
а также `vercel.json` без их опасных schedules. Jackie MCP `listings_update` должен
оставаться preview-only и не иметь Amazon PATCH sink.

Этот boundary нельзя называть repo-wide mutation/paid containment: Bundle Factory
publish/republish/poll-pending, A+ factory, content-generation/tick и audit vision
fallback являются отдельными active business flows. Пока они не получили Product
Truth-bound owner action/budget gates, release prompt обязан явно запрещать оператору
их вызов, а общий production-readiness verdict остаётся NO-GO.

`phase0-containment.test.ts` намеренно сканирует весь `scripts/**`,
`src/lib/sourcing/**`, `src/lib/walmart/**` и root scratch scripts. Поэтому safety
certification является repo-level gate, а не герметичным unit-test одного каталога.

## 5. Смешанные файлы — только ручные hunks

Нельзя целиком stage/commit следующие файлы:

- `ss-control-center/prisma/schema.prisma` — Product Truth модели смешаны с Walmart
  submission/new-SKU моделями;
- `ss-control-center/package.json` — Product Truth scripts смешаны с параллельными
  Walmart scripts и `ajv`;
- `ss-control-center/package-lock.json` — текущий diff не требуется Product Truth;
- корневой `AGENTS.md` — Product Truth и Walmart new-SKU policy в одном файле;
- `docs/wiki/index.md` и `docs/wiki/task-registry.md` — несколько параллельных инициатив;
- `src/app/api/walmart/growth/remediation/route.ts` — Product Truth POST tombstone
  смешан с независимым GET refactor;
- Bundle Factory validation pipeline/approval/brand-field validator — Product Truth
  consumer hook смешан с Walmart prepublication work.

Для `schema.prisma` Product Truth hunk обязан включать exact listing scope, immutable
identity/content/offer/component/cost evidence, metered ledger, harvest lifecycle,
queue v3 и operational run models. Hunk нельзя считать правильным только потому, что
файл локально проходит `prisma validate`: clean-checkout migrations и schema должны
описывать один и тот же контракт.

## 6. Отдельный consumer-cutover commit

Bundle Factory adapter следует выпускать отдельно после core release:

```text
ss-control-center/src/lib/bundle-factory/product-truth-recipe-input.ts
ss-control-center/src/lib/bundle-factory/__tests__/walmart-product-truth-recipe.test.ts
```

Нельзя stage один `validator-walmart-product-truth.ts`: он зависит от параллельного
Walmart new-SKU/prepublication контура. Production consumer cutover остаётся 0/4 до
отдельного shadow/owner activation/enforced gate.

## 7. Clean-checkout acceptance

Product Truth Git handoff становится GO только после отдельного scoped commit и новой
проверки из чистого checkout этого commit:

```bash
npm ci
npm run test:product-truth-certification
npm run product-truth:census -- --help
npm run product-truth:manifest -- --help
npm run product-truth:migrations -- --help
npm run product-truth -- matcher-replay --help
npm run product-truth -- doctor --help
npm run product-truth -- backfill-plan --help
npm run product-truth -- backfill-apply --help
npm run product-truth -- readiness --help
npm run product-truth -- plan --help
npm run product-truth -- execute --help
npm run product-truth -- resume --help
npm run product-truth -- status --help
npm run product-truth -- report --help
npx prisma validate
node ../scripts/wiki-brain.mjs
```

`matcher-replay --help` здесь является developer clean-checkout smoke только для
наличия CLI surface. Операторский factual replay v2.2 не запускается этой npm-командой:
он исполняется исключительно sealed wrapper-командой из
[[product-truth-operator-runbook]].

Дополнительные обязательные доказательства:

- 54-file runtime closure и 8 SQL assets разрешаются без missing imports;
- generated `src/generated/prisma/**` создаётся заново postinstall, а не переносится
  из dirty worktree;
- поддерживаемая версия Node закреплена в release metadata, а прямой runtime/import
  `dotenv/config` либо имеет прямую dependency, либо удалён; transitive dependency
  не считается воспроизводимым контрактом;
- Product Truth targeted ESLint clean;
- Wiki-Brain имеет 0 broken links;
- никакой test/preflight не делает DB/network/provider/marketplace call;
- `git show COMMIT:path` содержит все entrypoints, migrations, tests и operator canon.

Repo-wide `tsc` должен оцениваться отдельно: несвязанные ошибки нельзя скрывать, но и
нельзя выдавать их за дефект Product Truth, если changed-file diagnostics пусты.

Актуальная adjacent clean closure зафиксирована в
`release-artifacts/product-truth-operational-closure-2026-07-19/`; exact required base
и resulting tree вынесены во внешний checksum-bound release status, чтобы versioned
Git tree не ссылался на собственный hash. Именно её operator prompt заменяет более
раннюю Gate 1 tree-binding инструкцию. Release status честно отделяет зелёный frozen
CLI от NO-GO Phase 1 production/cutover и оставшихся business-flow action/budget gates.

## 8. После Git handoff

Даже чистый зелёный release не означает завершение Phase 1. Следующий внешний Gate 1:

1. реальные sanitized connected-store snapshots и owner census attestation;
2. полные Amazon/Walmart reports для каждого census-required `IN_SCOPE` store;
3. owner scope dispositions и zero-blocker authoritative manifest;
4. authoritative recipe/identity evidence для оставшихся 86 matcher cases; corpus
   v2.2 и exact runtime уже заморожены, но partial evidence не является Gate 1 PASS;
5. отдельный matcher version/provenance migration и consumer cutover до любых
   production decision writes под изменённым behavior;
6. отдельный owner approval на exact Turso migration plan;
7. затем migration certification → backfill → full readiness, и только после этого
   отдельный budget approval на canary.

Walmart ITEM acquisition/reissue code реализован и legacy/generic-client create
hard-retired, но единственная live reconciliation session quarantined после provenance
incident. Её поздний конфликтующий `ABSENCE_ONLY` не может быть входом reissue. Поэтому
исполнение заблокировано до отдельного owner disposition и свежего eligible evidence;
permit bytes/hashes/confirmation сами по себе этот blocker не снимают, и Claude Code
не получает исполнимую report-create команду.

Ни один из этих пунктов нельзя заменить mutable DB mirror, локальным test fixture или
самодельной owner attestation. Product Truth v1 проверяет canonical/hash/scope/time
binding owner artifacts, но не цифровую подпись; их авторство доказывается только
внешней custody владельца до отдельного решения о Product Truth trust root.
