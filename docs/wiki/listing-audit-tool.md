# 🔍 Listing Audit Tool (Bundle Factory Phase 2.0a)

> **Создан:** 2026-05-17
> **Триггер:** Блокировка Retailer Distributor аккаунта за Trademark Logo Misuse (5 ASINs)
> **Цель:** превентивно найти и переделать рискованные листинги в остальных 4 Amazon аккаунтах до того как Amazon их найдёт

---

## 🎯 Что делает

Сканирует все active listings × 5 Amazon аккаунтов (SALUTEM, PERSONAL, AMZCOM, SIRIUS, RETAILER), считает risk score на каждом листинге по 5 правилам и складывает результаты в `ListingAuditResult`. Высокорисковые → batch select → автоматическая remediation через Bundle Factory pipeline (Phase 2.1+) или ручной review.

UI: `/bundle-factory/audit`. Кнопка «Run full audit» → ~5–10 минут → таблица с фильтрами BLOCKED / WARNING / LOW_RISK / COMPLIANT.

---

## 📊 Risk scoring (5 правил)

| # | Правило | Penalty |
|---|---|---|
| 1 | ASIN matches active `BrandConflict` (incident pattern) | +80 |
| 2 | Foreign brand в title под own brand (`Salutem Vita` / `Starfit`) | +40 (+10/extra brand) |
| 3 | Missing curator/assembler disclaimer на Salutem-branded листинге | +15 |
| 4 | Foreign brands present + browse node не Gift Basket Exception | +30 |
| 5 | Claude Vision detected foreign logos в main image | +35 |

Cumulative ≥ 80 → **BLOCKED**, 50–79 → **WARNING**, 20–49 → **LOW_RISK**, иначе **COMPLIANT**.

Vision check (R5) пропускается когда score уже ≥ 80 — экономит ~$0.01–0.02 на каждом BLOCKED листинге.

---

## 🗄️ База данных

4 новые таблицы (см. [Database Schema](database-schema.md) + миграция `20260517010000_bundle_factory_phase_2_0a_audit`):

- **ListingAuditScan** — один run, аггрегированные счётчики
- **ListingAuditResult** — одна строка на каждый отсканированный листинг + risk score
- **ListingRemediation** — 1:1 follow-up работа по рискованному листингу
- **BrandConflict** — permanent blocklist (seeded из 2026-05-17 incident, 5 ASINs)

---

## 🔌 SP-API integration

- **Sellers API** (`/sellers/v1/marketplaceParticipations`) — авто-получение `selling_partner_id` для каждого аккаунта, кэшируется per-scan
- **Listings Items API 2021-08-01** (`/listings/2021-08-01/items/{sellerId}/{sku}`) — read-only для audit, PATCH для remediation (Phase 2.1+)
- Rate limit: 5 req/sec per store → 220ms throttle между detail fetches
- Parallel across 5 accounts, sequential pagination внутри
- 200-page safety cap на account (= 4000 listings ceiling)

---

## 🤖 AI Vision

`src/lib/bundle-factory/audit/vision-check.ts` — Claude Sonnet 4.5 wrapper. Запрос: «list all brand logos visible, distinguish own brand from foreign». Response JSON: `{has_foreign_logos: bool, detected_logos: string[]}`.

Cost: ~$0.01–0.02 per image. Graceful degradation если `ANTHROPIC_API_KEY` не задан — vision просто пропускается, остальные 4 правила работают.

---

## 🛠️ Remediation pipeline

Phase 2.0a — только **manual_review** path:
1. Operator select высокорисковые в UI
2. POST `/api/bundle-factory/audit/remediate` → создаёт `ListingRemediation` rows со `status='manual_review'`
3. Vladimir обрабатывает руками через Bundle Factory (когда Phase 2.1 готов)

Auto-remediation (Phase 2.1+) — stubs в `src/lib/bundle-factory/audit/remediation.ts` бросают `NotImplementedError`. Запланированный порядок:
1. `extractProductEssence` (text → essence)
2. `generateCompliantTitle` (Claude + title-policy.md)
3. `generateCompliantBullets` (+ disclaimer)
4. `generateCompliantDescription` (+ disclaimer)
5. `regenerateMainImage` (gpt-image-1, no foreign logos)
6. `runComplianceGate` (Phase 2.0 gate)
7. `spApiPatchListing` (PATCH к Amazon)

---

## 💰 Cost estimate

- **Один full audit scan:** ~$10–20 (Vision на 1000+ listings × 5 accounts)
- **Per-listing remediation (Phase 2.1+):** ~$0.13–0.27
- **Первая чистка (50–100 remediations):** ~$20–50 total

После first run — monthly audits ~$10–20/mo.

---

## ⚙️ Deploy

1. Local migration уже применена через `prisma migrate`
2. Turso production: `node scripts/turso-migrate-bundle-factory-phase-2-0a-audit.mjs` (вручную)
3. Optional seed permanent blocklist в prod: `SEED_TARGET=turso npx tsx prisma/seed.ts`

⚠️ Vercel Hobby (60s function cap): full scan может быть убит mid-run. Partial results остаются queryable, scan можно re-run. Долгосрочный fix — переезд триггера на n8n VPS или upgrade plan.

---

## 📚 Связанные документы

- [Bundle Factory](bundle-factory.md) — родительский модуль
- [Amazon SP-API](amazon-sp-api.md) — общая инфраструктура SP-API
- `docs/BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md` — полная спецификация
- `docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md` — compliance rules (shared с Phase 2.0)
- `docs/marketplace-rules/amazon/title-policy.md` — Section 6 hard rule на foreign brands

---

**Maintained by:** Vladimir + Claude · **Phase 2.0a shipped:** 2026-05-17
