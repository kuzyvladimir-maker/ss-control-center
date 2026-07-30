# Архитектура товарного справочника и Product Truth Platform — КАНОН

> **OWNER CANON v2.0 — подтверждено Владимиром 2026-07-18.**
> Техническое отображение канона на локальную реализацию уточнено 2026-07-19,
> matcher Gate 1 фактически актуализирован 2026-07-20;
> бизнес-цель, четыре потребителя и двухфазная стратегия не изменены.
>
> Этот документ — верхнеуровневый источник истины для любой работы, которая касается
> `DonorProduct`, `DonorOffer`, `SkuComponent`, `SkuCost`, распознавания товара,
> retailer sourcing, Bundle Factory, создания или улучшения листингов, unit economics
> и будущего Procurement Module.
>
> Если другой план, старый handoff, комментарий в коде или локальный алгоритм расходится
> с этим документом, сначала приводим его к этому канону. Текущий изменяемый план работ:
> [[donor-catalog-execution-roadmap]]. Технические детали: [[reference-catalog-engine]],
> [[product-sourcing-engine]], [[enrichment-division-of-labor]], [[cogs-true-cost-agent]].

---

## 1. Главная цель

Построить **единый, независимый от каналов продаж, постоянно обновляемый источник
правды о реальных товарах**, который связывает:

```text
что это за физический товар
  → из чего состоит наш SKU
  → где товар реально купить в нашей зоне
  → в какой фасовке, по какой цене и в каком количестве
  → какие подтвержденные факты и изображения использовать
  → сколько зарабатывает SKU, канал и бизнес
```

Справочный донорский каталог — не вспомогательная таблица COGS и не коллекция чужих
карточек. Это **центральный товарный фундамент бизнеса по перепродаже**, на котором
строятся четыре больших направления:

1. **Bundle Factory** — создание совершенно новых листингов на любых каналах.
2. **Listing Improvement** — проверка, исправление и улучшение текущих листингов.
3. **Unit Economics** — себестоимость, прибыльность и экономика SKU/канала/бизнеса.
4. **Procurement** — закупка проданных товаров в правильных магазинах и фасовках.

Amazon, Walmart, eBay, TikTok Shop, собственный сайт и будущие площадки — только
потребители одной и той же товарной правды. Добавление нового канала не должно требовать
повторного сбора каталога.

---

## 2. Что каталог представляет — и чем он не является

### 2.1. Справочник реальных товаров

Каталог описывает реальные товары независимо от наших SKU и площадок:

- бренд, продуктовую линию, точный вариант и вкус;
- форму, размер и единицу измерения;
- покупаемые фасовки и количество базовых единиц внутри;
- UPC/GTIN на уровне конкретной покупаемой фасовки;
- состав, аллергены, пищевую ценность и подтвержденные claims;
- описание, атрибуты и реальные изображения упаковки;
- retailer offers, URL источника, продавца, ZIP/store, цену и наличие;
- время наблюдения, источник, confidence и статус проверки.

Один физический товар остается тем же товаром, продается ли он в Walmart, Publix
или Target. Ретейлер — источник и место закупки, а не идентичность товара.

### 2.2. Наши SKU и листинги

Отдельный слой — то, что продаем мы на каналах. Наш SKU может быть:

- одной единицей товара;
- мультипаком одного варианта;
- набором разных вкусов;
- бандлом разных продуктов;
- подарочным набором или кастомным ассортиментом.

Связь между нашим SKU и справочником — **рецепт SKU**:

```text
Наш channel SKU
  └── рецепт
      ├── точный товарный вариант A × qty
      ├── точный товарный вариант B × qty
      └── точный товарный вариант C × qty
```

Рецепт, а не единый GTIN, является универсальным представлением того, что мы продаем.
Один listing может содержать несколько реальных товаров, а один реальный товар может
использоваться сотнями SKU и на нескольких каналах.

### 2.3. Каталог НЕ является

- дампом Walmart, Amazon, Target или другого ретейлера;
- копией наших marketplace listings;
- хранилищем AI-сгенерированных title/bullets как фактов;
- одноразовым snapshot цен;
- таблицей «один SKU = один товар»;
- поводом каждому модулю самостоятельно ходить в интернет и платить за те же данные.

---

## 3. Каноническая модель: вариант → покупаемая фасовка → локальный оффер

