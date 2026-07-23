# 📚 Project Wiki — Salutem Solutions Control Center

Оглавление базы знаний проекта. Claude Code читает этот файл в начале сессии.

## ▶️ ПРОДОЛЖИТЬ РАБОТУ (читать первым на новой машине)
- **[Product Truth Platform — OWNER CANON](product-catalog-architecture.md) — обязательная архитектура единого товарного справочника: четыре потребителя (Bundle Factory, Listing Improvement, Unit Economics, Procurement), рецепт SKU, точный вариант → фасовка → локальный оффер, provenance и правила достоверности. При конфликте со старым документом побеждает этот канон.**
- **[Product Truth Control Center](product-truth-command-center.md) — живой фазовый execution board постоянного внедрения движка в существующий модуль Catalog: permanent release, canonical API/UI, durable operations, production data gates и staged cutover четырёх consumers.**
- **[Walmart New SKU — execution board](walmart-new-sku-command-center.md) — живой чек-лист превращения готового pilot engine в воспроизводимый optional Bundle Factory submodule и проведения первого SKU до подтверждённого LIVE.**
- **[Дорожная карта донорского каталога](donor-catalog-execution-roadmap.md) — текущий исполнимый план: локальная no-spend стабилизация, authoritative Phase 1 всех Amazon+Walmart listings на grain `(channel, positive storeIndex, raw SKU)`, затем управляемое расширение по брендам/группам/ретейлерам/demand (Phase 2). Содержит migration, budget и action gates.**
- **[Product Truth operator runbook](product-truth-operator-runbook.md) — единственный workflow исполнения готового engine suite: trusted census → authoritative manifest → matcher replay → owner-gated migrations/backfill → readiness → sealed canary/waves через canonical npm-команды. Claude Code здесь оператор, а не автор движка.**
- **[Product Truth release scope](product-truth-release-scope.md) — точный Git boundary готового движка и обязательная clean-checkout сертификация перед передачей Claude Code; локально зелёный dirty worktree не является release.**
- **[Product Truth Matcher Replay v2.2](product-truth-matcher-replay-v2.md) — канонический eight-input offline Gate 1: честный `POST_BLIND_RECONCILED_CONSENSUS` без ложного blind-agreement claim, exact runtime wrapper, one-to-one 386, two-case/four-tier golden и fail-closed 86 unresolved.**
- **[Product Truth consumer cutover](product-truth-consumer-cutover.md) — доказанный аудит legacy bypasses и канонический порядок подключения Bundle Factory, Listing Improvement, Unit Economics и Procurement: manifest-bound gateway, set-based reads, shadow, owner activation и enforced без fallback.**
- **[Product Truth baseline — 2026-07-18](product-truth-baseline-2026-07-18.md) — исторический pre-migration read-only снимок Turso, а не доказательство текущего runtime. Его 4 330 live rows provisional: нет Walmart ITEM_CATALOG report, Amazon store 1 упирается в предел 1 000 строк; authoritative Phase 1 denominator ещё не заморожен.**
- **[SESSION-HANDOFF.md](SESSION-HANDOFF.md) — оперативный исторический handoff и состояние прошлых потоков; читать после канона и roadmap, цифры перепроверять на дату продолжения.**
- **[📡 CHAT-SYNC — доска синхронизации параллельных чатов](CHAT-SYNC.md) — COGS-flow и consumer-чаты фиксируют инциденты, просьбы и вехи. Каноническая машинная граница — durable queue + versioned read-contract; `enrich_priority_skus`/`EnrichedReadySku` остаются только legacy-совместимостью до cutover.**
- **[🗂️ Реестр задач (mission control)](task-registry.md) — все задачи/идеи по всем чатам, сессиям и машинам; статус + иерархия. Читать И обновлять при существенной работе.**
- **[🤝 Разделение труда: обогащение → потребители (КОНТРАКТ)](enrichment-division-of-labor.md) — один общий Sourcing/Enrichment Engine пишет товарную правду; потребители читают каталог и заказывают пробелы через единую очередь, не оплачивая повторный поиск. Текущая COGS-реализация — операционный владелец контура, а не отдельный каталог.**
- **[📉 Даунскейл vision-payload (1536px JPEG)](vision-payload-downscale.md) — почему полноразмерные 2200px PNG в vision забили диск бокса (codex пишет стенограмму с base64 картинки, +4.3 ГБ/сутки) и уронили всю vision через nginx 500. Фикс в `fetchB64()`; 1024px отвергнут — ломает чтение варианта.**
- **[📦 Walmart-фиды: разрешать по ТОВАРАМ, не по фиду](walmart-feed-partial-settlement.md) — `feedStatus` остаётся INPROGRESS, пока не сядет последний item, и один медленный товар держал в заложниках 46 уже применённых. Статус каждого товара доступен сразу: `checkFeedItemsPartial()`.**

## 🗺️ Карта связей
- [CONNECTIONS.md](CONNECTIONS.md) — полная карта зависимостей между статьями

## 🧠 Поддержка базы знаний (авто)
- [Wiki-Brain — авто-санитар знаний](wiki-brain-system.md) — скрипт `scripts/wiki-brain.mjs` + хуки Claude Code ловят сирот, битые ссылки и расхождение код↔доки. Запуск вручную: `node scripts/wiki-brain.mjs`

