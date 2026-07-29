# 🗂️ Реестр задач Command Center (mission control)

> **Зачем:** единый персистентный лог задач/идей ПО ВСЕМ чатам, сессиям и машинам
> (iMac ↔ MacBook). Живёт в git → синхронизируется и виден ЛЮБОМУ Claude в любой
> сессии/VS Code. Чтобы ни одна идея, задача или договорённость не терялась и не
> дублировалась между параллельными потоками работы. Часть [[wiki-brain-system]];
> связывать записи wiki-линками. Машинно-локальные предпочтения — в `memory/`;
> сюда — задачи и их иерархия.
>
> **Правило для каждого Claude:** в начале и в конце существенной работы —
> прочитать и ОБНОВИТЬ этот файл (статус, что сделано/осталось, чей чат). См.
> [[feedback_hold_main_goal]] (держать главную цель, доводить ветки до конца,
> помнить все озвученные подцели).

**Легенда статусов:** 🟢 done · 🟡 in-progress · ⚪ pending · 🅿️ parked/idea · ❌ dropped

---

## Активная инициатива: Product Truth Platform / донорский справочный каталог

**Owner direction:** Владимир, 2026-07-18. **Канон:**
[[product-catalog-architecture]]. **Исполнимый план:**
[[donor-catalog-execution-roadmap]]. Операционный snapshot исходной COGS-работы:
`HANDOFF_COGS_Donor_Enrichment_for_Codex_2026-07-18.md`.
Постоянное внедрение в SS Command Center и живой фазовый прогресс:
[[product-truth-command-center]].

**Главная цель:** единый независимый от каналов справочник подтвержденной правды о
реальных товарах, их покупаемых фасовках, локальных офферах и составе наших SKU.
Он является общим фундаментом для четырех направлений: создание новых листингов
через Bundle Factory, улучшение текущих листингов, unit economics и будущая
оптимизация закупок после продажи.

**Стратегия наполнения:**

- **Phase 1:** обогатить весь текущий продаваемый ассортимент Amazon и Walmart.
  Недавние продажи и выручка определяют порядок, но не исключают остальные live SKU.
- **Phase 2:** постоянно расширять каталог кампаниями по бренду, группе/категории,
  ретейлеру и demand-driven запросам; отдельно обновлять изменяемые цены и наличие.

### Текущее состояние и следующие ветки

- 🟡 **Walmart new-SKU turnkey pilot — current truth 2026-07-27:** Walmart остаётся
  отдельной channel-веткой общего Bundle Factory и читает только Product Truth /
  донорский справочник. Frozen release v32 выдан в
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-27-v32`: engine
  `cc086942…89898`, manifest `efa8e8cd…135b`, certificate `17bfde04…050c`;
  Product Truth `472/472`, focused Walmart `21/21`, fake-live `3/3`, TypeScript PASS.
  Exact RITZ Bits Cheese 8.8 oz Target content активирован production receipt
  `bdbfb3b2…e8aa1`. Два независимых pilot draft прошли
  `doctor→plan→stage`: pack-of-2 SKU `WM-5861-AF0E`, UPC `756441906004`,
  owner-preview target `$33.13`,
  stage `f31fd5d4…c97c`; pack-of-3 SKU `WM-E031-D5C4`, UPC `756441906011`,
  owner-preview target `$40.36`, stage `b467491c…fc3a`. Walmart writes `0`;
  внутренние UPC reservations
  действуют до `2026-07-28T13:52:56.990Z` /
  `2026-07-28T13:55:59.720Z`. Exact Walmart Product Type = `Snack Crackers`;
  выбран current active free Default Template `202402999000149568`. Owner-only
  preview/readiness Sites version 9 развернута из commit
  `d5daebe4e01161335416dabc4d5e717a9cd976d4` по прежнему URL. Следующий допустимый
  шаг — получить реальные candidate-bound Seller Center/category, rights, UPC
  authority, physical/package/country/expiration/fulfillment evidence, после чего
  engine выполняет certification→dry-run→approval→apply-preview. Live apply остаётся
  отдельным exact signed owner gate; массовые волны и schedule не разрешены.
  Канон: [[walmart-new-sku-operator-runbook]] и
  [[walmart-new-sku-command-center]]. Старые v26 current-status записи ниже —
  audit chronology, не operator authority.
- 🟡 **Bundle Factory Walmart data-gap fallback — 2026-07-28:** exact RU/EN request
  parser и новый canonical Product Truth readiness endpoint различают input
  conflict, engine capability gap и missing product evidence. Production read-only
  probe исходного Campbell's `5 × 8` запроса нашёл пять exact variants, готовых по
  content и заблокированных только `FRESH_LOCAL_PRICE`; все пять поддерживаются
  bounded `TARGETED_WALMART_EVIDENCE` текущим source. Terminal-LF exact decision
  evidence теперь сохраняется byte-for-byte и проходит SHA/matcher verification;
  operator execution требует нового verified frozen release с этим fix. Focused `16/16`,
  TypeScript, ESLint, API probe и full Next build PASS. UI показывает пробелы и
  правильный следующий engine, `Generate` сам выполняет fail-closed Product Truth
  preflight, а `Check again` повторяет исходный запрос. Production commits:
  `37a3aec5` / `923c0d34`. Automatic Web execution/resume остаются blocked: legacy
  enqueue/cron retired, Product Truth Web Operations runtime `OFF`; stages B–F не
  активированы. Walmart/provider/DB writes и paid calls `0`. Канон:
  [[walmart-new-sku-command-center]] и
  [[product-truth-web-operations-control-plane]].
- 🟡 **Product Truth Control Center / permanent productization:** owner 2026-07-19
  подтвердил, что готовый engine должен стать постоянным backend существующего
  модуля `Catalog`, а не ручным Claude-run или вкладкой Walmart Growth. Reconciled
  `r4` прошёл clean Product Truth `444/444`, TypeScript, targeted ESLint, production
  build и Wiki-Brain. 2026-07-26 owner одобрил G1–G4 в точных безопасных границах.
  Reconciled `r5` собран поверх current shared base
  `af403b1ffbbfa7c039935824c8b9cd8bd59aa99e`, сохраняет семь более свежих owner
  документов и проходит no-hardlink clean checkout: Product Truth `445/445`,
  TypeScript, targeted ESLint, production build, Wiki-Brain `0/0` и diff-check.
  G1 consumed: shared local `main` fast-forwarded на
  `df1e6600ef3a38ba402b5785ac7ed4ef1a3597a2`; Product Truth `445/445`,
  targeted ESLint и Wiki-Brain `0/0` прошли, unrelated dirty worktree и два
  recovery-stash сохранены, push/deploy/production не выполнялись. G2 Stage A
  завершён локально в commit `fc98be84c`: отдельные command/artifact/event custody
  tables и guards, canonical parser/state machine и Product Truth Ed25519 verifier
  сертифицированы `451/451`; TypeScript, Prisma validate, targeted ESLint и
  production build прошли. Runtime hardcoded `OFF`, production migration не
  применялась, route/worker/provider effects отсутствуют. G3 scope/census завершён:
  contract fix `4465e14a` прошёл Product Truth `452/452`, authoritative census
  содержит 6 required scopes и 0 blockers, evidence commit `e129060e`, census SHA
  `ca0380c4…cdeda3`. Amazon store1
  `Salutem Solutions`,
  store3 `AMZ Commerce` и Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC`; Amazon
  store2/store4/store5 исключены из текущего snapshot как blocked и возвращаются
  только через successor census/manifest. G4 закрыт: единственный create request
  `019f9f34…319a` достиг `READY` continuation-only GET-ами, второй create не
  выполнялся; старая quarantined session и permit bytes не переиспользовались.
  Final cadence `59f25201` = `180s × 9`; production parser `cfb41078` прошёл clean
  Walmart report suite `229/229`. Complete ITEM v6 содержит `5236` rows
  (`3891 PUBLISHED`, `734 SYSTEM_PROBLEM`, `611 UNPUBLISHED`) при нуле
  malformed/duplicate/conflict. Fresh Amazon store1/store3 reports захвачены
  GET-only без report-create. Manifest policy commit `9090580e` прошёл clean
  Product Truth `453/453`; final report-bound disposition и authoritative manifest
  v3 готовы: `5935` live listings, `3` exact reports, `0` blockers, canonical SHA
  `94359db1…9062c`. G5 read-only plan `162b2dbd…53cf78` построен из clean checkout
  `0fdbc0c9`: `5935` scope imports, `5935` artifact-only review tasks, обе ledgers
  ready, writers/FK blockers, canonical cost recomputes, provider calls и DB writes
  = `0`. По отдельному owner approval scope-only apply завершён `APPLIED`:
  inserted/exact scopes = `5935/5935`, missing/conflict/unexpected/writers/FK =
  `0`, cost/legacy/provider/paid/marketplace/procurement effects = `0`.
  Full-denominator readiness reconciled `5935/5935`, но четыре consumers имеют
  `0 ready` на `CURRENT_SCOPED_SKU_COST_MISSING`; G6 activation и G7–G8 не
  разрешены. 2026-07-26 завершён no-paid legacy bridge без третьего каталога:
  сохранены exact source snapshot `e13cd87b…03e8` и bridge plan
  `27b1d6ae…2360`; строгая проверка нашла `20` content-complete scopes и `0`
  fresh-price scopes. Первый owner-approved canary plan v1
  `c6996af9…9bbd` атомарно rollback на production-only metered-receipt trigger:
  committed materialization writes = `0`. Provenance исправлен без выдуманного
  receipt: canonical row имеет route `legacy-materialized-bridge`, original
  provider остаётся в immutable source binding. Regression теперь применяет все
  восемь production migrations и metered-provider fixture; certification
  `468/468`, targeted ESLint `PASS`. Новый plan v1.1 =
  `ba899ce9…fae3d`, максимум `35` canonical DB rows; read-only production
  preflight `ae64cdd6…be6db` дал `READY_TO_APPLY`, exact existing `0`, absent
  `35`, FK violations `0`. По новому exact owner gate plan применён:
  apply-report `49568cd4…2e15`, inserted `35/35`, donor transitions `5`, FK
  violations `0`. Независимый postcheck `28e8254e…9a18` подтвердил exact
  existing `35`, absent `0`. Full-denominator readiness report
  `27d83878…2dfa` reconciled `5935/5935`: Bundle Factory/Listing Improvement
  ready `5/5`, Unit Economics `UNSOURCEABLE 5/5`, Procurement ready `0/5`;
  provider calls и readiness DB writes `0`, cutover = `0/4`. Следующий audit
  доказал, что remaining `15` scopes образуют `8` общих donor/variant групп и
  содержат один College Inn donor→multiple-variant collision; старый fixed-five
  apply запрещён. Graph-aware wave contract v2 теперь дедуплицирует общие
  variant/decision/donor/content rows, сохраняет отдельные listing evidence/cost
  links, считает exact row ceiling и fail-closed блокирует identity collision.
  Shared-graph/idempotency/collision/rollback regressions и полный Product Truth
  suite `470/470`, TypeScript, targeted ESLint, CLI help и diff-check прошли.
  Fresh read-only production snapshot `0f0b0d48…c4ed` и bridge plan
  `1f5f90a7…5b5c` сохранили denominator `5935` и `20` candidates при нуле
  writes/calls. Immutable graph-aware wave `367ffc2f…0354` содержит `14`
  бесконфликтных listings / `7` unique graphs / максимум `70` rows;
  `FaisalX-3816` quarantined. Production preflight `07706ccf…d72c` =
  `READY_TO_APPLY`, absent `70`, exact-existing `0`, FK violations `0`.
  Exact owner gate получен; approval `3a7c6f36…1033`, pre-send preflight
  `73b7456d…bc37`. Wave завершена `APPLIED`: `70/70` rows, `7` donor
  transitions, FK `0`; report `38ddef90…9284`, postcheck
  `43bb2207…0262` = `ALREADY_APPLIED`. Full readiness
  `014770f0…c644`: `5935/5935`, content-ready `19`, Unit Economics
  `19 UNSOURCEABLE`, Procurement `0`, writes/provider calls `0`, cutover `0/4`.
  Standing no-paid policy `0ede5d62…2696` разрешает автономные
  collision-free waves ≤`100` rows только после fresh `READY_TO_APPLY`;
  money/marketplace/activation/procurement gates остаются закрыты. Verifier
  встроен в apply engine и проверяет canonical policy/preflight bytes, target,
  manifest, freshness, row ceiling и collisions до transaction; targeted
  `21/21`, TypeScript, ESLint и полный Product Truth `477/477` прошли.
  Canonical-aware snapshot/plan `1.1.0` прекратил повторное предложение уже
  materialized scopes. Fresh production read-only evidence: snapshot
  `95f247db…0e3c`, plan `a97497ca…6cd7`, index `46c7412c…008`; exact counts =
  `19 ALREADY_CANONICAL`, `0` новых content-complete no-paid candidates,
  `82` identity-only, `5834` quarantine. `FaisalX-3816` явно блокируется
  donor→different-variant conflict; audit writes/calls = `0`. Следующая активная
  работа повысила bridge до `1.2.0`: outer seller UPC больше не доказывает
  multipack component, а live gallery barcode + exact Target item может дать
  immutable no-paid content evidence. `FaisalX-1148` materialized по standing
  policy: `7/7` rows, postcheck `300236be…43d9` = `ALREADY_APPLIED`. Fresh
  readiness `5c56c425…e92b`: `5935/5935`, content-ready `20`, Unit Economics
  `20 UNSOURCEABLE` / `5915 missing`, Procurement `0`. Successor timestamp guard
  и exact-content apply regression прошли; full Product Truth `481/481`.
  Read-only forecast: `82` identity-only scopes, `48` donor groups, `41`
  collision-free groups / `64` listings, conservative paid ceiling `99.5`
  credits без approval. Generic direct-Target lane `1.0.0` завершён: два GET
  без retry; Arnold item `12973001` дал exact evidence `1fd29173…c7988`,
  Iberia item `80838482` не имел allergen warning и остался fail-closed.
  `FaisalX-1228` materialized по standing policy: `7/7`, apply report
  `869eebaa…b9ca5`, postcheck `5705560d…07cc5` = `ALREADY_APPLIED`.
  Successor audit = `21 ALREADY_CANONICAL`, `0` новых no-paid content-only,
  `81` identity-only, `5833` quarantine. Readiness `cac37257…44192`:
  `5935/5935`, content-ready `21`, Unit Economics `21 UNSOURCEABLE` /
  `5914 missing`, Procurement `0`; Product Truth certification `487/487`.
  Canonical planner переиспользован; локальный G7 proposal
  `df3da159…65b88` выбрал пять unique collision-free Walmart graphs с
  worst-case ceiling `17.5` units и нулём calls/writes. Фактический provider
  spend остаётся заблокирован до owner-defined reserve floor, exact maximum
  units и последующего fresh plan-bound permit/approval.
  Recommended values материализованы offline: exact plan
  `ae810cb1…5360e`, target set `f7284014…c2ab`, max `17.5` units, reserve floor
  `15000`, expiry `2026-07-28T12:39:07Z`; plan-time DB/provider calls `0`.
  Exact основной G7 approval получен. Fresh remote doctor прошёл, spend `0`;
  статус G7 = `APPROVED_PENDING_BALANCE_EVIDENCE`: бесплатного Unwrangle
  balance endpoint нет, cache пуст, последний receipt stale. Нужен отдельный
  exact `target_search` balance probe максимум `1` unit, после чего основной
  plan-bound permit/confirmation может быть собран без изменения его ceilings.
  Old plan `ae810cb1…5360e` истёк до probe и остался с spend `0`; replacement
  plan `bca2decb…6413c` бесплатно перевыпущен на тот же target set
  `f7284014…c2ab`, те же max `17.5` run units/reserve floor `15000`, expiry
  `2026-07-29T17:27:40Z`. Combined gate был получен; один no-retry Target
  Search probe фактически списал `2.5`, а не заявленный `1` unit. Evidence
  `9c385650…1a6f`; main execution и canonical/marketplace writes `0`.
  Target tariff guard исправлен и full certification = `489/489`. Статус =
  `AWAITING_AMENDED_COMBINED_APPROVAL`: unchanged main `17.5`, optional fresh
  probe `2.5` only if stale, cumulative maximum `22.5`.
  Живой checklist и acceptance gates:
  [[product-truth-command-center]]; единый ledger: [[product-truth-owner-gates]].
