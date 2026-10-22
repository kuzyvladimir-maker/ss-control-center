# Walmart Listing Integrity — основной план до конечной цели

Статус: ACTIVE  
Владелец цели: Vladimir  
Исполнитель разработки и квалификации: Codex  
Оператор замороженного движка после пилота: Command Center / Claude Code  
Последняя сверка: 2026-08-01

## Главная цель

Исправить Walmart-каталог так, чтобы фактически продаваемый товар, вариант, размер,
состав набора и количество полностью совпадали с title, description, bullet points,
атрибутами, MAIN и каждым дополнительным изображением. Карточка должна быть одним
правдивым целым, не создавать ложных ожиданий и возвратов, сохранять публикацию и
индексацию.

Готовность всей цели нельзя объявить по одному тесту, одному изображению или одному
SKU. Нужен доказанный замкнутый цикл:

`найти → доказать → предложить исправление → проверить до публикации → исправить → дождаться propagation → перечитать buyer PDP → Qualification → показать владельцу`.

## Постоянные ограничения

- Один live canary до любых волн.
- До точной команды владельца Walmart content write запрещён.
- Для первого canary допустим только заранее показанный exact diff.
- Цена, inventory, delisting и любые другие SKU не затрагиваются.
- Ошибка или неопределённость дают `REVIEW/FAIL`, а не автоматический PASS.
- Следующий SKU не начинается, пока предыдущий не получил фактический Qualification PASS.
- Mass run запрещён до успешного one-SKU canary и малого пилота 2–3 SKU.
- Amazon не является blocker для первого Walmart canary. Общий Product Truth остаётся
  единым, но точная истина canary строится из Walmart-side authoritative evidence и
  точного товарного варианта; параллельный каталог не создаётся.

## Фазы и фактическое состояние

### [x] Phase 0 — цель, границы и stop conditions

Зафиксированы главная цель, один-canary-first, запрет массовых изменений, обязательная
Qualification и требование фактической галереи `ДО → ПОСЛЕ`.

### [x] Phase 1 — detector, repair engine и Qualification

Собран closed-loop engine. Проверены source-aware detection, exact surgical repair,
propagation без повторной записи, fresh buyer reread и независимая Qualification.
Основной suite: 109/109 PASS; detector/exact-resolution/PDP: 37/37 PASS.

### [x] Phase 2 — frozen release и Command Center

Production release заморожен и запускается через verifier-wrapper. В Command Center
добавлена read-only вкладка `Walmart Growth → Listing Integrity`. Она показывает
текущие изображения, proposed repair, exact diff и Qualification chain, но не даёт
скрытого mass apply.

### [x] Phase 3 — исторический one-SKU defect и визуальное одобрение

SKU `FaisalX-1183`:

- title: `Pack of 6`;
- историческая MAIN от 2026-07-22: одна упаковка;
- proposed MAIN: шесть точных упаковок;
- gallery проверена;
- владелец визуально одобрил proposed MAIN и gallery;
- свежая live MAIN от 2026-07-25 уже показывает шесть упаковок и перцептивно
  совпадает с ранее одобренной proposed MAIN;
- receipt замороженного writer для происхождения этого live-изменения отсутствует,
  поэтому оно не объявляется выполненным нашим движком;
- свежий reread выявил отдельный дефект: title/изображения говорят `hot dog buns`,
  а bullet 3 — `hamburger buns`.

Legacy donor audit дополнительно доказал неправильную привязку к Chessmen Butter
Cookies. Этот donor запрещено переносить в canonical Product Truth.

### [x] Phase 4 — единый процесс одного SKU и свежий read-only pilot

Задача фазы — не перепись всего каталога и не ожидание массового ITEM report. Один
SKU должен пройти одной командой:

`Product Truth → exact seller/catalog identity → buyer PDP → MAIN + вся gallery →
blind observation → deterministic audit → SOURCE_REQUIRED/BAD/REVIEW/CLEAN_CANDIDATE`.

ITEM v6 может быть дополнительным census/source artifact, но не является обязательным
предусловием последовательной проверки одного exact SKU.

Уже сделано:

- Product Truth schema migrations 8/8 применены и сертифицированы;
- реализован чистый Product Truth → one-SKU detector bridge без title fallback и без
  возможности превратить multipack donor в multipack-of-multipacks;
- найден и исправлен пропущенный runtime import, который прежние projection-only
  тесты не исполняли;
- исправлено разделение ролей: current buyer title теперь проверяется против Product
  Truth, а не обязан заранее буквально совпадать с donor title;
- добавлена единая локальная команда
  `npm run walmart:listing-integrity -- doctor|capture|inspect|observe|diagnose|review`;
  `review` связывает exact Product Truth candidate, свежий diagnosis, buyer PDP,
  buyer snapshot, все image bytes и donor audit, затем выполняет полный
  Qualification precheck и выпускает immutable review certificate без write-authority;
  она читает exact evidence одного SKU, побайтово проверяет все изображения и выдаёт
  один sealed результат с SHA-256;
