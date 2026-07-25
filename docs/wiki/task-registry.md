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

## Активная инициатива: Product Truth Platform / постоянный Catalog

**Канон:** [[product-catalog-architecture]] · **живой board:**
[[product-truth-command-center]] · **оператор:** [[product-truth-operator-runbook]].

Это один независимый от каналов Product Truth Platform для Bundle Factory,
Listing Improvement, Unit Economics и Procurement. Canonical variant catalog,
exact marketplace listing scope и SKU recipe — разные проекции одной платформы,
а не параллельные каталоги. Content truth и price/COGS outcome независимы.

- 🟢 Phase 0 — канон, execution board и безопасный release boundary проверены.
- ⛔ Phase 1 — current engine уже находится в permanent source; узкий docs/recovery
  import candidate полностью проверен и ждёт отдельного owner merge decision.
- 🟢 Phase 2 — в изолированной candidate branch готов authenticated default-OFF
  read-only API `/api/catalog/product-truth/[view]`: overview/readiness,
  variants/content/offers, exact listing recipes/COGS, runs/queue/budgets/blockers.
  Product Truth `436/436`, TypeScript/ESLint/build `PASS`; paid/provider/production
  действий не было.
- 🟢 Phase 3 — единый Catalog / Product Truth UI с семью canonical views; старые
  `/reference-catalog` и `/cogs` остались aliases без legacy API reads. Product
  Truth `437/437`, TypeScript/ESLint/build `PASS`.
- ⛔ Phase 4 — default-OFF workflow, sealed runs/queue/budgets/blockers видимы;
  Execute/retry/replay отсутствуют. Completion/threat audit и canonical
  [[product-truth-web-operations-control-plane]] готовы: не дублировать внутренний
  operational ledger; отдельные SSCC command/artifact/event tables, append-only DB
  custody, новый Product Truth Ed25519 domain и pinned external worker. Реализация
  Stage A ждёт exact owner gate; production activation/spend он не разрешает.
- 🟢 Phase 6 contract preparation — pure hash-bound adapters всех четырёх consumers
  готовы (`7/7`): Bundle Factory draft seed, Listing Improvement preview seed,
  Unit Economics typed basis и Procurement factual-pack review plan. Они не имеют
  DB/network/provider/process surface и не означают runtime activation. Gateway
  `1.1.0` несёт exact recipe variant/qty для inventory и не выводит target из offer.
- ⚪ Далее — authoritative manifest/backfill/readiness, затем staged business-runtime
  cutover `OFF → SHADOW → ENFORCED` по одному consumer и только потом
  owner-approved canary/waves. Production cutover остаётся `0/4`.

---

## Активная инициатива: Walmart multipack — довести листинги до эталона (100%)

**Чат-владелец:** «SS Command Center / multipack remediation» (сессия ba0c998a, iMac, 2026-07-04→).
**АРХИТЕКТУРА (канон для всех 3 чатов):** [[product-catalog-architecture]] — ОДНА
Product Truth Platform с разными проекциями (канонический вариант и exact
marketplace listing scope) + связь = РЕЦЕПТ (вариант×кол-во, НЕ GTIN) + ОДИН
enrichment-контур пишет, все читают. Этот чат
(картинки) = ПОТРЕБИТЕЛЬ каталога; наш водопад/vision/гейты = сорсинг-слой движка.

**Главная цель (ствол):** все листинги Walmart-мультипаков в идеальной картине —
правильное главное фото (N одиночных единиц нужного товара) + SEO/LLM-текст +
максимум атрибутов, где офицер квалификации проверяет КАЖДЫЙ пункт по каждому
листингу. Порядок: сначала финализировать весь уже-тронутый бэклог (~743), потом
новые пачки, потом весь каталог. Эталон: [[walmart-ideal-listing-spec]].

### Ветки
- 🟢 **Single-unit гейт + агент квалификации** — донор не может быть мультипаком; `qualifyDonorFront` (до тайла) + `qualifyTiledMain` (после). Честный 6-блочный грейд взамен «есть картинка = A-to-Z». Коммит 71aeaba. [[single-unit-donor-gate-2026-07-04]]
- 🟢 **Codex-Vision ($0)** — гейты через ChatGPT-подписку (GPT-5.4), Sonnet-резерв; паритет 8/8. Коммит 0b680c1.
- 🟢 **Расширенный водопад магазинов** — Walmart 1P → Sam's/Target/Costco → Publix/BJ's/Aldi (OpenClaw) → Google Images (крайний край) → генерация. Коммит 8687094.
- 🟢 **Второй бесплатный vision-воркер = Claude CLI (Max-подписка)** — `/analyze-claude` на боксе, отдельная очередь (параллельно Codex), диспетчер round-robin двух дорожек. ~2x скорость, $0. Коммит 6fc092f.
- 🟡 **Финализация бэклога — КАНОНИЧНЫЙ ПАЙПЛАЙН, полный прогон 743 идёт** (обновлено 07-07, мультипак-чат ba0c998a). ⛔ **Прежний план «REVERT 11» ОТМЕНЁН — НЕ ИСПОЛНЯТЬ:** категория «not-multipack:20» из ночного аудита была багом скретч-эвристики (`realUnits` обнуляла пак по словам «Count/Ct/Bags», игнорируя авторитетный packCount) — владелец поймал по 3 скриншотам; из 20 семь корректны (не трогать), 11 — обычный wrong-product → REBUILD. Правило: [[feedback_packcount_source_of_truth]] (packCount — истина; «реверта на одну» в алгоритме не существует). Также починены bakery-quirk гейта (пакет булок = 1 единица) и fetchB64-ретраи (фантомные ошибки R2). **Канон = `_pipeline.ts`** (шаг 0: квол текущей живой картинки → pass = не трогаем; иначе identify → одиночный донор → плитка ×packCount → квол-офицер; getItem-тайтлы для пустых; чекпоинт `_pipeline_state.json`). **✅ Первые 9 ОПУБЛИКОВАНЫ 07-07 (явный ОК владельца, item-level ingested 9/9):** Jarritos ×2/×4/×6 + 5 Pepperidge/Sara Lee + Lance-был-Oreo; `FaisalX-1156` придержан (промо-плашка у донора). **Полный прогон 743 в фоне** → галерея `walmart-review/full-run.html` → QC владельца → публикация батчами + item-level верификация. История аудитов (справочно): `reaudit686.html`, `final-audit.html` (315 «живых дефектных» — цифра слегка завышена bakery-quirk'ом; истина будет из прогона канона).
- ⚪ **Codex/vision очередь с приоритетами** — ручной Bundle Factory + обогащение каталога не должны толкаться и терять работу; BF по ночам, обработка листингов отдельно.
- ⚪ **3-слойная донорская база** — сырьё от первоисточника (+ описание, привязанное к КАЖДОМУ фото) / наши текущие данные / LLM-генерация по политике маркетплейса. Основа: [[reference-catalog-engine]].
- ⚪ **Комбинированный vision-промпт** — один вызов: описать каждое фото + сразу выбрать лучшее для титульной плитки (меньше вызовов + обогащает базу).
- ⚪ **Новая чистая пачка 100** — только после финализации бэклога; полный пайплайн + офицер квалификации по каждому пункту.
- ⚪ **Полный каталог** — прогон на бесплатных дорожках после того, как пачка 100 = 100/100.

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