```text
ТОВАРНЫЙ ВАРИАНТ / CONCEPT
"Uncrustables Strawberry"
  │
  ├── ПОКУПАЕМАЯ ФАСОВКА: box 4 count, GTIN A
  │     ├── Walmart offer, ZIP/store, $X, stock, URL, observedAt
  │     └── Target offer,  ZIP/store, $Y, stock, URL, observedAt
  │
  └── ПОКУПАЕМАЯ ФАСОВКА: box 10 count, GTIN B
        ├── Target offer,  ZIP/store, $Z, stock, URL, observedAt
        └── Publix offer,  ZIP/store, $W, stock, URL, observedAt

НАШ SKU
  └── рецепт: [товарный вариант × необходимое количество единиц]
```

Минимально система обязана различать:

1. **Товарный вариант** — бренд + линия + вкус/формула + форма товара.
2. **Базовую потребительскую единицу** — точный размер/мера реального товара.
3. **Покупаемую фасовку** — сколько базовых единиц продается вместе, UPC/GTIN.
4. **Локальный оффер** — retailer/store/ZIP, цена, наличие, продавец, URL, время.

Физическая схема может эволюционировать, но эти смыслы нельзя смешивать.

### Отображение на текущие таблицы

- `CanonicalProductVariant` — неизменяемая нормализованная идентичность физического
  варианта; это канонический variant identity, а не карточка ретейлера.
- `DonorProduct` — source-specific карточка/кандидат. Она становится exact alias
  канонического варианта только через неизменяемый `DonorProductVariantDecision`;
  соседний вкус или другая фасовка не могут быть молча перепривязаны.
- `ProductContentObservation` — неизменяемый exact-only snapshot контента с URL,
  hashes, временем и run/approval/receipt provenance. Материализованные поля
  `DonorProduct` не являются единственным историческим источником фактов.
- `DonorOffer` — стабильная source identity покупаемого retailer item/offer.
  `DonorOfferObservation` — отдельный неизменяемый snapshot цены, stock, seller,
  ZIP/store locality и времени наблюдения.
- `SkuComponent` — текущая материализованная bill-of-materials связь для совместимости.
  Авторитетная доказательная запись компонента конкретного cost result —
  `SkuComponentEvidence`.
- `SkuCost` — append-only датированный результат расчёта вместе с recipe hash,
  typed outcome (`FACT/ESTIMATE/UNSOURCEABLE`) и воспроизводимым evidence.
- `MeteredProviderBudget` + `MeteredReservationReceipt` — hard budget ledger;
  платное content/price observation обязано ссылаться на успешно закрытый receipt
  того же provider, run и plan-bound standing authorization.
- `GeneratedContent` и channel listings — производные артефакты, не товарная истина.
- `WalmartCatalogItem` / Amazon snapshots — зеркала наших живых каналов, не доноры.

Единая программная граница чтения для четырёх потребителей —
`src/lib/sourcing/product-truth-read-contract.ts`, contract
`product-truth-read-contract/4.0.1`. Он требует точный scope
`(channel, positive storeIndex, raw SKU)` и не имеет fallback на голый SKU.
Потребитель не должен самостоятельно собирать
«правду» из legacy `DonorProduct`, `SkuComponent` или последнего ненулевого `SkuCost`.
Read-contract выбирает состояние на `asOf`, не возвращает estimate как content truth,
не поднимает старую положительную цену поверх нового `UNSOURCEABLE` и отделяет
accounting manual cost от retailer buy options. Для exact content он сначала требует
валидную immutable provenance, затем выбирает наиболее полный snapshot и только при
равной полноте — самый свежий; поэтому более новая частичная карточка не может скрыть
ранее доказанные exact-поля того же варианта. Exact identity/content/cost evidence
дополнительно обязано нести полный matcher provenance tuple: version, SHA точных
implementation bytes и SHA matcher release manifest; неполный или устаревший tuple
fail-closed отклоняется.

Для массовых consumers граница имеет set-based batch projection до 100 exact scopes:
одна schema check/read transaction, общий `asOf`/freshness policy и обязательный SHA-256
authoritative manifest. Single reader использует тот же assembler, поэтому не может
получить отдельную policy semantics. Staged activation оформлена отдельным owner-sealed
контрактом `OFF → SHADOW → ENFORCED`, привязанным к consumer subset, DB fingerprint,
manifest, contract version и read-only/no-mutation claims. Подробный аудит и порядок
переключения: [[product-truth-consumer-cutover]].