- добавлены `capture|inspect`: `capture` останавливается до Walmart при отсутствии
  canonical Product Truth, а `inspect` может безопасно собрать live self-consistency
  evidence для source-blocked SKU, не объявляя его Product Truth и не разрешая repair;
- schema gate теперь сначала доказывает доступность БД и больше не выдаёт сетевой/DNS
  отказ за «отсутствует вся Product Truth schema»;
- strict buyer parser принимает exact отображаемый Walmart item даже если внутренний
  `primaryUsItemId` отличается или отсутствует; действительно чужой товар
  по-прежнему fail-closed отклоняется;
- доказаны `BAD` для MAIN `1 вместо 6`, reject изменённых image bytes, reject другого
  SKU и честный `CLEAN_CANDIDATE`, который ещё не называется PASS до source-aware
  Qualification;
- unknown outcome после передачи запроса vision-worker теперь обязательно сохраняет
  partial evidence, stable exact call key и `OBSERVATION_UNKNOWN_OUTCOME`; retry
  запрещён;
- неизвестный исход для `Athar-1591` сверен с remote reservation ledger: запрос
  был зарезервирован, result не сохранён, consumption неизвестен, повтор запрещён;
- выполнены пять успешных свежих read-only наблюдений:
  `FaisalX-1183`, `FaisalX-1181`, `FaisalX-1130`, `FaisalX-1208`, `Comm-05`;
- `FaisalX-1183` и `FaisalX-1181` имеют явное противоречие
  `hot dog buns ↔ hamburger buns`; три остальных не имеют найденного внутреннего
  противоречия, но честно остаются `SOURCE_REQUIRED`, а не PASS;
- comparator v5 на 24 immutable размеченных примерах дал 24/24:
  12/12 известных BAD найдены, 12/12 исправленных PASS, false PASS/BAD = 0;
- актуальная проверка: one-SKU suite 21/21, remediation/Qualification 102/102,
  verifier-wrapper/operator 8/8 и targeted ESLint PASS;
- owner-gallery с 17 реальными изображениями запечатана SHA-256
  `61ee94ab2e510206b088ae8e228c3a0b3dfa85700bb22eb3d0591ed68af7786e`;
  в рамках фазы Walmart writes = 0.

Exit criteria закрыты:

- команда самостоятельно получает свежие read-only exact-SKU/Product Truth/buyer
  inputs либо возвращает `SOURCE_REQUIRED`, не останавливая всю очередь;
- limited image-worker adapter выдаёт signed blind observations без знания Product
  Truth и без Walmart write path;
- смешанная калибровочная выборка содержит известный BAD, визуально корректный SKU,
  wrong-product gallery и source-blocked SKU;
- по каждому SKU сохранён sealed отчёт и точный следующий шаг; ни один REVIEW не
  повышается до PASS;
- Amazon scope и полный ITEM v6 census не участвуют в этом exit criterion.

### [x] Phase 5 — финальный one-SKU apply package и owner review

Закрыто на frozen v39: exact review, one-SKU package, Ed25519 permit и pre-write
Qualification доказаны и применены для последовательных canary. Текущий
сертифицированный release `b4e0cf03…d3d8fb`, manifest `8b31432b…acd2`,
clean suite `196/196 PASS`.

> Детальные пункты ниже сохраняют исторический v4 checkpoint разработки. Его
> тогдашние `ещё не выпущен/не подтверждено` не описывают текущее состояние v39.

Сначала закрыть exact Product Truth для одного найденного дефекта и собрать immutable
package минимальной хирургической коррекции. Исторический MAIN-only package
`FaisalX-1183` нельзя отправлять повторно: свежая live MAIN уже показывает шесть
упаковок. Перед отправкой показать владельцу:

- текущую полную карточку;
- предлагаемое исправление;
- фактический title, текст, pack count, MAIN и всю gallery;
- список каждого изменяемого поля;
- явный список неизменяемых полей;
- rollback asset;
- свежую visual attestation и Qualification precheck.

Текущий прогресс:

- exact single-unit candidate доказан существующим общим donor:
  Pepperidge Farm Bakery Classics Top Sliced Butter Hot Dog Buns,
  `14 oz / 8 ct`, UPC `014100050162`;
- источник Chessmen Butter Cookies подтверждён как wrong-product и запрещён;
- свежие manufacturer, Target exact single-unit, Walmart first-party base item и
  live Pack of 6 согласуются по identity/variant;
- минимальный diff затрагивает только `description` и `bullets`: в обоих явно
  появляется `Pack of 6`, шесть пакетов по восемь булочек; ошибочный
  `hamburger buns` удаляется;
- `title`, attributes, MAIN, gallery, price, inventory, identifiers и listing status
  остаются неизменными;