- 🟢 Канон v2.0 с четырьмя потребителями, двумя фазами и законами достоверности записан.
- 🟢 Отдельный roadmap с gates, критериями Phase 1/2 и owner-решениями записан.
- 🟢 Обязательные указатели добавлены в Wiki‑Brain и инструкции Codex/Claude.
- 🟢 **Phase 0 / local no-spend implementation:** strict matcher, независимые content/
  price axes, terminal lifecycle, durable queue, immutable evidence/provenance,
  append-only cost history, versioned read-contract и hard budget guards реализованы
  локально. Готовый engine suite покрывает trusted census → authoritative manifest →
  matcher replay → owner-gated migrations/backfill → four-consumer readiness → sealed
  `plan|execute|resume|status|report`. Авторитетный результат — последний immutable
  artifact команды `npm run test:product-truth-certification` на exact release bytes;
  реестр не фиксирует устаревающий total. Prisma schema valid, targeted ESLint clean,
  новые Product Truth TypeScript errors отсутствуют. Paid calls, production writes и
  marketplace mutations не выполнялись.
- 🟡 **Phase 0 / Git handoff:** из exact base собраны локальные изолированные commits
  core `5023c50b`, Bundle Factory adapter `19f9a67c` и certification docs
  `6cdac81a`; обновлённый candidate добавляет Gate 1/census preflight hardening и
  проходит полный glob-based certification command, все operator CLI help-smokes,
  Prisma, targeted ESLint и Wiki-Brain; точные counts берутся из release artifact, а
  не из этой строки. Проверенный patch-series сохранён в
  `release-artifacts/product-truth-2026-07-19/`. `origin/main` всё ещё NO-GO:
  отдельная GitHub-ветка не опубликована без явного owner approval. Точный boundary
  и acceptance: [[product-truth-release-scope]].
- 🟢 **Phase 0 / migration and backfill control:** V2 migration planner создаёт
  immutable plan/owner-approval/confirmation artifacts, exact schema/queue fingerprints
  и dual receipts; повторный post-activation plan идемпотентен и не переписывает ledger.
  `backfill-plan` read-only проверяет canonical migration report/certificate sidecars,
  exact release/live schema, обе ledgers, immutable activation receipt, writer
  quiescence, manifest/registry conflicts, identity/content/cost gaps и integrity; owner-gated
  `backfill-apply` атомарно импортирует только immutable listing scopes. Legacy COGS не
  повышается до canonical, missing outcomes становятся artifact-only review tasks.
- 🟢 **Phase 0 / legacy Product Truth + Listing Improvement containment:** Amazon
  repricer, remediation/auto-improve, Growth advisor/optimizer/bulk apply/enqueue/
  drain/rollback, snapshot restore, Walmart remediation/generated-image apply, COGS
  sweep и reference enrichment/harvest paths hard-retired; Jackie MCP
  `listings_update` preview-only, опасные schedules удалены.
  Transitional Unit Economics явно non-authoritative и теперь
  возвращает nullable `BLOCKED` при missing/UNSOURCEABLE COGS вместо прибыли с COGS=0.
- 🔴 **Phase 0 / remaining business-flow gates:** Bundle Factory publish/republish и
  scheduled UPC self-heal, A+ factory, content generation/tick и audit vision paid
  fallback ещё не имеют Product Truth-bound owner action/budget artifacts. Это
  отдельный blocker global production-readiness; Product Truth operator их не вызывает.
- 🟢 **Phase 0 / consumer contract preparation:** доказан аудит всех четырёх контуров;
  read-contract 3.2.0 привязан к exact manifest, полному matcher provenance tuple и
  имеет set-based batch до 100 scopes;
  готовы общий gateway и owner-sealed staged activation `OFF→SHADOW→ENFORCED` по
  consumer subset без legacy fallback. Канонический план:
  [[product-truth-consumer-cutover]]. Это готовность к shadow, не production cutover.
- 🟢 **Phase 0 / Unit Economics SHADOW wiring:** отдельный read-only endpoint
  `/api/economics/product-truth-shadow` подключён к manifest registry и общему
  gateway. Он по умолчанию `OFF`, сверяет exact owner activation с вычисленным DB
  fingerprint и Bearer token до чтения, затем сравнивает legacy/canonical cost в одной
  read transaction и одном `asOf` без изменения бизнес-ответа. Inventory manifest,
  cursor и partition проверяются fail-closed. Owner activation ещё не выдан; общий
  cutover остаётся **0/4**.
- 🟢 **Phase 2 / campaign contract preparation:** pure sealed contract фиксирует
  brand/group/retailer/demand scope, ZIP 33765, first-party routes, owner-gated
  Sam's/Costco, запрет BJ's, provider ceilings/reserve floors, dedup и hash-linked
  checkpoints. Он не имеет DB/network/provider/execution capabilities; внешний
  registry/runtime и любой spend остаются будущими owner-gated этапами после Phase 1.
- 🟢 **Phase 1 authoritative scope:** trusted census + immutable builder
  `phase1-authoritative-scope-manifest/v3` policy 1.3.0 fail-closed связывает все
  supported Amazon/Walmart slots, owner attestation, canonical dispositions, derived
  required scopes и exact report bytes SHA-256;
  relabeled/tampered v2 не проходит importer. Final successor census содержит 6
  required scopes и 0 blockers; fresh Amazon store1/store3 и Walmart store1 bytes
  связаны с exact disposition. Manifest содержит `5935` live listings, `3` exact
  reports, `0` blockers, canonical SHA `94359db1…9062c`. Provisional snapshot
  сохранён только как исторический non-authoritative baseline. Повтор raw SKU между
  точными scopes не объединяется и
  не требует исключения; конфликт exact listingKey/mapping остаётся блокером.
  Приоритет по продажам не сужает denominator.
- 🟢 **Phase 1 / Gate 1 operator preparation:** готов rejected-template packet
  `release-artifacts/product-truth-gate1-2026-07-19/` с machine-readable blockers,
  provisional evidence inventory, точными owner/operator шагами и census
  `--prepare-owner-attestation`. Он не является approval или authoritative manifest.
  Неоднозначный Walmart ITEM create-attempt ещё не получил owner-signed disposition:
  неизвестный parallel process добавил read-only GET и поздние конфликтующие
  `CAPTURED`/`ABSENCE_ONLY` files поверх terminal failure. RequestId не принят, create
  POST не повторялся; session quarantined read-only. Последующий аудит
  воспроизвёл fail-open: v1 loader принимал запрещённые conflicting final hashes.
  Теперь любой retained terminal page failure необратимо блокирует evidence, а
  production CLI live request v1 полностью retired до credentials/writes/network.
  Старый hash-only permit и не связанный с bytes `source_evidence_release_sha256`
  запрещены. Отдельный exact-v6/API probe затем вернул raw zero-row sentinel для
  исходного окна. Codex независимо проверил все шесть файлов и полный quarantine
  inventory и выпустил final content-addressed frozen R4 release: source artifact SHA
  `3efd693468f9c0761d6091d379c06e2daddb7d8dadc908228eb282ddeab4fa31`,
  frozen bundle SHA
  `49b731c3ad1abe54de6d036a251cdf2731e5dad1bb3bd8797a83a6ed428b0fab`,
  fresh until `2026-07-20T23:13:21.286Z`. R1–R3 запрещены. Full Ed25519 verifier
  retained inside frozen bundle; combined local suite 132/132 и independent frozen
  rebuild/replay 45/45, 0 Critical/High. Dedicated production owner key ещё не
  enrolled, а live create command отсутствует. Новый POST остаётся запрещён до
  точного owner risk decision, key enrollment и отдельной one-shot execution
  certification; реальных calls новым контуром не было.
- 🟡 **Phase 1 / matcher Gate 1, v2.2 offline release готов:** v1 title-only
  `386/386 PASS` и четырёхфайловый v2.1 handoff запрещены как vacuous/ложно
  provenance-marked evidence. Финальный engine заморожен на commit
  `78e0664908cd37c3746a311084f4826a031b3658`, tree
  `7a2eb1a6bbc0886fec33898268db3036e240aa22`; focused `23/23`, полный Product Truth
  suite `432/432`. Eight-input v2.2 сохраняет raw source, corpus, две post-blind
  acceptance, original blind task, frozen blind A/B и reconciliation map; sealed
  wrapper fail-fast проверяет exact runtime. Исходный blind comparison:
  `80 exact / 181 structural disagreement with same semantic result / 127 semantic
  disagreement`; обе final acceptance имеют `priorExposure=true` и
  `blindAgreementClaimed=false`. Codex wrapper replay: report SHA
  `29aa05aaf8590fe09905e3b85f4d55f4dcc46e01a9b92cdec59deaf47e4fa8d5`, index SHA
  `2bffe77e99c1a943e85ff7295226876528ba6bfa00362d14d68da073113cc937`, semantic
  `304/304 PASS`, golden `2 cases / 4 comparisons`, quarantine `300 resolved / 86
  unresolved`, общий exit `2`, only blocker `UNRESOLVED_EVIDENCE_PRESENT`.
  `MATCHER_CORPUS_NOT_CANONICAL` закрыт; full Gate 1 truth остаётся открыт только по
  86 authoritative evidence gaps. Historical replay остаётся immutable на matcher
  `1.2.0`; current operational source получил release `1.2.1` с implementation/release
  SHA и fail-closed read-contract `3.2.0`. Production остаётся закрыт до нового frozen
  release, owner-approved exact-eight activation/backfill и consumer cutover.
  Claude Code запускает только untouched sealed wrapper manifest; queue 1 458,
  provider/DB/marketplace actions не разрешены.
- 🟢 **Frozen Product Truth operator closure:** latest handoff находится в
  `release-artifacts/product-truth-operational-closure-2026-07-19/` и требует exact
  tree из immutable release README/status. Он закрывает фактический import graph,
  targeted Walmart executor, Amazon Growth containment и preview-only Jackie listing
  tool; Claude Code только исполняет готовый CLI. Production Phase 1 всё ещё NO-GO.
