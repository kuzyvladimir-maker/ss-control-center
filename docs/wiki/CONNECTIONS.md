# 🗺️ CONNECTIONS — Карта связей Wiki

Полная карта зависимостей между wiki-статьями проекта SS Control Center.

---

## Модули

### [Dashboard](dashboard.md)
← [Shipping Labels](shipping-labels.md), [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)

### [Shipping Labels](shipping-labels.md)
← [Veeqo API](veeqo-api.md), [Veeqo API Quirks](veeqo-api-quirks.md) (VAS из shipping_service_options, tracking object-shape, Vercel ephemeral disk), [SKU Database](sku-database-migration.md), [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Procurement](procurement-module.md) (ждёт тега `Placed` на заказе перед покупкой этикетки), [Claude AI](claude-ai.md) (AI classification в [Shipping Labels Page v1](shipping-labels-page-v1.md)), [Google Drive](google-drive-setup.md) (постоянное хранение PDF этикеток), [Drive Backfill](drive-backfill.md) (Layer 2 safety net когда синхронная загрузка упала), [Frozen Analytics](frozen-analytics.md) (risk badge + recommendation per row + PDF filename marker)
→ [Dashboard](dashboard.md), [n8n Автоматизация](n8n-automation.md) (заменён ss-control-center), [Frozen Analytics](frozen-analytics.md), [Adjustments Monitor](adjustments-monitor.md), [Shipment Monitor](shipment-monitor.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Ship Date Trick](ship-date-trick.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Carrier rules](carrier-selection-rules.md), [Label filename](label-filename-format.md), [Shipping Labels Page v1](shipping-labels-page-v1.md) (UI и dashboard)

### [Procurement](procurement-module.md)
← [Veeqo API](veeqo-api.md) (orders + products + tags + internal notes)
→ [Shipping Labels](shipping-labels.md) (ставит тег `Placed` → Shipping Labels автоматически видит заказ как готовый к покупке этикетки; раньше тег ставился вручную), [Telegram](telegram-notifications.md) (Phase 7 — уведомления о приоритетных заказах)
⊂ SS Control Center (auth, design system, Turso БД)
⇔ SKUStorePriority (новая таблица в БД)

### [Bundle Factory](bundle-factory.md)
← Perplexity API (research стадия), OpenAI API (image gen + content backup), [Claude AI](claude-ai.md) (primary text generation), Higgsfield (image + video alternative), Cloudflare R2 (CDN storage для bundle images), GS1 GEPIR (UPC validation), [Amazon SP-API](amazon-sp-api.md) (Listings Items API + Brand Registry для Salutem Vita), [Walmart Marketplace API](walmart-api.md) (item listings), **Vladimir's Walmart Business account** (authoritative для Walmart store registry)
→ [Procurement](procurement-module.md) (новый bundle создаёт дефолтный SKUStorePriority с порядком магазинов), [Dashboard](dashboard.md) (Bundle Factory analytics card в Phase 2)
⊂ **Marketplace Rules KB** (`docs/marketplace-rules/` — 25 файлов: Amazon Gift Set Policy, browse-nodes-grocery, gtin-exemption-process, category-files, Walmart Multipack, eBay, TikTok), Salutem Vita + Starfit Brand Registry, SS Control Center (auth, design system, Turso БД)
⇔ [Customer Hub](customer-hub.md) (Order ID coupling после first order на новом ASIN), [Frozen Analytics](frozen-analytics.md) (новый Frozen bundle → risk profiling), [SKU Database](sku-database-migration.md) (новый bundle → запись с cost & shipping data)
**Phase 0 завершён 2026-05-17:** Концепт (`BUNDLE_FACTORY_CONCEPT_v1_0.md`), Sourcing Map v1.1 (**37 магазинов, 14 Walmart**), Data Model (14 Prisma моделей в `BUNDLE_FACTORY_DATA_MODEL.md`), Marketplace Rules KB (25 файлов), Phase 1 промпт для Claude Code.
**Phase 1 завершён 2026-05-17** (ветка `feat/bundle-factory-phase-1`): 14 Prisma моделей в `prisma/schema.prisma` + миграция (sqlite + idempotent Turso script `scripts/turso-migrate-bundle-factory-phase-1.mjs`) + 5 seed-скриптов (37 stores, 9 brand accounts, 30 marketplace rules, 63 GTIN trackers, UPC pool с graceful skip когда Active Listings Report отсутствует) + 10 API endpoints `/api/bundle-factory/{stores,upc-pool,master-bundles,channel-skus,briefs,drafts,research,marketplace-rules,generation-jobs,lifecycle-logs}` + 7 UI pages `/bundle-factory/{,briefs,drafts,master-bundles,live,stores,settings}` (Salutem Design System v1.0) + sidebar entry. Ready for Phase 2.