## 🏛 Орг-схема ЛРХ (построение организации)
- [Орг-схема ЛРХ — индекс раздела](lrh-green-volumes/index.md) — зелёные тома 1–3, ~840 статей, разобраны на отдельные ИП ОХС
- [Командный центр по 7 отделениям](lrh-green-volumes/command-center-orgboard.md) — раскладка модулей продукта по орг-доске
- [Бэклог идей и будущих модулей](ideas-backlog.md) — нереализованные планы

## 🏢 Компания, персонал, обучение
Контентная база будущих модулей **Staff Hats** (Отд 1) и **Training** (Отд 5), оцифрованная с Google Drive 2026-06-21.
- [Компания: описание, миссия, стратегия](company-overview.md) — собрано из проверенных Drive-источников (отдельного mission-документа не нашлось)
- [Шляпы постов (должностные инструкции)](staff-hats/index.md) — хаб должностных инструкций / шляп постов (ФЦ, маркетплейсы, офис)
- [Обучение персонала (курсы)](training/index.md) — хаб курсов обучения (старт: курс по замороженным продуктам)

---

## 🎨 Design / UI
- [Sidebar по орг-схеме (7 отделений)](sidebar-orgboard.md) — левый сайдбар сгруппирован по 7 отделениям ЛРХ (вариант «Канон»), каждое отделение сворачивается стрелкой; превью `design/sidebar_orgboard_preview.html`
- [Design System и mockup‘ы](design/index.md) — Salutem Design System v1.0, каталог 7 HTML mockup'ов в `/design/` (source of truth для Next.js UI)
- [Mobile Adaptation](mobile-adaptation.md) — аудит мобильной адаптации, план перехода (sidebar→drawer, table→cards, breakpoint md=768px)

## 🏗️ Архитектура
- [Архитектура проекта](project-architecture.md) — стек, модули, структура
- [Database Schema](database-schema.md) — Prisma, 19 моделей
- [Auth System (UI login)](auth-system.md) — логин в UI Control Center, SHA-256+salt, session cookies
- [External API Auth](external-api-auth.md) — Bearer token, middleware, MCP Server
- [RBAC — Roles & Permissions](rbac-roles-permissions.md) — кастомные роли, доступ по модулям (вкл/выкл), invite-only, Settings только admin; proxy + access cookie
- [Jackie — full admin API access](jackie-full-access.md) — агент OpenClaw Джеки: его существующий `JACKIE_API_TOKEN` теперь = полный admin на всех 264 эндпоинтах (MCP + manifest + прямой REST); новый токен НЕ создавали