- чистый Qualification precheck = PASS; он не разрешает write;
- штатная one-SKU команда `review` побайтово связала proposal с exact diagnosis,
  buyer snapshot/PDP, всеми тремя live image assets и donor audit; regression test
  доказывает, что сертификат остаётся `OWNER_REVIEW_REQUIRED` и имеет
  network/model/DB/Walmart writes = 0;
- owner-review package SHA-256:
  JSON `ce1b31e0…cb72b`, HTML `ad6af7ba…a0206`;
- read-only review certification SHA-256:
  file `10a9fafb…e527`, sealed body `12aff1f6…14bc0`.
- актуальный certified review подключён к
  `Walmart Growth → Listing Integrity`: сверху показаны exact Product Truth,
  текущие MAIN/gallery без изменений, полный текст `ДО → ПРЕДЛАГАЕМОЕ`,
  неизменяемые поля и точная owner-команда; исторический `MAIN 1 → 6`
  свёрнут и явно помечен как неактуальный payload;
- UI читает review только через SHA-bound current-review index, заново проверяет
  certification/diagnosis/snapshot/PDP/donor bindings и локальные image bytes;
  tamper test fail-closed, loader/UI 9/9, TypeScript и ESLint PASS.
- owner-side compiler теперь детерминированно строит из exact review request,
  активного Product Truth binding и свежих Walmart material bytes только
  data-only one-SKU execution package. Compiler отдельно доказывает unchanged
  images, exact seller/spec binding, surgical payload и permit sequence; на этой
  стадии network/model/DB/Walmart writes = 0;
- fresh material capture ограничен ровно тремя попытками: OAuth `1`, exact item
  GET `1`, Get Spec POST `1`; redirect/retry/content write = `0`, неизвестный
  сетевой исход fail-closed;
- clean-checkout release v4 заморожен:
  release ID `cb9d4f2b0a216e2c6cc2d9c7239bafab7867dc2bd37af3eed42d51b5a9138ae2`,
  manifest SHA `208c4cee282b7ff2d3aaebfb594946f081c8b4d31e3f883a46917670f832ea2c`;
  109/109 declared tests, targeted ESLint и diff-check PASS; operator doctor и
  owner-package doctor = `READY`;
- v4 устраняет внешний «магический» Product Truth binding: после exact owner
  confirmation compiler сам детерминированно строит из SHA-bound review
  non-reusable one-SKU truth artifact и связывает его с Ed25519 sequence/permit.
  Он не требует price/COGS, не активирует shared catalog, не пригоден для mass run
  и сам по себе не разрешает Walmart write;
- frozen release readiness не является write-authority. Реальный execution
  package для `FaisalX-1183` ещё не выпущен: exact owner confirmation не получено.
- exact v3 compilation request создан и независимо проверен:
  `FaisalX-1183-repair-compilation-request-20260725-v3.json`, file SHA
  `6813237a2a9910b0e8ada11f9b3ad7498649a4a8129ea21933b8f1093915c00d`,
  body SHA
  `dbedeb76af540f9300e096715167943cf59b3eeaab2225827ee5b67ba8aaad52`;
  verifier подтвердил SKU/item/UPC, changed fields только
  `description|bullets` и `unchanged_image_bytes=true`;
- свежий production Product Truth point-read сохранён в
  `FaisalX-1183-source-control-20260725-v2`: статус `SOURCE_REQUIRED`, blockers
  `LISTING_SCOPE_NOT_REGISTERED`, `CURRENT_SCOPED_SKU_COST_MISSING` и
  `SAME_PRODUCT_PIPELINE_REQUIRES_ONE_COMPONENT:FOUND_0`; execution accounting:
  Product Truth reads `1`, Walmart/model/DB writes и Walmart reads `0`. Это
  сохраняется как честный shared-catalog backlog, но v4 больше не делает полный
  Phase 1 census prerequisite первого owner-reviewed canary.

Exit criteria закрыты: package `READY`, owner видел полный diff; write-authority
выдавалась отдельно и только на один exact SKU.

### [x] Phase 6 — один live canary

Только после точной команды владельца:

> Подтверждаю SKU `<exact SKU>` и показанный exact diff `<hash>`

Выполнить один заранее показанный surgical Walmart content write. Maximum SKU
count = 1; retries = 0; price, inventory и delisting = 0. Никакие поля вне
утверждённого exact diff не меняются. Для `FaisalX-1228` выполнен ровно один
POST, feed `18C7B0B1…AX8BBgA` terminal `SUCCEEDED`, retry/reapply `0`.

### [x] Phase 7 — propagation и независимая Qualification

После submission:

1. сохранить Walmart response и feed/status evidence;
2. дождаться propagation;
3. заново получить buyer-facing PDP;
4. повторно проверить товар, вариант, количество, title, description, bullets,
   attributes, MAIN и всю gallery;
5. проверить published status и доступные признаки индексации.

При `FAIL/REVIEW` следующий SKU запрещён. Анализируется причина, выполняется только
точечная корректировка или rollback, затем весь reread/Qualification повторяется.
`FaisalX-1228` получил fresh Qualification `PASS` по всем 14 facets; publication,
indexing, title, images, attributes, price и inventory сохранены.

