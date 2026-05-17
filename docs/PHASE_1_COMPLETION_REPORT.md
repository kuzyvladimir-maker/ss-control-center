# Bundle Factory Phase 1 — Completion Report

**Branch:** `feat/bundle-factory-phase-1`
**Started:** 2026-05-17
**Completed:** 2026-05-17
**Pushed to remote:** see §9 below

---

## ✅ Completed

### 1. Database — Prisma schema + migration
- [x] 14 new Prisma models appended to `ss-control-center/prisma/schema.prisma` (existing 30+ models untouched).
- [x] Migration `prisma/migrations/20260517000000_bundle_factory_phase_1_initial/migration.sql` (created via `prisma db push`, captured from generated DDL).
- [x] All 9 enum types from the data-model spec encoded as TEXT columns (SQLite + Prisma 7 do not support native enums). Allowed values live in `src/lib/bundle-factory/enums.ts` as `as const` tuples + literal-union types.
- [x] Schema validates (`npx prisma validate`).
- [x] Prisma client regenerated.
- [x] `npx tsc --noEmit` passes.
- [x] `npx next build` passes — no errors, no warnings.

### 2. Turso production migration
- [x] `ss-control-center/scripts/turso-migrate-bundle-factory-phase-1.mjs` mirrors the SQL idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Vladimir runs it manually after PR review with:
  ```bash
  cd ss-control-center
  node scripts/turso-migrate-bundle-factory-phase-1.mjs
  ```