### [Phase 2.2 — Variation Matrix + Content Generation](phase-2-2-content-generation.md)
← [Phase 2.1 Research + Image Mirror](phase-2-1-research.md) (consumes curated ResearchPool + BundleDraft at status=VARIATION_SELECTED), [Phase 2.0 Compliance Gate](phase-2-0-compliance-gate.md) (Stage 4 wires `runComplianceGate({ autoFix: true })` after every Claude generation; rules 3 + 4 inject disclaimer), [Phase 2.6.2 Claude Rewrite](phase-2-6-2-claude-rewrite.md) (`disclaimer-text.ts` Variant A reused; banned-words list + style rules mirror PHASE_2_6_2 findings), Anthropic Claude Sonnet 4.5 (per-template generation with prompt caching), `docs/marketplace-rules/{amazon,walmart}/` (baked into `kb-content/` for runtime use)
→ [Phase 2.3 Image Generation](phase-2-3-image-generation.md) (consumes `BundleDraft.status=GENERATED` with all GeneratedContent rows CAN_PUBLISH), [Bundle Factory](bundle-factory.md) (GeneratedContent rows become source for ChannelSKU in Phase 2.4 promote-draft)
⊂ Bundle Factory Phase 2; orchestrator dedups 5 Amazon channels into one Claude call (template owner pays cost; sibling rows carry 0¢); retry budget = 3 attempts per template before manual-review escalation.
⇔ KB content must be synced via `scripts/sync-kb-content.sh` whenever `docs/marketplace-rules/` changes — runtime reads from `kb-content/`, not from the canonical docs tree (Vercel build container can't see siblings above `ss-control-center/`).
⇔ [Bundle Factory Fixes 2026-05-21](bundle-factory-fixes-2026-05-21.md) (`browse-node-resolver` called in `content-pipeline.ts:198` to thread the resolved Amazon node into compliance Rule 5).

### [Phase 2.3 — Image Generation](phase-2-3-image-generation.md)
← [Phase 2.2 Content Generation](phase-2-2-content-generation.md) (consumes `BundleDraft.status=GENERATED` with all CAN_PUBLISH GeneratedContent rows), [Phase 2.0 Compliance Gate](phase-2-0-compliance-gate.md) (Rule 6 vision check activated here — `skip_image_check: false`; `detected_logos` from BLOCKED verdict feeds the next-attempt negative prompt), [Phase 2.1 Research + Image Mirror](phase-2-1-research.md) (reuses R2 setup; main image lives at `prod/<slug>/main<attemptSuffix>.png`), `src/lib/bundle-factory/audit/vision-check.ts` (Rule 6 implementation), OpenAI gpt-image-1 ($0.04 / 1024×1024)
→ [Phase 2.4 Validation](phase-2-4-validation.md) (provides `main_image_url` for `validator-image-dimensions` + `validator-image-format` + `validator-compliance-rerun` with image), [Bundle Factory](bundle-factory.md) (`BundleDraft.main_image_url` populated)
⊂ Bundle Factory Phase 2; `MAX_IMAGE_RETRIES=3`, manual_review_required=true on exhaustion. Status machine GENERATED → IMAGE_GENERATING → IMAGE_GENERATED.
⇔ Cloudflare R2 (storage); Anthropic Vision (Rule 6 runs against the R2 URL).

### [Phase 2.4 — Validation](phase-2-4-validation.md)
← [Phase 2.3 Image Generation](phase-2-3-image-generation.md) (consumes IMAGE_GENERATED draft with R2 image_url; image inspection validators fetch R2), [Phase 2.0 Compliance Gate](phase-2-0-compliance-gate.md) (`validator-compliance-rerun` re-runs full gate with image — fail-CLOSED, vs the rest of validators which degrade-to-warning on throw), [Bundle Factory Fixes 2026-05-21](bundle-factory-fixes-2026-05-21.md) (`browse-node-resolver` written here onto ChannelSKU; per-validator try/catch isolation added; UPCPool seeded so `validator-upc-format` + `reserveUpc` work), [Veeqo API](veeqo-api.md) (`validator-inventory` — fail-soft on Veeqo 5xx)
→ [Phase 2.5 Distribution](phase-2-5-distribution.md) (only `validation_status='PASSED'` ChannelSKU rows are eligible for publish; promote-draft creates the rows with `listing_status='PENDING'`), [Bundle Factory](bundle-factory.md) (ChannelSKU rows materialised here; UPCs reserved from UPCPool)
⊂ Bundle Factory Phase 2; outcomes PASSED → promote / NEEDS_REVIEW → operator / FAILED → no promote. 15 registered validators in `validation-pipeline.ts:63-79`.
⇔ UPCPool (`reserveUpc()` atomic AVAILABLE → ASSIGNED), Brand Registry TODO (per-category Amazon browse-node for single-brand bundles — currently falls back to Gift Basket Exception).

### [Phase 2.5 — Distribution](phase-2-5-distribution.md)
← [Phase 2.4 Validation](phase-2-4-validation.md) (gated by `ChannelSKU.validation_status='PASSED'`), [Amazon SP-API](amazon-sp-api.md) (`PUT /listings/2021-08-01/items/{sellerId}/{sku}`, optional `?mode=VALIDATION_PREVIEW`), [Walmart Marketplace API](walmart-api.md) (Items API `feedType=MP_ITEM_4.7`), [Telegram Notifications](telegram-notifications.md) (`sendSuccessAlert` / `sendFailureAlert` on publish events), [Critical Alerts](critical-alerts.md) (shares Telegram channel)
→ Live marketplace listings on Amazon (`ATVPDKIKX0DER`) + Walmart (US); `ChannelSKU.listing_status` walks PENDING → SUBMITTED → LIVE / FAILED via background `poll-pending` cron.
⊂ Bundle Factory Phase 2 (final stage); DRY RUN by default — `?dryRun=false` required for real writes; auto-abort on error_rate > 10% in batch.
⇔ [Account Map](phase-2-5-distribution.md) (`account-map.ts`) explicitly excludes STORE5 RETAILER (US suspended 2026-05-17, refresh_token revoked) + STORE4 SIRIUS (no SP-API app); n8n cron pings `/api/bundle-factory/distribution/poll-pending` to walk SUBMITTED rows.

### [Bundle Factory Fixes 2026-05-21](bundle-factory-fixes-2026-05-21.md)
⊂ Bundle Factory Phase 2 (post-ship cleanup driven by E2E smoke findings)
← [Phase 2.0 Compliance Gate](phase-2-0-compliance-gate.md) (`BUNDLE_FACTORY_VISION_SKIP` env honoured in `audit/vision-check.ts`; only for smoke / CI, never prod), [Amazon SP-API](amazon-sp-api.md) (Stage A UPCPool seed via `GET_MERCHANT_LISTINGS_ALL_DATA` report)
→ [Phase 2.2 Content Generation](phase-2-2-content-generation.md) (`browse-node-resolver` wired at `content-pipeline.ts:198` for compliance Rule 5), [Phase 2.4 Validation](phase-2-4-validation.md) (`browse-node-resolver` wired in `promote-draft.ts`; per-validator try/catch added to `validation-pipeline.ts`; UPCPool populated so `reserveUpc` works), [Bundle Factory](bundle-factory.md) (3934 UPCPool rows seeded — 934 ASSIGNED from SP-API + 3000 AVAILABLE from `seed-upc-pool-available.ts`)
⇔ `browse-node-resolver` cooperative with compliance Rule 5 (multi-brand bundle → Gift Basket Exception node `12011207011`); single-brand currently uses same node (TODO: per-category Brand Registry mapping).
⇔ E2E smoke `scripts/smoke-bundle-factory-e2e.ts` — parameterised SINGLE_FLAVOR + MIXED_FLAVOR, 14/14 PASS both. Canonical happy-path regression check.

### [Phase 2.1 — Research + Image Mirror](phase-2-1-research.md)
← Perplexity sonar-pro API (Stage 2 grounded retail research, ~$0.01/call), Cloudflare R2 (Stage 2.5 mirror of returned reference images so we don't depend on rotating retailer URLs), [Sourcing Map](bundle-factory.md) (Tier 1 + Tier 2 chains feed the Perplexity system prompt), [Cloudflare R2 setup](cloudflare-r2-setup.md), [Bundle Factory](bundle-factory.md) (BundleDraft / GenerationJob / GenerationStage / ResearchPool tables from Phase 1)
→ Phase 2.2 Variation Matrix (consumes `RESEARCHED` BundleDrafts + their curated ResearchPool), [Phase 2.0 Compliance Gate](phase-2-0-compliance-gate.md) (will be wired into Stage 4 content-gen output in Phase 2.2/2.4)
⊂ Bundle Factory Phase 2; orchestrator `runResearch` writes to ResearchPool + ListingLifecycleLog + GenerationStage in a single transaction-of-effects.
⇔ R2 image mirror is best-effort — on failure the pipeline falls back to retailer URLs and continues (the failure count surfaces in `GenerationStage.output_snapshot.mirror_summary`).

### [Phase 2.0 — Compliance Gate](phase-2-0-compliance-gate.md)
← [Phase 2.0a Listing Audit Tool](listing-audit-tool.md) (BrandConflict table created + seeded here; Rule 7 reads from it), [Phase 2.6.2 Claude Rewrite](phase-2-6-2-claude-rewrite.md) (`disclaimer-text.ts` minimal Variant A wording reused by Rules 3 + 4 — only text verified to survive Amazon PDP code 99300), `src/lib/bundle-factory/audit/vision-check.ts` (Rule 6 reuses `detectForeignLogosInImage` + own-brand whitelist + generic-deli ignorelist from Phase 2.6.0)
→ Phase 2.1 → 2.5 Bundle Factory pipeline (gate is the protective layer between Stage 4 content gen and Stage 7 Distribution; hook points to be wired when Phase 2.1 lands), [Bundle Factory](bundle-factory.md) (`BundleDraft.compliance_status` + `ChannelSKU.compliance_status` gate publication)
⊂ Bundle Factory Phase 2; 8 hard rules over 1 table (ComplianceCheck) + 1 audit-log table (ComplianceAuditLog).
⇔ Phase 2.5 Distribution (will pre-check `compliance_status='CAN_PUBLISH'` before SP-API submit; Telegram alerts on BLOCKED — deferred to Phase 2.5).

### [Phase 2.6.1 — Disclaimer Injection](phase-2-6-1-disclaimer-injection.md)
← [Listing Audit Tool](listing-audit-tool.md) (consumes `risk_reasons` containing "Missing curator/assembler disclaimer" from `ListingAuditResult`), [Amazon SP-API](amazon-sp-api.md) (Listings 2021-08-01 PATCH endpoint), `src/lib/bundle-factory/remediation/disclaimer-text.ts` (Option C Defensive text constants)
→ [Listing Audit Tool](listing-audit-tool.md) (writes back `ListingRemediation` rows + flips `ListingAuditResult.remediation_status` to PLANNED → DONE / FAILED / verification_failed / rolled_back)
⊂ Phase 2.6 Remediation pipeline скелета из Phase 2.0a (`src/lib/bundle-factory/audit/remediation.ts`); paired phases 2.6.2 (Title Rewrite, Claude ~$0.01/listing), 2.6.3 (Image Regen, gpt-image-1 ~$0.04/listing), 2.6.4 (Manual Review)
⇔ Plan→Execute→Verify→Rollback shape — reused as template by 2.6.2 and 2.6.3.

### [Customer Hub](customer-hub.md)
← [Gmail API](gmail-api.md), [Amazon SP-API](amazon-sp-api.md), [Claude AI](claude-ai.md), [Veeqo API](veeqo-api.md)
→ [Dashboard](dashboard.md)
⊂ [Decision Engine](customer-hub-decision-engine.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)

### [Account Health](account-health.md)
← [Amazon SP-API](amazon-sp-api.md)
→ [Dashboard](dashboard.md)
⇔ [A-to-Z & Chargeback](atoz-chargeback.md) (ODR), [Feedback Manager](feedback-manager.md) (Negative Feedback), [Shipping Labels](shipping-labels.md) (LSR/VTR)

### [Frozen Analytics](frozen-analytics.md)
← [Veeqo API](veeqo-api.md), [Weather/Geocoding](weather-geocoding.md), [Shipping Labels](shipping-labels.md), [Shipment Monitor](shipment-monitor.md)
⇔ [Customer Hub](customer-hub.md) (frozen жалобы), [Frozen/Dry классификация](frozen-dry-classification.md), [Frozen shipping rules](frozen-shipping-rules.md)

### [Adjustments Monitor](adjustments-monitor.md)
← [Amazon SP-API](amazon-sp-api.md), [SKU Database](sku-database-migration.md)
→ [Dashboard](dashboard.md)
⇔ [Shipping Labels](shipping-labels.md) (label cost/carrier)

### [Shipment Monitor](shipment-monitor.md)
← [Veeqo API](veeqo-api.md) (tracking events), [Shipping Labels](shipping-labels.md) (label data), [Carrier APIs](carrier-tracking-apis.md) (Level 2)
→ [Dashboard](dashboard.md), [Frozen Analytics](frozen-analytics.md) (delivery timeline)
⇔ [Customer Hub](customer-hub.md) (delivery issues), [Telegram](telegram-notifications.md) (daily report)

---

## Алгоритмы

### [Выбор ставки](shipping-rate-selection.md)
⊂ [Shipping Labels](shipping-labels.md)
← [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md)
→ [Бюджет](budget-check-algorithm.md)
⇔ [Carrier rules](carrier-selection-rules.md)

### [Budget Check](budget-check-algorithm.md)
⊂ [Shipping Labels](shipping-labels.md)
← [Выбор ставки](shipping-rate-selection.md)
⇔ [Walmart ограничения](walmart-restrictions.md)

### [Decision Engine](customer-hub-decision-engine.md)
⊂ [Customer Hub](customer-hub.md)
← [Claude AI](claude-ai.md), [Amazon SP-API](amazon-sp-api.md)
→ [A-to-Z & Chargeback](atoz-chargeback.md)
⇔ [Frozen shipping rules](frozen-shipping-rules.md)

### [Frozen/Dry классификация](frozen-dry-classification.md)
← [Veeqo API](veeqo-api.md) (теги)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md)
⇔ [Walmart ограничения](walmart-restrictions.md), [Frozen Analytics](frozen-analytics.md)

### [Weekend Distribution](weekend-distribution.md)
⊂ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
← [Frozen/Dry классификация](frozen-dry-classification.md), [Timezone правила](timezone-rules.md)
⇔ [Frozen shipping rules](frozen-shipping-rules.md)

---

## Интеграции

### [Veeqo API](veeqo-api.md)
→ [Shipping Labels](shipping-labels.md), [Frozen Analytics](frozen-analytics.md), [Customer Hub](customer-hub.md), [n8n Автоматизация](n8n-automation.md), [Shipment Monitor](shipment-monitor.md)
⇔ [Timezone правила](timezone-rules.md), [Frozen/Dry классификация](frozen-dry-classification.md), [SKU Database](sku-database-migration.md)

### [Amazon SP-API](amazon-sp-api.md)
→ [Customer Hub](customer-hub.md), [Account Health](account-health.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md), [Adjustments Monitor](adjustments-monitor.md)
⇔ [Gmail API](gmail-api.md), [External API Auth](external-api-auth.md)

### [Walmart Marketplace API](walmart-api.md)
→ [Customer Hub](customer-hub.md) (orders + returns sync, заменяет screenshot schema), [Adjustments Monitor](adjustments-monitor.md) (recon reports), [Account Health](account-health.md) (Seller Performance), [Shipment Monitor](shipment-monitor.md) (Level 1.5 tracking), [Shipping Labels](shipping-labels.md) (verification endpoint), [Dashboard](dashboard.md)
⇔ [Veeqo API](veeqo-api.md) (Veeqo использует delegated Walmart key), [External API Auth](external-api-auth.md)
← [Walmart ограничения](walmart-restrictions.md)

### [Gmail API](gmail-api.md)
→ [Customer Hub](customer-hub.md) (Messages + Chargebacks)
⇔ [Amazon SP-API](amazon-sp-api.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Amazon Notifications Map](amazon-notifications-map.md)

### [Amazon Notifications Map](amazon-notifications-map.md)
← [Gmail API](gmail-api.md), [Amazon SP-API](amazon-sp-api.md)
→ [Customer Hub](customer-hub.md), [Account Health](account-health.md), [Shipping Labels](shipping-labels.md), [Adjustments Monitor](adjustments-monitor.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)
⇔ [Dashboard](dashboard.md) (счётчики), [Decision Engine](customer-hub-decision-engine.md), [n8n Автоматизация](n8n-automation.md)

### [SKU Database](sku-database-migration.md)
→ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)
⇔ [Adjustments Monitor](adjustments-monitor.md), [Veeqo API](veeqo-api.md)
← [Database Schema](database-schema.md) (таблица `SkuShippingData`)
Мигрировано из Google Sheets 2026-05-12. Архив: [google-sheets-sku-db.md](google-sheets-sku-db.md) (DEPRECATED).