- 🔄 **Walmart new-SKU operationalization (2026-07-27):** единый Bundle Factory path
  и legacy Walmart bypass закрыты; current frozen release v26 проходит Product Truth
  `468/468`, focused shipping/permit `18/18` и fake-live `3/3` с одним `MP_ITEM`,
  одним `SKU_TEMPLATE_MAP`, exact association read-back и replay без дополнительных
  POST. Matcher release `1.2.1`, read-contract `3.2.0`,
  doctor/plan `1.7.0` и listing
  manifest `1.2.0` заморожены в current operator runtime. Production Product Truth
  schema теперь активирована и независимо подтверждена; ITEM v6 attempt завершился
  безопасным `HTTP 429` без retry.
  Первый owner-approved apply plan v2 дошёл до Turso transaction, но direct
  `PRAGMA ignore_check_constraints` был отвергнут до commit; вся transaction
  откатилась, post-failure schema совпала byte-exact, durable DB writes = `0`, retry
  не выполнялся. Совместимость исправлена без ослабления проверки и подтверждена
  remote rollback probe плюс full suites. Новый read-only plan v3 имеет SHA
  `96b675ac71344a4ded72e51cbe9d4b880139d7d5dd288e67895b8f87924b1d7f`,
  activation SHA `7b8ca99284ffdb229d488474ab9570595fd4829965b7a66d784ab4c83fe8df7e`,
  `canApply=true`, `blockers=[]`, те же exact 8 migrations и 128 compatibility rows.
  Plan/approval v2 не переиспользовались. Владелец одобрил exact v3 bytes
  2026-07-23; одно применение завершилось успешно: 8/8 migrations applied/tracked,
  receipt/Prisma ledgers ready, schema after
  `8c9fc783e53fe4a94b7433eb1b06ac8b36ce03226100bfe4500d3e896367d511`.
  Activation report SHA `9039f22612ed76a7efeaf473c5b94f1e151109b962c91b361558dfc8dd22a1db`,
  certification SHA `d26f57023230f6c2145a7bd09c2d9c4c2028dd80521082dda4da5f3d310b8093`;
  независимый post-commit plan SHA
  `37c6d141e3d97c3d8fef1f54f57cff6725b6b657126c48b23194a9db487913fa`
  имеет `blockers=[]`. Свежий self-contained backup для exact plan
  сохранён в `backups/20260722T224444Z`: portable SHA
  `6e69911d1ab83f77545c9fa5789d35e29f11cd434a25b24d2f03e3fdef952526`,
  `integrity_check=ok`, FK violations `0`; он локально воспроизвёл production
  schema/queue/writer hashes. Дополнительный 2026-07-22 source/schedule audit доказал,
  что reference enrichment/harvest/COGS legacy workers не включены в `vercel.json`,
  их routes и manual mutation endpoints retired/410, а canonical Product Truth CLI не
  является background daemon; owner не обязан вручную искать/останавливать writers,
  потому что apply повторяет plan-bound writer/drift preflight fail-closed. Current
  release: `release-artifacts/walmart-new-sku-pilot-engine-2026-07-26-v26`, engine
  `e44553af…a78135`, manifest `e441a1c0…91460`, certificate `45526f11…73ca5`. Active
  plan/doctor/certification/runtime валидаторы принимают только exact-identifier
  point guard и отклоняют legacy full-seller-catalog binding. Targeted Product Truth
  использует только `EXISTING_EXACT` или machine-derived
  `EVIDENCE_VERIFIED_BOOTSTRAP`; ручной canonical identity input отклоняется. Живой
  checklist: [[walmart-new-sku-command-center]]. Повторная локальная проверка
  2026-07-25 подтвердила exact release/manifest, byte-exact совпадение пяти ключевых
  mutable/frozen Walmart файлов и зелёные gallery lint/build/render `2/2`; внешних
  публикаций, Walmart/DB writes, paid calls или UPC reservation не было. Clean gallery
  после сверки с current public Walmart PDP закреплён current commit
  `d772c9a8…fc894e`: buyer-view отделён от internal economics/UPC/Product Truth
  evidence, exact product title является единственным PDP `h1`. Текущий локальный
  deployment archive SHA `9ac1aa74…6d691a`; предыдущие archives superseded.
  До owner gate existing Sites target read-only подтверждал
  `custom` access только owner account и saved versions/live URLs `0`. Все шесть
  preview image URL 2026-07-25 вернули
  `HTTP 200 image/jpeg`; image rights/final count-accurate assets ещё не закрыты.
  После явного owner approval Sites version `1` успешно развернута по owner-only URL
  `https://walmart-new-sku-owner-preview.kuzy-09.chatgpt.site`; post-deploy access
  остаётся `custom`, allowed groups `0`, а deployment screenshot подтвердил
  корректный buyer-view. Это только review surface: Walmart/UPC/DB/provider effects
  равны `0`. По owner feedback низкого качества Pack of 3 hero выпущена Sites
  version `2` из clean commit `674d6945…2b6191`: три упаковки выровнены, перекрытие
  уменьшено, source повышен до `1400×1400 qlt=95`; lint/build/render `2/2`, тот же
  owner-only URL, business/marketplace data без изменений. Повторный owner review
  правильно выявил, что version `2` не закрыла root cause: opaque white JPEG canvas
  всё ещё перекрывал нижний слой. Version `3` временно разложила 2/3 изображения по
  отдельным grid columns, но owner review вернул её из-за маленьких неестественно
  разнесённых упаковок. Current owner-only Sites version `5`, commit
  `df13727d…78cf3`, использует deterministic exact-pixel cutout: удаляется только
  связанный с краями near-white canvas, упаковка не перерисовывается, а на
  `2200×2200` показываются ровно 2/3 увеличенные exact-source единицы без белого
  перекрытия. Все `20/20` donor images имеют fail-closed artwork disposition;
  old purple `#2/#18/#19` и два не доказанных exact-product promo исключены.
  Mutable engine regression `101/101`, gallery lint/build/render `3/3`; этот
  Image Truth contract позже вошёл в frozen v25. Владелец 2026-07-26 явно принял
  buyer-view pack-of-2/pack-of-3 целиком: exact-source изображения, количество
  упаковок, title, описание, цену и общий вид листинга. Это закрывает review только
  текущего preview и не разрешает UPC reservation, certification или Walmart
  publication.
  Fresh production v26 doctor 2026-07-27 прошёл store/schema/trust/UPC/duplicate
  infrastructure и authenticated exact-UPC Walmart GET `200`, но честно остановился
  на единственном blocker `NO_CURRENT_CANONICAL_PILOT_CANDIDATES`;
  `next_command=null`, diagnostic SHA `cb0727fd…d2dbc`. Принятый owner-preview RITZ
  Cheese связан с donor `75422f18-e3d2-4c62-ae62-7287aaa75119` и direct Walmart
  item `34312392`; старый v12 plan истёк. Следующий шаг требует отдельного owner
  budget gate на максимум `1` Oxylabs query unit + `2.5` Unwrangle detail units,
  reserve floor `100`; UPC reservation/listing publication этим gate не разрешаются.
  После acceptance локальный Product Truth `doctor→plan` без provider/DB/Walmart
  effects подготовил два следующих exact donor candidates: RITZ Bits Peanut Butter
  8.8 oz, plan SHA `d24f00aa…1727`, и OREO Thins Mint 11.78 oz, plan SHA
  `c71857db…5e6`. Новый fail-closed contact-sheet/MAIN-selector классифицирует всю
  donor gallery и разрешает MAIN override только из exact donor URLs; aspect-aware
  compositor поддерживает широкие упаковки без generative redraw, distortion,
  badge или белого перекрытия. Focused engine tests `8/8`, TypeScript errors `0`.
  Четыре новых preview имеют artifact SHA `d078790e…9337` и `ea3594af…b7eb`.
  Owner-only Sites version `6` из commit `ffe59241…3742`, archive SHA
  `c5922a5f…9fc`, успешно развернута по прежнему URL. Галерея теперь показывает
  три exact товара и шесть buyer-view вариантов с отдельным выбором товара и
  Pack of 2/3; lint/build/render `3/3`. Walmart/UPC/DB/paid-provider effects `0`.
  Owner review version `6` выявил, что дополнительные позиции визуально скрыты за
  переключателями и страница воспринимается как один RITZ Cheese PDP. Исправляющая
  owner-only version `7` из commit `d4e4728e…91bd`, archive SHA
  `5e3e22a6…5ceb`, теперь открывается catalog overview со всеми шестью карточками
  одновременно; у каждой видны товар, Pack of 2/3, MAIN, title, price, review status
  и отдельная кнопка полного Walmart buyer-view. Lint/build/render `3/3`, URL и
  access policy прежние, внешние effects `0`.
  После template-aware пересборки owner-only Sites version `8` из commit
  `7fcdc6f2…bbce`, archive SHA `ee316d8d…f361`, закрепила новые artifact hashes и
  explicit free-shipping selection для всех шести preview; URL и owner-only access
  не изменились. Deployment `succeeded`, Walmart/UPC/DB/provider effects `0`.
  Owner pricing clarification 2026-07-26 supersedes zero-shipping-only contract:
  required landed total делится как `item price + exact template shipping`; referral
  и margin считаются с total. Official Walmart, consumer research и seller-community
  evidence закреплены в [[walmart-new-sku-shipping-price-strategy]]. При равной
  speed/coverage/total default — fast/free; paid shipping только experiment, более
  быстрый service или экономически необходимое исключение. V26 реализует owner
  selection account-scoped template в Bundle Factory, exact rate snapshot,
  item/ship split, referral с landed total, worst-case margin, signed
  `SKU_TEMPLATE_MAP` и post-publish association verification. Текущие шесть preview
  остаются explicit free shipping по решению владельца. Production read-only store1
  probe разобрал все `11` active templates, включая Walmart-форму с отсутствующим
  неиспользуемым zero variable charge; free templates = `3`, marketplace/DB/provider
  writes = `0`.
  Policy snapshot `2026-07-26.1` повторно сверен с official Walmart sources и теперь
  требует 14 pinned sources/11 review domains, fresh Health & compliance и ingestible
  privilege, seller-owned inventory, no retail arbitrage/competitor packaging/inserts
  и exact fulfillment-center/lag binding. Pricing gate требует fresh exact-variant
  comparable и нормализует pack counts. Current v26 считает referral с landed total
  и target contribution margin `30%` для каждого exact template scenario. Comparable
  является warning, а не внутренним hard reject; официальный
  Walmart Pricing Rule остаётся внешним риском.
  Ошибочная внутренняя дата Product ID policy
  исправлена на official `2025-06-05`. Official Developer Portal recheck
  2026-07-23 не обнаружил Item Spec drift: recommended `MP_ITEM` остаётся
  `5.0.20260501-19_21_29-api`, `MP_ITEM_MATCH` — `v4.2`, как в frozen v26.
  Full local rehearsal на копии exact backup дополнительно прошёл: 8/8 migrations
  applied/tracked, 128/128 compatibility rows, schema after `8c9fc783…d511`, integrity
  `ok`, FK violations и postcheck blockers `0`; summary SHA `1afd1b5c…1225`.
  Production получила ровно одну schema migration transaction; business-data
  backfill, provider/model calls и marketplace mutations не выполнялись. Следующий
  backfill plan нельзя честно выпустить без отсутствующего пока authoritative Phase 1
  manifest v3 из owner-attested census, свежих per-scope Amazon reports и Walmart
  ITEM catalog; mutable mirrors не являются заменой. Этот cross-channel manifest/
  backfill остаётся отдельным Product Truth Platform track и не блокирует критический
  путь первого Walmart pilot candidate: один exact gap закрывается только sealed
  `TARGETED_WALMART_EVIDENCE`, без нового каталога и без уменьшения Phase 1 denominator.
