# Walmart Listing Integrity Platform

> **Owner decision, 2026-07-19:** текущая работа должна стать постоянной частью
> Command Center, а не одноразовым скриптом для Claude Code. Пользовательская
> поверхность — отдельная вкладка **Listing Integrity** внутри `/walmart-growth`.
> Каноническая товарная правда остаётся в [[product-catalog-architecture]].

## Цель

Для каждого активного Walmart SKU доказать, что фактически отгружаемый товар,
вариант, размер, состав набора и количество согласованы с title, description,
bullets, attributes, MAIN и каждым gallery image. После изменения отдельно
подтвердить buyer-facing результат, published status и индексацию. Главная
бизнес-метрика — отсутствие возвратов из-за неверного ожидания товара или count.

## Где живёт продукт

- UI: новая вкладка **Walmart Growth → Listing Integrity**.
- Backend: постоянный resumable worker/state machine, а не длинный HTTP-запрос и
  не один монолитный CLI-файл.
- Product facts: только общий versioned Product Truth read-contract. Отдельный
  Walmart donor/catalog truth запрещён.
- Immutable evidence: content-addressed artifacts и append-only attempt history;
  UI показывает их, но не становится источником истины.
- Claude Code: release/emergency operator готового frozen suite. Он не является
  ежедневным scheduler, не переписывает движок и не принимает решения за owner gate.

## Канонический цикл одного SKU

`INGESTED → AUDITED → ISSUE_PROVEN → REPAIR_PLANNED → OWNER_APPROVED →`
`APPLY_REQUESTING → APPLIED → PROPAGATING → LIVE_REREAD → QUALIFIED`

Терминальные исходы:

- `PASS` — весь listing surface совпал с Product Truth и exact repair target;
- `RECHECK_NO_WRITE` — Walmart ещё распространяет изменение, повторный write запрещён;
- `OWNER_REVIEW_REPLAN` — исправление не прошло независимую проверку;
- `BLOCKED_SOURCE` — Product Truth или authoritative live evidence недостаточны;
- `MANUAL_REVIEW` — результат write неоднозначен, автоматический retry запрещён.

Следующий SKU нельзя применять до доказанного `PASS` текущего SKU в данной
контролируемой последовательности.

## Слои движка

1. **Scope and source intake** — authoritative published population, Product Truth,
   buyer PDP/surface и реальные bytes всех изображений.
2. **Deterministic audit** — identity, variant, pack/count, text, attributes,
   source provenance, published/indexing и структурные image checks.
3. **Visual audit** — bounded vision worker проверяет продукт, вариант, count,
   MAIN и gallery. Он не определяет Product Truth и не разрешает write.
4. **Repair planner** — строит exact full-surface target и before/after diff только
   из подтверждённых фактов и approved image assets. Full target — эталон для
   post-read QA, а не требование повторно отправить все поля в Walmart.
5. **One-SKU writer** — из full target выводит минимальную surgical mutation только
   для разрешённых changed fields, сохраняя exact header, identifiers, productType и
   актуальную Walmart spec. Отдельный owner-signed permit связывает именно этот
   payload; durable one-shot ledger допускает ровно один `MP_MAINTENANCE`, сохраняет
   raw response/feed-status evidence и запрещает автоматический retry неизвестного
   результата. Audit `attribute_claims` нельзя напрямую использовать как write schema.
6. **Qualification Officer** — свежий независимый live reread, source-aware rebuild
   и полный повторный audit. Cached/self-hashed PASS не является authority.
7. **Queue and scheduler** — resumable shards, budgets, stop conditions, canary и
   waves; массовый запуск разрешается только отдельным owner gate.

## Граница LLM/vision

Оркестрация, Product Truth matching, количество, state transitions, permits,
writes, feed polling и verification — детерминированный код. Vision-модель нужна
только там, где по bytes необходимо понять, изображён ли точный продукт/вариант и
сколько единиц видно. Если у товара есть approved exact reference images и
достаточный deterministic fingerprint, этот вызов можно пропустить. Любой model
result остаётся evidence, а не единоличным разрешением на публикацию.