### [Claude AI](claude-ai.md)
→ [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md), [Feedback Manager](feedback-manager.md), [A-to-Z & Chargeback](atoz-chargeback.md)

### [Telegram](telegram-notifications.md)
→ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md), [Account Health](account-health.md), [Shipment Monitor](shipment-monitor.md)

### [Weather/Geocoding](weather-geocoding.md)
→ [Frozen Analytics](frozen-analytics.md)

### [Carrier Tracking APIs](carrier-tracking-apis.md)
→ [Shipment Monitor](shipment-monitor.md) (Level 2), [Frozen Analytics](frozen-analytics.md)

### [n8n Автоматизация](n8n-automation.md)
Реализует [Shipping Labels](shipping-labels.md)
← [Veeqo API](veeqo-api.md), [SKU Database](sku-database-migration.md), [Telegram](telegram-notifications.md)
⊂ [Выбор ставки](shipping-rate-selection.md), [Бюджет](budget-check-algorithm.md), [Weekend распределение](weekend-distribution.md), [Frozen/Dry классификация](frozen-dry-classification.md)

---

## Бизнес-правила

### [Timezone правила](timezone-rules.md)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [n8n Автоматизация](n8n-automation.md), [Weekend распределение](weekend-distribution.md)
← [Veeqo API](veeqo-api.md)