Authoritative Phase 1 scope имеет отдельный canonical artifact
`phase1-authoritative-scope-manifest/v3`. Его policy фиксирует
`builderPolicyVersion=phase1-scope-builder-policy/1.2.0`, embedded owner-attested
`phase1-connected-store-census/v1` с policy
`phase1-connected-store-census-policy/1.1.0`, census content/capture SHA,
owner-disposition schema `phase1-scope-disposition/v3`, `dispositionInputSha256`,
derived `requiredScopesSha256` и
`contentSha256` точных байтов каждого локально переданного marketplace report. Ручной
required-scope denominator запрещён. Изменение любого из этих входов создаёт другой
manifest. `authoritative=true` допустим только при нуле blockers и полной reconciliation
на grain `(channel, positive storeIndex, raw SKU)`. При этом локальный SHA доказывает
неизменность полученных байтов, но не их marketplace custody: реальный экспорт из
Amazon/Walmart и owner-подтверждение всех подключённых scopes остаются обязательными
внешними доказательствами.

Runtime validator дополнительно требует ровно одну owner disposition для каждого
census-derived scope и exact report/listing reconciliation; удаление scope/report/listings
с последующим пересчётом всех локальных hashes не может уменьшить denominator.
Технически `UNRESOLVED` scope также остаётся в census-derived denominator: он не
может исчезнуть, но может быть закрыт явным `EXCLUDED_OWNER_CONFIRMED`. Для такого
исключённого scope допускается `accountId=null`, только если тот же null независимо
зафиксирован census; `IN_SCOPE` всегда требует реальный account ID и exact report.

### Статус реализации на 2026-07-19

Локально в dirty worktree реализован основной no-spend технический контур: matcher 1.2.0,
canonical variant/alias decisions, immutable content/offer/cost evidence, независимые
content и price/COGS roles, terminal harvest lifecycle, exact listing-scope queue с
одной попыткой, distributed metered budget ledger, receipt-to-observation links,
append-only cost history и единый read-contract четырёх потребителей. Owner-gated
migration planner теперь фиксирует **8 ordered migrations**.

После аудита consumers локально также готовы manifest-bound set-based reader, общий
consumer gateway и отдельный activation contract. Они намеренно не включены в runtime:
без authoritative manifest/migrations/backfill режим остаётся `OFF`, а cutover — 0/4.

Локальный schema gate fail-closed проверяет необходимые tables, columns, indexes,
triggers и foreign keys до canonical read/write или metered work. Отдельный
`product-truth-backfill-readiness/1.0.0` строит только read-only
`READ_ONLY_NO_PAID_PLAN`: связывает exact manifest, migration certification и DB target,
считает catalog/scope coverage, активных writers, unsettled receipts и integrity
blockers. Он не применяет migrations, не выполняет backfill, не вызывает providers и не
продвигает legacy данные в truth; любой реальный writer остаётся отдельным
owner-reviewed шагом.

Containment известных legacy Listing Improvement mutations также выполнен локально:
hard-retired Amazon repricer, Amazon remediation/auto-improve cron, Amazon Growth
advisor/optimizer/bulk apply/enqueue/drain/rollback и snapshot restore; Walmart
remediation worker, generated-image apply и remediation enqueue также возвращают
`410`. Опасные schedules удалены, а Jackie MCP `listings_update` оставлен только как
fail-closed preview и больше не импортирует Amazon PATCH sink. Это не consumer cutover
и не repo-wide сертификат отсутствия mutations.

Отдельные действующие business flows пока остаются вне этого containment: Bundle
Factory publish/republish, scheduled UPC self-heal, A+ generation/publish, content
generation/tick и audit vision fallback. Они защищены существующей session/RBAC или
cron boundary, но ещё не связаны с Product Truth snapshot и отдельным owner action/
budget artifact. Product Truth operator не имеет права вызывать их; до отдельного
cutover/gate они остаются явными readiness blockers, а не допустимым fallback.

Legacy Unit Economics пока явно помечена
`LEGACY_UNSCOPED_TRANSITIONAL` и non-authoritative, но fail-open устранён: newest
`NULL/UNSOURCEABLE` не пропускает старую положительную стоимость, а неизвестная COGS
даёт nullable `BLOCKED`, а не расчёт прибыли с COGS=0.