## Что показывает вкладка

- source readiness, coverage и свежесть;
- progress по состояниям и очередь, приоритизированная продажами/возвратами;
- per-SKU Product Truth, current live surface и все изображения рядом;
- точная причина ошибки и confidence/evidence;
- proposed full-surface diff;
- owner approval одного SKU или запечатанной волны;
- feed/propagation/live-verification status;
- PASS/rework/manual-review, published/indexing и audit trail;
- vision call budget, фактические calls и стоимость/лимиты.

## Текущий честный статус

Точный текущий snapshot и постоянный owner-visible phase checklist:
[[walmart-listing-integrity-checkpoint-2026-07-21]]. Исторический one-SKU
snapshot: [[walmart-listing-integrity-checkpoint-2026-07-19]].

- Локальные фазы 0–5 закрыты: полный offline
  `detect → plan → repair → fresh reread → qualify` доказан, combined suite
  **109/109 PASS** в рабочей проекции и чистом checkout. Cross-process custody
  lock, fixed data-only production
  dependency factory, native one-shot zero-retry transport и bounded operator
  `doctor/plan/execute/resume/status/report` реализованы. Clean-checkout release
  `0d21ffcd…246d` запечатан manifest SHA `387d4093…7c74` и запускается
  только через verifier-wrapper.
- Frozen read-only audit/observer и visual worker существуют, но полный каталог
  ещё не просканирован на свежих authoritative sources.
- Legacy `src/lib/walmart/multipack/remediate.ts` умеет собирать и отправлять
  `MP_MAINTENANCE`, но не является production Listing Integrity writer: в нём нет
  нового one-SKU owner permit, durable exact consumption/evidence boundary и
  безопасной unknown-outcome политики; batch retry несовместим с этим контрактом.
- Production closure v2 пройден, verifier/writer pins и attestations готовы. Один
  dedicated public trust root enrolled; password-free private key хранится локально
  вне repository и скрыт за обычным точным подтверждением diff. Frozen `doctor`
  возвращает `READY`, но это не write-authority. Exact eight Product Truth migrations
  уже активированы в production Turso и независимо сертифицированы. Следующий blocker
  — business-data truth для конкретного scope: point-read через read-contract `3.2.0`
  для `walmart:1:FaisalX-1183` возвращает `LISTING_SCOPE_NOT_REGISTERED` и
  `CURRENT_SCOPED_SKU_COST_MISSING`. Локальная догадка/ручной competing truth не
  используется. Read-only donor audit дополнительно доказал старую ошибочную привязку
  этого SKU к Chessmen Butter Cookies; точный buns candidate остаётся
  `legacy_unverified`. Свежие существующие Amazon reports для store1/store3/store5
  уже сохранены без report-create, а authoritative Phase 1 manifest ждёт owner
  disposition по store2/store4/store5 и свежий Walmart ITEM v6.
- Малый fresh read-only тест начат на двух реальных SKU. `FaisalX-1130` выявил
  ложный `BAD` на широком атрибуте `Flavor=Grain`; правило исправлено так, что hard
  mismatch выдаётся только при явном запрещённом Product Truth marker. После этого
  `FaisalX-1183` дал настоящий quantity-confusion defect: title = `Pack of 6`, а
  buyer MAIN показывает одну упаковку. Реальный контроль `before BAD → proposed
  MAIN PASS` закреплён regression-тестом. Расширенный detector/exact-resolution/
  public-PDP suite = **37/37 PASS**,
  closed-loop repair suite = **109/109 PASS**, Walmart listing writes = `0`.
- Первая read-only вкладка **Walmart Growth → Listing Integrity** реализована в
  shadow-режиме. Она читает frozen fresh-control evidence, показывает текущую MAIN
  и gallery, предложенную MAIN, exact diff, Qualification chain и честно блокирует
  canary/mass actions. Loader 7/7, component server-render 1/1, targeted TypeScript
  и ESLint PASS; экран читает SHA-256-bound verification evidence, а не
  захардкоженные счётчики. Он также показывает SHA-bound canonical Product Truth
  readiness: schema 8/8 активирована, но exact scope `walmart:1:FaisalX-1183`
  заблокирован отсутствующими listing scope/current scoped cost. Execution package,
  Walmart write и mass run остаются закрыты до canonical business-data readiness.
  Эти три authority оси независимы; self-asserted `READY` без production
  certification отвергается fail-closed. Постоянный
  scheduler/API/state store ещё не подключены, поэтому
  live canary, unattended и mass repair остаются `NO-GO`.
