# 🤝 Единый enrichment-контур → четыре потребителя (КОНТРАКТ)

> **Утверждено владельцем 2026-07-08; уточнено 2026-07-18; приведено к OWNER
> CANON 2026-07-26.** Реализует канон [[product-catalog-architecture]] («ОДИН
> Sourcing/Enrichment Engine пишет — все потребители читают»). Название
> «COGS-чат» обозначает исторического операционного владельца общей реализации,
> а не отдельный COGS-каталог и не постоянную runtime-границу.
> Техническая миграция от legacy-очереди к единой durable queue и её gates описаны
> в [[donor-catalog-execution-roadmap]].
> **Статус 2026-07-26:** exact-eight Product Truth schema применена и
> сертифицирована; business-data backfill не выполнен; consumer cutover равен
> `0/4`. Поэтому legacy-интерфейсы ниже описывают только переходную совместимость,
> а не production truth. Authoritative Amazon/Walmart reports и финальный Phase 1
> manifest v3 отсутствуют; paid/provider run не выполнялся.
> Причина: оба чата (COGS и картинки/контент) гоняли ОДИН и тот же конвейер
> «распознай листинг → найди в рознице → запиши донора» независимо → vision-лимиты
> и Unwrangle-кредиты платились ДВАЖДЫ за SKU, а два слепых балансировщика
> насыщали линии друг друга (ночь 2026-07-07/08: −9.4k кредитов при +30 SKU).
> Связано: [[retail-source-capability-matrix]], [[cogs-true-cost-agent]],
> [[task-registry]]. Операторское исполнение готового движка:
> [[product-truth-operator-runbook]].

## Правило одной строкой

**Обогащает один общий Product Truth Sourcing/Enrichment Engine. Bundle Factory,
Listing Improvement, Unit Economics и Procurement читают готовое через versioned
read-contract; если данных не хватает, они ставят запрос в единую очередь и НЕ
запускают собственный identify / retail-search / donor-harvest.**

## Граница разработчик → оператор

Код Product Truth engine создаёт и сертифицирует Codex/разработчик. **Claude Code
не пишет и не изменяет этот движок во время операционного batch:** он только
исполняет готовый CLI-suite:

```bash
npm run product-truth:census -- ...
npm run product-truth:manifest -- ...
npm run product-truth:migrations -- <plan|apply> ...
npm run product-truth -- <matcher-replay|doctor|backfill-plan|backfill-apply|readiness|plan|execute|resume|status|report> ...
```

Полный контракт команд и артефактов: [[product-truth-operator-runbook]]. Для Claude
Code запрещены собственные enrichment-скрипты/SQL/API/browser fallback, legacy
`scripts/cogs-enrich-batch.ts`, `--all`/implicit scope, обход approval/budget ledger,
BJ's и любые publish/delist/reprice/purchase mutations. Sam's/Costco допускаются
только отдельным exact owner-approved club plan; обычные canary/waves идут без clubs.

Каждый canary и каждая новая wave получают новый exact request/runId, sealed plan,
owner approval и immutable artifact directory. `resume` применим только к тому же
безопасно `interrupted` run с теми же plan/approval/DB bindings. `ambiguous` никогда
не replay автоматически: сначала ручная ledger/provider reconciliation и owner
disposition.

Matcher Gate 1 имеет отдельную fail-closed boundary: v2.2 запускается Claude Code
только через exact sealed runtime wrapper из [[product-truth-matcher-replay-v2]], а
не direct npm runner. Offline semantic `304/304 PASS` не разрешает enrichment:
86 source rows остаются `UNRESOLVED_EVIDENCE`, full truth `BLOCKED`, и очередь
1 458 по-прежнему ждёт отдельного authoritative scope/budget owner gate.

## Кто что делает

| Стадия | Владелец | Что пишет |
|---|---|---|
| Распознавание и identity decision | **Product Truth engine** | canonical variant + immutable matcher decision; legacy identity cache — материализация |
| Поиск в рознице | **Product Truth engine** | стабильные donor/offer identities + immutable price/stock observations |
| Рецепт SKU | **Product Truth engine** | full scoped recipe evidence (`variant × qty`); legacy `SkuComponent` — материализация |
| Product acquisition cost | **Product Truth engine** | append-only `SkuCost` + typed component evidence (`FACT/ESTIMATE/UNSOURCEABLE/MISSING/INVALID`) |
| Контент-харвест точного варианта | **Product Truth engine** | immutable exact-only content observations; mutable donor fields — материализация |
| Bundle Factory / Listing Improvement | **consumer adapters** | читают canonical snapshot; создают свои preview/draft artifacts только после своих gates |
| Unit Economics / Procurement | **consumer adapters** | читают typed cost/offer projections; не ищут товар самостоятельно |
| Проверка сгенерированных consumer assets | соответствующий consumer | допустима для его outputs; это не catalog enrichment |