Операционное исполнение вынесено в sealed Product Truth runner и CLI с командами
doctor/plan/balance-probe/authorize/execute/resume/status/report: immutable plan и
автоматическая standing authorization связывают точный
scope, provider ceilings и DB target; concurrency равна 1; queue/ledger attempt
закрывается атомарно; crash recovery запрещает replay неопределённого результата;
report и artifact index имеют неизменяемую hash-binding. Legacy batch entrypoint
выведен из эксплуатации: Claude Code должен только исполнять готовый движок, а не
проектировать или изменять его во время очередного прогона. Актуальный certification
result берётся из последнего полного прогона suite; этот канон намеренно не закрепляет
устаревающее количество тестов.

Gate 1 matcher replay подчинён отдельному канону
[[product-truth-matcher-replay-v2]]. Старый title-only exact-386 replay признан
vacuous: legacy `VARIANT_MISMATCH` не является truth label. Финальный v2.2 связывает
ровно восемь immutable inputs: raw source, corpus, две post-blind consensus acceptance,
исходный blind task, два frozen blind review и reconciliation map. Он честно фиксирует
`priorExposure=true`, `blindAgreementClaimed=false` и исходное сравнение
`80 exact / 181 structural disagreement with same semantic result / 127 semantic
disagreement`; post-blind consensus нельзя называть независимым blind agreement.
Неразрешимые evidence rows остаются `UNRESOLVED_EVIDENCE`, не вызывают matcher и не
превращаются в synthetic reject. Production floor — минимум 300 resolved и максимум
86 unresolved; threshold не является целью разметки. Полный Gate PASS требует
`PASS_FULL`; partial/blocked всегда возвращает общий FAIL/exit 2, даже при semantic
PASS на resolved subset. Claude Code запускает только exact sealed runtime wrapper,
а не direct runner, и не создаёт corpus/verdicts. Финальный frozen engine — commit
`78e0664908cd37c3746a311084f4826a031b3658`, tree
`7a2eb1a6bbc0886fec33898268db3036e240aa22`; tests `23/23` и `432/432`. Sealed replay
доказал semantic `304/304 PASS`, golden `2 cases / 4 comparisons`, `300 resolved / 86
unresolved`, но full truth остаётся BLOCKED только по
`UNRESOLVED_EVIDENCE_PRESENT`. Отдельно запрещены production writes под прежним
literal matcher version `1.2.0` до version/provenance migration и consumer cutover.

Для точечного закрытия Product Truth gap перед Walmart new-SKU pilot в исходниках
реализован отдельный sealed lane `TARGETED_WALMART_EVIDENCE`. Он не является новым
каталогом, массовым harvest или обходом Phase 1: один run связывает ровно один уже
существующий `DonorProduct`, ровно один его direct first-party Walmart `DonorOffer`,
числовой Walmart item ID, нормализованный product URL и одну canonical identity.
Поддерживаются два режима:

- `EXISTING_EXACT` переиспользует уже подтверждённый exact alias;
- `EVIDENCE_VERIFIED_BOOTSTRAP` допускает начальное создание не более одного
  `CanonicalProductVariant` и одного immutable exact decision для sealed legacy
  donor/offer. Движок сам детерминированно выводит консервативную identity из точного
  brand, полного post-brand title signature и нормализованного размера в sealed
  donor bytes. Ручной identity-файл и техническая аттестация владельца запрещены.
  Pinned standing owner policy разрешает только точный metered plan и его бюджет,
  но не заменяет машинное доказательство товарной идентичности. Approval/permit
  создаются движком; владелец не копирует технические tokens.

Bootstrap ничего не записывает до свежего exact Walmart search evidence, которое
обязано независимо подтвердить тот же numeric item ID, нормализованный URL,
`Walmart.com` first-party seller, полный набор identity tokens, размер и base-unit
pack. Внутренний transaction scope guard запрещает создать либо изменить другой
donor/offer/variant/decision и откатывает запись при drift. Один plan разрешает
максимум один Oxylabs
Walmart query (`1` unit) и один Unwrangle Walmart detail (`2.5` units), ZIP `33765`,
price TTL `24h`, минимум два exact-variant изображения и wall clock `180000 ms`.
OFF, clubs, BJ's, fanout, автоматический replay, publish, delist, reprice и purchase
жёстко выключены. Уже существующий полный exact content snapshot можно переиспользовать
только вместе со свежей ценой и только если detail receipt для этого run ещё не
существует; начатый detail call старым контентом не «спасается» и не повторяется.
Claude Code исполняет только frozen CLI и exact emitted arguments — без кода, SQL,
ручного API или самостоятельного retailer search.