### [x] Phase 8 — фактическая галерея владельцу

Показать владельцу не proposal, а фактический результат Walmart:

- `ДО`;
- утверждённое предложение;
- `ПОСЛЕ` из свежего buyer PDP;
- Qualification verdict;
- статус публикации и индексации;
- точный журнал изменённых/неизменённых полей.

Фактическая галерея `FaisalX-1228` прошла `23/23`; HTML SHA
`962cb411…4f2df`, verification body SHA `b0ecc010…8826b`.

### [ ] Phase 9 — малый контролируемый пул (IN PROGRESS)

Выбрать 2–3 разных класса дефектов и для каждого отдельно повторить фазы
`detect → repair → reread → Qualification → owner gallery`. Никаких групповых writes
до доказанного PASS предыдущего SKU. Successor pool
`controlled-pool-185264f5a6a7cb304e6e` содержит 10 SKU и 328 repair-ready
кандидатов. `RizwanX-2168` не является repair-ready: fresh diagnosis честно
перевёл его в `SOURCE_REQUIRED`, потому что текущий Product Truth ошибочно принял
nutrient claim `20g protein` за package size, тогда как exact package показывает
`2.5 oz / 71 g`; такой truth запрещено использовать для repair. Текущий exact
SKU в этой последовательности — `FaisalX-1144`. Walmart уже принял один
description/bullets/MAIN feed; retry `0`, feed terminal `SUCCEEDED`, а fresh
buyer reread остаётся `PENDING_PROPAGATION` только из-за старой MAIN. Следующий
допустимый action — только Qualification reread без write. Параллельный
`FaisalX-1434` также имел ровно один принятый text-only feed. Теперь он закрыт
fresh frozen Qualification `PASS` и фактической галереей `LIVE_SURFACE_PASS`:
все `23/23` проверки истинны. Первый gallery attempt упал только на локальном
reporting-дефекте outer quantity; recovery использовал тот же immutable package,
feed, Qualification receipt и live capture, выполнив `0` новых Walmart read/write.
Shared register и V50 atomic admission запрещают новый POST, пока
`FaisalX-1144` не получит terminal Qualification/disposition.

Exit criteria: 100% pilot SKU имеют фактический PASS, отсутствуют wrong-product image
mixing, quantity confusion, collateral field changes и потеря публикации/индексации.

### [ ] Phase 10 — полный read-only аудит Walmart-каталога

Только после пилота просканировать весь затронутый каталог. Для каждого SKU проверить:

- product identity и variant;
- recipe/pack count;
- title, description, bullets и attributes;
- MAIN и каждое gallery image;
- несоответствия между изображениями;
- publication/indexation risk.

Результат — не список автоматических writes, а классифицированный backlog:
`PASS`, `REPAIRABLE`, `REVIEW`, `BLOCKED_SOURCE`, `DO_NOT_TOUCH` с evidence и confidence.

### [ ] Phase 11 — контролируемые repair waves

Исправлять только подтверждённые `REPAIRABLE` SKU небольшими owner-approved волнами.
После каждой волны обязательны propagation reread, Qualification, отчёт о публикации,
ошибках и возвратных рисках. При ухудшении stop condition закрывает следующую волну.

### [ ] Phase 12 — постоянный модуль

Живой implementation checkpoint: [[walmart-listing-integrity-codex-progress-2026-08-01]].

После доказанных canary/pilot/waves завершить постоянный workflow в Command Center:

- read-only мониторинг по расписанию;
- очередь дефектов и evidence gallery;
- proposal/approval separation;
- one-SKU и wave execution packages;
- обязательная Qualification после apply;
- immutable history и rollback evidence;
- отсутствие автономных массовых Walmart writes без owner policy.

Текущий прогресс Phase 12: локальный Stage A control contract и persistent schema
готовы. Pure scheduler/state machine и SQL независимо запрещают обгон SKU, второй
live apply, retry/replay неизвестного POST и переход без package/permit; terminal
история и artifacts append-only. Trusted operator admission проверяет exact frozen
receipt, package/permit/feed/fresh Qualification и отсекает runtime `OFF`/`READ_ONLY`.
Новая transactional persistence boundary атомарно записывает CAS-переход SKU,
content-addressed evidence и hash-chain event; stale replay не создаёт дубликаты.
GET-only control status API дополнительно валидирует sealed
DB rows, показывает active SKU/next decision, честно различает
`NOT_INSTALLED`/`INSTALLED` и запрещает mutation methods; общий focused итог
`71/71`, TypeScript/ESLint и diff-check PASS. Verified status-card подключена к Walmart Growth
→ Listing Integrity. Готовы process-local runtime authority и clean pinned
resumable worker: простая строка `ONE_SKU` не даёт authority, а уже существующий
Ed25519 one-SKU permit заново проверяется и связывается с exact listing/state
revision/release; отдельный пользовательский пароль или второй owner approval не
создаётся. Shell-free adapter допускает только exact V50 wrapper suffix для
`execute|resume|qualify`, сверяет release/manifest/global-admission/package и
confirmation, не имеет retry/replay и атомарно передаёт receipt в CAS state +
evidence + hash-chain transaction. Additive Stage A migration отдельно проверена
в production как `INSTALLED`: exact tables, indexes, triggers и Prisma checksum
совпадают; runtime policy остаётся hardcoded `OFF`. Broad Stage B switch не
создаётся: write-authority возникает transient только из exact one-SKU Ed25519 permit.