## 📦 Модули
- [Dashboard](dashboard.md) — главная страница, карточки, сводка
- [Store Filter System](store-filter-system.md) — глобальный мульти-селект магазинов (Phase 1: Dashboard) — 2026-05-12
- [Sales Cards on Dashboard](sales-cards-dashboard.md) — 5-period gross revenue + linear forecast (Dashboard) — 2026-05-12
- [COGS / True-Cost Agent](cogs-true-cost-agent.md) — sourcing-часть Product Truth Platform: рецепт SKU + датированная закупочная стоимость товара (`exact/estimate/stale/review/unsourceable`). Полная unit economics отдельно добавляет упаковку, лёд, shipping и fees без двойного счёта. Текущий baseline и стабилизация — в roadmap.
- [Economics / Profit Module (Phase 7)](economics-profit-engine.md) — страница `/economics`: per-SKU профит = цена+доставка − COGS − упаковка − referral − своя доставка; калькуляторы комиссий Amazon vs Walmart; потребляет SkuCost (не дублирует донор-матчинг); estimated-комиссии (актуалы из settlement позже). **7.0+7.1 готово, 7.2 OpEx/P&L ждёт Sellerboard-CSV** — 2026-06-20
- [Finance Core — Funds (Phase 1)](finance-funds.md) — финансовое ядро бизнеса (фонды первыми): cash-basis, общий пул, payout-маркетплейсов → резерв (COGS+shipping+упаковка) → водопад FP1/FP2 → free; UI-CRUD фондов, недельный cron; модели Payout/Fund/FundAllocation/FinancePlanRun. Часть большого Finance super-module (P&L по юрлицам, налоги, payroll, прогноз, QuickBooks) — 2026-06-20
- [Marketplace financial APIs](marketplace-financial-apis.md) — справочник: какие Amazon/Walmart API дают финансы (Statement View = V2 settlement report, Transaction View = financialEvents, реклама = отдельный Ads API), нетто-payout, инкрементальный pull; таксономия бакетов (Get Report «разложить на молекулы») — 2026-06-20
- [Product Resolution & Retail Sourcing Engine](product-sourcing-engine.md) — общий enrichment-мозг для **четырёх потребителей**: Bundle Factory, Listing Improvement, Unit Economics и Procurement. Распознаёт точный вариант, собирает весь доступный payload и локальные first-party офферы один раз для общего каталога.
- [Product Sourcing Engine — Build Plan](product-sourcing-engine-build-plan.md) — **мастер-план step-by-step** (Stages 0–5): схема+UPC → аккаунты сервисов → матчинг → сбор цены/контента/картинок → потребители → авто-обновление. Разделение SS-CC/Jackie, стек сервисов, бюджет $400–900 разово — 2026-06-07
- [Retail Source Capability Matrix](retail-source-capability-matrix.md) — **объективная карта: какой сервис что даёт по каждому ритейлеру** (цена / 1P / фото / состав / пищевая / UPC), по живым пробам. Oxylabs=walmart/amazon/google (Amazon COMPLETE, Walmart без UPC); Unwrangle=walmart-detail(нутриенты/UPC)+target/sams/costco; Publix/Aldi/BJ's=только браузер. Движок роутит по `source-capabilities.ts` (cheapest-first, стоп-при-попадании, дедуп) — 2026-07-05
- [Разделение труда: enrichment → потребители (КОНТРАКТ)](enrichment-division-of-labor.md) — один общий Sourcing/Enrichment Engine пишет product truth; Bundle Factory, Listing Improvement, Unit Economics и Procurement читают единый versioned read-contract и ставят gaps в durable queue. Legacy view/Setting — только переходная совместимость, не канонический интерфейс.
- [Product Truth operator runbook](product-truth-operator-runbook.md) — готовый CLI-контур для doctor/plan/execute/resume/status/report; Claude Code не редактирует engine, не использует legacy batch, не расширяет scope и не обходит owner/budget/action gates.
- [Walmart new-SKU operator runbook](walmart-new-sku-operator-runbook.md) — строгая цепочка готового `walmart:new-sku` engine для Claude Code: только doctor→plan→stage→optional UPC rotation→certify→dry-run→approve→owner-gated apply→verify; pilot 1–2 SKU, без правки кода, SQL/direct API, выдуманного evidence, повторного ambiguous POST и автоматического расширения до 15–20.
- [Walmart Listing Integrity Platform](walmart-listing-integrity-platform.md) — **owner-решение 2026-07-19: постоянная часть Command Center**, вкладка Listing Integrity внутри `/walmart-growth`: для каждого активного Walmart SKU доказать согласованность отгружаемого товара/варианта/count с title+bullets+attributes+MAIN+gallery, затем buyer-facing подтверждение; resumable worker + immutable evidence, product facts только из versioned Product Truth read-contract; Claude Code — operator готового frozen suite.
- [Walmart Listing Integrity — основной план](walmart-listing-integrity-master-plan.md) — постоянный owner-visible чеклист Phase 0–12: один canary, фактическая Qualification и галерея `ДО → ПОСЛЕ`, малый пилот, полный read-only аудит, контролируемые волны и постоянный модуль; Amazon не блокирует первый Walmart canary.
- [Walmart Listing Integrity — operator runbook](walmart-listing-integrity-operator-runbook.md) — единственный bounded workflow Claude Code: doctor→plan→execute/resume→status→report, exact next_command, один SKU/permit/POST, unknown outcome без retry.
- [Walmart Listing Integrity — pause checkpoint 2026-07-19](walmart-listing-integrity-checkpoint-2026-07-19.md) — локально проверенный one-SKU core, 49/49 focused PASS, честный production NO-GO и точный restart order.
- [Walmart Listing Integrity — execution checkpoint 2026-07-21](walmart-listing-integrity-checkpoint-2026-07-21.md) — фазы 0–5 закрыты, полный offline detect→repair→fresh reread→Qualification, bounded operator и clean-checkout verifier-wrapper доказаны, 109/109 PASS; sealed release готов, doctor NO-GO только на owner trust root, live/mass NO-GO.
- [Walmart Listing Integrity — Phase 6 controlled proof](walmart-listing-integrity-phase6-pilot.md) — точный read-only pilot: сначала fresh ITEM v6 + shared Product Truth + complete buyer PDP/MAIN/gallery bytes, затем whole-listing selection в пределах 6 shards/24 images, 0 listing writes; source disposition/key и model execution остаются отдельными owner gates.
- [Procurement Module](./procurement-module.md) — текущий мобильный execution UI вокруг Veeqo плюс будущий planning/optimizer: sale → SKU recipe → inventory deficit → свежие локальные first-party офферы → оптимальный pack/store shopping plan.
- [Bundle Factory](bundle-factory.md) — фабрика листингов для 9 каналов. Исторический Phase 2 довёл общий pipeline до Distribution, но это **не** означает готовность legacy Walmart `MP_ITEM_4.7` к созданию новых SKU. Новый Walmart-контур отдельно требует Product Truth, MP_ITEM 5.0, compliance, sealed approval/lifecycle и buyer-facing verification.
- [Listing Audit Tool](listing-audit-tool.md) — Bundle Factory Phase 2.0a. Сканирует 5 Amazon аккаунтов на foreign-brand риски (по образцу 2026-05-17 incident), 5-rule risk score, batch remediation. Shipped 2026-05-17.
- [Phase 2.0 — Compliance Gate](phase-2-0-compliance-gate.md) — защитный gate между Stage 4 (AI content gen) и Stage 7 (Distribution) Bundle Factory pipeline. 8 hard rules (foreign brands в title, brand field, disclaimer bullets/description, browse node для multi-brand, vision check, permanent blocklist, promotional language). Rules 3+4 имеют auto-fix; vision rule fail-CLOSED. UI: `/bundle-factory/compliance` (4 таба + KPI strip). 31 unit test + 4 smoke cases — все проходят. Shipped 2026-05-19.
- [Phase 2.2 — Variation Matrix + Content Generation](phase-2-2-content-generation.md) — Stage 3 (deterministic composition variant generator, $0 cost) + Stage 4 (Claude Sonnet 4.5 per-channel content with prompt caching of marketplace-rules KB) + Compliance Gate feedback loop (max 3 retries with failed-rule context, manual-review queue beyond). 5 Amazon channels share one Claude call (template owner pays, siblings carry 0¢). Banned words list and disclaimer text are reused from Phase 2.0 + Phase 2.6.2. UI: `/bundle-factory/briefs/[id]` (variant table) + new `/bundle-factory/drafts/[id]` (per-channel content cards). 28 unit tests + 1 end-to-end smoke — all pass. Shipped 2026-05-19.
- [Phase 2.3 — Image Generation](phase-2-3-image-generation.md) — Stage 5 gpt-image-1 main bundle photo (1024×1024) uploaded в Cloudflare R2; Compliance Gate Rule 6 (vision check) активируется post-generation; retry loop до 3 попыток с stronger negative из `detected_logos`. ~$0.04/image. `BundleDraft.status: GENERATED → IMAGE_GENERATING → IMAGE_GENERATED`. Shipped 2026-05-19.
- [Phase 2.4 — Validation](phase-2-4-validation.md) — Stage 6 финальный pre-flight: 15 validators (title/bullets/description/brand/SKU/UPC/dims/weight/COO + amazon-browse-node/walmart-item-type + image-dims/format + compliance-rerun + inventory). Outcome PASSED → `promote-draft.ts` создаёт ChannelSKU rows (UPC из UPCPool, SKU `XX-XXXX-XXXX`). NEEDS_REVIEW / FAILED → operator gate. Per-validator try/catch isolation: одна ошибка — `warning`, не блокирует pipeline. Shipped 2026-05-20.
- [Phase 2.5 — Distribution](phase-2-5-distribution.md) — исторический Stage 7 snapshot (2026-05-20). Его Walmart `MP_ITEM_4.7` adapter и простой feed-poller **не являются текущим new-SKU контрактом** и не должны исполняться для новых Walmart SKU; Amazon-часть и история сохранены в документе.
- [Bundle Factory Fixes 2026-05-21](bundle-factory-fixes-2026-05-21.md) — post-2.5 cleanup: mock research fixture 3→6 items, UPCPool 0→3934 (934 ASSIGNED из SP-API + 3000 AVAILABLE через `seed-upc-pool-available.ts`), `PreconditionError`/`NotFoundError` → 409/404 (вместо generic 500), `browse-node-resolver.ts` (auto-Gift-Basket-Exception для multi-brand bundles), validator isolation (throw → warning), `BUNDLE_FACTORY_VISION_SKIP` env для smoke. E2E smoke `scripts/smoke-bundle-factory-e2e.ts` 14/14 PASS обе case (SINGLE_FLAVOR + MIXED_FLAVOR).
- [Phase 2.1 — Research + Image Mirror](phase-2-1-research.md) — Stage 1 (Brief Input) + Stage 2 (Perplexity sonar-pro Research) + Stage 2.5 (Cloudflare R2 Image Mirror). Multi-step Brief form (`/bundle-factory/briefs/new`); detail page polls Stage 2 progress live; ResearchPool curation (edit/delete) + approve →  VARIATION_SELECTED for Phase 2.2. Mock fixture in dev so UI works without burning Perplexity credit. Stage 4 Compliance Gate hook deferred until content generation lands. Shipped 2026-05-19.
- [Phase 2.6.1 — Disclaimer Injection](phase-2-6-1-disclaimer-injection.md) — bulk SP-API PATCH добавляющий defensive curator/assembler disclaimer в bullets+description для всех листингов с reason "Missing disclaimer". $0 cost, plan→execute→verify→rollback pipeline. Started 2026-05-19.
- [Phase 2.6.2 — Claude Content Rewrite](phase-2-6-2-claude-rewrite.md) — заменяет regex-scrub Фазы 2.6.1 на Claude Sonnet 4.5-generated bullets+description (после того как scrub дал только 1/5 AMZCOM safety pass). Первый safety-test упал 0/6 — оказалось, виноват Option C Defensive disclaimer (триггерил Amazon PDP 99300). После swap'а на минимальную Variant A — safety re-test **10/10 PASS** (5/5 AMZCOM + 5/5 SALUTEM, real PATCH). Full execute остальных ~1028 листингов ждёт явного approval Vladimir. 2026-05-19.
- [Bundle Factory → Listing Studio (Phase 7)](bundle-factory-listing-studio.md) — редизайн Bundle Factory в конфигурируемый «Listing Studio»: источник из донорского каталога, цена из экономики (≥20% маржи), wizard (source/set-type/counts/variations/marketplace/model/image strategy), marketplace-точное превью + approve/edit по аналогии с A+ модулем. Shipped: `donor-pool.ts` (донор→ResearchPool) + `validator-margin-floor` (маржа-гард). Wizard/preview — план (owner sign-off 2026-06-20).
- [Bundle Factory — Master Plan (весь модуль)](bundle-factory-master-plan.md) — форвард-план всего модуля: матрица (режимы own-brand/gift-set × категории frozen/dry × каналы Amazon/Walmart/eBay/Shopify), единый промт-движок, конвейер, roadmap P0–P4. НЕ тонуть в одной ячейке — строим всю матрицу (owner 2026-07-01).
- [Uncrustables preview→publish батч 1+2 (2026-07-23)](uncrustables-preview-publish-batch12.md) — 9 новых mixed-flavor листингов созданы штатным BF-путём и опубликованы на Amazon store1 (все ACCEPTED, 7/9 сразу BUYABLE): официальные составы/аллергены Smucker's, production-proofs в реестре подлинности v3 (MERGED registry), новые обязательные атрибуты GROCERY (`list_price`=цене, `melting_temperature` 32°F), проверенный промт-контракт (row layout + uniform size + exact text), конвейер из 6 скриптов; №10 XL ждёт image-воркер.
- [Uncrustables — реальная упаковочная логика по кулерам](uncrustables-cooler-packing.md) — **операционная истина владельца (2026-07-22)**: рациональные счётчики S до 30 (комфорт 28) / M 48–54 / L 60–66 (72 запрещён) / XL 90–135; мёртвые зоны 31–47, 55–59, 67–89; фасовка 18ct (54=3×18) и 24ct существуют; планировщик генерирует счётчики только из этих диапазонов с приоритетом верхних границ кулеров.
- [Uncrustables Studio — план вшивания конвейера в BF](uncrustables-studio-integration-plan.md) — утверждённый дизайн модуля `/bundle-factory/uncrustables` (2026-07-23): render-before-draft, машина состояний кандидата, human APPROVE/SUBMIT gates, union запечатанных манифестов (частично реализован), submit через существующий `runDistribution()`, ноль правок Codex-lane файлов, фазировка A0–A5 → B; миграция схемы = owner gate.
- [Bundle Factory — Ценообразование, Картинки, Вместимость кулеров](bundle-factory-pricing-and-images.md) — canonical правила владельца (2026-07-01): цена по категориям (frozen=кулер / dry=коробка), вход = целевая маржа/ROI (выведено из бестселлеров: **маржа ~34% / ROI ~70% с базой товар+упаковка+лейбл**), COGS из каталога; титульные картинки (инфо-карточка слотом #1 после main; Uncrustables count-accurate коробки vs индивидуальные упаковки по вкусу; «Gift Set» на кулере); таблица вместимости кулеров ↔ розничные фасовки (Uncrustables 4/10/15, Jimmy Dean 4/8/12, S=12 круассанов / 2×8, M=3×8).
- [Amazon listing rejections — диагностика отказов SP-API](amazon-listing-rejections.md) — почему листинг встал в `FAILED` и как узнать настоящую причину: `VALIDATION_PREVIEW` (не мутирует листинг) через `scripts/_amz_preview.ts`. Разобранные коды: **8572/8566** (UPC не бьётся с brand-записями — утёк бренд `Smucker's` вместо `Uncrustables`; чинится канонизацией на границе публикации) и **99300** (промо-заявления ИЛИ **заявления о доставке/срочности** — «sold and shipped frozen»; ищется leave-one-out через `_bisect_99300.ts`). Пиши «Keep frozen», не «Ships frozen». Классификатор Amazon непоследователен → баним проактивно (`SALE_SHIPPING_CLAIM_BANNED`, Rule 8). Аудит живых листингов: `_scan_claims.ts`. 2026-07-09.
- [Bundle Factory — Real-Photo Composite Main Images + QA Officer](bundle-factory-composite-images.md) — **IP-мандат владельца (2026-07-08)**: для own-brand Uncrustables больше НЕ генерим AI-упаковку (риск выдуманных вкусов / кривого текста → правообладатели). Композитим РЕАЛЬНЫЕ фото донор-коробок (нетронутые пиксели) в сетку на белом: SINGLE = N count-accurate коробок, MIX = variety-сетка всех вкусов. **QA-офицер** (Claude vision, $0) сверяет каждую картинку с эталоном (реальные коробки? белый фон? все вкусы? нет выдуманного текста / retailer-лого?). Cleanliness-picker выбирает чистое фото (Target scene7 > Walmart seo с баннером) и делимый pack (24→6×4). Драйвер `scripts/_img_replace.ts` заменяет картинки на живых листингах (PUT create-or-replace, `republish`). Проверено live на Amazon store1 (2200-композит). Shipped 2026-07-08.
- [Shipping Labels](shipping-labels.md) — план + покупка labels через Veeqo. Полная спец v1.0: [shipping-labels-page-v1.md](shipping-labels-page-v1.md) — dashboard + AI classify + packing profiles (2026-05-12)
- [Discard Label fix + Toasts](discard-label-and-toasts.md) — почему «Discard Label» казалась мёртвой (невидимый фидбэк, не сломанный handler) + новая app-wide toast-система `toast.*` / `<Toaster />` + confirm-диалог (2026-06-08)
- [Shipment Monitor](shipment-monitor.md) — мониторинг доставок, детекция проблем, подготовка claims (спроектирован, после Phase 1)
- [Customer Hub](customer-hub.md) — Messages, A-to-Z, Chargebacks, Feedback (в разработке)
- [Call Center AI Agent](call-center-ai-agent.md) — Sarah, голосовой AI-агент для CS call-центра. 21 секция, 20 категорий звонков (C1-C20), скрипты EN+ES, deescalation (HEARD), anti-fraud, escalation к Vladimir, refund tiers (<$30 auto / $30-50 logged / >$100 escalate). Master Prompt: `CALL_CENTER_AI_AGENT_v1_0.md`. 2026-05-23.
- [Account Health v2.0](account-health-v2.md) — мониторинг Amazon (AHR + Policy Compliance × 10 категорий + ODR/LSR/VTR) + Walmart (8 metrics live через Insights API + Item Compliance), 2 таба, drill-down по нарушениям — 2026-05-12, Walmart Performance v2 — 2026-05-15
- [Critical Alerts Engine](critical-alerts.md) — Telegram + UI push при пересечении критических порогов Amazon/Walmart — 2026-05-12
- [Telegram Notification Routing](telegram-notification-routing.md) — аудит всех Telegram-отправок: что/когда/куда; env-флаги-выключатели (reprice/health/buy/bundle OFF), Walmart → группа. Развели потоки, чтобы личка Джеки не захламлялась — 2026-06-08
- [Account Health (исходный)](account-health.md) — предыдущая версия, оставлена как reference
- [Frozen Analytics](frozen-analytics.md) — инциденты с frozen, SKU risk profiles
- [Adjustments Monitor](adjustments-monitor.md) — корректировки веса/размеров
- [A-to-Z & Chargeback](atoz-chargeback.md) — защита от претензий
- [Feedback Manager](feedback-manager.md) — отзывы, классификация удаляемости
- [Pricing Module](pricing-module.md) — модуль ценообразования: floor/ceiling guardrails, классификация по cost-модели, sync cron (старт с Uncrustables, store1)
- [Pricing & New-Listing Launch SOP](pricing-launch-sop.md) — **канон (Vladimir 2026-07-13, с Джеки):** Layer A = формула 70% net ROI (item = landed×1.5); Layer B = запуск через КУПОН вниз (макс ~13% до floor), база-цена НЕ двигается никогда, купон сужается к нулю; no fake strikethrough / no list-low-and-raise; репрайсер min=floor max=item
- [New-ASIN Launch Experiment (Coupon vs Sale Price)](pricing-launch-experiment.md) — **A/B (Vladimir 2026-07-13):** 163 живых Uncrustables ASIN, база = Layer A ITEM (ChannelMax min/max для обоих плеч); Arm A = купоны группами по count (13%, $1150), Arm B = sale price по-ASIN (13% через SP-API discounted_price); сбалансировано по count-миксу; метрики = первые продажи / units / conversion за 30 дней → какой рычаг эффективнее
- [COGS / Pricing Engine Roadmap](cogs-pricing-engine-roadmap.md) — roadmap: единый каталог SKU с себестоимостью ритейлеров → динамическое ценообразование (6 фаз)
- [Reference Catalog Engine](reference-catalog-engine.md) — техническая архитектура общего Product Truth Platform; подчинена OWNER CANON и обслуживает четыре направления, а не только COGS/контент
- [Amazon Growth Roadmap](amazon-growth-roadmap.md) — стратегия роста Amazon: источники данных, Listing Health Score, план модуля `/amazon-growth`
- [Walmart Growth Roadmap](walmart-growth-roadmap.md) — стратегия роста Walmart: Action Center, List Quality, Buy Box, региональный темплейт доставки
- [Walmart Listing Integrity Platform](walmart-listing-integrity-platform.md) — постоянный контур в Walmart Growth: authoritative audit → exact one-SKU repair → live reread → независимый Qualification Officer; Claude не является ежедневным runtime
- [Walmart write-тулы для Джеки](walmart-write-tools.md) — MCP-тулы `walmart_update_price` (PUT /v3/price или bulk price feed 1.7) + `walmart_update_item` (MP_MAINTENANCE, title/bullets/description/attributes) + `walmart_feed_status`; dry_run у всех, brand-voice блок, тот же Client ID/Secret токен store1 (Sirius) с full_access на price/item/feeds — 2026-07-13
- [Listing Quality Stack](listing-quality-stack.md) — **общий фундамент** для создания (Bundle Factory) И улучшения (Amazon/Walmart Growth) листингов: единый KB (атрибуты из API + правила картинок/контента), генерация картинок (frozen hero + GPT-subscription воркер), полнота атрибутов, brand-voice, QA-офицер. Принцип «один KB + общие модули, не копии» — 2026-06-27
- [Bundle Factory — Rebuild Plan](bundle-factory-rebuild-plan.md) — пошаговый план пересборки (Фазы 0–6): фундамент (реестр атрибутов, чистка KB, brand-voice) → контент из каталога → полные атрибуты → картинки → QA-офицер → каналы → переиспользование в Growth. Owner sign-off 2026-06-27 — 2026-06-27
- [Amazon Brand-Card + Attributes](amazon-brand-card-and-attributes.md) — Food product type (не Grocery) + полный набор атрибутов для поиска (allergen enum fix, condition/expiration/heat/liquid) + единая cold-chain бренд-карточка «Dear customer» в галерею каждого frozen/chilled листинга (генерится один раз gpt-image-2, переиспользуется из R2; активирован ранее пустой путь other_product_image_locator). 2026-07-01
- [Dashboard Refresh Fan-out](dashboard-refresh-fan-out.md) — кнопка Refresh синхронизирует все данные (Amazon, Walmart, Health) параллельно
- [Sales Overview — Hybrid Channels](sales-overview-hybrid-channels.md) — гибридный источник продаж: Amazon/Walmart из cache, остальные от Veeqo; NaN-health исключена
- [Merge Orders](merge-orders.md) — сигнализация объединяемых заказов в Veeqo: группировка по адресу, deep-link в Mergeable view
- [Procurement — Retire From Sale](procurement-retire-from-sale.md) — снятие товара с продажи на Walmart: поиск по каталогу, обнуление инвентаря всех SKU
- [Procurement — Title Source](procurement-title-source.md) — фикс: заголовок берём из строки заказа (customer), не из устаревшего каталога Veeqo
- [Procurement — Walmart Cancellation Check](procurement-walmart-cancellation-check.md) — live-проверка флага отмены от покупателя на странице закупок (одноклик)
- [Walmart Quantity Inquiry](walmart-quantity-inquiry.md) — уточнение количества у клиента по email: поиск аномалий, модалка, крон опроса ответов
- [Walmart Quantity Confusion Fix](walmart-quantity-confusion-fix.md) — мультипаки: детерминированный композит главного фото с сеткой товаров
- [Multipack — исправление чужих/дублирующихся фото (2026-07-01)](2026-07-01-multipack-wrong-image-fix.md) — инцидент+фикс: донор-гейт по 2 словам + identity-blind verify ставили фото не того товара на разные SKU; identity-гейт `frontMatchesListing` (fail-closed) + строгий enrich-матч
- [🎯 Эталон идеального листинга Walmart](walmart-ideal-listing-spec.md) — qualification target: с чем движок СРАВНИВАЕТ листинг (main image / secondary / title / description / bullets / attributes), собран из офиц. гайда Walmart; identity-first «A-до-Я» вместо ложного «есть картинка»; поток Movement #1 (каталог → обогащение Oxylabs+Unwrangle → квалификация → улучшение)
- [Single-unit donor gate + qualification agent (2026-07-04)](single-unit-donor-gate-2026-07-04.md) — фикс инцидента «тайлили мультипак-донор → N упаковок вместо N единиц»: два fail-closed vision-гейта (`qualifyDonorFront` до тайла + `qualifyTiledMain` после), общий водопад `resolveDonorPhoto` (Walmart 1P → Google Images → Sam's/Target) в бою + честный 6-блочный грейд взамен «есть картинка = A-to-Z»

## 🧮 Алгоритмы
- [Выбор ставки (Rate Selection)](shipping-rate-selection.md) — Dry vs Frozen логика (Dry-правила упрощены 2026-05-14)
- [Ship Date Trick](ship-date-trick.md) — автоматический сдвиг Frozen на понедельник для дешёвой ставки — 2026-05-14
- [Budget Check](budget-check-algorithm.md) — формулы бюджета по каналу/типу
- [Decision Engine](customer-hub-decision-engine.md) — 5 слоёв AI-анализа
- [Frozen/Dry классификация](frozen-dry-classification.md) — по тегам Veeqo
- [Weekend Distribution](weekend-distribution.md) — Frozen Пт→Пн/Вт + Ship Date Trick
- [Frozen Risk Cap](shipping-frozen-risk-cap.md) — критический риск ограничивает транзит Frozen 2 днями вместо обычных 3
- [Shipping v3.5 Checkpoint](shipping-v3.5-checkpoint.md) — чекпоинт рабочего состояния: Frozen shipping v3.5 проверена боем (12/12 labels), git-tag для отката

## 🔌 Интеграции
- [Veeqo API](veeqo-api.md) — заказы, ставки, покупка labels
- [Veeqo API Quirks](veeqo-api-quirks.md) — подводные камни (10 пунктов): VAS из `shipping_service_options`, tracking_number бывает объектом, order tags → /bulk_tagging, /buy 200 + errors[], Vercel ephemeral disk
- [Google Drive (PDF этикеток)](google-drive-setup.md) — OAuth refresh-token setup (service account на personal Gmail Drive не работает) — переписано 2026-05-15
- [Drive Backfill (Layer 2)](drive-backfill.md) — async safety net поверх синхронной Drive загрузки; n8n cron каждые 15 мин + admin retry на `/admin/integrations` — 2026-05-15
- [Amazon SP-API](amazon-sp-api.md) — orders, messaging, reports, health, finances
- [Walmart Marketplace API](walmart-api.md) — orders, returns, recon reports, Seller Performance v2 через Insights API (10 per-metric endpoints, 2026-05-15)
- [Gmail API](gmail-api.md) — buyer messages, chargeback notifications
- [Carrier Tracking APIs](carrier-tracking-apis.md) — UPS Tracking (FedEx/USPS в планах), реальный carrier ETA + события
- [Amazon Notifications Map](amazon-notifications-map.md) — маппинг ~30 типов email-уведомлений → модули + Gmail queries
- [SKU Database (Internal DB)](sku-database-migration.md) — веса и размеры, мигрировано из Google Sheets 2026-05-12
- [Claude AI](claude-ai.md) — Decision Engine, генерация ответов
- [Telegram](telegram-notifications.md) — уведомления Владимиру
- [Weather & Geocoding](weather-geocoding.md) — температура для frozen analytics
- [n8n Автоматизация](n8n-automation.md) — 3 workflow для shipping
- [ChannelMAX Guide](channelmax-guide.md) — руководство по Amazon-репрайсеру ChannelMAX: загрузка инвентаря, флэт-файл репрайсинга, колонки
- [Veeqo Package Sync](veeqo-package-sync.md) — sync габаритов в Veeqo: PUT allocation_package, verify из response (без лишних GET)
- [Walmart Buy Shipping](walmart-buy-shipping.md) — покупка этикеток Walmart через SWW API: заказ остаётся Acknowledged, Shipped отмечается отдельно
- [Walmart Multi-node Inventory](walmart-multi-node-inventory.md) — инвентарь на несколько ship nodes: fix retire-listing, чтобы обновлять все склады
- [Drive Folder Structure](drive-folder-structure.md) — структура папок Google Drive для этикеток (по месяцам/дням/маркетплейсам)

## 📋 Бизнес-правила
- [Timezone правила](timezone-rules.md) — UTC-7, America/New_York
- [Cutoff Time Rule (3 PM ET)](cutoff-time-rule.md) — effective ship date → next business day после 15:00 ET; skip weekends/US federal holidays. §0.1 MASTER_PROMPT v3.2 — 2026-05-14
- [Carrier Selection Rules](carrier-selection-rules.md) — UPS preference, USPS after noon
- [Walmart ограничения](walmart-restrictions.md) — no Frozen, no weekend, 10% budget
- [Frozen Shipping Rules](frozen-shipping-rules.md) — ≤3 дня, food safety CS
- [Label Filename Format](label-filename-format.md) — формат имени PDF
- [Timezone EDD (Pacific)](timezone-edd.md) — Veeqo EDD конвертируется в Pacific timezone (не UTC/NY) для совпадения с UI

## 📌 Отложенные задачи (TODO)
- [Деплой на Vercel + Postgres](deploy-to-vercel-plan.md) — план публикации в интернет, ~1ч 15м, отложен 2026-04-10

## Решения и паттерны
- [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md) — миграция Login/Invite/StoreTabs на Salutem Design System

## Известные проблемы и грабли
- [Veeqo API Quirks](veeqo-api-quirks.md) — order tags нельзя ставить через `PUT /orders/{id}` (silently no-op); работает только `POST /bulk_tagging`. Найдено 2026-05-04.
- [Veeqo API Quirks §7](veeqo-api-quirks.md) — VAS поле динамическое, читать из `rate.shipping_service_options[]` (USPS Ground Advantage требует `DELIVERY_CONFIRMATION`, не `NO_CONFIRMATION`). Master Prompt §12 устарел. 2026-05-14.
- [Veeqo API Quirks §8](veeqo-api-quirks.md) — `tracking_number` может быть объектом, не строкой. 2026-05-14.
- [Veeqo API Quirks §10](veeqo-api-quirks.md) — Vercel serverless ↔ `writeFileSync('public/labels')` не работает; нужен Google Drive или fallback на Veeqo URL. 2026-05-14.

---
Последнее обновление: 2026-05-23
- **Call Center AI Agent v1.0** — Master Prompt для голосового AI-агента CS call-центра. Sarah как идентичность, 20 категорий звонков (C1-C20, расширены от текстовых C1-C10), скрипты EN+ES, deescalation (HEARD), anti-fraud patterns, escalation tree, refund tiers по сумме, Voice platform recommendations (Vapi/Retell/ElevenLabs + Twilio + Deepgram + Claude Sonnet 4.x). `docs/CALL_CENTER_AI_AGENT_v1_0.md` + wiki article + CONNECTIONS обновлён.

Предыдущее обновление: 2026-05-21
- **Bundle Factory Phase 2.3 / 2.4 / 2.5 + Fixes** — wiki gap fix. Image Generation (gpt-image-1 + R2 + Rule 6 vision retry), Validation (15 validators + promote-draft → ChannelSKU + UPCPool reserve), Distribution (Amazon PUT + Walmart MP_ITEM_4.7, DRY-RUN by default, Telegram alerts, n8n poll-pending cron). Plus 2026-05-21 cleanup: mock fixture 6 items, UPCPool 3934 entries, PreconditionError 409, browse-node-resolver, validator isolation, E2E smoke 14/14.

Ранее: 2026-05-17
- **Bundle Factory концепт v1.0** — фабрика массового создания gift sets под Salutem Vita / Starfit brand. AI-pipeline в 7 стадий + Marketplace Rules KB + Sourcing Module. Заменяет Phase 2 placeholder "Product Listings". Сопряжён с Amazon Gift Basket Exception (Oct 14, 2024 policy).

---
Ранее: 2026-05-14
- **MASTER_PROMPT v3.2 + Cutoff Time Rule** — effective ship date вместо «today» после 15:00 ET, учёт weekends и US federal holidays. §0.1 нового MASTER_PROMPT.
- Sprint shipping labels в продакшене: VAS из live rate, tracking object-shape, post-buy modal + audit log, Google Drive upload (раньше работал только n8n).
- Ship Date Trick реализован (был "Handle manually").
- Dry rate rules упрощены.
