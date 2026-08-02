# Walmart Bundle Factory: расследование и ремонт 2026-08-02

> **Статус:** ремонт в коде завершён; деплой r21 в процессе (локальная сборка
> прошла, контейнер Vercel падает по OOM — выгрузка prebuilt-артефакта).
>
> **Вход расследования:**
> [[walmart-bundle-factory-independent-diagnostic-handoff]] — нейтральный
> handoff Codex. Расследование выполнено независимо: сырой transcript чата
> `019f778e-2901-7d00-9e51-4a4cc2164492`, production-ledger Turso,
> worker-артефакты, код релизов r8–r19, candidate patch `4a879ef11`.

## Доказанный диагноз

### Первая точка сбоя (2026-08-01 14:38 UTC)

`WEB_CONTROL_CONFIG_INVALID: owner trust root is permitted only in the
owner-gated metered stage` — production env нёс пины релиза r6 (29 июля,
стадия PRODUCTION_READ_ONLY) плюс owner-ключ, что новый код отверг fail-closed.
Класс причины: релизные env-пины обновляются руками отдельно от деплоя.

### Двигатель повторяющегося цикла

1. **Вся идентичность команд и все чтения статуса были привязаны к семи
   релизным пинам** (`commandSeed` + фильтры чтения). Каждый деплой делал
   in-flight batch невидимым (`WEB_CONTROL_BATCH_NOT_FOUND`).
2. **Codex выкатил 12 релизов за 14 часов** (r8–r19), каждый «фикс» обнулял
   видимый мир предыдущей попытки. Ledger: один и тот же batch
   `ptbfw-14e44dd1…` пересоздан под r8/r9/r11/r12; `ptbfw-f993e3d5…` — под
   r17/r18/r19.
3. **UI держал batch ID в sessionStorage вкладки** — рефреш/новая вкладка
   показывали разные вселенные.
4. Под ярлыком `CLI_EXIT_1` — три разных реальных дефекта (по артефактам):
   r8 `TARGETED_EVIDENCE_CANONICAL_MIGRATIONS_REQUIRED` (worker ждал 8
   миграций, в БД было 9 — следствие раздвоения repo: локальный main вёл
   Product Truth, origin — нет); r13 `PRIOR_HARVEST_STATE_FORBIDDEN`;
   r16/r17 `heartbeat HTTP 409 (P2028)` — интерактивные транзакции Prisma не
   переживают латентность Turso.
5. Оплаченные EXECUTE r14/r18 зависли в RUNNING навсегда: финальная запись
   отбита 409/P2028, а статус читался как «живой» процесс.
6. Финал r19: `METERED_BUDGET_PERMIT_CONFLICT` — budget-строка попытки r18
   (immutable per runId+provider) заблокировала новое одобрение того же batch.
   ~15.5 provider credits потрачено, 0 листингов.

### Candidate patch Codex (`4a879ef11`)

Верный слой durable GenerationJob/стабильного URL, но не трогает
admission/worker/budget — сам по себе цикл бы не закрыл. Влит в main и
дополнен фиксами ниже.

## Ремонт (все коммиты в main)

| Коммит | Что |
|---|---|
| `81af85021` | Merge: объединение локального main (95 уникальных коммитов Product Truth/listing-repair) с релизной веткой Codex (r8–r19 + durable build) |
| `6eb141e7e` | Примирение движка: один таймаут control-API (150s — доказано 47-секундными транзакциями Turso), один wall-clock (360s — доказано >3мин search+detail), channel-independent реюз exact-контента (канон: точный ВАРИАНТ, не ритейлер), lease-aware heartbeat + идемпотентное терминальное завершение; из stash доведён standing-wave WIP. Сертификация 719/719 |
| `4f89f79e0`* | Чтения статуса batch — target-scoped (env+db), НЕ release-scoped: деплой больше не осиротляет batch. Пины релиза остаются в командах как audit truth. Started-then-abandoned EXECUTE презентуется терминальным AMBIGUOUS (`ENRICHMENT_WORKER_SIGNAL_LOST_AFTER_START`). Попытка ≥2 получает собственную идентичность batch (`attempt` в identity) — новые runId → свежие budget-строки, никакого наследования authority |
| `aa4aab22f` | AMBIGUOUS/DECLINED — терминальные для durable-build UI (finalize, не вечный poll) |
| `814ea0c43` | Дубль объявления heartbeat-флага из merge |

\* хеш коммита Phase 1 — см. `git log`, сообщение «batch survives deploys».

Тесты: Product Truth certification **722/722**, Walmart/Bundle Factory
**199/199**, durable-build UI 6/6, tsc чистый, production build чистого
дерева — PASS. Регрессия «деплой посреди batch», «вторая попытка»,
«мёртвый lease» — новые тесты в
`product-truth-web-control-admission.test.ts`.

## Развёртывание r21

- Релиз: `product-truth-web-control-2026-08-02-r21`, commit `814ea0c43`,
  tree `b6f2d9c42…`, exec `cd3e0fde1…`.
- Env-пины и оба confirmation пересобраны из production-значений и проверены
  боевым загрузчиком: `ACTIVE / PRODUCTION_READ_ONLY`. Metered-стадию включаем
  непосредственно перед owner-approve платного обогащения.
- Worker + owner-agent переведены на pinned checkout
  `~/.cache/sscc/checkouts/product-truth-r21-814ea0c43` (по политике
  чекаутов), owner-agent health 204.
- Vercel: git-сборки падают по OOM контейнера; артефакт собран локально
  (`vercel build --prod`, rc=0), выгрузка `deploy --prebuilt` ждёт разрешения
  командной строки Vercel в правах Claude Code.

## Урок