SHA-pinned seed boundary создаёт только `DEFAULT_OFF` очередь и fail closed при
пересечении с active predecessor, `--all`, retry/replay или неполном scope.
Read-only worker по одному SKU выполняет manifest-bound fresh capture, signed blind
image observe и diagnosis. `CLEAN_CANDIDATE` больше не переводится напрямую в
`AUDITED_PASS`: сначала отдельный source-aware rebuild проверяет raw seller/catalog/
PDP, Product Truth manifest, exact image bytes, observer plan и signed receipts,
затем создаёт no-write Qualification receipt и factual gallery `ДО = ПОСЛЕ`.
Только после этого атомарно пишется `AUDITED_PASS`; `BAD` переходит в
`ISSUE_PROVEN`, source/evidence gaps — в quarantine. Unknown observer outcome не replay. Permanent
`ISSUE_PROVEN` lane теперь детерминированно выбирает exact
`DESCRIPTION_BULLETS[_MAIN[_GALLERY]]` route, выполняет pre-Qualification,
собирает one-SKU package/permit и передаёт его только frozen wrapper. После
Qualification `PASS` exact receipt и fresh capture сохраняются, factual gallery
обязательна, а локальный gallery failure восстанавливается без повторного POST.
Полный локальный production regression = `258/258 PASS`; full-project TypeScript,
targeted ESLint и diff-check PASS. Отдельный clean-snapshot supervisor release v2
дополнительно сертифицирован `294/294 PASS`, содержит 251 runtime-файл, проверяет
318-file inventory и отвергает byte tamper до запуска. Исправлен также неверный
asset root: diagnosis читает images относительно exact buyer snapshot directory.
Frozen supervisor v4 (`303/303`) сохраняет sealed reservation `FaisalX-1435`
другой Walmart-сессии и закрывает stale-population gap. На каждой новой pool
boundary он строит immutable census только из exact downloaded `ITEM_CATALOG`:
report/mirror row count и `downloadedAt/syncedAt` обязаны совпасть, report не старше
24 часов, snapshot не старше 15 минут. Первый authoritative denominator = `5235`
строк / `3877 PUBLISHED`; read-only pool v8 видит `66` Product Truth-ready и
`1726` source-required, исключает `1144/1435`, writes `0`. Static census от 28 июля
больше не является runtime input. Successor watcher под LaunchAgent ждёт оставшийся predecessor disposition,
затем продолжит строгую очередь. OS-level restart probe PASS: wrapper и worker
автоматически восстановлены после controlled termination, повторный status сохранил
zero-write predecessor wait. Следующий platform gap — controlled-pool/full-catalog
operation и итоговая отчётность.

Runtime-gap между параллельными вкладками закрыт отдельно от DB Stage A: frozen
V50 добавляет manifest-bound private global admission root. Перед единственным
writer POST создаётся атомарный claim exact SKU/package/permit/plan/release;
второй процесс не может получить admission. Claim не протухает автоматически,
а архивируется только после fresh `PASS` либо verified
`QUARANTINED_UNRESOLVED`. Clean checkout V50: release `729f5cc0…bdd6c`, manifest
`65f6fff8…53aff`, suite `203/203`, ESLint/diff-check PASS. `1434` уже закрыт
Qualification + gallery PASS; пока `1144` остаётся в propagation monitoring,
root удерживает импортированный active claim `1144`, и новый execute невозможен.

## Текущая точка

Активная фаза: **Phase 9 — малый контролируемый пул**.

- `FaisalX-1144`: один exact POST уже принят как feed
  `18C7B9727AC0538CA1F1E40C884D0BCD@AX8BBwA`; terminal `SUCCEEDED` получен в
  `2026-08-01T17:12:25Z`, item failures `0`, continuation writes `0`. Первый
  fresh Qualification в `17:13:08Z` = `PENDING_PROPAGATION`: description и
  bullets уже exact `PASS`, title/attributes/gallery/pack/publication также
  `PASS`, но buyer MAIN пока остаётся прежней wrong-product картинкой. Check 7
  independent reread в `18:44:20Z` подтвердил те же old MAIN bytes
  `54826f…fa82c` против target `7ed4b0…aff7`, dHash distance `28`; продолжение
  остаётся только fresh reread того же SKU без write, failure/quarantine не раньше
  `23:12:25Z`. Check 16 в `21:01:04Z` остаётся `PENDING_PROPAGATION`:
  единственный первичный blocker `main`, live SHA `54826f…fa82c`, target
  `7ed4b0…aff7`, dHash `28`; title/text/attributes/gallery/pack/product,
  publication и indexing PASS, continuation writes `0`.