### [Carrier Selection Rules](carrier-selection-rules.md)
⊂ [Выбор ставки](shipping-rate-selection.md)
⇔ [A-to-Z & Chargeback](atoz-chargeback.md) (Claims Protected), [SKU Database](sku-database-migration.md)

### [Walmart ограничения](walmart-restrictions.md)
→ [Shipping Labels](shipping-labels.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Бюджет](budget-check-algorithm.md)
⇔ [Customer Hub](customer-hub.md)

### [Frozen Shipping Rules](frozen-shipping-rules.md)
→ [Shipping Labels](shipping-labels.md), [Выбор ставки](shipping-rate-selection.md), [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md)
⇔ [Frozen Analytics](frozen-analytics.md), [Frozen/Dry классификация](frozen-dry-classification.md), [Weekend распределение](weekend-distribution.md)

### [Label Filename Format](label-filename-format.md)
⊂ [Shipping Labels](shipping-labels.md), [n8n Автоматизация](n8n-automation.md)

---

## Design / UI mockups

### [Design System](design/index.md)
Каталог HTML‑mockup'ов в `/design/` и описание Salutem Design System v1.0. Источник визуальной правды для Next.js реализации.

**Design tokens (source of truth):**
- `design/DESIGN_TOKENS.md` ⊂ все `design/*.html` (CSS variables, типографика, радиусы)

