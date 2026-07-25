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

### [x] Phase 3 — реальный one-SKU defect и визуальное одобрение

SKU `FaisalX-1183`:

- title: `Pack of 6`;
- текущая MAIN: одна упаковка;
- proposed MAIN: шесть точных упаковок;
- gallery проверена;
- владелец визуально одобрил proposed MAIN и gallery;
- меняется только MAIN;
- title, description, bullets, attributes, price, inventory и gallery не меняются.

Legacy donor audit дополнительно доказал неправильную привязку к Chessmen Butter
Cookies. Этот donor запрещено переносить в canonical Product Truth.

### [ ] Phase 4 — единый процесс одного SKU и свежий read-only intake — IN PROGRESS

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
- добавлена единая локальная команда `npm run walmart:listing-integrity -- diagnose`;
  она читает exact evidence одного SKU, побайтово проверяет все изображения и выдаёт
  один sealed результат с SHA-256;
- добавлены `capture|inspect`: `capture` останавливается до Walmart при отсутствии
  canonical Product Truth, а `inspect` может безопасно собрать live self-consistency
  evidence для source-blocked SKU, не объявляя его Product Truth и не разрешая repair;
- schema gate теперь сначала доказывает доступность БД и больше не выдаёт сетевой/DNS
  отказ за «отсутствует вся Product Truth schema»;
- server-side Walmart PDP substitution оформлена как штатный
  `BUYER_CAPTURE_REQUIRED`: точные seller/catalog evidence сохраняются, чужой primary
  product отвергается, images/model/writes не запускаются. Exact browser HTML можно
  импортировать через `inspect --buyer-pdp-html=...`; item ID всё равно повторно
  проверяется strict parser;
- реальный read-only `FaisalX-1183` подтвердил этот stop:
  seller/catalog GET `2`, buyer GET `1`, images/model/DB writes/Walmart writes `0`;
  sealed intake SHA
  `698cf12b5dcb019e3c70625a60ddc62aafdee7acded3ccf7f18d95549206a624`;
- доказаны `BAD` для MAIN `1 вместо 6`, reject изменённых image bytes, reject другого
  SKU и честный `CLEAN_CANDIDATE`, который ещё не называется PASS до source-aware
  Qualification;
- новый one-SKU suite 17/17 PASS, schema-gate suite 11/11 PASS, targeted ESLint PASS.

Exit criteria:

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

Собрать immutable package для одного изменения MAIN. Перед отправкой показать владельцу:

- текущую MAIN;
- предлагаемую MAIN;
- фактический title и Pack of 6;
- список каждого изменяемого поля;
- явный список неизменяемых полей;
- rollback asset;
- свежую visual attestation и Qualification precheck.

Exit criteria: package `READY`, owner видит полный diff. Это ещё не разрешение на write.

### [ ] Phase 6 — один live canary

Только после точной команды владельца:

> Загружай FaisalX-1183

Выполнить один MAIN-only Walmart write. Maximum SKU count = 1; retries = 0; price,
inventory, delisting и gallery writes = 0.

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

Активная фаза: **Phase 4**.  
Следующий action: получить exact buyer-facing capture для одного SKU (автоматически
через browser worker либо импортом строгого HTML), завершить signed blind observation,
затем выполнить смешанную read-only калибровочную выборку. Новый ITEM v6 report request
и полный catalog census для этого не требуются.  
Live listing writes на текущей точке: **0**.  
Mass run: **NO-GO**.
