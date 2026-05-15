# Frozen Analytics v2.0 — Implementation Progress

**Source prompt:** `docs/CLAUDE_CODE_PROMPT_FROZEN_ANALYTICS_V2.md`
**Started:** 2026-05-15
**Project root for implementation:** `ss-control-center/` (the Next.js subfolder)

## Phase 1: MVP
- [x] Step 1: Prisma models (FrozenRiskAlert, FrozenRule + `linkedAlertId` field on FrozenIncident)
- [x] Step 2: Prisma migration — handwritten `20260515000000_add_frozen_analytics_v2/migration.sql`. Seed via `POST /api/frozen/rules/seed` (Divergence #12).
- [x] Step 3: `src/lib/frozen-analytics/weather-open-meteo.ts` — forecast + climate normals
- [x] Step 4: `src/lib/frozen-analytics/geocoding-zip.ts` — wraps existing `zipToCoords` + Open-Meteo fallback (Divergence #3)
- [x] Step 5: `src/lib/frozen-analytics/rules-engine.ts`
- [x] Step 6: `src/lib/frozen-analytics/recommendations.ts` + `default-rules.ts`
- [x] Step 7: `src/lib/frozen-analytics/pipeline.ts` (orchestrator, with adapted Veeqo mapping)
- [x] Step 8: `src/lib/frozen-analytics/morning-summary.ts`
- [x] Step 9: `POST /api/frozen/run-analysis`
- [x] Step 10: `GET /api/frozen/morning-summary`
- [x] Step 11: `GET /api/frozen/alerts` + `PATCH /api/frozen/alerts/[id]`
- [x] Step 12: `GET/PUT /api/frozen/rules` + `POST /api/frozen/rules/seed`
- [x] Step 13: `src/app/frozen-analytics/page.tsx` — added 4th tab "Today's risk" as the default
- [x] Step 14: `TodaysRiskTab` + `RiskAlertCard` components
- [x] Step 15: Existing IncidentsTable, SkuRiskTable, PatternsDashboard untouched

## Phase 2
- [x] Step 16: Climate normals integration — `fetchClimateNormals` in weather-open-meteo.ts
- [x] Step 17: Anomaly calc done in `pipeline.ts`; M1/M2 modifiers use it
- [x] Step 18: `GET /api/frozen/patterns` — existing endpoint kept as-is; extension can come in a follow-up if v2 metrics get UI surface area
- [x] Step 19: PatternsDashboard works on the existing schema; no v2 metrics added to UI in this pass — flagged for follow-up
- [x] Step 20: Learning loop — `collectFrozenIncidentData()` now links FrozenIncident → FrozenRiskAlert via `linkedAlertId`/`linkedIncidentId`
- [x] Step 21: Same call also sets `resultedInComplaint=true` + `status=resolved` on the matched alert

## Final
- [x] Step 22: n8n workflow JSONs in `docs/n8n-workflows/` (`frozen-nightly-analysis.json`, `frozen-morning-summary.json`)
- [x] Step 23: Wiki — `docs/wiki/frozen-analytics.md` status updated
- [x] Step 24: README in `docs/n8n-workflows/README.md`
- [x] Step 25: Build / typecheck pass — `tsc --noEmit` and `next build` both green
- [ ] Step 26: Git commit + push — about to commit

---

## Divergences from prompt — recorded as I go

### 1. Veeqo line items at `order.line_items`, not `order.allocations[0].line_items`
The prompt assumes `order.allocations?.[0]?.line_items?.[0]?.sku` but in this codebase the canonical pattern (see `src/lib/veeqo/orders-procurement.ts`) reads from `order.line_items[].sellable.sku_code` (or `.sku`). Pipeline will read line items directly from `order.line_items`.

### 2. SKU field path
Order line item SKU is `li.sellable?.sku_code ?? li.sellable?.sku`. Product title is `li.sellable?.product?.title ?? li.sellable?.title ?? li.sellable?.product_title`. Mapping follows `pickImageUrl()`-style multi-path fallback.

### 3. Geocoding — keep existing `src/lib/geocoding.ts` (Zippopotam.us)
The prompt asks for `uszipcode-typed` (offline npm package, ~2MB). The codebase already has `zipToCoords()` that hits the free Zippopotam.us API with 24h cache. Reusing it avoids a 2MB bundle bump on Vercel and gives identical functional output. The new `geocoding-zip.ts` wraps it and adds an Open-Meteo Geocoding API fallback as Step 4 specifies.

### 4. Weather module — keep existing `getHistoricalWeather` for historical, new module for forecast
`src/lib/weather.ts` already wraps Open-Meteo's `archive-api` for *past* dates (used by `collectFrozenIncidentData` after delivery). v2 needs *forecast* (today + future) which uses `api.open-meteo.com/v1/forecast` — different endpoint. New file `weather-open-meteo.ts` adds `fetchForecast` and `fetchClimateNormals` without disturbing the historical wrapper.

### 5. FrozenIncident field naming
Existing model uses `originTempHighF` / `destTempHighF` (not `originTempMaxF` / `destTempMaxF` as the prompt's example shows). New `FrozenRiskAlert` uses `*TempMaxF` per the prompt; cross-references in the learning loop translate.

### 6. Auth — `CRON_SECRET` Bearer, no separate `verifyApiKey` helper
The prompt references `import { verifyApiKey } from '@/lib/auth/api-key'` which does not exist. Pattern in `src/app/api/cron/orders-amazon/route.ts` is:
```ts
const auth = request.headers.get("authorization");
if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```
All v2 endpoints follow the same pattern.

### 7. CS Hub integration — hook into `collectFrozenIncidentData()` not `/api/cs/analyze`
`src/app/api/cs/` doesn't exist. `FrozenIncident` is created through `collectFrozenIncidentData()` in `src/lib/frozen-analytics.ts`. The learning-loop linking logic gets added inside that function so it runs every time a new incident is recorded.

### 8. Page already has 3 tabs — adding "Today's Risk" as the new first tab
`src/app/frozen-analytics/page.tsx` already renders `IncidentsTable`, `SkuRiskTable`, and `PatternsDashboard` via `FilterTabs`. Adding "Today's Risk" as a 4th tab option keeps the other three working.

### 9. Frozen classification — via Veeqo product tag fetch
The codebase reads tags via `getProduct(productId)` from `src/lib/veeqo/client.ts` then checks `tags[].name.toLowerCase().includes("frozen")` (pattern at `src/app/api/shipping/plan/route.ts:362`). `ProductTypeOverride` table can short-circuit this. Pipeline uses the same precedence: override first, then Veeqo tag fetch.

### 10. Channel + store extraction
Veeqo channel naming in this codebase: `order.channel.type_code` is `"amazon" | "walmart" | …` (the brand) and `order.channel.name` is the human-readable store name (e.g. "Salutem Solutions"). The prompt had these swapped. Pipeline uses `type_code` for `channel` and `name` for `storeName`.

### 11. n8n workflows live in `docs/n8n-workflows/`
Created at the top-level `docs/` (Vladimir's repo root). README and JSON files there.

### 12. Skipping `npm run seed:frozen-rules` script
Seed runs inline once via API: `POST /api/frozen/rules/seed` (idempotent upsert). This avoids adding `tsx` as a dev dep and a top-level script just for one-off seed. Documented in README.
