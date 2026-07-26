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
  теперь активен только с runtime hardcoded `OFF`. G3 scope: Amazon store1
  `Salutem Solutions`,
  store3 `AMZ Commerce` и Walmart store1 `SIRIUS TRADING INTERNATIONAL LLC`; Amazon
  store2/store4/store5 исключены из текущего snapshot как blocked и возвращаются
  только через successor census/manifest. G4 разрешает одну новую zero-retry
  read-only ITEM v6 попытку, но старую quarantined session переиспользовать нельзя.
  G5–G8 не разрешены. Живой checklist и acceptance gates:
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
- 🟡 **Phase 1 authoritative scope:** локальный trusted census + immutable builder
  `phase1-authoritative-scope-manifest/v3` policy 1.1.0 fail-closed связывает все
  supported Amazon/Walmart slots, owner attestation, canonical dispositions, derived
  required scopes и exact report bytes SHA-256;
  relabeled/tampered v2 не проходит importer. Provisional snapshot сохранён только как
  исторический non-authoritative baseline. Ещё нужны Walmart `ITEM_CATALOG`, Amazon
  `GET_MERCHANT_LISTINGS_ALL_DATA`, owner dispositions по store scopes и финальный
  manifest всех live listings. Повтор raw SKU между точными scopes не объединяется и
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
- 🔄 **Walmart new-SKU operationalization (2026-07-23):** единый Bundle Factory path
  и legacy Walmart bypass закрыты; current frozen release v23 проходит Product Truth
  `429/429`, Walmart unit/security с exit `0` и fake-live `3/3` с одним POST и replay
  без второго. Matcher release `1.2.1`, read-contract `3.2.0`,
  doctor/plan `1.7.0` и listing
  manifest `1.1.0` заморожены в current operator runtime. Production Product Truth
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
  release: `release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23`, engine
  `94ec2928…0f5f`, manifest `7c7baa79…a5c`, certificate `cc5603d8…9242`. Active
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
  всё ещё перекрывал нижний слой. Current Sites version `3`, commit
  `79de4979…255fbd`, полностью запрещает overlap/rotation/shadow/z-index и раскладывает
  2/3 изображения по отдельным grid columns; regression + render suite `3/3`.
  Policy snapshot `2026-07-23.4` повторно сверен с official Walmart sources и теперь
  требует 14 pinned sources/11 review domains, fresh Health & compliance и ingestible
  privilege, seller-owned inventory, no retail arbitrage/competitor packaging/inserts
  и exact fulfillment-center/lag binding. Pricing gate требует fresh exact-variant
  comparable, нормализует pack counts, включает shipping label в item price и требует
  owner target contribution margin `30%` после goods, packaging, shipping и referral
  `15%`. Comparable является warning, а не внутренним hard reject; официальный
  Walmart Pricing Rule остаётся внешним риском.
  Ошибочная внутренняя дата Product ID policy
  исправлена на official `2025-06-05`. Official Developer Portal recheck
  2026-07-23 не обнаружил Item Spec drift: recommended `MP_ITEM` остаётся
  `5.0.20260501-19_21_29-api`, `MP_ITEM_MATCH` — `v4.2`, как в frozen v23.
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
  lifecycle. External owner gate теперь Ed25519 v2: hash-only permit отвергается,
  exact engine/SKU/UPC/payload/seller/DB/doctor/preview/slot подписываются внешним
  private key, а подпись повторно проверяется рядом с `/feeds`. DB release cap хранит
  два immutable pilot slots и запрещает удалять submission ledger. Каждый doctor/plan
  содержит только один SKU; doctor receipt schema =
  `walmart-new-sku-doctor-receipt/1.7.0`, plan schema =
  `walmart-new-sku-plan/1.7.0`, certification schema =
  `walmart-new-sku-certification/1.8.0`, certification input =
  `walmart-new-sku-certification-input/1.6.0`, policy evidence =
  `walmart-new-sku-policy-review-evidence/1.2.0`, owner permit =
  `walmart-new-sku-owner-permit/2.0.0`, policy snapshot =
  `walmart-us-prepublication/2026-07-23.4`. Structured POLICY_REVIEW разбирается
  машинно; raw seller/category/recall/brand artifacts byte/provenance-bound, но
  требуют реальной human/owner проверки, а eleven-domain screen не гарантирует полноту
  изменяемого Walmart policy universe. Buyer worksheet также fail-closed: отдельный
  `verify --mode seal-evidence` требует исходный immutable verify receipt, связывает
  certification/channel/SKU/latest attempt/item/source, проверяет canonical JSON,
  freshness и screenshot race/alias safety и заполняет только screenshot SHA-256;
  final status заново сверяет lifecycle/DB. Verify receipt schema `1.1.0` и lifecycle
  activation contract v3 дополнительно связывают immutable attempt с exact
  certification SHA/payload SHA/seller fingerprint/idempotency key; poller проверяет
  тот же active attempt до GET и transactionally перед lifecycle update. Повторные
  initial verify получают разные receipt-bound worksheet paths. Seller-scoped
  exact-identifier guard запечатан в doctor/plan/certification; unrelated seller mirror
  rows не читаются и не могут блокировать candidate. Exact staged SKU `404` и UPC
  `SPEC` absence повторно подтверждаются до certification/submit. Fake-live CLI
  integration прошёл doctor→plan→stage→certify→dry-run→approve
  →`TEST_FIXTURE_ONLY` signed permit→ровно один fake POST→generated buyer worksheet
  →engine seal→final `BUYER_VERIFIED/LIVE`→idempotent replay без второго POST;
  old-cert/newer-attempt mismatch отклоняется до HTTP/DB. Это не retry unknown POST outcome. Walmart production write
  не выполнялся. После выпуска авторитетны exact
  focused Walmart command, отдельная
  integration command `scripts/__tests__/walmart-new-sku-engine.integration.test.ts`
  и `npm run test:product-truth-certification`, записанные в immutable certificate на
  тех же frozen bytes. Актуальный persistent release выдан в
  `release-artifacts/walmart-new-sku-pilot-engine-2026-07-23-v23`: engine SHA
  `94ec292870b398aa08385c6d951454b790aaa7db662d6aa796337f7026340f5f`, manifest SHA
  `7c7baa79bb965c21cc8f9d7b1fb631d0a6f153719193b172c3d468ac31656a5c`, certificate SHA
  `cc5603d8d56421c151b92b5a6726c1cf10c3dfa52732614763cde6dc6fec9242`.
  Walmart unit/security exit `0`, fake-live integration `3/3` и Product Truth `429/429`;
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
  pack-of-3 `$40.36` / profit `$12.11`; margin обоих = `30%`. Preview artifact:
  `ss-control-center/data/walmart-new-sku-engine/previews/20260723T132637Z-ritz-cheese-pack2-pack3-owner-preview.json`,
  SHA `a84a84d6786a249c4f40760fbc5090f60edc88320ae065aa8b2dadda7559596d`.
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
  Business-data backfill не выполнен, authoritative Phase 1 manifest v3 отсутствует,
  consumer cutover на единый Product Truth read-contract = **0 из 4**. Legacy
  `DonorProduct`/`SkuComponent`/`SkuCost`/views не доказывают readiness.
  Свежий source-readiness audit сохранил sanitized production snapshots. Read-only
  live verification 2026-07-23 доказала: Amazon store1/store3 участвуют в US
  marketplace; store4 не
  имеет credentials; store5 получает LWA token, но больше не имеет US marketplace
  participation; store2 получает LWA token, но Sellers API возвращает HTTP 403.
  Уже существующие свежие `GET_MERCHANT_LISTINGS_ALL_DATA` reports для store1,
  store3 и store5 скачаны read-only без report-create: соответственно 1563, 514 и
  0 строк; exact bytes запечатаны SHA-256. Поэтому store2/store4 остаются
  `UNRESOLVED` до owner connectivity disposition, store5 требует явного exclusion
  как deactivated/no-US-participation, а для Walmart store1 всё ещё нужен свежий
  owner-authorized ITEM v6. Новый bounded GET-only Walmart probe (1 OAuth + 1 GET,
  zero retry) полностью покрыл последние 24 часа и увидел только ITEM v2; API-visible
  v6 в этом окне нет. Отчёты и census нельзя подменять mutable listing mirrors.
  Внешние listing/DB writes = 0.
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
Production/live canary/mass run остаются `NO-GO`.

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
- 🟢 **Frozen one-SKU compiler/release v4 (2026-07-25)** — owner-side compiler
  строит data-only execution package только из SHA-bound review request, активного
  shared Product Truth binding и свежих exact Walmart item/spec bytes. Fresh
  capture ограничен OAuth `1` + item GET `1` + Get Spec POST `1`; retry, redirect,
  model/DB/content writes = `0`. Clean-checkout release ID
  `cb9d4f2b0a216e2c6cc2d9c7239bafab7867dc2bd37af3eed42d51b5a9138ae2`,
  manifest SHA
  `208c4cee282b7ff2d3aaebfb594946f081c8b4d31e3f883a46917670f832ea2c`;
  109/109 declared tests, targeted ESLint и diff-check PASS. Frozen operator
  doctor и owner-package doctor = `READY`; release readiness не разрешает write.
  V4 удаляет внешний arbitrary Product Truth binding: после exact confirmation
  compiler выводит non-reusable one-SKU truth artifact прямо из SHA-bound review,
  связывает его с Ed25519 sequence/permit, не требует price/COGS и не активирует
  shared catalog/mass scope. Реальный `FaisalX-1183` package ещё не выпущен:
  следующий gate — exact owner confirmation, затем свежий read-only package и
  отдельное owner confirmation перед единственным execute.
  Exact v3 compilation request file SHA `6813237a…5c00d`, body SHA
  `dbedeb76…ad52`; independent verifier подтвердил description/bullets-only diff
  и unchanged image bytes. Fresh production point-read
  `FaisalX-1183-source-control-20260725-v2` = `SOURCE_REQUIRED`:
  `LISTING_SCOPE_NOT_REGISTERED`, `CURRENT_SCOPED_SKU_COST_MISSING`,
  `FOUND_0` components; Product Truth reads `1`, Walmart reads/writes,
  model и DB writes `0`.
- 🟢 **One-SKU remediation + Qualification closed loop (2026-07-22)** — локальные
  фазы 0–5 закрыты: real source-aware BAD → exact surgical repair → propagation
  `RECHECK_NO_WRITE` → fresh buyer reread → Qualification PASS; следующий SKU до
  PASS заблокирован. Combined remediation suite **101/101 PASS**; cross-process
  custody/inventory lock, frozen data-only dependency factory, native one-shot
  zero-retry/no-refresh transport, bounded operator CLI и external clean-checkout
  verifier-wrapper закрыты. Production caller больше не может
  подменить payload/verifier/ledger/custody/transport. External effects = 0
  network/model/DB/Walmart writes. Combined suite **109/109 PASS** в рабочей
  проекции и clean checkout. Исторический release v2 `0d21ffcd…246d`, manifest
  `387d4093…7c74`, superseded release v3 `b11f4cca…243a`, current production
  release v4 `cb9d4f2b…38ae2`, manifest `208c4cee…ea2c`; wrapper `doctor` =
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