- Для `FaisalX-1183` exact current MAIN и две gallery-картинки перенесены из
  временного capture в content-addressed custody. SHA-bound `canary-preview.json`
  фиксирует только один допустимый diff: MAIN `1 → 6`; title, description,
  bullet points, attributes, price, inventory и gallery неизменны. Loader
  побайтово перепроверяет все четыре asset SHA перед показом экрана. Свежая
  signed v2 visual attestation всё ещё обязательна перед live apply. Exact
  two-call shadow plan и offline verifier подготовлены: verifier заново связывает
  request bytes, prompt, image SHA, call key, worker build/ledger, Ed25519 receipt,
  blind observation и deterministic Product Truth decision; malformed response
  fail-closed отвергнут до создания attestation. Два разрешённых subscription-
  вызова выполнены без retry/fallback: current MAIN независимо воспроизведён как
  `BAD` (1 вместо 6), exact target MAIN = `PASS`, gallery `BAD = 0`, два
  lifestyle/nutrition slot остаются на owner review. Fresh replay выявил и закрыл
  три ложных отказа comparator: product/variant field drift, leading inner-count
  literal и serving-size-vs-package-size на Nutrition Facts. Comparator v5 =
  **38/38**, worker security **17/17**, observation **17/17**, shadow loader
  **7/7**, UI **1/1**, targeted TypeScript/ESLint и diff-check PASS. Signed bundle
  сохранён побайтово; UI перепроверяет все file SHA и обе Ed25519 receipts и
  fail-closed отвергает tamper. External effects: Claude subscription calls `2`,
  attempts `2`, retries/fallbacks/paid API/OpenAI/Walmart/DB writes `0`. Временные
  remote `/tmp`-файлы удалены после локальной SHA-bound custody.

## Порядок доведения до постоянного продукта

1. ~~Закрыть Phase 5: cross-process custody, frozen dependencies/native transport,
   operator commands и clean-checkout sealed release.~~ Закрыто 2026-07-22.
2. ~~Выполнить первые малые read-only проверки на свежих exact-SKU/Product Truth/
   buyer данных и доказать хотя бы один реальный defect case без writes.~~ Закрыто
   на `FaisalX-1130` и `FaisalX-1183`; второй SKU дал настоящий MAIN 1-vs-6 defect.
   До live canary остаётся sealed source-aware прогон текущих bytes всех gallery.
3. Только по отдельным owner permits провести 1–3 полных canary:
   detect → repair → propagation → live reread → PASS; следующий SKU не начинать
   до PASS текущего.
4. **[SHADOW UI COMPLETE / RUNTIME PENDING]** Подключить тот же backend к вкладке
   Listing Integrity и resumable queue. Read-only evidence view уже реализован;
   постоянные scheduler/API/state store остаются. Вкладка обязательно показывает
   фактическую галерею `До → После`, text/attribute diff, buyer reread,
   Qualification и published/indexing status каждого canary.
5. Только после просмотра владельцем первых фактических `До → После` и отдельного
   подтверждения открыть контролируемые waves; Claude вывести из ежедневного runtime.

Точный контракт и stop conditions следующего этапа:
[[walmart-listing-integrity-phase6-pilot]].

## Связи

- [[product-catalog-architecture]] — OWNER CANON товарной идентичности.
- [[walmart-listing-integrity-operator-runbook]] — единственный workflow Claude Code.
- [[listing-quality-stack]] — общий Listing Quality/Qualification слой.
- [[walmart-growth-roadmap]] — продуктовая поверхность Walmart Growth.
- [[donor-catalog-execution-roadmap]] — gates общего Product Truth Platform.