Статус этого узкого lane на 2026-07-19: **source implemented and locally certified**.
Focused, integration, stress и полный Product Truth suite прошли без provider calls;
исполняемым handoff считается только отдельно замороженный clean release с exact tree
и checksum. До такого release binding, pinned standing policy и metered permits
платный запуск не разрешён.

Это **не означает external production readiness**: 8 migrations не применялись и не
верифицировались на Turso, backfill не выполнен, consumer cutover на read-contract равен
**0 из 4**, authoritative Amazon/Walmart reports и финальный Phase 1 manifest v3 не
получены. Paid provider canary, gap enrichment и любой иной платный Product Truth run не
запускались. Поэтому локальная готовность кода не является заявлением о готовности
production schema, данных или внешнего runtime.
Текущий исторический baseline: [[product-truth-baseline-2026-07-18]].

Если текущая схема не может честно выразить вариант, фасовку, оффер, рецепт или
provenance, схему нужно расширять, а не прятать разные смыслы в одном поле.

---

## 4. Четыре стратегических потребителя

### 4.1. Bundle Factory — совершенно новые листинги

Bundle Factory **всегда начинает со справочного каталога**. Он не должен повторно
распознавать и добывать товар, если подтвержденный вариант уже существует.

Пользователь или алгоритм выбирает варианты, количества и канал. Bundle Factory берет:

- точную идентичность и состав каждого компонента;
- изображения и подтвержденные товарные факты;
- реальные фасовки и локальные цены;
- доступность и ожидаемую закупочную стоимость;
- правила конкретного канала.

На этой основе он создает производный channel-specific листинг:

- рецепт SKU;
- title, bullets, description и attributes;
- MAIN и secondary images с правильными вариантами и количеством;
- bundle composition;
- рекомендуемую цену и margin guard;
- draft/publish payload для Amazon, Walmart, eBay, TikTok Shop, сайта или нового канала.

Факты едины; форма представления различается по marketplace policy. Каталог не хранит
«Amazon title» как истину — channel adapter создает его из подтвержденных фактов.

### 4.2. Listing Improvement — текущие листинги

Для существующего листинга работает обратный путь:

```text
живой listing
  → определить фактический рецепт
  → связать каждый компонент с точным вариантом
  → сравнить listing с подтвержденными фактами
  → построить исправленный текст/графику/атрибуты
  → проверить и применить по правилам канала
```

Каталог должен позволять находить неправильный вкус, размер, количество, чужое фото,
неверный вариант, неполный состав, устаревшую nutrition, пропущенные attributes и
несоответствие текста изображению.

Алгоритмы используют каталог как фактическую основу, но создают **новый** контент под
политику площадки. Generated content никогда не перезаписывает исходные факты.

### 4.3. Unit Economics — SKU, канал, проект и бизнес

Каталог предоставляет procurement truth:

- точный рецепт SKU;
- требуемое количество каждого варианта;
- доступные покупаемые фасовки;
- локальные цены, наличие и историю наблюдений.

Product acquisition cost должен считаться через оптимальную комбинацию фасовок, а не
как слепой `minimum price per unit`. Например, для шести булок три двухупаковки Target
могут быть выгоднее шести одиночных Walmart; для одной булки ситуация обратная.

Полная экономика строится слоями:

```text
оптимизированная закупочная стоимость компонентов
+ упаковка и cold-chain/лед
+ операционные fulfillment costs
= полная COGS

revenue
- COGS
- channel/payment fees
- shipping, ads, returns и другие переменные расходы
= contribution profit
```

Результаты должны быть доступны по SKU, order line, заказу, каналу, категории, периоду,
проекту и бизнесу. Цены и cost periods историчны: сегодняшнюю цену нельзя выдавать за
стоимость товара в старой продаже.

### 4.4. Procurement — закупка после продажи

Будущий Procurement Module превращает продажу на любом канале в реальный план закупки:

```text
продажа
  → channel SKU
  → рецепт
  → требуемые варианты и количества
  → минус доступный/зарезервированный inventory
  → дефицит
  → локальные офферы и фасовки
  → оптимальный план магазинов и покупок
```