Причина трёх суток цикла — не один баг, а связка: раздвоенный репозиторий →
worker и БД из разных миров; release-scoped identity → каждый «фикс»-деплой
стирает контекст; sessionStorage → браузер лжёт; fail-closed дефекты воркера
всплывают по одному. Чинить инцидент двенадцатью деплоями в живой контур —
само по себе усилитель инцидента.

Связанные: [[walmart-new-sku-command-center]],
[[product-truth-web-operations-control-plane]],
[[walmart-new-sku-operator-runbook]], [[product-truth-owner-gates]].

---

## Этап 1 закрыт: пять листингов дошли до VALIDATED (2026-08-02, r40)

Все пять черновиков Campbell's Pack-of-8 проходят валидацию целиком. Что
пришлось починить и почему — каждый пункт был настоящим расхождением, а не
«отключением проверки».

### Полоса (lane) вместо одного набора проверок для всего

У Walmart в Bundle Factory две разные полосы:

1. **frozen pilot** (`walmart:new-sku`) — набор доказательств собирает и
   подписывает владелец вне приложения: здоровье аккаунта, одобрения
   категорий, отзывы (recall), права на бренд, регистрант GS1 за UPC;
2. **studio lane** — фабрика строит листинг сама из одного точного
   канонического варианта, владелец смотрит его на экране.

Проверки пилота требовали от studio-полосы бумаг, которые код не может
произвести честно. Теперь ChannelSKU несёт маркер
`attributes.listing_lane = "WALMART_STUDIO_DRAFT"`, а
`validator-walmart-prepublication` для этой полосы возвращает
`skipped: walmart_studio_lane` (видно в деталях, не молча).

Взамен работает **`validator-walmart-product-truth` в studio-режиме** — он и
защищает от «чужого товара в живой плитке»: точный canonical variant,
неизменяемое content observation, актуальный релиз matcher-а, цена с
observation-id, и MAIN-картинка с SHA-256 исходных байтов, которая обязана
показывать ровно `pack_count` единиц.

### Бренд и вкус: канонические токены — это ключ хеша, а не текст витрины

`component.flavor` — отсортированный мешок токенов для хеширования. На живых
черновиках это дало буллет `Exact flavor or variant: chicken pie pot pub style`
и `Same campbells product`. Настоящее написание производителя лежит в решении
матчера (`decision_evidence.targetIdentity`): `Pub-Style Chicken Pot Pie`,
`Campbell's`. Листинг теперь берёт его (`walmartStudioDisplayFlavor` /
`walmartStudioDisplayBrand`). Где производитель отдельного вкуса не объявляет,
листинг молчит — точное имя товара в тайтле и так несёт вариант.

Артефакт легаси-моста `Campbell'S` (тайткейс через апостроф) чинится точечно.

### Остатки: 50 единиц, объявленные, а не прочитанные

Решение владельца 2026-08-02: по 50 единиц на позицию во всех складах. Бизнес
buy-to-order — склада нет, товар покупается в момент продажи, поэтому чтение
Veeqo описывает склад, с которого этот канал не отгружает. `validator-inventory`
для Walmart возвращает объявленное количество
(`WALMART_STUDIO_DECLARED_INVENTORY_UNITS = 50`), Amazon-путь не тронут.

### Аллергены: закрытый enum Amazon не должен ронять листинг Walmart

Часть доноров публикует набор аллергенов списком в европейской номенклатуре
(`celery`, `molluscs`, `gluten`). Amazon-проекция такие метки отвергает — и это
правильно для Amazon. Для черновика, у которого канал только WALMART,
декларация переносится текстом целиком (`declaredAllergenLabelsFromStored`).
Молча выбросить аллерген из пищевого листинга нельзя ни при каких условиях.

### Вес и габариты: провенанс с честным именем источника

`verified_physical_package` получил второй источник —
`STUDIO_NET_MASS_ESTIMATE`: вес считается от точной заявленной нетто-массы
производителя (Product Truth `sizeBaseAmount`) плюс тара и коробка, коробка
подбирается по объёму из лестницы реальных размеров. Запись прямо говорит, что
это оценка. Измерения оператора через форму Ship specs перезаписывают её.

Для Campbell's 8×18.8 oz: нетто 150.4 oz → объявлено 179 oz, коробка 12×9×6.

### Цена: на странице и в листинге теперь одно число

При промоушене цена пересчитывалась Amazon-моделью (кулеры, FBA) и выходила
ниже той, что владелец видел на карточке черновика ($45.04 против $51.58).
Теперь для studio-черновика берётся цена из его собственной Walmart-экономики —
той, что посчитана по точному shipping-шаблону и 15% referral.

### Тип товара — из живой таксономии Walmart

`GET /v3/items/taxonomy?feedType=MP_ITEM&version=5.0` (store 1, 2026-08-02):
Food & Beverage → Soups, Broths & Bouillon → **Prepared & Packaged Soups**.
Список `WALMART_STUDIO_PRODUCT_TYPES` расширяется только после такой проверки;
неизвестный товар даёт понятную ошибку, а не выдуманный slug.

### Состояние на конец этапа

| SKU | Товар | Цена | Остаток | Валидация |
|---|---|---|---|---|
| AN-WMB4-DL59 | Pub-Style Chicken Pot Pie | $51.58 | 50 | PASSED |
| JF-WMQ7-TFDW | Baked Potato with Steak and Cheese | $51.58 | 50 | PASSED |
| UY-WMX5-TKBA | New England Clam Chowder | $54.78 | 50 | PASSED |
| GR-WM7L-PZ3L | Creamy Chicken and Dumplings | $54.78 | 50 | PASSED |
| TL-WMQ4-8EHY | Chicken Broccoli Cheese | $54.78 | 50 | PASSED |

Публикация на Walmart остаётся отдельным решением владельца (AGENTS.md §2).