- `FaisalX-1433`: параллельная сессия владеет exact text-only feed
  `18C7B9B47A6F57DC8A51646DCB4F45F1@AX8BBwA`; feed terminal `SUCCEEDED`.
  Fresh v49 exact-plan Qualification в `2026-08-01T17:38:15Z` = `PASS`: v49
  корректно учитывает перевод Walmart opaque `Count=2` в mapped count claim.
  Однако owner-signed text-only target сам сохраняет live attributes
  `Roasted chicken` / `Roasted`, а fresh Product Truth projection остаётся
  `SOURCE_REQUIRED`. Поэтому это scoped text-plan PASS, а не финальный
  full-listing integrity PASS; `1433` остаётся в отдельном full-surface backlog
  до authoritative Product Truth и нового attribute plan/permit.
- `FaisalX-1434`: один text-only POST принят в `17:40:00Z` как feed
  `18C7BF3254785F99B4AD7A9EFD72B632@AX8BBgA`; terminal feed `SUCCEEDED`, fresh
  Qualification в `19:11:10Z` = `PASS` по всем facets. Recovered factual gallery
  body SHA `19669f55…5661` = `23/23 PASS`; recovery Walmart reads/writes = `0`.
  Старый reporting error сохранён как evidence и не является listing failure.
- Следующий SKU не начинается, пока оба активных predecessor feed не получили terminal
  disposition и fresh buyer readback; `FaisalX-1144` должен завершиться
  Qualification `PASS` либо документированным terminal quarantine.
- Постоянная вкладка уже читает verified pool и final galleries. Cross-chat
  runtime admission gap закрыт V50; production Stage A schema, persistent state,
  frozen worker, exact-permit authority, seed boundary, read-only diagnosis worker,
  exact repair-route/package lane, mandatory post-Qualification gallery и detached
  successor watcher PID `47320` (`PPID 1`) готовы. Он публикует и repair-, и
  no-change gallery в постоянный completed-root до advancement. Следующий platform gap — durable scheduler hosting;
  broad runtime activation отсутствует, а Walmart write возможен только по одному
exact permit.

Отдельно закрыта наблюдаемость живого detached/frozen контура, который ещё не
представлен Stage A DB run: новый read-only runtime-status loader проверяет bounded
regular custody files, exact successor/monitor schemas, PID liveness и нулевой
write claim во время predecessor wait. Вкладка показывает active SKU, текущую
фазу, номер/результат Qualification check и состояние обоих процессов, обновляясь
каждые 15 секунд. Runtime API имеет только GET; mutation methods возвращают `405`,
сам loader выполняет `0` Walmart reads/writes. Текущий live projection =
`FaisalX-1144`, check `16`, `PENDING_PROPAGATION`, blocking facet `main`,
publication/indexing preserved, failure not before `23:12:25Z`; оба процесса
running. Runtime/API/UI combined regression `16/16`, TypeScript, ESLint и Next
production build PASS. Terminal FAIL, если он наступит только после SLA, отдельно
показывается как `REQUIRES_DISPOSITION` и не освобождает admission самовольно.

Successor runtime preflight дополнительно закрепил рабочий vision route до
release predecessor hold: LaunchAgent явно выбирает sealed Codex
`gpt-5.6-sol/medium` contract и authenticated `ssh-openclaw`. Это исключает
известный Claude weekly `429` и неправильную трактовку общего `/generate` URL.
Plist SHA `bd756f2e…16ad18`; controlled restart `67025/67026` вернулся в exact
`1144` wait, writes/model calls `0/0`.

Новый ITEM v6 report request и массовая перепись каталога не являются
предусловием текущего exact-SKU цикла. Mass run: **NO-GO**.

## Phase 7.2c — frozen control v5 checkpoint (2026-08-01T21:35Z)

- ✅ Terminal MAIN-only failure больше не может навсегда удержать строгую
  очередь. После полного Walmart SLA он получает только sealed
  `QUARANTINED_UNRESOLVED`; same-payload replay и второй POST запрещены.
- ✅ Crash после публикации disposition и crash после DB terminal state, но до
  публикации, покрыты раздельными exact-byte recovery tests. Второй путь
  восстанавливает disposition только из persisted owner-private Qualification
  receipt; external effects `0`.
- ✅ Clean control release v5: `e06c8e33…d66d6f2`, manifest
  `daef082f…709831`, `308/308 PASS`, tamper rejected.
- ✅ LaunchAgent v5 active на predecessor boundary, PIDs `75023/75025`, plist
  `4ade8ff6…4d7f4`; `FaisalX-1144` check 18 всё ещё
  `PENDING_PROPAGATION`, writes `0`.