Оптимизация должна учитывать не только цену за единицу, но и:

- требуемое количество и остаток после вскрытия фасовки;
- возможность использовать излишек в следующих заказах;
- наличие в конкретной зоне/магазине;
- membership, minimum order, pickup/delivery;
- расстояние и консолидацию нескольких заказов;
- cold-chain, срок годности и срочность;
- общую стоимость корзины у каждого ретейлера.

Выход — shopping/procurement plan: что купить, сколько фасовок, где, по какой цене и по
каким URL. Позже он может готовить корзины или автоматизировать покупку, но только через
отдельные approval gates.

Фактическая покупка замыкает feedback loop: чек и реально оплаченная цена обновляют
историю офферов и улучшают будущую COGS.

---

## 5. Двухфазная стратегия наполнения каталога

### Phase 1 — сначала товары, которые мы уже продаем

Первый приоритет — **все актуальные товары и компоненты наших живых Amazon и Walmart
листингов**. Это кратчайший путь одновременно разблокировать четыре направления.

Phase 1 должна:

1. Получить авторитетный список живых Amazon/Walmart listings.
2. Для каждого SKU определить точный рецепт, включая multipacks и mixed bundles.
3. Связать каждый компонент с exact товарным вариантом или явно пометить unresolved.
4. Собрать подтвержденный контент и локальные retailer offers в зоне ZIP 33765.
5. Рассчитать procurement cost и полный cost stack с явным provenance/tier.
6. Сделать данные пригодными для Bundle Factory, Listing Improvement, Economics и
   будущего Procurement.

Успех Phase 1 — не «у каждой строки есть какое-то число или фото». Каждый live SKU
должен быть полностью классифицирован: exact/confirmed, estimate/review или честно
unresolved/unsourceable. Никаких молчаливых пробелов и подмен вариантов.

Из этого же массива подтвержденных товаров Bundle Factory уже сможет создавать новые
вариации, мультипаки и бандлы без повторной добычи.

### Phase 2 — стабильное расширение за пределы текущих продаж

После покрытия текущего бизнеса каталог системно расширяется кампаниями:

- по бренду;
- по продуктовой группе/категории;
- по retailer assortment;
- по закупочной возможности и локальной доступности;
- по спросу, марже и возможностям новых листингов.

Кампания обязана иметь scope, источник, ZIP/store, бюджет, dedup, checkpoint и критерий
готовности. «Собирать все подряд» означает планомерно расширять охват, а не запускать
безграничный скрейп без контроля качества и расходов.

Phase 2 превращает справочник из отражения текущего ассортимента в библиотеку будущих
возможностей для Bundle Factory и закупки.

### Постоянная эксплуатация

После Phase 1/2 каталог остается живым:

- стабильные identity/content facts обновляются по версии товара или умеренному TTL;
- цена, stock и ZIP/store availability — значительно чаще;
- stale/unknown никогда не выдаются за current/available;
- повторная добыча свежих данных запрещена;
- все сетевые и платные операции идут через общий budgeted enrichment engine.

---

## 6. Законы товарной правды

1. **Один writer, много consumers.** Внешние retailer calls делает единый sourcing/
   enrichment engine. Потребитель ставит задачу в очередь, а не создает свой scraper.
2. **Рецепт связывается с товарным вариантом, не с GTIN.** GTIN относится к фасовке.
3. **Exact content donor отделен от price evidence.** Cross-size или sibling могут быть
   ценовой оценкой, но никогда не источником фото, состава или nutrition другого варианта.
4. **Факты отделены от generated content.** Channel copy производен, но упаковка
   товара не может быть придумана или генеративно перерисована. Exact donor image
   сохраняет пиксельную идентичность точного варианта; разрешены только
   детерминированные crop/resize/white-canvas и повторение exact source asset.
5. **Image truth — жёсткий fail-closed закон.** Brand, product, flavor, size, count
   и package artwork обязаны совпадать с exact variant минимум на `99%`. Если это
   нельзя доказать, изображение не допускается к публикации. Для multipack MAIN
   видимо ровно `N` полных единиц из sealed recipe — без скрытых, лишних,
   перекрывающихся упаковок и без добавленного quantity badge. Права на публикацию
   проверяются независимо от товарной точности.
6. **Каждый важный факт имеет provenance:** source URL, retailer, capturedAt, ZIP/store,
   match method/version, confidence и fact/estimate status.