- 🟡 **Walmart new-SKU pilot engine:** внутри общего Bundle Factory собран защищённый
  operator CLI `npm run walmart:new-sku -- ...` поверх общего Product Truth read-contract;
  финальная owner-коррекция 2026-07-23 закрепляет один product source: Product Truth /
  донорский справочник даёт точную товарную и закупочную истину. Полный all-status
  каталог наших Walmart listings не является входом нового SKU; перед certification
  остаются только authenticated exact staged-SKU absence и exact UPC `SPEC` search.
  Amazon/Walmart — отдельные channel-ветки общего Bundle Factory, а не один общий
  listing path. После доказанного pilot 1–2 SKU будущие волны 15–20 и schedule являются
  отдельными gated releases; текущий pilot release их не разрешает. Полный фазовый
  board: [[walmart-new-sku-command-center]].
  operator handoff: `HANDOFF_WALMART_NEW_SKU_ENGINE_TO_CLAUDE_2026-07-18.md`:
  текущий `MP_ITEM` `5.0.20260501-19_21_29-api` + live Get Spec, exact UPC
  `responseFormat=SPEC`, безопасная ротация `MP_ITEM_MATCH`, structured eleven-domain
  prepublication screen, sealed
  plan→stage→certify→dry-run→approve→apply→verify и durable submission/buyer-proof
  lifecycle. External owner gate теперь Ed25519 v3: hash-only permit отвергается,
  exact engine/SKU/UPC/item payload/SKU-template-map payload/template/fulfillment
  center/seller/DB/doctor/preview/slot подписываются внешним
  private key, а подпись повторно проверяется рядом с `/feeds`. DB release cap хранит
  два immutable pilot slots и запрещает удалять submission ledger. Каждый doctor/plan
  содержит только один SKU; doctor receipt schema =
  `walmart-new-sku-doctor-receipt/1.7.0`, plan schema =
  `walmart-new-sku-plan/1.7.0`, certification schema =
  `walmart-new-sku-certification/1.11.0`, certification input =
  `walmart-new-sku-certification-input/1.8.0`, policy evidence =
  `walmart-new-sku-policy-review-evidence/1.2.0`, owner permit =
  `walmart-new-sku-owner-permit/3.0.0`, policy snapshot =
  `walmart-us-prepublication/2026-07-26.1`. Structured POLICY_REVIEW разбирается
  машинно; raw seller/category/recall/brand artifacts byte/provenance-bound, но
  требуют реальной human/owner проверки, а eleven-domain screen не гарантирует полноту
  изменяемого Walmart policy universe. Buyer worksheet также fail-closed: отдельный
  `verify --mode seal-evidence` требует исходный immutable verify receipt, связывает
  certification/channel/SKU/latest attempt/item/source, проверяет canonical JSON,
  freshness и screenshot race/alias safety и заполняет только screenshot SHA-256;
  final status заново сверяет lifecycle/DB. Verify receipt schema `1.2.0` и lifecycle
  activation contract v3 дополнительно связывают immutable attempt с exact
  certification SHA/payload SHA/seller fingerprint/idempotency key; poller проверяет
  тот же active attempt до GET и transactionally перед lifecycle update. Повторные
  initial verify получают разные receipt-bound worksheet paths. Seller-scoped
  exact-identifier guard запечатан в doctor/plan/certification; unrelated seller mirror
  rows не читаются и не могут блокировать candidate. Exact staged SKU `404` и UPC
  `SPEC` absence повторно подтверждаются до certification/submit. Fake-live CLI
  integration прошёл doctor→plan→stage→certify→dry-run→approve
  →`TEST_FIXTURE_ONLY` signed permit→ровно один fake `MP_ITEM` POST + один
  `SKU_TEMPLATE_MAP` POST→exact association read-back→generated buyer worksheet
  →engine seal→final `BUYER_VERIFIED/LIVE`→idempotent replay без второго POST;
  old-cert/newer-attempt mismatch отклоняется до HTTP/DB. Это не retry unknown POST outcome. Walmart production write
  не выполнялся. После выпуска авторитетны exact
  focused Walmart command, отдельная
  integration command `scripts/__tests__/walmart-new-sku-engine.integration.test.ts`
  и frozen Product Truth certification, записанные в immutable certificate на
  тех же frozen bytes. Актуальный persistent release выдан в
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-26-v26`: engine SHA
  `e44553afaf59ff57b0d02181bcfb8bcbcd3f0914043116a44db1681c57a78135`, manifest SHA
  `e441a1c00a368b3d831004c1f87fceac26d1336a328d1eb19c1d746286991460`, certificate SHA
  `45526f1155a307a981eb837f9afeaaec6510c29944992d187f0f925c0da73ca5`.
  Focused shipping/permit `18/18`, fake-live integration `3/3` и Product Truth `468/468`;
  hardcoded totals не заменяют exact command и certificate. Все releases до v12
  сохранены как historical artifacts; v13/v14 не прошли frozen certification, v15
  superseded до выпуска certificate. Реальных Walmart writes не было. Свежий
  diagnostic doctor
  `2026-07-19T04:05:11.937Z` подтвердил store 1/Sirius, authenticated Walmart catalog
  `GET` HTTP 200, MP_ITEM spec `5.0.20260501-19_21_29-api` и 13 064 AVAILABLE UPC без
  duplicate reservations. Исторический Product Truth canonical-eight read-only plan
  был запечатан без blockers, `canApply=true`, plan SHA
  `8c1a1157246b63195e5d39899f31e2cd3d7b4d6a62f02e0789b674de8bc05f2a`; Walmart
  lifecycle pre-Product-Truth diagnostic plan имел `eligibleForApply=true`, plan SHA
  `25d7c29a9136fe579011296e27430b53ac2c94b390b530dfe33685541c228ef0`.
  После matcher `1.2.1` оба старых SHA являются diagnostic only. Первый свежий plan
  v2 был owner-approved и исполнен один раз, но Turso отверг direct PRAGMA внутри
  transaction до commit; полный rollback и post-failure plan доказали schema/data
  writes `0`. Исправленный read-only exact-eight Product Truth plan v3 готов: SHA
  `96b675ac71344a4ded72e51cbe9d4b880139d7d5dd288e67895b8f87924b1d7f`,
  migration set SHA `2eb39e0cff00a9044c466318f8ca5f1cccc94887514b323d02c4bec31e4f96e0`,
  activation SHA `7b8ca99284ffdb229d488474ab9570595fd4829965b7a66d784ab4c83fe8df7e`,
  `canApply=true`, `blockers=[]`. Plan/approval v2 запрещено переиспользовать. Exact
  v3 approval применён один раз; 8/8 migrations применены и tracked, post-commit plan
  подтвердил новый schema SHA и `blockers=[]`. Backfill не выполнен; для него нужен
  отдельный authoritative Phase 1 manifest v3 и новый sealed plan.
  Current pre-migration production snapshot сохранён как
  self-contained portable SQLite: `integrity_check=ok`, FK violations `0`, 117 tables,
  SHA `6e69911d1ab83f77545c9fa5789d35e29f11cd434a25b24d2f03e3fdef952526`;
  независимая immutable-проверка подтвердила отсутствие WAL/SHM dependency, а
  исправленный local migration plan воспроизвёл production schema/queue/writer/
  migration-set/activation hashes. Manifest:
  `ss-control-center/data/walmart-new-sku-engine/activation/backups/20260722T224444Z/backup-manifest.json`.
  Для нулевого canonical candidate source реализует sealed
  `TARGETED_WALMART_EVIDENCE`: `EXISTING_EXACT` либо
  `EVIDENCE_VERIFIED_BOOTSTRAP`, один existing donor + один direct first-party
  Walmart offer. Движок сам выводит conservative identity из exact
  brand/full post-brand title signature/normalized size; ручной owner identity-файл и
  identity attestation удалены. Bootstrap не пишет до fresh exact search, который
  независимо подтверждает item/URL/first-party/full identity tokens/size/base pack, и
  transactionally ограничен одним variant/decision без нового donor/offer.
  Cap: один Oxylabs query
  (`1` unit), один Unwrangle detail (`2.5` units), ZIP `33765`, TTL `24h`, минимум два
  images, `180000 ms`; OFF/clubs/BJ's/fanout/replay/publish/delist/reprice/purchase
  запрещены. Existing exact content reuse разрешён только с fresh price и без detail
  receipt. Focused/integration code и buyer-evidence seal bytes этого lane входят в
  выданный certificate; provider calls не выполнялись и release не является разрешением
  на spend. Claude Code только исполняет frozen CLI, без кода/SQL/manual API.
  Frozen v12 на новой копии exact portable production snapshot штатно применил
  current 8/8 Product Truth migrations и локально запечатал RITZ Bits Cheese 8.8 oz
  pack-of-2 candidate: machine identity mode, один donor/offer, provider calls `0`,
  production writes `0`, targeted plan SHA
  `5970067627b633beac37b36c720c333898ebec682db864666cace687bc74803a`.
  Исторический v20 commercial preflight отклонил RITZ по прежнему owner contract
  `20% + 125% ceiling`. Artifact
  `ss-control-center/data/walmart-new-sku-engine/candidates/20260723T054756Z-ritz-cheese-commercial-preflight.json`,
  SHA
  `969beb9a078593cc6d7d22c9256b28ff00c7bc8730154f50da583ffe90af9584`;
  он сохраняется только как audit history и не является current candidate decision.
  V23 использует `walmart-new-sku-commercial-discovery/1.1.0`: Walmart sourcing
  разрешён, target contribution margin = `30%`, referral = `15%`, comparable =
  warning. Два preview RITZ рассчитаны как pack-of-2 `$33.13` / profit `$9.94` и
  pack-of-3 `$40.36` / profit `$12.11`; margin обоих = `30%`. Current preview artifact:
  `ss-control-center/data/walmart-new-sku-engine/previews/20260726T162500Z-ritz-cheese-pack2-pack3-owner-preview.json`,
  SHA `3e0a406f6f7ae57377884cea149136df6ee551dfc30b1e2ebbfaac2fecd3d030`.
  Он не является publication evidence; paid calls `0`, UPC reservation `false`,
  Walmart/DB writes `0`. Physical-size guard по-прежнему отклоняет SKIPPY
  `16.3 oz / 64 oz / 80 oz`.
  Исторический v20 doctor сохраняет blocked результат в отдельный
  `walmart-new-sku-doctor-diagnostic/1.0.0`, не создаёт green receipt и возвращает
  `next_command: null`; production pack-2/pack-3 diagnostic SHA:
  `57b1f71e…9496a` / `b2f0b1ef…ca5eb`.
  Исторический `gs1_validated` означает только CSV check-digit flag и не является
  GS1 registry proof. Certification теперь требует exact staged UPC, совпадение
  registry registrant с pool owner, exact Product Truth brand и seller-account
  fingerprint. Permit теперь связан с source
  release `walmart-new-sku-source-release/3.3.0`, frozen manifest
  `walmart-new-sku-frozen-source-release/2.2.0` и dependency policy
  `walmart-new-sku-runtime-dependency-closure/1.3.0`; sealed exclusion исключает
  `.DS_Store`, а verifier отклоняет его внутри frozen topology. Permit также связывает
  exact source tree/dependency lock, а
  `TEST_FIXTURE_ONLY` key не принимается production mutation transport. Production
  publish остаётся **NO-GO**: Product Truth schema развёрнута и сертифицирована 8/8,
  а Walmart lifecycle safety v3 теперь также применён schema-only; production exact
  canonical pilot candidate ещё не создан, а
  diagnostic doctor не выпустил green receipt. Persistent engine release уже выдан,
  но сам по себе эти production gates не снимает. Owner-side технический gap закрыт:
  один offline Walmart owner-control signer создаёт encrypted-at-rest key только вне
  repository. Public key сохраняет три исторически domain-separated действия, но
  текущий new-SKU workflow использует только exact MP_ITEM submit; ITEM v6 request и
  catalog activation отменены как prerequisites. Подписи между domains непереносимы.
  Инструменты показывают exact summary и подписывают request без
  network/Walmart/DB/model access. Автоматический init без пользовательского пароля
  завершён; machine secret находится в macOS Keychain, реальный doctor =
  `OWNER_CONTROL_READY`, public fingerprint
  `ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a`
  pinned, раздельный regression `92/92 PASS`. Claude Code эту поверхность не
  запускает. Private key остаётся во внешней custody. Immutable Bundle Factory
  Walmart release v20 и отдельный ITEM v6 report executor с production trust root
  выпущены и проверены офлайн; executor теперь только audit evidence и не должен
  выполнять report request. Это также не разрешает listing publish. Свежий
  post-Product-Truth lifecycle
  plan создан read-only: SHA `dce9ece5f3613cf765ae21040fdaf471f578d88b4dc1b4b748d0d5e3f7036ac4`,
  `eligibleForApply=true`, `blockers=[]`, duplicate active UPC reservations `0`.
  Владелец отдельно разрешил установить технический предохранитель; exact
  schema-only transaction завершилась `applied`, report SHA
  `9cd66451c701e8d6fac49cf89de1656b367bc5cb27bd6ea97668676a485e94d1`,
  production schema after
  `c54877cb6cf9cb2e823092a739bc078a11af1e4102a6d1c650ee200e23c3dbeb`.
  Transactional postconditions подтвердили обязательные lifecycle objects, Prisma
  history и immutable receipt; backfill, provider/Walmart/model calls и listing
  publication = `0`. Historical owner-review packet:
  `ss-control-center/data/walmart-new-sku-engine/activation/OWNER_REVIEW_20260723T015030Z_WALMART_LIFECYCLE.md`.
  Дополнительная local rehearsal на копии production backup прошла: lifecycle report
  `applied`, integrity `ok`, FK violations `0`, required objects `10/10`, повторный
  plan остановлен `MIGRATION_ALREADY_ACTIVATED`; active fence, global two-SKU cap и
  buyer-evidence/attempt-SKU mismatch guards доказаны на backup-shaped schema. Durable
  summary SHA `3bc021833bd9a1c049e7ba38be46a57ea532b077b65150c12ab31515475ee9ef`.
  После локальной репетиции production получила только описанную schema transaction;
  Walmart/provider/model calls и business-data writes `0`.
  Pre-enrollment one-shot report-request executor сохранён как safety/audit evidence:
  manifest SHA `2faa4399e751ad4d7877629347ba7c6138d915ca99bfca5909f4c33d77918c5e`,
  bundle SHA `b44b6a354d512cda3229186c3da0224a65f1c807d7732db622945681d5f7429e`,
  sidecars `OK`, private modes `0500/0400`, safety suite `71/71 PASS`. Его production
  trust root пуст, поэтому он fail-closed и не является исполнимым POST release.
  Подготовленная pre-enrollment
  `item-v6-store1-20260723-pilot-codex-v2` session authority и empty ledger остаются
  audit evidence и не переиспользуются. Fresh GET-only absence probe v2 успешно
  доказал zero-row exact query; renewal evidence SHA
  `0c203bef0b14f199c6eca33560257adbf8baf4d17721950a6dfd765333be64a5`
  действует до `2026-07-23T06:39:07.290Z`. Новый self-bound executor manifest SHA
  `1e87043d3cf0ab879f184c5a8bbbb5445e84e3ed4a2fd6e56b1951efb13cf575`,
  bundle SHA
  `2afdb43f918be2fff93db8426f6e1bf683a846471a792288cff451847e07e7f3`;
  replacement plan SHA
  `6d0de1ba35edf3ea9f65bbb85021700548979cbf74c2de4529bf168b1ec2a614`,
  empty one-shot ledger SHA
  `da45bf39385ada3b50e872c4a8a6ceefe4b7726512d8f86e4dce2a5281d6fada`.
  Focused release suite `12/12 PASS`; authorization не создана, новый report POST не
  отправлен и по owner-коррекции не требуется, network/model/DB/Walmart writes на
  подготовке `0`. Owner preview помечается superseded/do-not-execute:
  `ss-control-center/data/audits/walmart-source-intake/item-v6-pilot-authorization-store1-20260723-codex-v3/OWNER_PREVIEW.md`.
  Без обхода этого source gate создан только provisional legacy shortlist из трёх
  direct-first-party donor rows: RITZ Bits Cheese 8.8 oz, RITZ Bits Peanut Butter
  8.8 oz и OREO Thins Mint 11.78 oz; SHA
  `bac54c85864ce09e0382422cc2c140e80e50b5a4871fe83d55824e752d116161`.
  Он не является Product Truth/candidate authority и сохраняет blockers exact
  identity/content/storage, price, dimensions/economics, UPC registry, images/rights и
  current policy. Любой stale mirror screen остаётся лишь подсказкой и не является
  product source или обязательным novelty boundary.
  Исправленный Product Truth plan v3 применён и закрыт; его approval не переносится
  на backfill, lifecycle, provider или Walmart actions.
  Любое последующее approval не разрешает автоматически backfill, targeted provider
  run, lifecycle apply, key enrollment или POST. На последующих отдельных gates
  владелец ещё должен разрешить оставшиеся Walmart gates; пока не предоставлены
  реальные evidence/measurements/images для 1 SKU и не выпущен exact signed permit;
  второй SKU, волны 15–20 и расписание не разрешены.
- 🟡 **Production activation:** exact 8 Product Truth migrations применены к Turso и
  независимо сертифицированы; post-commit plan подтверждает 8/8 и обе ledgers.
  Authoritative Phase 1 manifest v3 готов; G5 scope-only apply завершён и verified
  `5935/5935`. Canonical cost/legacy/provider/paid/marketplace/procurement effects
  были `0`. Post-apply full-denominator readiness reconciled все `5935`, но
  consumer cutover на единый Product Truth read-contract = **0 из 4** и
  каждый consumer blocked на `CURRENT_SCOPED_SKU_COST_MISSING`. Legacy
  `DonorProduct`/`SkuComponent`/`SkuCost`/views не доказывают readiness.
  Свежий source-readiness audit сохранил sanitized production snapshots. Read-only
  live verification 2026-07-23 доказала: Amazon store1/store3 участвуют в US
  marketplace; store4 не
  имеет credentials; store5 получает LWA token, но больше не имеет US marketplace
  participation; store2 получает LWA token, но Sellers API возвращает HTTP 403.
  Fresh `GET_MERCHANT_LISTINGS_ALL_DATA` reports для store1/store3 скачаны GET-only
  без report-create: `1571` и `502` строк. Owner disposition исключает
  store2/store4/store5 из текущего snapshot до successor census. Complete Walmart
  ITEM v6 содержит `5236` rows и даёт `3891 PUBLISHED` live listings. Exact bytes
  всех трёх reports, successor census и disposition связаны manifest SHA
  `94359db1…9062c`. Отчёты и census нельзя подменять mutable listing mirrors.
  No-paid evidence-bound canonical materialization canary из уже удерживаемых source
  artifacts завершён. V1 transaction полностью rollback на production
  metered-receipt guard и не оставила строк. Исправленный plan v1.1
  `ba899ce9…fae3d` применён по новому owner gate: `35/35` exact rows, postcheck
  `ALREADY_APPLIED`, partial/FK violations `0`. Он переиспользовал существующий
  donor/BOM каталог и не выполнял enrichment. Full readiness теперь имеет пять
  content-ready listings, пять честных `UNSOURCEABLE` cost outcomes и ноль
  procurement-ready; cutover остаётся `0/4`. Внешние listing writes = 0.
- 🟡 **ChannelMAX VC same-model canary / no-spend:** state machine и точные 103-byte
  forward/rollback артефакты готовы; добавлен finite CDP adapter skeleton с exact
  target/hash/one-row/one-submit контрактами. Browser execution остаётся hard-disabled:
  нет pinned read-only File Uploader DOM evidence и reviewed selectors/parsers;
  production gate не включён, внешних действий не было.
- 🟡 **Amazon Uncrustables MAIN / owner-relaxed correction:** из 164 строк подтверждены
  140 KEEP и ровно 24 REPLACE_MAIN_ONLY; 23 content-addressed assets уже имеют
  R2 readback evidence. Для 24 строк собраны SHA-sealed plan и отдельный
  `MAIN_MEDIA_ONLY_V1` selection: offline exact-patch validation 24/24 PASS,
  targeted safety tests 45/45, Amazon calls/writes = 0. Перед публикацией остаются
  live `VALIDATION_PREVIEW`, свежий sealed rollback plan, закрытие текущего QX OFFER
  mutation fence и отдельная проверка TY (`8541`).
- 🟢 **Uncrustables MAIN two-phase safety:** canonical surgical CLI допускает
  `--submit-only` только для exact `OFFER_ONLY_V1` или `MAIN_MEDIA_ONLY_V1` selection.
  MAIN wave сохраняет каждую принятую операцию как `SUBMITTED` и не делает
  same-action post-write GET; gallery/content profiles запрещены. Повторный запуск
  блокируется до первого Amazon call при любом canonical pending journal или terminal
  action, а settlement выполняется существующим exact-selection
  `--recover-pending-only`. Offline focused 20-action тесты 2/2 и OFFER/pending/
  surgical regressions 81/81 зелёные; этот code-change не выполнял Amazon calls.
- 🟢 **Uncrustables launch-promo safe 161 / offline:** из pinned A/B strategy
  `2026-07-20..2026-08-19` выпущена детерминированная проекция ровно 161 SKU:
  81 coupon и 80 Sale Price, без перераспределения оставшихся назначений. Identity
  holds `SZ-ASPI-JFAT`, `TY-AST2-JE9P`, `VN-AS1A-D572` исключены; scope byte-bound к
  исходному v4 manifest/source CSV и exact safe-base-offer 161. JSON/CSV и SHA-256
  sidecars находятся в
  `ss-control-center/data/repairs/launch-pricing/uncrustables-safe-promo-161-20260720-20260819-v1/`.
  Артефакт явно `offline_only`, `owner_approval_received=false`,
  `execution_authorized=false`, `external_mutations=0`; Amazon/ChannelMAX не вызывались.
- ⚪ После Gate 1 подготовить бесплатный forecast и отдельный budget request на canary
  5–10 SKU. Очередь 1 458 не запускать как есть: пересобрать по актуальному manifest.
- ⚪ После owner approval: canary → отчет → отдельный approval на контролируемые волны
  Phase 1 → readiness-профили четырех потребителей.
- ⚪ Отдельные owner gates: платный batch, optional Sam's/Costco club bucket, делистинг
  `unsourceable`, Amazon min/max/repricing, публикация изменений и любая покупка.
  BJ's не является gate-кандидатом и запрещён текущим source policy.

---

## Активная инициатива: Walmart Listing Integrity — довести весь каталог до эталона

**Операционный журнал:** `ss-control-center/docs/WALMART_LISTING_INTEGRITY_CHARTER.md`
(активная Codex goal entity + постоянный файловый журнал, обновлено 2026-07-19).
**Source-readiness ledger:**
`ss-control-center/docs/WALMART_LISTING_INTEGRITY_SOURCE_READINESS_2026-07-18.md` —
точный статус реальных входов и quarantined ITEM v6 request.
**ITEM provenance incident:**
`ss-control-center/docs/WALMART_ITEM_RECONCILIATION_PROVENANCE_INCIDENT_2026-07-19.md` —
неизвестный параллельный процесс добавил read-only GET и противоречивую offline
promotion; session заморожена read-only, retained `ABSENCE_ONLY` запрещено считать
авторитетным.
**АРХИТЕКТУРА:** [[product-catalog-architecture]] — этот поток является одним из
потребителей общего Product Truth Platform. Он не создаёт параллельный каталог:
отсутствующие варианты заказывает через единый enrichment-контур, а свои
сгенерированные изображения проверяет собственными QA-гейтами.

**Постоянная продуктовая поверхность:** owner решил 2026-07-19 встроить контур
как отдельную вкладку **Listing Integrity** в `/walmart-growth`. Backend — resumable
state machine; Claude Code остаётся release/emergency operator, не ежедневным
исполнителем. Точный target и границы LLM/vision: [[walmart-listing-integrity-platform]].
Единственный owner-visible план от canary до полного каталога и постоянного модуля:
[[walmart-listing-integrity-master-plan]]. Его фазовый чеклист является текущей
операционной картой; Amazon не блокирует первый Walmart canary.
Текущий execution checkpoint, постоянный owner-visible phase checklist, тесты и
точные оставшиеся блокеры: [[walmart-listing-integrity-checkpoint-2026-07-21]].
Исторический pause snapshot: [[walmart-listing-integrity-checkpoint-2026-07-19]].
Три отдельно подтверждённых live canary закрыты fresh Qualification PASS;
четвёртый exact SKU закрыт terminal Qualification `FAIL` и изолирован как
`QUARANTINED_UNRESOLVED` до Content Ownership/Walmart Support и нового плана.
Пятый exact canary `FaisalX-1140` принят Walmart одним POST и находится в
`APPLIED_PROPAGATING / FEED_NOT_TERMINAL`; разрешены только GET-only
continuations того же feed до fresh Qualification.
Автоматический/mass run остаётся `NO-GO`.

**Главная цель (ствол):** исправить все Walmart-листинги так, чтобы фактически
отгружаемый товар, вариант, размер, состав набора и количество полностью совпадали с
title, description, bullets, attributes, MAIN и каждым gallery image. Карточка должна
быть одним правдивым целым и не вызывать возвраты из-за неверного ожидания; изменения
не должны терять published status или индексацию. Эталон: [[walmart-ideal-listing-spec]].

**Текущий gate:** frozen MAIN Gate B v2 = `GO`; mass run = `NO-GO`. Сертифицированы
24 frozen artifacts в ordered batch-4, shuffled batch-4 и singleton: 36/36 известных
BAD определены как BAD во всех layout, ни один известный PASS не получил BAD,
false pass/false bad/technical error = 0. Это не доказывает текущие buyer PDP,
полный текст или gallery.

### Ветки
- 🟢 **Единый one-SKU process boundary и read-only pilot (2026-07-25)** — вместо catalog census и
  разрозненных ручных шагов добавлена команда
  `npm run walmart:listing-integrity -- doctor|capture|inspect|observe|diagnose|review`.
  Она принимает один exact
  SKU evidence set, проверяет Product Truth, current buyer title/body/attributes,
  MAIN, всю gallery и exact image bytes, затем сохраняет один SHA-sealed outcome:
  `SOURCE_REQUIRED`, `BAD`, `REVIEW` или `CLEAN_CANDIDATE` с `next_step`.
  `CLEAN_CANDIDATE` не повышается до PASS без существующей source-aware
  Qualification. `capture` останавливается до Walmart при source block; `inspect`
  разрешает только live self-consistency evidence без Product Truth/repair authority.
  Недоступная БД больше не маскируется как missing schema. Strict buyer parser
  принимает exact отображаемый Walmart item при отличающемся/null внутреннем
  `primaryUsItemId`, но чужой товар по-прежнему отклоняет. После передачи запроса
  vision-worker любой transport failure сохраняется как
  `OBSERVATION_UNKNOWN_OUTCOME` со stable call key и без retry. Реальный неизвестный
  исход `Athar-1591` сверен с remote reservation ledger и навсегда исключён из
  повтора. Mixed pilot завершён: пять успешных live-наблюдений; `FaisalX-1183` и
  `FaisalX-1181` имеют противоречие `hot dog buns ↔ hamburger buns`, ещё три SKU
  остаются `SOURCE_REQUIRED`. Историческая MAIN `FaisalX-1183` 1-vs-6 показана
  рядом со свежей live MAIN из шести упаковок; происхождение изменения writer
  receipt не доказано. Comparator v5 replay = 24/24, false PASS/BAD = 0.
  Команда `review` детерминированно связывает exact proposal с diagnosis, buyer
  snapshot/PDP, всеми image bytes и donor audit, выполняет Product Truth precheck
  и выпускает immutable certificate без write-authority.
  Focused suites: one-SKU 21/21, remediation/Qualification 102/102,
  verifier/operator 8/8, targeted ESLint PASS. Owner-gallery с 17 изображениями:
  `ss-control-center/data/audits/walmart-listing-integrity-single-calibration/owner-gallery-20260725.html`,
  SHA `61ee94ab…7786e`; Walmart writes 0. Следующий этап: exact Product Truth и
  один минимальный owner-reviewed repair package; ITEM v6 census не prerequisite.
- 🟡 **Первый exact text repair review (2026-07-25)** — для `FaisalX-1183`
  подтверждён single-unit donor Pepperidge Farm Top Sliced Butter Hot Dog Buns
  `14 oz / 8 ct`, UPC `014100050162`; Chessmen donor запрещён. Fresh source-backed
  target меняет только `description` и `bullets`: явно сообщает Pack of 6,
  6 bags × 8 buns = 48 и удаляет `hamburger buns`. Title, attributes, MAIN,
  gallery, price, inventory и listing state неизменны. Новый pure review precheck
  доказал, что прежний description без внешнего pack count должен fail-closed
  отклоняться, а предложенный full text target проходит; focused qualification
  suite 10/10 и ESLint PASS. Review hashes: JSON `ce1b31e0…cb72b`, HTML
  `ad6af7ba…a0206`; independent review certification file SHA
  `10a9fafb…e527`, sealed body `12aff1f6…14bc0`.
  Актуальный review подключён к вкладке `Walmart Growth → Listing Integrity`
  через current-review index SHA `24f0a7e6…c7cf1`: current MAIN/gallery показаны
  без изменений, полный text diff отображается рядом, а старый `MAIN 1 → 6`
  свёрнут как историческое доказательство. Loader перепроверяет proposal,
  certification, diagnosis, buyer snapshot/PDP, donor audit и image bytes;
  tamper fail-closed. Loader/UI 9/9, combined control 30/30, TypeScript/ESLint PASS.
  Для решения владельца дополнительно собран единый экран
  `Сейчас → После исправления` с одинаковой current/proposed MAIN, всей live gallery,
  точным description/bullet diff и явной границей unchanged fields:
  `ss-control-center/data/audits/walmart-listing-integrity-single-calibration/FaisalX-1183-owner-gallery-before-after-20260726.html`,
  SHA `1a4ca270…d1b57`; все 5 image references разрешаются в 3 существующих
  SHA-bound image bytes, missing images = 0.
  Следующий gate — owner review exact Product Truth + diff;
  Product Truth activation и Walmart write ещё не выполнялись.
- 🟢 **Owner calibration pool v1 (2026-07-26)** — без census и массового
  прогона собран репрезентативный read-only пул из четырёх реальных SKU:
  `FaisalX-1181` и `FaisalX-1183` имеют доказанный text-only repair,
  `FaisalX-1130` проверяет, что `15 Grain` не принимается за outer count,
  `FaisalX-1208` проверяет, что правильный product class `Hamburger Buns` не
  загрязняется исправлением соседнего hot-dog SKU. Для первых двух title,
  attributes, MAIN, gallery, price, inventory и listing state остаются
  неизменными; description теперь однозначно фиксирует outer bags, inner count
  и total buns, а неоднозначное `our 8-pack` удалено вместе с ошибочным
  `hamburger buns`. Оба target прошли
  `precheckWalmartListingRepairTargetForReview`; оба контроля дали
  `NO_CHANGE/HOLD`. Просмотрены все 12 оригинальных buyer-snapshot images,
  их SHA-256 перепроверены; 20/20 HTML image references существуют.
  Title/Qualification focused suite `14/14`, targeted ESLint PASS.
  Data artifact:
  `ss-control-center/data/audits/walmart-listing-integrity-single-calibration/owner-calibration-pool-20260726-v1.json`,
  SHA `1fa045a4…ff44`; единая gallery:
  `ss-control-center/data/audits/walmart-listing-integrity-single-calibration/owner-calibration-pool-gallery-20260726-v1.html`,
  SHA `a8e19bc5…c555`. Gallery явно разделяет unchanged product-first title
  и quantity-first description/bullet; Walmart/network/model/DB writes `0`.
  Owner visual review закрыт 2026-07-26: владелец подтвердил, что пул выглядит
  нормально, и разрешил продолжить к canary. Уточнённый target не переиспользует
  старый hash: новый `FaisalX-1183` review file SHA `1c66873a…1c548`,
  независимая certification file SHA `af08b766…97089`, новый exact compilation
  request file SHA `3df3e4e4…d95cc`, body `9d06498e…127f3`. Request доказывает
  description/bullets-only diff, unchanged title/images и mass write `false`.
  Frozen owner-package `doctor` = `READY`; exact confirmation request-строки
  получена 2026-07-26. Первая попытка v4 package остановилась до OAuth на ложном
  `compilation request body SHA mismatch`; package не создан, network/model/DB/
  Walmart writes = `0`.
  Повторный production preflight после возобновления goal на `2026-07-26`
  подтвердил owner trust root/key `6aba8f02…a9d2` и обязательные store1 client ID,
  secret и seller ID под точными именами compiler. Значения credentials не
  выводились.
- 🟢 **Frozen one-SKU compiler/release v6 (2026-07-26)** — v5 заменил v4 после
  найденного на реальном request дефекта: v4 принимал законный zero-effect
  `assurance`, выбрасывал его при нормализации и затем ложно отклонял второй
  внутренний SHA-check. V5 валидирует и сохраняет exact assurance schema,
  fail-closed отклоняет неожиданные top-level fields и содержит regression на
  повторную hash-valid проверку. Первый v5 fresh capture затем доказал вторую
  production-разницу: реальный item GET возвращает `mart: "WALMART_US"` и `wpid`
  без numeric `itemId`, тогда как v5 принимал только legacy-object `mart.itemId`.
  Этот вызов имел OAuth `1` + Walmart reads `2`, retries/content writes `0`.
  V6 принимает обе наблюдавшиеся формы, но при отсутствии numeric item ID требует
  exact account, SKU, product identifier, product type, published/active state,
  `mart=WALMART_US` и bounded `wpid`. Owner-side compiler
  строит data-only execution package только из SHA-bound review request, активного
  shared Product Truth binding и свежих exact Walmart item/spec bytes. Fresh
  capture ограничен OAuth `1` + item GET `1` + Get Spec POST `1`; retry, redirect,
  model/DB/content writes = `0`. Clean-checkout release ID
  `8a453e9663e9a5bfc6685486455bfb040fa2e13434f2867b923e175a045239d6`,
  manifest SHA
  `0b15288b0eae50bacffd6ace7d5e5af1df21a3de2611a4efb9b673fdd2820583`;
  136/136 declared tests, targeted ESLint и diff-check PASS. Frozen operator
  doctor и owner-package doctor = `READY`; release readiness не разрешает write.
  V6 сохраняет удаление внешнего arbitrary Product Truth binding: после exact
  confirmation
  compiler выводит non-reusable one-SKU truth artifact прямо из SHA-bound review,
  связывает его с Ed25519 sequence/permit, не требует price/COGS и не активирует
  shared catalog/mass scope. Реальный `FaisalX-1183` package выпущен read-only:
  execution package SHA `2cfbcf62…1545`, request payload SHA
  `ce08e24b…0ddd`, plan receipt SHA `3828217f…1377c`, status
  `READY_TO_EXECUTE_ONE_SKU`; package network = OAuth `1` + reads `2`, retries
  `0`, Walmart content writes `0`. Следующий gate — отдельное exact owner
  confirmation перед единственным execute.
  Exact v3 compilation request file SHA `6813237a…5c00d`, body SHA
  `dbedeb76…ad52`; independent verifier подтвердил description/bullets-only diff
  и unchanged image bytes. Fresh production point-read
  `FaisalX-1183-source-control-20260725-v2` = `SOURCE_REQUIRED`:
  `LISTING_SCOPE_NOT_REGISTERED`, `CURRENT_SCOPED_SKU_COST_MISSING`,
  `FOUND_0` components; Product Truth reads `1`, Walmart reads/writes,
  model и DB writes `0`.
- 🟡 **Frozen one-SKU compiler/release v7 + первый live canary (2026-07-26)** —
  владелец подтвердил execute `FaisalX-1183` по exact payload
  `ce08e24b0ed7cc864fdf987b9aa21216b6469a12c233c2d2f10bf2a4cb0f0ddd`
  и разрешил менять только `description`/`bullets`. V6 execute остановился после
  локального permit burn, но до открытия транспорта: immutable terminal =
  `FINAL_PRE_SEND_GATE_FAILED`, OAuth/POST/network/Walmart writes = `0`,
  `feedId=null`; authorization `82848f56…7094` окончательно consumed и не
  переиспользуется. Root cause доказан: verified wrapper не загружал workspace
  `.env`, а v6 разрешал транспортный credential check только после permit burn.
  V7 переносит side-effect-free credential/seller-account preflight до artifact
  persistence и permit burn, повторно связывает тот же transport snapshot на
  последнем send gate и сохраняет bounded dependency error code. Также в release
  включён owner-approved product-first title-order precheck. Clean commit
  `5d7027d6…b986`, tree `ffcd7fd8…b5855`, release
  `bd0f903e…f24100`, manifest `db1f3b39…09c26`; clean certification
  **137/137 PASS**, targeted ESLint/diff-check PASS. Exact operator prefix теперь
  загружает external `ss-control-center/.env`; secrets не копируются в release.
  Следующий шаг: fresh v7 package/doctor/plan, доказать неизменный payload SHA,
  затем один execute, GET-only continuation при необходимости и fresh
  Qualification. Mass run остаётся `NO-GO`.
- 🟡 **Accepted-feed recovery v8 / canary in Walmart review (2026-07-26)** —
  fresh v7 package сохранил exact payload `ce08e24b…0ddd`; единственный
  `MP_MAINTENANCE` POST получил HTTP 200 и feed
  `18C5F5E0D07A5E6BB8B1380E4B6C6018@AX8BBgA`. Повторный POST запрещён.
  После durable `POST_RESPONSE` ledger остался `REQUESTING`, потому что v7
  generic feed-ID validator не разрешал реальный символ `@`. V8 добавляет exact
  feed-ID regression и sealed `recover-accepted`, pinned только к predecessor
  v7: clean commit `7861c2dc…81913c7`, tree `6bb3049a…ad2b6`, release
  `63cf3a86…e34377c`, manifest `5e8484df…27fcc2`; certification **139/139 PASS**,
  ESLint/diff-check PASS. Recovery перевёл ledger в `ACCEPTED`; bounded GET
  видит exact SKU `FaisalX-1183`, `INPROGRESS / DP_MODEL_INREVIEW`,
  `itemsReceived=1`, `itemsFailed=0`, новых POST `0`. Следующий gate — terminal
  feed, fresh live reread, Qualification и фактическая галерея `До → После`.
  V9 отдельно sealed для последующих nonterminal продолжений: command
  `resume-recovered` имеет только exact GET authority; clean commit
  `8c30c9b4…57010`, tree `97fe4c57…5ccdd`, release
  `bba76d69…ca96fb2`, manifest `c84bc8da…96f676`, suite **139/139 PASS**.
  V10 ограничивает этот continuation ровно одним GET за запуск: commit
  `5b9e573f…35fd2d`, tree `a2e3cc0d…dc39bc`, release
  `bb6c5666…8a27c08`, manifest `0fe5cb07…cc27e0d`, suite **139/139 PASS**.
  Fresh capture `FaisalX-1183-20260726T2235Z` подтвердил: buyer PDP пока ещё
  показывает старые description/bullets, title/images unchanged; Qualification
  остаётся `PENDING_PROPAGATION`, а не `PASS`/`FAIL`. Fresh v10 one-GET
  continuation at `2026-07-26T23:03:25Z` снова вернул
  `APPLIED_PROPAGATING / FEED_NOT_TERMINAL`; transport = OAuth `1` + feed GET
  `1`, maintenance POST `0`. Receipt SHA-256 =
  `f134cb1f…47f8e82`; повторная публикация по-прежнему запрещена.
- 🟢 **Первый production canary закрыт полным Qualification PASS
  (2026-07-26)** — тот же единственный feed
  `18C5F5E0D07A5E6BB8B1380E4B6C6018@AX8BBgA` достиг terminal `SUCCEEDED`;
  новых POST `0`. Fresh live buyer/seller/image capture подтвердил exact
  `FaisalX-1183`, `PUBLISHED/ACTIVE`, product-first title без изменений,
  утверждённые description/bullets для Pack of 6 и неизменные MAIN/gallery
  URLs и bytes. V11 sealed release `dbb14ad1…ffe97ac`, manifest
  `d32dfa46…624c65`, clean suite **142/142 PASS** добавил самостоятельную
  fail-closed команду `qualify`. Authoritative receipt = `PASS`, 14/14 facets,
  `next_sku_unblocked=true`, Walmart/model/DB writes `0`; receipt file SHA
  `42ffd0d3…02b7c6`. Финальная фактическая `До → После` галерея имеет
  **17/17 PASS**, body SHA `f677d6b9…b75d6`. Следующий шаг — свежий read-only
  review следующего отдельно выбранного SKU; массовые writes остаются `NO-GO`.
- 🟢 **Следующий read-only кандидат зафиксирован (2026-07-27)** —
  fresh intake `FaisalX-1181` (Pack of 2) выполнил Product Truth read `1`,
  Walmart GET `2`, buyer PDP `1`, image GET `3`; model/DB/Walmart writes `0`.
  Title, description, bullets, MAIN и обе gallery картинки не изменились с
  утверждённой калибровки; все три image SHA-256 совпали побайтово, поэтому
  повторный model call не нужен. Intake body SHA `efdc6cbd…6e8a8`.
  Отдельный exact owner review теперь frozen: review file SHA
  `8e6e4e21…7dc48`, certification `PASS` file SHA `dc0ac3ce…f6706`,
  compilation request file SHA `fbdac9c5…9a678`, body SHA
  `b09fb637…feabb`. Command Center current-review index переключён на этот SKU;
  loader/fail-closed suite `8/8 PASS`. Меняются только description/bullets;
  title, attributes, MAIN/gallery bytes, price, inventory, status и identifiers
  неизменны. Dedicated exact owner gallery generated directly from the sealed
  request and fresh image bytes: verification body SHA `fb9f18ea…d1f27`,
  gallery file SHA `dfb9502b…9c75`; its six checks pass and Walmart writes `0`.
  Exact owner review confirmation received. Frozen v11 owner compiler then
  captured fresh live item/spec materials and emitted one-SKU execution package
  SHA `482132e3…e7a98`; frozen plan receipt SHA `6caa9ad5…de43` is
  `READY_TO_EXECUTE_ONE_SKU`. Exact surgical payload SHA
  `d89b1f70…7bcd5` contains only `shortDescription` and `keyFeatures` plus
  required SKU/UPC/header identifiers; title/images/price/inventory/status and
  unapproved attributes are absent. Package effects: OAuth `1`, Walmart reads
  `2`, retries `0`, model/DB/Walmart writes `0`. Exact execute confirmation was
  consumed once: Walmart accepted payload `d89b1f70…7bcd5` as feed
  `18C609204E4D5112A3E3306F577A50DA@AX8BBwA`; POST `1`, retry `0`,
  item failures `0`. Initial poll ended `APPLIED_PROPAGATING`.
  The run exposed a real v11 continuation contradiction (`20m` initial poll
  versus `15m` doctor/permit). Frozen v13 release `6c74f28d…0c42c0`,
  manifest `fb912f22…639041`, clean suite `142/142` plus ESLint/diff-check,
  replaces stale write-gate receipts with a one-GET resume accepting only
  current/v11 bindings and requiring durable `ACCEPTED` custody. First v13
  continuation receipt SHA `35fd9426…8732` is still
  `APPLIED_PROPAGATING / FEED_NOT_TERMINAL`; continuation Walmart writes `0`.
  Bounded same-feed checks through `2026-07-27T05:04:19Z` remain
  `INPROGRESS / DP_MODEL_INREVIEW`: received `1`, processing `1`, failed `0`.
  Latest receipt SHA `4dd9b682…c8b2f26`; each continuation is exactly one GET
  with POST `0` and Walmart writes `0`. Sparse same-feed continuation then
  reached terminal `SUCCEEDED` at `2026-07-27T12:09:26Z`; receipt SHA
  `68c6535d…5f6947`, POST `0`, Walmart writes `0`. Fresh frozen Qualification at
  `2026-07-27T12:11:20Z` is `PASS` on all 14 facets with writes/model calls `0`;
  receipt SHA `3ccb0045…5f1d49`, Qualification body SHA
  `f231a6bc…758fcb`. Final factual `FaisalX-1181` gallery is `18/18 PASS`, body
  SHA `51fb1ada…68a957`, HTML SHA `12d63964…36c19`. The next SKU is unblocked;
  owner accepted the factual result and authorized continuation; automatic mass
  apply remains prohibited.
- 🟡 **Permanent operations Stage A + controlled pool 10 (2026-07-28)** —
  refreshed exact-byte census/plan after sync contains `3566` total,
  `2644 PUBLISHED`, `3471 ACTIVE`, `1298 VISUAL_TRIAGE_READY`, `17`
  deterministic conflicts and `1738` scan tasks. Census file SHA
  `f5b08a01…92226d`; plan file SHA `74ed37e7…19f0b7`. Immutable pool
  `controlled-pool-c2a1c74507029bf12380`, file SHA `99cd89b2…e72a9`, is bound
  to those exact bytes, the three final Qualification galleries, one unresolved
  quarantine and read-only performance/Product Truth inputs. It contains
  `1204` candidates: `14 repair-ready`, `1190 source-required`, with ten queued
  rows beginning `FaisalX-1140`. `FaisalX-2768` is excluded as
  `QUARANTINED_UNRESOLVED`, not marked repaired; same-payload replay is false.
  The pool enforces strict order/max apply in-flight `1` and grants no
  Walmart/model/provider write authority. `Walmart Growth → Listing Integrity`
  exposes factual galleries, quarantine and source-required state through
  read-only routes. The legacy unconstrained QC POST remains retired with HTTP
  `410`. Frozen release v23 `b2852a34…3f5826a`, manifest
  `041f4a5a…f99d94`, passed clean checkout `178/178`, targeted ESLint and
  diff-check. Tests use sealed local fixtures rather than mutable live pool
  directories. Remaining Phase 7.2 work is the default-OFF persistent
  scheduler/resumable worker; no automatic or mass apply is authorized.
- 🟡 **Full image-set repair v25 / `FaisalX-1140` canary
  (2026-07-28)** — Product Truth = Pepperidge Farm Farmhouse Hearty White
  Bread, outer Pack of 4. Fresh diagnosis proved that the live MAIN/gallery
  show Hamburger Buns/mixed bun products. The reviewed target changes only
  `description`, `bullets`, `MAIN` and `gallery`; title remains product-first,
  while price, inventory and listing status are excluded. Exact curated image
  set contains the deterministic four-loaf MAIN plus two Product Truth-matching
  gallery assets; reviewed image-set certificate body is
  `d49c5f9a…fb000d`. Frozen v25 release
  `7f418e7c…63aaf81`, manifest `5b75b429…f42749a`, passed clean checkout
  `184/184`, targeted ESLint and diff-check. A first real owner-package attempt
  found `variantGroupSource is not defined` before any Walmart write; v25 fixes
  it and re-certifies the entire suite. The final package payload is
  `86b6f6a1…e0cbe1`. Walmart accepted exactly one POST as feed
  `18C689CE7F4F50BCBC0E931360F8D73F@AX8BBwA` at
  `2026-07-28T19:10:22.467Z`; retry `0`. After the initial 20 bounded polls and
  subsequent one-GET continuations it remains
  `APPLIED_PROPAGATING / FEED_NOT_TERMINAL`. Every continuation is
  `RESUME_EXACT_FEED_GET_ONLY`; a second POST is forbidden. Frozen v26
  `e5e8bfbb…250ae91`, manifest `a5be535c…b22e3ec`, clean `186/186`, adds the
  missing full image-set live Qualification and factual-gallery verifier, with
  v25 as the only accepted predecessor and a gallery-drift rejection
  regression. Fresh Qualification, factual `До → После` gallery and any next
  SKU remain blocked on terminal feed status. Latest sealed local status/report
  both say `ACCEPTED → resume` (file SHA `5df350b5…b227c8e` and
  `5057ec04…13d84`). Mass/automatic run is `NO-GO`.
- 🟢 **Reviewed MAIN engine v14 / `FaisalX-1148` canary завершён
  (2026-07-27)** — exact defect = ambiguous description/bullets plus current
  MAIN showing `8` packages for outer Pack of `2`; title, attributes, gallery,
  price, inventory and status remain unchanged. Candidate MAIN
  `d5f5a7d9…35858` is rebuilt byte-for-byte from exact Product Truth single-unit
  source `8d70a272…55c00`, signed blind decision is `PASS`, R2 public bytes match,
  and both gallery slots are preserved. Frozen release v14
  `e9bc8e4f…dbc00e`, manifest `438fcf4d…fa1d1`, clean certification
  `146/146` plus TypeScript/ESLint/diff-check PASS. Exact one-SKU execution and
  fresh Qualification remain the current step. Exact execution package
  `47db1f09…2401f`, payload `a9ca3439…2b50e` was accepted exactly once as feed
  `18C62987D97D584A8C474291F416F0F8@AX8BBgA`; POST `1`, retry `0`, item
  failures `0`. Тот же feed достиг terminal `SUCCEEDED`; frozen v15
  Qualification вернула `PASS` на всех 14 facets, receipt SHA
  `a0e98b9d…815cf`, body `005139c0…8e05`. Final factual gallery = `20/20 PASS`,
  verification body `6588948d…ed55e`, HTML SHA `dbee9f5b…e43e9`; publication,
  indexing, title и gallery сохранены. The factual-gallery
  verifier now handles the exact reviewed-MAIN diff separately from text-only:
  changed MAIN must have fresh Qualification `PASS`, while title and both
  gallery slots remain exact; the prior text-only canary regression is
  `20/20 PASS`. Mass/automatic run is `NO-GO`.
- 🟡 **Attribute-only canary `FaisalX-2768` / terminal feed, buyer propagation
  (2026-07-27)** — Product Truth и buyer text однозначно задают Campbell's
  Condensed Golden Mushroom Soup, Quantity of 4, но структурированные buyer
  attributes оставались `Flavor=qty 4`, `Count=1` без multipack quantity.
  Frozen v18 допускает только четыре mappings: `flavor=Golden Mushroom`,
  `count=4`, `countPerPack=1`, `multipackQuantity=4`; все opaque attributes
  сохраняются omission-ом, а title/description/bullets/MAIN/gallery/price/
  inventory/status отсутствуют в payload. Exact payload SHA
  `5171d717…1a84`. Первый bounded POST получил definite Walmart
  `HTTP 520 / SYSTEM_ERROR.GMP_GATEWAY_API` без `feedId`; ledger terminal
  `FAILED`, повтор этого permit не выполнялся. Fresh live item/spec bytes затем
  совпали с baseline. Новый independently signed one-SKU plan выполнил один
  POST того же exact payload; feed
  `18C632A8D8735E4599AF541E02A79070@AX8BBwA` достиг `SUCCEEDED`, retry `0`.
  Первый post-write verifier обнаружил собственный coverage gap для
  attributes-only plan до выдачи verdict. V20 сохраняет read-only
  Qualification, принимает v18 как единственный predecessor и sealed как
  release `84230eba…7417b5`, manifest `326e1511…6aeed2d`, clean suite
  `156/156` + ESLint/diff-check PASS. Он также исправляет прежний ложный
  двухчасовой failure gate на опубликованную Walmart шестичасовую SLA.
  V21 `0378f158…df56a`, manifest `e088c575…1a84c4`, clean suite `157/157`
  дополнительно закрывает обнаруженный live variant-group gap: ordinary
  one-SKU attribute repair теперь fail closed, если mapped field является
  активным grouping key или variant evidence неполна.
  V22 `5af7bc87…5846b81`, manifest `b3961fca…216e33`, clean suite `162/162`
  добавляет узкий доказуемый fallback: весь exact ITEM v6 denominator `5236`
  строк, ровно один active/published non-primary group member, те же fresh
  seller/Get Spec bytes, complete one-member group submission и один primary.
  Production doctor = `READY`, network/writes `0`.
  Финальный v21 buyer reread в `22:40:10Z`, уже после полного SLA, всё ещё
  показал старые attributes; старый payload честно закрыт как `FAIL`, receipt
  SHA `b4d18e6a…453c2`, при неизменных PASS для текста, изображений,
  PUBLISHED/ACTIVE и indexing. V22 затем собрал fresh group evidence и выполнил
  один exact group-aware payload `e29c3947…353a`: четыре Product Truth поля плюс
  `variantGroupId=campCondGoldMush`, `variantAttributeNames=["flavor"]` и один
  primary; все текстовые/визуальные/коммерческие поля отсутствуют. Feed
  `18C646C459EA512FA3901FDEDE289A71@AX8BBgA` = `PROCESSED`,
  `1/1 SUCCESS`, retry `0`. Первая fresh Qualification в `22:43:48Z` =
  `PENDING_PROPAGATION`, receipt SHA `247148a8…1675`, failure-not-before
  `2026-07-28T04:42:52.181Z`. Scheduled rereads remained pending until the
  final `2026-07-28T04:45:10Z` Qualification returned `FAIL`: buyer PDP still
  exposes `Count=1` and omits Flavor, Count per pack and Multipack quantity.
  Final receipt SHA `c8a6110a…add53f`, body `890d5f51…725f8`; all text,
  image, publication and indexing facets remain PASS. No factual gallery was
  created because the listing was not repaired. Terminal disposition
  `failure-disposition-829cd4d5ffe9a977ae297eba` seals it as
  `QUARANTINED_UNRESOLVED`, repair-complete false and same-payload replay false;
  its next action is Content Ownership/Walmart Support then a new plan. Fresh
  successor pool `controlled-pool-c2a1c74507029bf12380` excludes that listing
  and begins with `FaisalX-1140`. The completed monitor's accidental
  launchd keepalive restart loop was removed; redundant local starts failed on
  immutable EEXIST before a new Qualification. Other SKU are unblocked without
  falsely declaring `FaisalX-2768` repaired.
- 🟢 **One-SKU remediation + Qualification closed loop (2026-07-22)** — локальные
  фазы 0–5 закрыты: real source-aware BAD → exact surgical repair → propagation
  `RECHECK_NO_WRITE` → fresh buyer reread → Qualification PASS; следующий SKU до
  PASS заблокирован. Combined remediation suite **101/101 PASS**; cross-process
  custody/inventory lock, frozen data-only dependency factory, native one-shot
  zero-retry/no-refresh transport, bounded operator CLI и external clean-checkout
  verifier-wrapper закрыты. Production caller больше не может
  подменить payload/verifier/ledger/custody/transport. External effects = 0
  network/model/DB/Walmart writes. Combined suite **136/136 PASS** в текущей
  проекции и clean checkout. Исторический release v2 `0d21ffcd…246d`, manifest
  `387d4093…7c74`, superseded release v3 `b11f4cca…243a`, current production
  release v6 `8a453e96…239d6`, manifest `0b15288b…20583`; wrapper `doctor` =
  `READY` with zero external effects.
  Phase 6A fresh exact-window probe теперь отдельно закрыт: reusable
  `plan|execute|inspect|verify` lane **5/5 PASS**, live evidence =
  `ABSENCE_ONLY`, OAuth `1` + GET `1`, report-create/retry/model/DB/listing
  writes `0`, family SHA `fdd883fb…f41e57`. Dynamic probe уже связан с
  frozen R4 incident baseline в renewal artifact `0c203bef…64a5`; byte-level
  verifier и one-shot executor дополнены password-free delegated source-only
  authorization: focused regression **68/68 PASS** + targeted ESLint. Owner
  отдельно отклонил пароль/private-key ceremony для этого read-only/source шага,
  и он удалён из operator path. Один exact ITEM v6 create был отправлен
  `2026-07-22T12:04:44.047Z`; Walmart вернул deterministic HTTP 429 без requestId,
  повторов `0`, model/DB/listing writes `0`, authorization terminal и повторно не
  используется. Чтобы не ждать массовый ITEM report, выполнены два bounded exact-SKU
  read-only контроля. `FaisalX-1130` выявил ложный `BAD` на широком
  `Flavor=Grain`; правило исправлено, expanded detector/exact-resolution/PDP
  suite теперь **37/37 PASS**.
  `FaisalX-1183` подтвердил настоящий quantity-confusion defect: title =
  `Pack of 6`, buyer MAIN показывает одну упаковку; offline repair candidate с
  шестью точными упаковками переводит MAIN-компонент в `PASS`. Evidence:
  `ss-control-center/data/audits/walmart-listing-integrity-fresh-controls/FaisalX-1183-20260722T122025Z/manifest.json`.
  Первый постоянный read-only экран уже встроен как вкладка **Walmart Growth →
  Listing Integrity**: current MAIN/gallery, proposed MAIN, exact diff и
  Qualification chain, без live/mass controls. Loader 3/3, component render 1/1,
  targeted TypeScript/ESLint PASS. Exact current MAIN/gallery bytes и candidate
  MAIN перенесены в content-addressed custody; SHA-bound canary preview доказывает
  MAIN-only diff и нулевые writes. Следующий полный gate — свежая signed
  source-aware visual attestation и только затем один live canary. Exact
  two-call shadow request plan и независимый offline verifier готовы; verifier
  перепроверяет request/image/call/worker-ledger/Ed25519/result/truth bindings и
  fail-closed отклоняет malformed response без output. Два owner-approved
  read-only вызова выполнены: exact current MAIN `BAD` (1 vs 6), exact target MAIN
  `PASS`, gallery BAD `0`, gallery REVIEW `2`. Fresh replay закрыл три comparator
  false-negative/false-BAD причины: product/variant field placement, leading
  count in dedicated inner-content claim и Nutrition serving size как ложный
  package-size mismatch. Comparator v5 38/38, worker security 17/17, observation
  17/17, shadow loader 7/7, UI 1/1, targeted TS/ESLint/diff-check PASS. UI теперь
  проверяет exact bundle SHA и обе Ed25519 receipts; byte tamper fail-closed.
  Calls/attempts `2/2`, retries/fallbacks/paid API/OpenAI/Walmart/DB writes `0`.
  Владелец визуально подтвердил target MAIN с шестью упаковками и обе gallery;
  review закреплён SHA `919b85f1…80b`. Повторный frozen-release `doctor`
  подтвердил production trust root: dedicated password-free private key хранится
  вне repository, public key enrolled, один-SKU writer технически готов. Exact
  execution package пока не может быть собран через канонический consumer boundary.
  Exact-eight Product Truth migrations уже активированы и сертифицированы, но свежий
  point-read `walmart:1:FaisalX-1183` через read-contract `3.2.0` возвращает
  `LISTING_SCOPE_NOT_REGISTERED` и `CURRENT_SCOPED_SKU_COST_MISSING`.
  Listing Integrity не создаёт competing activation: общий current Product Truth
  plan v3 из Walmart new-SKU flow имеет SHA `96b675ac…1d7f`; apply завершён 8/8,
  certification SHA `d26f5702…8093`, post-commit plan SHA `37c6d141…13fa`.
  Дублирующий Listing Integrity read-only probe помечен
  `SUPERSEDED-…-do-not-apply`; business-data backfill не выполнялся. SHA-bound
  readiness snapshot SHA `51f12e2533d1d5dcfdda6965c215223463b42064a252f7b507fd2e24b4c1a8aa`
  теперь честно разделяет состояние: schema 8/8 ready, exact SKU truth
  `BLOCKED_SKU_TRUTH_NOT_READY`, execution package `NO-GO`, Walmart write и mass run
  закрыты.
  Execution-package, one-SKU write и mass-run authority отображаются независимо;
  подмена bytes или самозаявленный `READY` падают fail-closed. Ручной competing
  truth запрещён.
  Владелец разрешил в дальнейшем не спрашивать отдельное подтверждение для
  некритической передачи служебных файлов/изображений внутри owner-controlled
  project/openclaw boundary; Walmart/DB/price/inventory/publish/mass actions всё
  равно требуют отдельного gate;
  live canary и mass apply `NO-GO`. Точный чеклист:
  [[walmart-listing-integrity-checkpoint-2026-07-21]]. Точный source order,
  whole-listing six-shard pilot budget и stop conditions:
  [[walmart-listing-integrity-phase6-pilot]].
- 🟢 **Single-unit гейт + агент квалификации** — донор не может быть мультипаком; `qualifyDonorFront` (до тайла) + `qualifyTiledMain` (после). Честный 6-блочный грейд взамен «есть картинка = A-to-Z». Коммит 71aeaba. [[single-unit-donor-gate-2026-07-04]]
- 🟢 **Codex-Vision subscription lane** — текущий frozen Gate B закреплён на `gpt-5.6-sol`, reasoning `medium`, с model/runtime/build attestation, exact call budgets, checkpoints и zero-model replay.
- 🟡 **Исторический водопад магазинов подчинён новому канону** — Listing Improvement больше не запускает самостоятельный retail search/донорский каталог; внешнее обогащение выполняет единый Sourcing/Enrichment Engine с budget owner gate.
- 🟢 **Второй бесплатный vision-воркер = Claude CLI (Max-подписка)** — `/analyze-claude` на боксе, отдельная очередь (параллельно Codex), диспетчер round-robin двух дорожек. ~2x скорость, $0. Коммит 6fc092f.
- 🟡 **Исторический бэклог ~743 сохранён как evidence/risk source, но прежний массовый pipeline больше не считается канонической истиной.** Он допускал self-validation по seller title/донору и создал wrong-product image mixing; его отчёты нельзя использовать как готовый repair plan. Ранее явно одобренные публикации остаются историей, но новый аудит начинается с exact buyer snapshot + подтверждённого recipe/facts. ⛔ «REVERT 11» по-прежнему отменён; title keywords не устанавливают pack truth.
- 🟢 **Frozen MAIN Gate B v2** — sealed ordered/shuffled/singleton replay и независимый adversarial audit. Исходная сертификация: Walmart 157/157, worker 8/8, scripts 10/10. Два PASS→REVIEW в singleton безопасно fail-closed; exact agreement остаётся диагностикой, directional safety — blocking gate.
- 🟢 **Offline readiness contracts** — готовы source-aware Product Truth audit export, четырёхисточниковый Shadow selection compiler и human-label/adjudication v2. Manifest имеет deep-frozen immutable policy/NO-GO, один precommitted seed и полный source rebuild; human context связывается с exact 50 cases/export и фактическими локальными MAIN bytes. Текущая проверка: Walmart 198/198, calibration 8/8, worker 8/8, релевантные Walmart scripts 4/4, strict TypeScript/ESLint/diff-check PASS. Общий scripts suite 9/10 из-за отдельного Uncrustables pinned-SHA mismatch. Отдельный Walmart truth catalog не создан; реальные source snapshots и реальные 50 labels ещё не собраны.
- 🟡 **Real-source readiness** — read-only baseline `2026-07-18T23:10:07.102Z`: 3 877 mirror rows, 2 859 provisional `PUBLISHED + ACTIVE`, но 0 сохранённых `ITEM_CATALOG`; `WalmartSkuPerf` покрывает 380/2 859 live SKU и устарел с 2026-06-14, local orders дают ~96/180 дней. Все catalog `itemId` — alphanumeric seller WPID, не public numeric buyer IDs. Реальный ITEM v6 create остался `MANUAL_REVIEW / AMBIGUOUS_POST_NETWORK_OUTCOME`; retry запрещён. Неизвестный параллельный процесс позже добавил недоверенный offline `ABSENCE_ONLY` поверх terminal failure; v1 fail-open воспроизведён и закрыт, live request CLI retired. Новый изолированный exact ITEM/v6/API probe для исходного окна вернул HTTP 200 raw zero-row sentinel. Его шесть файлов и неизменный quarantine inventory независимо проверены и запечатаны в final frozen R4 release (source artifact SHA `3efd693468f9c0761d6091d379c06e2daddb7d8dadc908228eb282ddeab4fa31`, bundle SHA `49b731c3ad1abe54de6d036a251cdf2731e5dad1bb3bd8797a83a6ed428b0fab`, fresh until `2026-07-20T23:13:21.286Z`). R1–R3 запрещены; R4 independently reproduced, 0 Critical/High. Честный verdict — no API-visible v6 request, но не доказательство недоставки исходного POST; account match operator-asserted, Walmart signature/TLS transcript отсутствует, duplicate risk non-zero. Ed25519 disposition v2 contract готов offline, production owner trust root пуст и live create path отсутствует. Следующий gate — точное owner risk decision + dedicated key enrollment; старые conflicting final/permit/release запрещены. Подробности: `ss-control-center/docs/WALMART_ITEM_RECONCILIATION_PROVENANCE_INCIDENT_2026-07-19.md`. Mass run остаётся `NO-GO`.
- 🟢 **Source-contract hardening milestone** — ITEM capture/published 44/44 и performance/Shadow/truth/human/zero integrated 148/148; targeted strict TypeScript, ESLint и diff-check PASS. Закрыты cross-account continuation, exact HTTP accounting, deadlines, symlink/canonical containment, versioned locator, crash-resume, redirect caps, exact-180 overlapping partitions, Returns lifecycle и Shadow JSON budgets. Локальные seals требуют trusted custody и не выдаются за подпись Walmart.
- 🟡 **Listing-integrity execution engine v4 / controlled batch readiness** —
  реализованы external Ed25519 owner authorization, immutable hard freshness =
  oldest(scope, Product Truth, buyer index, every locked buyer snapshot)+24h,
  permit v3 и append-only one-shot allowance ledger. Worker reservation ledger
  имеет pinned identity/epoch/path/inode/artifact hashes и проходит через health,
  call key, signed receipt, batch/terminal и audit. Fixed batch-4 ограничен шестью
  exact calls на partition; crash расходует grant и не допускает reissue/replay.
  Локальный code gate после независимого review = `PASS` только для одного
  изолированного trusted-custody executor: success и terminal требуют отдельные exact
  `0444` observation/attempt files; permit/partition/shard/call/request/policy/OCR/
  receipt/timing связаны; stable-read и canonical global path namespace проверяются
  до compile/report. Six-suite merge: 94 total, 93 PASS, 0 FAIL, 1 sandbox loopback
  SKIP; тот же redirect test вне sandbox 1/1; worker 23/23 с integration вне sandbox;
  targeted ESLint/diff-check PASS. Receipt v2 не подписывает `attempt_body_sha256`,
  поэтому hostile same-user/admin и multi-writer execution остаются вне допуска и
  независимое cryptographic pre-POST proof не заявляется. Remote worker blocker закрыт
  операторским отчётом Claude BF-Images: receipt v2, build `fed5fa5e…`, новый pinned
  ledger/epoch и authenticated health, model calls 0; старый build `080d3a50…`
  инвалидирован. Observer повторяет authenticated health перед model POST. Для freeze
  теперь остаются fresh ITEM/Product Truth/numeric buyer PDP/gallery sources и
  Shadow-50/gallery pilot. Отчёт:
  `ss-control-center/docs/WALMART_REMOTE_WORKER_OPERATOR_REPORT_2026-07-19.md`.
  Unattended mass остаётся `NO-GO`.
- 🟡 **Buyer-facing calibration** — one-call Oxylabs `walmart_product` probe готов и протестирован в dry-run: один primary attempt, 0 retries/fallback, immutable raw + receipt, global metered guard. Платный вызов требует отдельного owner approval и не выполнялся.
- ⚪ **Shadow-50 execution** — собрать реальные frozen sources и 50 exact SKU/item, sealed local MAIN bytes, две независимые human labels до модели + третий adjudicator при конфликте; затем отдельный runner, ordered + shuffled batch-4, ровно 26 normal attested subscription calls. `shadow_execution_ready=false`.
- 🟡 **Gallery pilot + owner-visible Before/After** — отдельный comparator/golden/pilot;
  успешный MAIN gate не переносится на дополнительные изображения. Для первых
  фактически исправленных SKU Command Center обязан показать рядом все изображения,
  text/attribute diff, fresh buyer reread, Qualification и published/indexing status;
  до просмотра владельцем контролируемые waves не открываются.
- ⚪ **Codex/vision очередь с приоритетами** — ручной Bundle Factory + обогащение каталога не должны толкаться и терять работу; BF по ночам, обработка листингов отдельно.
- ⚪ **Общий Product Truth Platform** — подтверждённые variant/pack/recipe/evidence отделены от текущих channel observations и generated content; Listing Improvement читает общий каталог, но не создаёт собственную донорскую базу. Основа: [[product-catalog-architecture]].
- ⚪ **Комбинированный vision-промпт** — один вызов: описать каждое фото + сразу выбрать лучшее для титульной плитки (меньше вызовов + обогащает базу).
- ⚪ **Sharded read-only catalog audit** — только после buyer snapshot readiness, truth coverage, полного Shadow-50 и gallery pilot; checkpoint/resume и stop conditions обязательны.
- ⚪ **Remediation** — отдельные инструменты по типам дефектов, canary, ручной approval, post-write buyer PDP + published/indexing verification и rollback; массовые writes сейчас запрещены.
- 🟡 **Локальный checkpoint перед следующим live gate (2026-07-20)** — ITEM v6
  one-shot source executor завершён: frozen loaded-code/manifest/runtime/account/
  expiry binding, cumulative head ledger, manual-review precedence и final family
  reread; independent focused suite `139/139 PASS`, lint/diff clean. Qualification
  v2 теперь rebuild-ит exact baseline/post sources, игнорирует cached/self-hashed
  PASS и связывает signed sequence + one-SKU permit + plan/target/Product Truth;
  focused `8/8 PASS`, production pin намеренно null. Реальный report POST и Walmart
  listing writes не выполнялись. Remediation остаётся `NO-GO`: нет production
  existing-listing writer, а WIP payload contract ещё не является Walmart-native
  surgical `MP_MAINTENANCE` (нужны header, identifiers/UPC, productType/current spec,
  changed-fields-only, frozen writer/ledger/raw feed evidence). Точная точка:
  `ss-control-center/docs/WALMART_LISTING_INTEGRITY_RESUME_CHECKPOINT_2026-07-20.md`;
  постоянный продуктовый target: [[walmart-listing-integrity-platform]].

---

## Прочие потоки Command Center (высокоуровнево — деталь в памяти/вики)

Эти инициативы ведутся в ДРУГИХ чатах; здесь только чтобы каждый Claude видел
ландшафт и не дублировал. Деталь — по ссылке.

| Поток | Статус | Где деталь |
|---|---|---|
| COGS / определение себестоимости (retail-донор → цена) | 🟡 параллельный чат | `project_cogs_catalog_pricing_roadmap`, `project_cogs_engine_spec_gaps` |
| Finance Core (funds, cash-basis, waterfall) | 🟡 | `project_finance_core_module` |
| Personal Finance (private pool, credit cards) | 🟡 Phase 2 | `project_personal_finance_module` |
| Pricing / repricer (Uncrustables, guardrails) | 🟡 | `project_pricing_module`, `project_uncrustables_pricing` |
| Bundle Factory / Listing Studio (mass gen) | 🟡 | `project_bundle_factory_vision`, `project_listing_studio` |
| QuickBooks integration | ⚪ | `project_quickbooks_integration` |
| RBAC / multi-user | ⚪ | `project_rbac_access_control` |
| Org-board sidebar reorg | ⚪ | `project_sidebar_reorg_idea` |
| Amazon Growth module | ⚪ | `project_amazon_growth` |
| Walmart Grow / Listing Quality | 🟡 | `reference_walmart_grow_hub`, `project_walmart_growth_levers` |

---

## Как поддерживать
1. Существенное сделал/начал/запарковал — обнови статус здесь ЖЕ.
2. Новая инициатива — строка + (если крупная) отдельный вики-док, слинкованный сюда.
3. Идея «на потом» — в 🅿️ parked, не теряем.
4. Прогнать `node scripts/wiki-brain.mjs` при сомнениях в связности.

---

## Product Truth G7 / listing-bound bootstrap — 2026-07-28

- [x] ✅ Five-listing G7 production canary выполнен и закрыт immutable artifact
  `c73aff01…1a4c`.
- [x] ✅ Исправлены `UNSOURCEABLE matchTier`, live Unwrangle tariff `2.5` и
  targeted lease > sealed wall clock.
- [x] ✅ Certification `508/508`; prohibited marketplace/procurement effects `0`.
- [x] ✅ Post-canary legacy bridge audit доказал variant conflicts, а не
  materialization readiness.
- [ ] 🔄 Спроектировать и реализовать `LISTING_BOUND_TARGETED_BOOTSTRAP`, который
  seals exact listing scope + structured canonical target и требует fresh strict
  retailer match до alias/price/content write.
- [ ] ⬜ Выпустить новый clean frozen release и single-SKU no-retry canary.
- [ ] ⬜ Только после успешного bridge postcheck открыть следующую bounded G7 wave.

Обновление:

- [x] ✅ `LISTING_BOUND_TARGETED_BOOTSTRAP` v1.4 реализован и fail-closed
  сертифицирован: TypeScript PASS, unit `13/13`, integration `11/11`, Product
  Truth `511/511`.
- [x] ✅ Старый unbound bootstrap запрещён для новых plans; три pilot conflicts
  сохранены в quarantine без rewrite/replay.
- [ ] 🔄 Clean frozen release + read-only preflight одного untouched candidate.
- [ ] ⬜ Один no-retry canary и fresh bridge postcheck.

---

## Product Truth standing provider authority — 2026-07-28

- [x] ✅ Найден источник ручных approval prompts: `AGENTS.md`,
  `product-truth-operator-runbook.md`, `product-truth-owner-gates.md` и CLI
  `--approval/--confirm`; это был project contract, не требование OpenAI.
- [x] ✅ Owner direction закреплена канонически: обычный Product Truth
  retailer/provider enrichment больше не требует chat approval, plan SHA,
  permit ID или confirmation от владельца.
- [x] ✅ Pinned policy
  `ss-control-center/data/audits/product-truth-standing-authority/standing-provider-policy-20260728-v1.json`,
  SHA `7b7bcc99…3eb0`: target/manifest bound, ≤100 listings/≤100 provider units
  на plan, Unwrangle floor `15000`, concurrency/attempt `1`, no retry/replay,
  clubs/BJ's/marketplace/price/inventory/delist/activation/procurement `false`.
- [x] ✅ Готовые CLI-команды `balance-probe` и `authorize` реализованы:
  первый делает ровно один no-retry Target Search balance call, второй offline
  выпускает внутренние approval/permit/confirmation и exact `next_argv`.
  API key не попадает в artifacts/stdout; owner action = `false`.
- [x] ✅ Balance probe переведён на mandatory distributed spend ledger:
  automatic one-call permit, deterministic reservation, durable receipt и
  settlement до выпуска evidence.
- [x] ✅ TypeScript PASS; полный Product Truth suite `519/519`.
- [x] ✅ Clean-checkout release `bc98d341…6fc12`, tree
  `6eaed976…fe5d`, engine `805431de…b355`; clean TypeScript, Prisma,
  Wiki-Brain и Product Truth `519/519`.
- [x] ✅ Read-only request `50483a90…3389` / plan `d9f1ffaf…ad21`;
  provider calls/DB writes `0`.
- [x] ✅ Без owner prompt выполнен single-SKU field-snapshot canary:
  terminal `COMPLETED`, combined spend `6`, retry `0`, no marketplace/business
  mutations. Immutable packet:
  `ss-control-center/data/audits/product-truth-standing-authority/20260729T004612Z-canary-v1/`.
- [x] ✅ Status/report и full-denominator postcheck `5935/5935`: exact Sunkist
  variant/price/partial content сохранены; missing allergens/storage явны.
- [x] ✅ Canonical listing recipe/COGS materialization отделена от content
  completeness: сохранённые exact evidence дали `10 FACT`, остальные `93`
  canonical recipes честно остались `UNSOURCEABLE`; provider spend `0`.

---

## Product Truth Phase 1 — checkpoint 2026-07-29

- [x] ✅ Saved-evidence canonical materialization завершена без повторного
  retailer/provider spend: readiness `5935/5935`, `FACT 10`, `ESTIMATE 0`,
  `UNSOURCEABLE 93`, `MISSING 5832`, `INVALID 0`.
- [x] ✅ Independent content/economics axes сохранены: Bundle Factory и Listing
  Improvement `22 ready`, Procurement `10 ready`.
- [x] ✅ FACT wave atomарно записала `30` append-only canonical rows; apply SHA
  `edbb8d57…52eaf`, повторный preflight = `ALREADY_APPLIED`.
- [x] ✅ Исправлен audit-only provenance regression после FACT promotion.
  Fresh bridge снова показывает `102` canonical / `5833` quarantine; plan SHA
  `45b1d14b…38462`.
- [x] ✅ Systemic quarantine partition исчерпывающе разложил все `5833`
  listings по восьми primary lanes: integrity `157`, listing identity `899`,
  component graph `284`, donor link `800`, exact donor offer `33`, price proxy
  `21`, retailer identity `3639`, other `0`. Report SHA
  `48c6c87e…6e4d2`; все effects равны нулю.
- [x] ✅ Clean release `8f8b3928…f5864`, tree `aeb5649f…d5714`,
  Product Truth `535/535`, TypeScript, Prisma, diff и clean-worktree PASS.
- [x] ✅ Unique strict existing-catalog rematch реализован fail-closed:
  ambiguity, canonical conflict и legacy-link conflict не перезаписываются.
  Clean release `628a569c…a654478`, tree `8c8a8650…fba73b`,
  Product Truth `541/541`.
- [x] ✅ Четыре no-paid one-component waves материализовали `46` listings:
  `331` inserted / `9` exact existing rows; все postchecks
  `ALREADY_APPLIED`, provider/retailer/marketplace effects `0`.
- [x] ✅ Multi-component recipe contract `3.6.0` завершён и clean-certified:
  release `86cc42b3`, tree `3ab97506…593f6`, Product Truth `542/542`,
  TypeScript/ESLint/Prisma/diff/clean-worktree PASS.
- [x] ✅ Последние пять exact bundle candidates применены одной bounded wave:
  plan `99e93cfe…cad3e`, preflight `READY_TO_APPLY`, `99` inserted rows,
  apply report `f53ae007…a3399`, postcheck `ALREADY_APPLIED`; paid/provider/
  marketplace/consumer/procurement effects `0`.
- [x] ✅ Fresh state: `154 canonical / 5781 quarantine / 0 automatic write
  candidates`. Readiness `5935/5935`: content-ready `32`, Unit Economics
  `10 FACT / 0 ESTIMATE / 145 UNSOURCEABLE / 5780 MISSING / 0 INVALID`,
  Procurement `10`; report `835a9242…bcc74`.
- [x] ✅ Fresh partition report `23034993…de9`: integrity `160`, listing
  identity `754`, component graph `406`, donor link `741`, exact donor offer
  `69`, price proxy `18`, retailer identity `3633`, other `0`.
- [ ] 🔄 Восстановить listing identity/component graph из уже сохранённых
  authoritative channel/catalog evidence и повторить fail-closed
  rematch/materialization без provider spend.
- [ ] ⬜ Повторять materialization/readiness до исчерпания безопасных классов,
  затем выполнить backfill readiness и four-consumer SHADOW comparison.

Текущее продолжение:

- [x] ✅ Canonical listing recipe/COGS отделены от content completeness:
  сохранённые exact evidence материализованы бесплатными bounded waves.
- [x] ✅ Current denominator audit: `5935` listings, `671` canonical,
  `5264` typed quarantine, automatic no-paid candidates `0`; параллельный каталог
  не создан.
- [x] ✅ `EXISTING_EXACT` standing plan теперь привязан к текущему
  `ProductTruthListingRecipeComponent`, а не mutable legacy `SkuComponent`.
  Real read-only Campbell's plan `f302cfb1…e542` прошёл standing eligibility;
  provider calls/DB writes `0`; certification `556/556`.
- [x] ✅ Campbell's lifecycle выполнен один раз и terminalized `AMBIGUOUS` на
  unexplained candidate token; Pepperidge Farm successor также terminalized
  `AMBIGUOUS` на out-of-stock + missing title brand. Для каждого: `3.5`
  provider units, retry/detail/canonical/marketplace writes `0`; replay
  запрещён.
- [x] ✅ Targeted adapter теперь сохраняет Oxylabs `general.brand` и допускает
  его только как exact token-equal comparison evidence при отсутствии бренда в
  title. Observed title и canonical matcher `1.2.1` не изменены; conflicting
  brand остаётся reject. Clean release `48788374`, tree `6462f400…4890`,
  Product Truth `575/575`, TypeScript и clean checkout PASS.
- [x] ✅ Standing doctor/plan contradiction закрыт: каждый targeted run требует
  exact canonical listing/component binding. Release `39474394`, tree
  `fd53fc74…6580`, clean Product Truth `575/575`, TypeScript PASS.
- [x] ✅ Glory Honey Carrots выполнен ровно один раз для
  `walmart:1:RizwanX-3049 / component 0`; terminal outcome `AMBIGUOUS`,
  combined spend `3.5` units, retry/detail/canonical/marketplace writes `0`.
  Report `0c44d4a3…62e`; автоматический replay запрещён.
- [x] ✅ Root cause второго multi-word brand false reject закрыт:
  existing-exact path восстанавливает `Glory Foods` из hash-bound decision
  evidence только если raw phrase пересобирается в тот же canonical variant ID.
  Contradictory brand остаётся fail-closed; matcher `1.2.1` не изменён.
  Release `38997655`, tree `973dea2d…d5c0`; shared Product Truth `579/579`,
  clean checkout `576/576`, TypeScript PASS.
- [x] ✅ Pepperidge Farm Swirl Cinnamon donor `702af605…34816` выполнен один
  раз с canonical binding `walmart:1:FaisalX-229 / component 0`. Content lane
  terminalized `AMBIGUOUS` на incomplete Unwrangle detail, retry `0`;
  lifecycle consumed `6` units total, marketplace mutations `0`. Exact
  first-party Walmart search всё же сохранил отдельное price observation
  `doo:80dffa…06d2` для item `10452822`, ZIP `33765`, `$3.57`.
- [x] ✅ Saved exact price materialized без новых provider calls во все восемь
  shared recipes `FaisalX-229/231/232/233/234/235/236/237`: plan
  `2adac05b…0413`, fresh preflight `READY_TO_APPLY`, apply
  `b1a490e0…cf15`, `24` append-only rows и `8 FACT`.
- [x] ✅ Full-denominator readiness `ad145926…9659`: `5935/5935` reconciled,
  Bundle Factory/Listing Improvement `100`, Unit Economics
  `18 FACT / 3 ESTIMATE / 740 UNSOURCEABLE / 5174 MISSING`, Procurement
  `18`. Все восемь Cinnamon listings читаются как `FACT`/`READY`; incomplete
  content не был relabelled как complete.
- [x] ✅ Cheez-It Original 21 oz donor `fce8b1aa…4e7e` выбран как следующий
  highest immediate-impact target: пять single-component Walmart recipes,
  binding `FaisalX-4464 / component 0`, plan `96181a7f…5856`.
- [x] ✅ Единственный provider attempt terminalized `AMBIGUOUS`: Oxylabs row
  не содержал все required target tokens. Report `36d8a694…1a19`, lifecycle
  spend `3.5` units, retry/detail/price/content/canonical/marketplace writes
  `0`; автоматический replay запрещён.
- [x] ✅ Provider reject diagnostics теперь перечисляют точные
  `MISSING_TARGET_TOKENS`/`UNEXPLAINED_CANDIDATE_TOKENS`, поэтому следующий
  fail-closed result диагностируется без повторного spend. Release
  `87b50d71`, tree `11ea7895…0a9`; focused `16/16`, full Product Truth
  `576/576`, TypeScript и targeted ESLint PASS.
- [ ] 🔄 Выбрать следующий highest-impact untouched exact Phase 1 target,
  выполнить один bounded standing-authority lifecycle и независимо
  материализовать только подтверждённые content/price evidence в существующий
  canonical graph с новым full-denominator postcheck.

