# Walmart Listing Integrity — основной план до конечной цели

Статус: ACTIVE  
Владелец цели: Vladimir  
Исполнитель разработки и квалификации: Codex  
Оператор замороженного движка после пилота: Command Center / Claude Code  
Последняя сверка: 2026-07-23

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

### [ ] Phase 4 — свежий Walmart source и exact truth одного canary — IN PROGRESS

Нужно получить свежий authoritative Walmart ITEM v6 и связать `FaisalX-1183` с точным
товарным вариантом Pepperidge Farm Butter Hot Dog Buns, 14 oz / 8-count, recipe
`6 × one sellable package`.

Уже сделано:

- Product Truth schema migrations 8/8 применены и сертифицированы;
- bounded GET-only probe полностью покрыл последние 24 часа и подтвердил, что готового
  ITEM v6 нет;
- report-create calls = 0, Walmart listing writes = 0;
- точный buns candidate найден, но ещё не promoted вручную.

Exit criteria:

- свежий completed ITEM v6 сохранён exact bytes + SHA-256;
- строка `FaisalX-1183` найдена и связана с buyer identity;
- exact product/variant/quantity подтверждены без legacy cookie donor;
- one-SKU Product Truth read-contract READY либо targeted owner-attested bootstrap
  прошёл канонический gate;
- Amazon scope не участвует в этом exit criterion.

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
Следующий внешний action: один новый zero-retry Walmart ITEM v6 report request; он не
изменяет листинги, но создаёт report request в Walmart.  
Live listing writes на текущей точке: **0**.  
Mass run: **NO-GO**.

