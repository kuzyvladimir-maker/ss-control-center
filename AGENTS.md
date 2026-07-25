# AGENTS.md — обязательный контекст проекта

## Product Truth Platform / донорский справочный каталог

Перед любой работой, затрагивающей товарную идентичность, `DonorProduct`,
`DonorOffer`, `SkuComponent`, `SkuCost`, retailer sourcing, Bundle Factory,
создание или улучшение листингов, unit economics либо Procurement, обязательно
прочитать полностью:

1. `docs/wiki/product-catalog-architecture.md` — **OWNER CANON**, главный источник
   истины о назначении и архитектуре каталога.
2. `docs/wiki/donor-catalog-execution-roadmap.md` — текущий порядок работ, gates,
   критерии готовности и решения, требующие подтверждения владельца.
3. `docs/wiki/enrichment-division-of-labor.md` — контракт единого enrichment-контура
   и его потребителей.
4. `docs/wiki/product-truth-operator-runbook.md` — единственный operator workflow
   готового Product Truth engine и жёсткая граница роли Claude Code.
5. `docs/wiki/product-truth-consumer-cutover.md` — доказанный список consumer bypasses,
   manifest-bound/set-based read boundary и staged shadow→owner activation→enforced.
6. `docs/wiki/product-truth-release-scope.md` — точный Git/release boundary и
   обязательный clean-checkout gate перед передачей готового движка оператору.
7. `docs/wiki/product-truth-matcher-replay-v2.md` — канонический offline Gate 1,
   восемь immutable inputs, честный post-blind provenance и sealed wrapper boundary.
8. `docs/wiki/product-truth-command-center.md` — живой implementation board
   постоянного модуля Catalog / Product Truth, его фазы, acceptance gates и прогресс.
9. `docs/wiki/product-truth-web-operations-control-plane.md` — канонический
   default-OFF design web→worker bridge, отдельного Product Truth owner trust root,
   immutable command artifacts и staged activation.
10. `docs/wiki/product-truth-owner-gates.md` — единый живой реестр независимых
    owner decisions, их точных границ, approval phrases и consumed evidence.
11. Для создания новых Walmart SKU — `docs/wiki/walmart-new-sku-operator-runbook.md`;
   это единственный operator workflow готового движка.
12. Для исправления существующих Walmart-листингов —
    `docs/wiki/walmart-listing-integrity-operator-runbook.md`; это единственный
    operator workflow frozen Listing Integrity repair engine.

Обязательные правила:

- Это один независимый от каналов Product Truth Platform для четырёх потребителей:
  Bundle Factory, Listing Improvement, Unit Economics и Procurement.
- Phase 1 — закрыть весь текущий продаваемый ассортимент Amazon и Walmart;
  продажи и выручка задают приоритет, но не сужают границу Phase 1.
- Phase 2 — системно расширять каталог по бренду, группе/категории, ретейлеру и
  demand-driven запросам, затем постоянно обновлять цены и наличие.
- Контент разрешено переносить только с точного товарного варианта. Ценовой proxy
  или другая фасовка — отдельное `price evidence`, а не `content donor`.
- Потребители читают общий каталог. Если данных нет, они ставят задачу в единую
  очередь и не создают параллельный каталог или собственный retailer-harvest.
- Canonical consumers должны использовать единый versioned Product Truth read-contract,
  а не самостоятельно трактовать mutable/legacy `DonorProduct`, `SkuComponent` или
  последний ненулевой `SkuCost`. Content readiness и price/COGS outcome — независимые
  оси: exact content не исчезает из-за estimate/unsourceable цены, а price proxy
  никогда не становится content truth.
- Наличие migration или теста в worktree не означает, что schema применена к Turso
  или что данные backfilled. Перед runtime-выводом отдельно доказать migration state,
  authoritative marketplace inputs и consumer cutover.
- Никаких платных массовых прогонов, включения harvest-cron, делистинга,
  репрайсинга/min-max, публикации листингов или закупок без соответствующего
  owner gate из roadmap.
- В операционном режиме Claude Code только вызывает готовый suite из
  `product-truth-operator-runbook.md`: `product-truth:census`,
  `product-truth:manifest`, `product-truth:migrations` и canonical
  `product-truth doctor|backfill-plan|backfill-apply|readiness|plan|execute|resume|status|report`.
  Matcher replay v2.2 — исключение: только exact sealed wrapper-команда из runbook;
  direct npm `matcher-replay` и direct runner запрещены.
  Он не редактирует движок, не запускает `scripts/cogs-enrich-batch.ts`, не использует
  `--all`/implicit scope или BJ's и не обходит sealed plan, approval, budget ledger
  или immutable artifacts. Sam's/Costco — только отдельный exact owner-approved club
  plan; `ambiguous` никогда не replay автоматически.
- Для Walmart new-SKU pilot Claude Code только вызывает готовый
  `npm run walmart:new-sku -- doctor|plan|stage|rotate-upc|certify|dry-run|approve|apply|verify`
  и следует exact `next_command`. Он не редактирует движок/tests/schema/migrations,
  не запускает owner/Codex-only `walmart:new-sku:schema` или
  `walmart:new-sku:catalog`, не создаёт owner permit/activation approval и
  останавливается при `next_command: null`. `apply --mode live` требует свежий doctor,
  reviewed apply-preview и отдельный Ed25519-signed external owner permit из pinned
  trust root; hash-only/self-asserted permit запрещён. Pilot release ограничен двумя
  SKU и не разрешает волны 15–20 либо schedule.
- Для Walmart Listing Integrity Claude Code только вызывает готовый
  verifier-wrapper из clean checkout по единственной команде и exact trust inputs
  из `walmart-listing-integrity-operator-runbook.md` (release ID `632bb723…8cc8d8`,
  manifest SHA `b42c3dc5…f618df`), затем только
  `doctor|plan|execute|resume|status|report`, следует exact `next_command` и
  останавливается при `next_command: null`. Прямой запуск mutable
  `scripts/walmart-listing-repair-operator.ts` запрещён. Он не
  редактирует движок/tests/schema/release pins/trust roots/package/permit/receipt,
  не использует legacy multipack writer, `--all`, retry или implicit scope.
  `execute` ограничен одним SKU и одним owner-signed permit; неизвестный POST
  никогда не replay, `resume` выполняет только exact feed GET.
- Датированный handoff — оперативный snapshot, не архитектурный канон.

Если реализация, старый документ или локальный план противоречит OWNER CANON,
не продолжать молча: обозначить расхождение и привести контракт к канону. После
существенного изменения обновить Wiki‑Brain/реестр задач и запустить
`node scripts/wiki-brain.mjs`.

## Обязательный протокол видимого прогресса

Для любой многоэтапной работы агент обязан до существенных действий показать
владельцу конечную цель и полный фазовый чек-лист. В каждом последующем обновлении
использовать одни и те же статусы:

- `✅` — этап завершён и проверен;
- `🔄` — единственный текущий этап;
- `⬜` — ещё не начат;
- `⛔` — ожидает owner gate или внешний вход.

После каждого завершённого этапа агент обновляет план в чате и соответствующий
канонический execution board/реестр задач. Нельзя оставлять владельца более чем на
один существенный tool/test цикл без короткого статуса: где мы, что доказано, что
делается сейчас и что будет следующим. Поток логов или строк кода не заменяет
прогресс-отчёт.