- 🔄 Закрыть `FaisalX-1144` через Qualification PASS либо post-SLA quarantine;
  затем v5 автоматически допускает следующий exact SKU. Mass run остаётся
  **NO-GO**.
- ✅ Historical pre-Stage-A admission `1144` также получил отдельный exact
  PASS-or-post-SLA-MAIN-quarantine bridge. LaunchAgent PID `77311`, script
  `09db3536…67cd5d`, plist `927ebdcf…82a13`; live pending-path, synthetic exact
  receipt publication/idempotency и tamper rejection PASS, external effects `0`.

## Phase 7.2d — continuous sealed epochs (2026-08-01T21:57Z)

- ✅ Frozen control v6 `d64ec0d7…96be4`, manifest `35507839…083f7`, clean
  commit `7ade36b`, certification `312/312 PASS`; tampered manifest identity
  отвергается до запуска successor.
- ✅ Полностью terminal run закрывается атомарно только после factual gallery
  каждого PASS. Run/evidence сохраняются, quarantine не получает ложную gallery,
  а следующая очередь строится только из свежего ITEM_CATALOG.
- ✅ LaunchAgent v6 active: wrapper/worker `81916/81922`, plist
  `d8a1348c…e4a31`, controlled epoch = `10`, но одновременно активен только один
  SKU и его один exact permit. Status остаётся exact predecessor wait `1144`,
  Walmart writes `0`; activation receipt `20b144c0…c58450`.
- 🔄 Закрыть `FaisalX-1144` через Qualification PASS либо post-SLA quarantine;
  bridge затем освободит global admission, после чего v6 начнёт следующий
  одиночный SKU без owner-пинка.

## Phase 7.2e — full-catalog terminal boundary (2026-08-01T22:06Z)

- ✅ Frozen v7 `8a376d9f…9d150`, manifest `67bb9037…71a7c`, clean commit
  `404e6a9`, `314/314 PASS`, tamper rejected.
- ✅ Все terminal listing keys читаются across preserved epoch. После ready rows
  source-required-only pool становится bounded one-SKU diagnosis queue;
  `QUARANTINED_SOURCE_REQUIRED` выполняет `0` writes и не повторяется.
- ✅ Fresh pool без remaining candidate возвращает `CATALOG_COMPLETE` и точный
  next action итогового отчёта вместо seed error/вечного цикла.
- ✅ LaunchAgent v7 active: `84829/84835`, plist `4d865687…8a23b`, max epoch
  `10`, exact predecessor wait `1144`, writes `0`, activation receipt
  `84abf4d3…7caf07`.
- 🔄 `FaisalX-1144` check `20` остаётся `PENDING_PROPAGATION` только по MAIN;
  следующий SKU начнётся автоматически только после PASS/post-SLA quarantine.

## Phase 7.2f — full published denominator (2026-08-01T22:11Z)

- ✅ Frozen v8 `17a9a38e…f4970`, manifest `81ac0087…78875`, clean commit
  `10b915d`, `315/315 PASS`, tamper rejected.
- ✅ Scope = все `3877` active PUBLISHED rows текущего authoritative
  ITEM_CATALOG, а не только `1799` preliminary quantity/title signals. Signals,
  returns и sales сохраняют priority, но не сужают denominator.
- ✅ Published row без findings и со `SOURCE_ACQUISITION_REQUIRED` покрыт
  dedicated regression и входит в diagnostic/source-required lifecycle.
- ✅ LaunchAgent v8 active `86209/86214`, plist `c5c82380…7daa5`, exact `1144`
  wait, writes `0`, activation receipt `23dbbc76…b2f0e`.
- 🔄 После terminal disposition `1144` начать первый fresh v8 epoch и доказать
  его exact denominator/counts перед первым следующем SKU.

## Phase 7.2g — source-blocked visual inspection (2026-08-01T22:20Z)

- ✅ Frozen v9 `111b01e9…7e65d0`, manifest `6ff23d0e…2ad0d9`, clean commit
  `adb402f`, `315/315 PASS`, tamper rejected.
- ✅ Каждый `SOURCE_REQUIRED` SKU получает exact seller/catalog/PDP/image capture,
  signed blind vision и conservative title/text/image self-consistency. Pack of 6
  vs one visible unit и cross-product contradictions покрыты regression.
- ✅ Source-blocked evidence может только приоритизировать enrichment/quarantine;
  repair authority, permit и Walmart write без canonical Product Truth запрещены.
- ✅ LaunchAgent v9 active `88750/88755`, plist `60f680fa…feb736`, exact `1144`
  wait, writes `0`, activation receipt `5a4b92fc…7e91a5`.
- 🔄 `1144` check `21` остаётся `PENDING_PROPAGATION`; следующий SKU закрыт до
  PASS либо post-SLA quarantine.