## Интерфейсы контракта

1. **Единая граница чтения — versioned Product Truth read-contract.** Все четыре
   consumer-модуля получают один snapshot recipe, exact content, price/COGS
   evidence и procurement options на заданный `asOf`. Они не строят truth через
   собственные joins к mutable `DonorProduct`, `SkuComponent`, последнему
   ненулевому `SkuCost` или legacy view. Content readiness и price outcome
   независимы: exact content остаётся доступным при estimate/unsourceable цене;
   price proxy никогда не отдаёт content. Authoritative scope задаётся только
   manifest `phase1-authoritative-scope-manifest/v3` на grain
   `(channel, positive storeIndex, raw SKU)`. Его builder policy, SHA-256 exact
   report bytes, owner-disposition input и required-scope census являются частью
   контракта; они не заменяют внешнее доказательство marketplace происхождения.
2. **Legacy readiness — только переходная совместимость.** Turso view
   `EnrichedReadySku` и его исторический `costStatus` не являются каноническим
   multi-consumer readiness contract. После применённой schema, но до
   authoritative manifest/backfill/cutover его разрешено использовать только в
   существующих legacy flows, не выдавая результат за Phase 1.
3. **Единая очередь запросов.** Durable/idempotent queue со статусами, exact need,
   attempt cap, dedup, `runId`, budget guard и terminal outcome реализована.
   `Setting.enrich_priority_skus` — legacy-приоритетный сигнал; список 1 458 нельзя
   платно запускать как authoritative scope или обходить owner budget gate.
4. **Единый vision-роутер** — `askVisionJson()` из `src/lib/sourcing/vision.ts`
   (взвешенные линии + in-flight балансировка + circuit-breaker). COGS-identify
   переключён на него 2026-07-08; свой round-robin в `identify.ts` удалён.
   SKU без фото → text-only через `generateTextViaClaudeWorker` (боксовый Claude-text).
5. **Донор не найден / без галереи / не подходит** — consumer НЕ ищет сам, а
   ставит точную потребность в общей очереди и берёт следующий готовый listing.
   Пока production cutover не выполнен, legacy картинки-flow может записать только
   приоритетный сигнал в `enrich_priority_skus`; это не разрешает автоматический
   paid harvest и не делает появление строки в `EnrichedReadySku` доказательством
   канонической readiness.
6. **QC КАРТИНОК остаётся у картинки-чата (подтверждено 2026-07-08):**
   `qualifyDonorFront` / `qualifyTiledMain` / `pickBestFront` над УЖЕ собранными
   donor-URL и своими сгенерёнными картинками — это контроль качества фото, НЕ
   обогащение. Право выбора/проверки фронт-фото из донорской галереи — за
   картинки-чатом. Запрещён ему только retail-ПОИСК новых доноров.
7. **Один операционный entrypoint.** Управляемые Product Truth canary/waves
   запускаются только через `npm run product-truth -- ...`. Наличие API key,
   legacy script или строки в очереди не является разрешением на paid execution.
   Exact plan, manifest, DB fingerprint, owner approval, confirmation и budget
   ledger обязательны вместе.
8. **Schema/backfill readiness — fail closed.** Локальный schema gate проверяет
   обязательные Product Truth tables/columns/indexes/triggers/foreign keys.
   Отдельный `READ_ONLY_NO_PAID_PLAN` может только сопоставить manifest, migration
   certification, DB target, coverage, writer activity, receipts и integrity
   blockers. Он не применяет migrations, не делает backfill и не вызывает
   providers.
9. **Legacy mutation containment — не consumer cutover.** Amazon repricer
   route/cron, Walmart remediation worker, generated-image apply route и
   remediation enqueue POST hard-retired (`410`). Они не являются аварийным
   fallback; четыре consumers всё ещё требуют staged shadow → owner activation →
   enforced через единый read-contract.

## Что это даёт

- Каждая дорогая операция (vision identify ~30-60с, retail-поиск 1-21 кредит)
  платится **один раз за SKU**.
- Бокс перестаёт быть полем боя двух слепых балансировщиков — один планировщик
  видит общую загрузку линий.
- Качество обогащения одно на всех: strict exact content identity,
  first-party price evidence, честный unsourceable и проверяемый provenance.