7. **Оценка никогда не маскируется под факт.** Exact, cross-size, sibling, stale,
   needs-review и unsourceable — разные состояния.
8. **Local availability — часть оффера.** `unknown` не означает `available`; URL товара
   на национальном сайте не доказывает наличие в Clearwater.
9. **First-party и marketplace разделены.** 3P reseller price не является нашей обычной
   закупочной себестоимостью.
10. **Размер, мера и pack count обязательны.** `12 oz`, `12 ct` и `pack of 12` — разные вещи.
11. **История не уничтожается.** Price, stock, identity decisions и cost periods должны
    быть воспроизводимы на дату.
12. **Неопределенность блокирует опасные действия.** Нельзя автоматически публиковать
    чужую картинку, заявлять неподтвержденный состав или покупать другой вкус.
13. **Кредиты и API calls — управляемый ресурс.** Paid batch требует owner-approved
    бюджета, hard cap, dry-run, checkpoint и отчет фактического расхода.
14. **Один проверяемый read-contract.** Все четыре потребителя получают один и тот же
    snapshot recipe/content/cost/procurement evidence; ad-hoc legacy joins не создают
    параллельную трактовку товарной правды.

---

## 7. Границы ответственности модулей

| Модуль | Чем владеет | Чего не делает |
|---|---|---|
| Reference Catalog / Sourcing | identity, facts, evidence, packs, offers, freshness | не создает channel listing как истину |
| Bundle Factory | рецепты новых SKU, drafts, channel content/images, publish payload | не добывает параллельного донора |
| Listing Improvement | audit, remediation plan, исправленный content, safe apply | не переписывает каталог generated-текстом |
| Unit Economics | cost stack, margin, price floor, historical economics | не объявляет estimate закупочным фактом |
| Procurement | demand, inventory allocation, shortage, buy-plan, actual purchase | не меняет identity товара ради удобной цены |

---

## 8. Определение готового результата

Платформа выполняет цель, когда:

- Bundle Factory создает channel-ready draft из каталога без нового хаотичного поиска;
- существующий listing можно связать с рецептом и проверить против exact facts;
- каждый текст/изображение прослеживается до точного варианта и evidence;
- для любого SKU объяснимы компоненты, фасовки, источник цены и полный cost stack;
- экономика считается по SKU, заказу, каналу и бизнесу с историей;
- продажа превращается в локальный procurement plan;
- одна подтвержденная карточка переиспользуется множеством SKU и каналов;
- freshness и availability видны явно;
- неверный вариант не проникает в content, pricing или procurement;
- enrichment выполняется идемпотентно и в пределах утвержденного бюджета.

---

## 9. Чего не делать

- Не создавать новый товарный справочник под отдельную фичу или канал.
- Не позволять Bundle Factory, Growth или Procurement самостоятельно скрейпить ретейлеров.
- Не связывать рецепт с ценовым sibling-донором как с content source.
- Не считать наличие одного изображения «полной карточкой».
- Не считать `needsReview=0` достаточным доказательством exact/local truth без provenance.
- Не перезаписывать cost history текущим числом.
- Не запускать paid enrichment без измеримого плана, pinned standing policy,
  fresh balance evidence и hard budget ledger; ручной per-plan chat approval
  для обычного Product Truth enrichment не запрашивать.
- Не делистить или репрайсить массово до повторной проверки затронутых SKU исправленным
  matcher/local-availability контуром.

---

## 10. Связанные документы

- [[donor-catalog-execution-roadmap]] — текущий план исполнения и phase gates.
- [[reference-catalog-engine]] — текущая техническая модель Donor DB/очереди.
- [[product-sourcing-engine]] — общий identify/source/persist/act движок.
- [[enrichment-division-of-labor]] — один enrichment writer, потребители читают.
- [[cogs-true-cost-agent]] — полная COGS и cost-period semantics.
- [[bundle-factory-master-plan]] — потребитель новых листингов.
- [[listing-quality-stack]] — общий контур качества создания/улучшения листингов.
- [[procurement-module]] — существующий procurement context и будущая эволюция.
- [[task-registry]] — текущий статус инициативы.

**Одним предложением:** справочный каталог — это Product Truth Platform бизнеса по
перепродаже; сначала он покрывает все реально продаваемые Amazon/Walmart товары, затем
системно расширяется и постоянно кормит создание листингов, их улучшение, экономику и
локальную закупку.