**Module ↔ mockup (двусторонние связи):**
- `design/dashboard_salutem.html` ⇔ [Dashboard](dashboard.md)
- `design/account_health_salutem.html` ⇔ [Account Health](account-health.md)
- `design/shipping_labels_salutem.html` ⇔ [Shipping Labels](shipping-labels.md)
- `design/customer_hub_salutem_v2.html` ⇔ [Customer Hub](customer-hub.md), [Decision Engine](customer-hub-decision-engine.md), [A-to-Z & Chargeback](atoz-chargeback.md), [Feedback Manager](feedback-manager.md)
- `design/frozen_analytics_salutem.html` ⇔ [Frozen Analytics](frozen-analytics.md)
- `design/adjustments_salutem.html` ⇔ [Adjustments Monitor](adjustments-monitor.md)
- `design/settings_salutem.html` ⇔ [External API Auth](external-api-auth.md), [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Gmail API](gmail-api.md), [Claude AI](claude-ai.md), [Telegram](telegram-notifications.md), [SKU Database](sku-database-migration.md), [Walmart API](walmart-api.md)

**Deprecated:**
- `design/customer_hub_v1_DEPRECATED.html` — архив v1, до алгоритма v2.1

### [Legacy Rebrand 2026-05](legacy-rebrand-2026-05.md)
← [Mobile Adaptation](mobile-adaptation.md) (баг обнаружен в Phase 0 audit)
→ [Auth System](auth-system.md), [Customer Hub](customer-hub.md)
⊂ Salutem Design System

