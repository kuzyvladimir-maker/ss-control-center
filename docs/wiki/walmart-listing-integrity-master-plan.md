# Walmart Listing Integrity — основной план до конечной цели

Статус: ACTIVE  
Владелец цели: Vladimir  
Исполнитель разработки и квалификации: Codex  
Оператор замороженного движка после пилота: Command Center / Claude Code  
Последняя сверка: 2026-07-25

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

### [ ] Phase 5 — финальный one-SKU apply package и owner review

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

Exit criteria: package `READY`, owner видит полный diff. Это ещё не разрешение на write.

### [ ] Phase 6 — один live canary

Только после точной команды владельца:

> Подтверждаю SKU `<exact SKU>` и показанный exact diff `<hash>`

Выполнить один заранее показанный surgical Walmart content write. Maximum SKU
count = 1; retries = 0; price, inventory и delisting = 0. Никакие поля вне
утверждённого exact diff не меняются.

### [ ] Phase 7 — propagation и независимая Qualification

После submission:

1. сохранить Walmart response и feed/status evidence;
2. дождаться propagation;
3. заново получить buyer-facing PDP;
4. повторно проверить товар, вариант, количество, title, description, bullets,
   attributes, MAIN и всю gallery;
5. проверить published status и доступные признаки индексации.

При `FAIL/REVIEW` следующий SKU запрещён. Анализируется причина, выполняется только
точечная корректировка или rollback, затем весь reread/Qualification повторяется.

### [ ] Phase 8 — фактическая галерея владельцу

Показать владельцу не proposal, а фактический результат Walmart:

- `ДО`;
- утверждённое предложение;
- `ПОСЛЕ` из свежего buyer PDP;
- Qualification verdict;
- статус публикации и индексации;
- точный журнал изменённых/неизменённых полей.

### [ ] Phase 9 — малый пилот 2–3 SKU

Выбрать 2–3 разных класса дефектов и для каждого отдельно повторить фазы
`detect → repair → reread → Qualification → owner gallery`. Никаких групповых writes
до доказанного PASS предыдущего SKU.

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

После доказанных canary/pilot/waves завершить постоянный workflow в Command Center:

- read-only мониторинг по расписанию;
- очередь дефектов и evidence gallery;
- proposal/approval separation;
- one-SKU и wave execution packages;
- обязательная Qualification после apply;
- immutable history и rollback evidence;
- отсутствие автономных массовых Walmart writes без owner policy.

## Текущая точка

Активная фаза: **Phase 5**.
Следующий action Codex: заново выпустить v3 compilation request из уже
сертифицированного review и проверить его против frozen compiler — **выполнено**.
Следующий gate: владелец подтверждает exact Product Truth candidate и показанный
text-only diff строкой, уже запечатанной в request. Это разрешает frozen owner
package compiler выпустить non-reusable single-SKU truth binding, получить свежие
Walmart spec/live item receipts и собрать connected execution package, но ещё не
разрешает Walmart write. Перед `execute` владелец видит exact package diff, SHA и
точную команду подтверждения; сам package и оба `doctor` write не разрешают.
Новый ITEM v6 report request и полный catalog census для этого не требуются.
Техническая проверка frozen engine и compilation request завершена. Текущий gate —
только exact owner confirmation review/truth; это не ошибка движка и не причина
запускать массовый прогон.
Live listing writes на текущей точке: **0**.  
Mass run: **NO-GO**.