- ✅ Fresh full-denominator production proof: pool `44463320…8b238`, file
  `6f82526e…f185e`, `3870 = 96 ready + 3774 source-required`; catalog `5235`
  rows, all write/model/paid effects `0`. Pool не seeded из-за active `1144`.

## Phase 7.2h — first epoch evidence and v14 visual normalization (2026-08-02T00:08Z)

- ✅ Exact first bounded epoch completed `10/10`, Walmart writes `0`; terminal
  quarantine advanced the queue instead of waiting indefinitely for MAIN.
- ✅ Root cause of the observed false negative is fixed narrowly: exact
  title-spanning `Product line` and exact `Flavor` can satisfy structured visual
  identity across separate packaging regions. Free-form model explanation is
  not repair authority and cannot turn REVIEW into PASS.
- ✅ Frozen v14 release `4ee130af…b7dfe`, manifest `1373d2a5…392b9`,
  `319/319 PASS`; LaunchAgent activated on the same owner-private custody root.
- ✅ Completed the next bounded v14 ten-SKU epoch while MAIN-only failures were
  quarantined and all later SKU continue sequentially.
- ✅ Re-admitted only the exact v13 false-negative cases through a new immutable
  release-bound recovery artifact; retain original quarantine bytes/history.
- ⬜ Continue controlled catalog epochs, then publish factual PASS galleries
  and final denominator/counts in Command Center. No mass write, price,
  inventory, repricing or delisting authority is introduced.

## Phase 7.2i — shared database writer boundary (2026-08-02T00:25Z)

- ✅ Second bounded epoch completed `10/10`, Walmart writes `0`; nine rows need
  exact Product Truth and one remains unresolved.
- ✅ Deferred read→write upgrade failure was reproduced independently and fixed
  by acquiring the exact active-run writer before CAS reads. Recovery reuses
  local evidence and cannot repeat a model call or marketplace operation.
- ✅ Frozen v16 `e5c01241…e8b46`, manifest `adfe475f…8dba3`, `320/320 PASS`;
  factual production recovery completed the epoch with empty v16 stderr.
- ✅ Continued the next ten-SKU epoch and implemented exact-state-bound one-time
  re-admission for the two v13 visual false negatives.

## Phase 7.2j — exact false-negative re-admission (2026-08-02T00:35Z)

- ✅ Sealed single-use readmission artifact is limited to exact historical
  states for `FaisalX-2554` and `FaisalX-3713`; every field, prior state SHA and
  evidence SHA is validated before pool selection.
- ✅ Re-admission means a fresh independent diagnosis only. It cannot reuse an
  uncertain model call, mutate original quarantine, authorize a marketplace
  write, or bypass strict one-SKU processing.
- ✅ Frozen v17 `7f3d8ae6…eacc41`, manifest `86c91ce5…e03ce`, clean commit
  `553fc9ef`, certification `322/322 PASS`; sealed pool selection, priority,
  exclusion rejection and automatic one-time consumption are regression tested.
- ✅ The already-running third epoch was handed from v16 to v17 at a saved
  per-SKU boundary with no completed-case replay. MAIN-image defects stay
  per-SKU quarantine and do not block analysis of the rest of the catalog.
- ✅ Finished the resumed epoch and proved both exact readmissions in the next
  fresh pool.
- ⬜ Continue controlled catalog epochs and publish factual repair/no-change
  galleries. No price, inventory, repricing, delisting or uncontrolled mass
  write authority is introduced.

Activation proof: v17 wrapper/worker `28961/28964` resumed the existing third
epoch at a saved SKU boundary; plist SHA `ab61fdde…3feba`, stderr empty, no
completed case replay and Walmart writes `0`.

## Phase 7.2k — temporary image hold with text lane active (2026-08-02T00:58Z)

- ✅ Third epoch completed `10/10`, writes `0`; completion evidence
  `1de1292a…e2905e24`.
- ✅ Exact readmissions were first/second in fresh pool `433481ca…23fd8f`.
  `2554` independently proved a real cross-product MAIN defect and `3713`
  resolved to source-required; neither wrote to Walmart.
- ✅ Frozen v18 `9bb25906…e68ed`, manifest `46c62544…fe0f0`, clean commit
  `e3573670`, `323/323 PASS`: routes changing MAIN/gallery defer before any
  candidate/model/permit creation, while `DESCRIPTION_BULLETS` remains enabled.
- ✅ Production proof on `2759`: only `route.json` was emitted, then terminal
  deferred quarantine; Walmart writes `0`, next SKU started automatically.
- 🔄 Continue the bounded pool and admit text-only repairs where the exact
  route and one-SKU permit pass. Retain every image defect for the later
  owner-reviewed image wave.

Production continuation proof: fourth run `wlirun-262a42fc2ea9a523e057c9f5`
completed `10/10`, evidence `54089e82…da9c13`, writes `0`. The following pool
has `readmission: null`, excludes exact `2554`/`3713`, and therefore proves
single-use consumption. Next Product Truth-ready pool body is
`58bcf03b…c3ceab2` and is active under v18.