### [Mobile Adaptation](mobile-adaptation.md)
**Phase 2 завершён 2026-05-04** — все таблицы проекта поддерживают мобильное отображение через паттерн "table + cards в одном компоненте". Phase 1 (App Shell) и Phase 2 (таблицы) вместе покрывают весь UI.

← [Design System](design/index.md) (токены не менялись), [Архитектура проекта](project-architecture.md) (Next.js 16, Tailwind v4, shadcn/ui)
⇔ ВСЕ модули (Dashboard, Customer Hub, Adjustments, Frozen Analytics, Claims, Feedback, Shipping, Settings, Account Health) — каждый имеет mobile-version
⊂ AppShell (Phase 1), Sidebar→drawer (Phase 1), Header→hamburger (Phase 1), 13 таблиц→cards (Phase 2)
← MobileNavContext, shadcn/ui:Sheet

---

## Инфраструктура

### [Database Schema](database-schema.md)
→ все модули

### [External API Auth](external-api-auth.md)
⇔ [Amazon SP-API](amazon-sp-api.md), [Veeqo API](veeqo-api.md), [Архитектура проекта](project-architecture.md)

### [Auth System (UI login)](auth-system.md)
← [Database Schema](database-schema.md) (модель User), Turso cloud DB
⇔ [External API Auth](external-api-auth.md) (параллельный механизм), [Архитектура проекта](project-architecture.md), [Деплой на Vercel](deploy-to-vercel-plan.md)