### 3. Pre-seed data — 5 idempotent seeders
- [x] `prisma/seed/store-registry.ts` → **37 stores** (Walmart 14 + Publix 9 + Target 3 + Winn-Dixie 3 + ALDI 2 + BJ's 1 + Sam's 1 + Costco 1 + Whole Foods 1 + Trader Joe's 1 + Fresh Market 1) with coordinates, distances, hours, delivery programs from `BUNDLE_FACTORY_SOURCING_MAP.md` v1.1.
- [x] `prisma/seed/brand-account.ts` → **9 mappings** (Salutem Vita × 5 channels + Starfit × 4 channels).
- [x] `prisma/seed/upc-pool-import.ts` → parses the newest `data/imports/Active_Listings_Report_*.txt`, filters UPCs to 742259/789232/617261 prefixes. **Gracefully skips with a TODO log when the file is absent** (Vladimir will drop the report in later).
- [x] `prisma/seed/marketplace-rules-seed.ts` → **30 hot-path rules** (Amazon title/bullets/images/gift-set/browse-node, Walmart title/multipack/images/frozen-restriction, eBay/TikTok placeholders).
- [x] `prisma/seed/gtin-exemption-init.ts` → **63 rows** (9 brand-channel pairs × 7 categories) all defaulting to `NOT_REQUESTED`.
- [x] Orchestrator `prisma/seed.ts` (registered in `prisma.config.ts` via the Prisma 7 `migrations.seed` field).
- [x] Seeder defaults to **local dev.db** even when `TURSO_DATABASE_URL` is present in `.env`, to prevent accidentally writing seed data to production. Opt-in to Turso explicitly with `SEED_TARGET=turso`.
- [x] `npx prisma db seed` runs clean: `stores=37 accounts=9 upcs=0 rules=30 exemptions=63`.

### 4. API endpoints — 10 routes
All under `/api/bundle-factory/`. Each wraps a `withErrorHandler` helper for JSON 500 fallback and 400 input-validation responses. Validation uses the enum tuples from `src/lib/bundle-factory/enums.ts`.

| Route | Methods | Purpose |
|---|---|---|
| `stores/route.ts` | GET | Filter by chain / tier / active; sorted by distance |
| `upc-pool/route.ts` | GET, POST | List + pool summary; POST `{action:"reserve"}` to allocate UPC |
| `master-bundles/route.ts` | GET, POST | Filter by status/brand/category; POST creates + audit-logs |
| `channel-skus/route.ts` | GET, POST | Filter by channel/status/master_bundle_id; POST creates + audit-logs |
| `briefs/route.ts` | GET, POST | DRAFT BundleDrafts (pipeline inbox) |
| `drafts/route.ts` | GET, POST, PATCH | Non-DRAFT BundleDrafts; whitelisted partial updates |
| `research/route.ts` | GET, POST | ResearchPool list + placeholder create |
| `marketplace-rules/route.ts` | GET | Cache of MarketplaceRule; parses `rule_value` JSON for callers |
| `generation-jobs/route.ts` | GET, POST, PATCH | Create job, stat updates |
| `lifecycle-logs/route.ts` | GET | Audit-trail reader (entity_id / type / FK filters) |

Smoke-tested via curl against the running dev server: routes load, hot-reload, return 400 on invalid enum input, return well-formed errors when the underlying table is missing.

### 5. UI — 7 pages under `/bundle-factory/`
Strict adherence to Salutem Design System v1.0 (cream + forest green + matte silver, ink palette, tabular-nums for every number, 14px panel radii, 8/10/14px rounded chips). No `text-black`, no `bg-white` on green backgrounds, no red for negative values.

- `page.tsx` — Overview with 4 KPI cards (Master Bundles, Channel SKUs, Drafts in flight, UPC Pool) + 2 section cards.
- `briefs/page.tsx` — DRAFT BundleDrafts.
- `drafts/page.tsx` — Non-DRAFT BundleDrafts with status pills.
- `master-bundles/page.tsx` — Filterable list of MasterBundles with component + ChannelSKU counts.
- `live/page.tsx` — ChannelSKUs in LIVE status, grouped by channel, with 30d sales totals.
- `stores/page.tsx` — All 37 pre-seeded sourcing stores, filterable by chain + tier.
- `settings/page.tsx` — UPC pool stats, brand account mappings, GTIN exemption tracker, marketplace rule cache.

Supporting components in `src/components/bundle-factory/`:
- `BundleFactorySubNav.tsx` — horizontal-scroll chip nav (sticks to design system).
- `StoreChainFilter.tsx` — chain + tier chip filters that update `?chain=` and `?tier=` params.

### 6. Sidebar integration
- [x] Bundle Factory entry added to the Phase 2 nav section in `SidebarContent.tsx` with the Package2 lucide icon.
- [x] Fixed a pre-existing bug where Phase 2 items hard-coded `active={false}` (now uses `isActive(item.href)` like the Operations items).

### 7. Wiki update
- [x] `docs/wiki/bundle-factory.md` — Phase 1 marked complete with full deliverable list.
- [x] `docs/wiki/database-schema.md` — Bundle Factory section updated from "to be added" to "added in `feat/bundle-factory-phase-1` 2026-05-17"; points readers at `src/lib/bundle-factory/enums.ts` for the allowed enum values.
- [x] `docs/wiki/CONNECTIONS.md` — Phase 1 completion paragraph appended to the Bundle Factory connection block.

### 8. Smoke testing
- [x] `npx tsc --noEmit` — clean.
- [x] `npx next build` — clean, all 7 Bundle Factory pages + 10 API routes registered.
- [x] Direct Prisma smoke (against local dev.db): 37 stores grouped exactly as expected, all seeds present.
- [x] `curl http://localhost:3000/api/bundle-factory/master-bundles?status=NOPE` → **400** with allowed-values list (validation works).
- [x] `curl http://localhost:3000/api/bundle-factory/channel-skus?channel=BAD` → **400** with allowed-values list.
- [x] `curl http://localhost:3000/bundle-factory/stores` → **307 → /login** (UI page exists, gated by `src/proxy.ts` session middleware).

### 9. Git
Six commits on `feat/bundle-factory-phase-1`:

```
e0fffe7 docs(bundle-factory): wiki update for Phase 1
beda3e7 feat(bundle-factory): sidebar integration
ea8c285 feat(bundle-factory): UI skeleton with 7 pages
9033087 feat(bundle-factory): API endpoints for 10 routes
af00149 feat(bundle-factory): pre-seed 37 stores, 9 brand accounts, UPC pool
4fe7654 feat(bundle-factory): add Prisma schema with 14 models
```

---

## 📊 Statistics

| Metric | Value |
|---|---|
| New Prisma models | 14 |
| New seed records | 37 stores + 9 brand accounts + 30 marketplace rules + 63 GTIN exemption trackers = **139** (+ N UPCs when report arrives) |
| API endpoints | 10 (across 10 route files) |
| UI pages | 7 |
| Sidebar entries | 1 |
| Wiki pages updated | 3 |
| Lines of code added | ~3,400 |
| Commits | 6 |

---

## 🐛 Issues encountered

1. **SQLite + Prisma 7 do not support native enums.** Worked around by storing them as TEXT and exposing the allowed values as `as const` tuples + literal-union TS types in `src/lib/bundle-factory/enums.ts`. Runtime validation uses an `isOneOf` helper.
2. **`prisma migrate dev` wanted to reset dev.db** because the existing dev.db had been bootstrapped via direct `db push` (no `_prisma_migrations` table). Worked around by capturing the SQL via `prisma db push` and writing the migration file manually.
3. **The seed initially hit Turso production** because `TURSO_DATABASE_URL` is present in `.env`. Fixed by defaulting the seeder to local dev.db; opt-in to Turso via `SEED_TARGET=turso`.
4. **Active Listings Report file is not yet present.** Per brief instructions, the UPC pool seeder gracefully skips with a clear "TODO: drop the Active Listings Report into data/imports/" log message and returns 0 without crashing.

---

## 🔜 Phase 2 readiness

- Database ready ✓ (14 tables + 139 seed rows on dev.db)
- Turso script ready ✓ (Vladimir runs it after PR review)
- API surface ready ✓ (Stage-2 Research pipeline can POST to `/api/bundle-factory/research`)
- UI placeholder ready ✓ (Drafts / Master Bundles tables auto-populate from the new tables as Stage-2+ writes to them)
- Ready for Phase 2 (Research pipeline implementation): Perplexity + web scraping pulling product candidates into `ResearchPool`.

---

## 📦 Vladimir's to-do list after merge

1. Review and merge `feat/bundle-factory-phase-1` PR.
2. Apply the Turso migration:
   ```bash
   cd ss-control-center
   node scripts/turso-migrate-bundle-factory-phase-1.mjs
   ```
3. Once the script confirms tables exist on production, run the seed against Turso:
   ```bash
   SEED_TARGET=turso npx prisma db seed
   ```
4. Drop the Active Listings Report into `data/imports/Active_Listings_Report_05-17-2026.txt` (or any matching glob) and re-run `npx prisma db seed` locally to populate UPCPool.