### [Store Filter System](store-filter-system.md)
← [Database Schema](database-schema.md) (`Store.channel` / `Store.storeIndex` / `Store.sellerId`)
→ [Dashboard](dashboard.md), [Sales Cards on Dashboard](sales-cards-dashboard.md)
⇔ `src/components/layout/Sidebar.tsx` (StoreFilterSelector), `src/components/layout/Header.tsx` (StoresLiveBadge)
Phase 2 planned → [Customer Hub](customer-hub.md), [Adjustments Monitor](adjustments-monitor.md), [Account Health](account-health.md), [Shipping Labels](shipping-labels.md)

### [Sales Cards on Dashboard](sales-cards-dashboard.md)
← [Store Filter System](store-filter-system.md), [Database Schema](database-schema.md) (`AmazonOrder`, `WalmartOrder`), [Amazon SP-API](amazon-sp-api.md), [Walmart API](walmart-api.md)
→ [Dashboard](dashboard.md)
⇔ `scripts/backfill-orders.ts` (data fresh-ness)
Phase 2 planned → sales-analytics-module (полноценная страница `/analytics`)

### [Архитектура проекта](project-architecture.md)
Обзорная статья, ссылается на все модули.

---

## Account Health v2.0

### [Account Health v2.0](account-health-v2.md)
← [Amazon SP-API](amazon-sp-api.md) — Selling Partner Insights role (AHR + Policy Compliance), Account Health API, Listings Issues API
← [Walmart API](walmart-api.md) — Seller Performance v2 (Insights API: `/v3/insights/performance/{metric}/summary` × 10 metrics) + Items API (lifecycleStatus для compliance)
← [Telegram Notifications](telegram-notifications.md) — канал доставки Critical Alerts
⇔ [Critical Alerts](critical-alerts.md)
→ [Dashboard](dashboard.md) — счётчик unacknowledged алертов в Health Issues card
⊂ [Database Schema](database-schema.md) — модели `PolicyViolationCategory`, `PolicyViolationDetail`, `WalmartPerformanceSnapshot`, `WalmartItemCompliance`
⇔ `docs/CLAUDE_CODE_PROMPT_ACCOUNT_HEALTH_V2.md` (implementation prompt)

### [Critical Alerts](critical-alerts.md)
⊂ [Account Health v2.0](account-health-v2.md)
← `AccountHealthSnapshot`, `WalmartPerformanceSnapshot` — evaluator создаёт алерты после каждого sync
→ Topbar `CriticalAlertsBell` компонент (polling 30 сек)
→ Telegram (severity CRITICAL/HIGH)
⊂ [Database Schema](database-schema.md) — модель `CriticalAlert`

### Иерархия БД
- `PolicyViolationDetail` ⊂ `PolicyViolationCategory` ⊂ `AccountHealthSnapshot`
- `WalmartItemCompliance` ⊂ `WalmartPerformanceSnapshot`

---

## Легенда
- `←` зависит от
- `→` используется в
- `⊂` является частью
- `⇔` двусторонняя связь

---
Последнее обновление: 2026-05-21 (+ Bundle Factory Phase 2.3 Image Gen, Phase 2.4 Validation, Phase 2.5 Distribution, post-ship Fixes 2026-05-21)
