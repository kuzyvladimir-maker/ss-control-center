# CLAUDE CODE PROMPT — Bundle Factory Phase 1 Implementation

> **For:** Claude Code (VS Code extension)
> **Project path:** `/Users/vladimirkuznetsov/SS Command Center/ss-control-center/ss-control-center/`
> **Created:** 2026-05-17
> **Estimated work:** 4-8 hours (overnight execution OK)

---

## 🎯 ТВОЯ ЗАДАЧА

Реализовать **Phase 1** модуля Bundle Factory в SS Control Center. Это foundational phase: создание Prisma schema, миграции, pre-seed data, базовая UI и API endpoints.

**Что НЕ входит в Phase 1:** actual AI generation pipeline (Phase 3+), image generation (Phase 6), SP-API distribution (Phase 9+). Только foundation.

---

## 📚 ИСТОЧНИКИ ИНФОРМАЦИИ (ОБЯЗАТЕЛЬНО ПРОЧИТАТЬ ПЕРЕД РАБОТОЙ)

В Vladimir's project знание разложено по docs. Прочитай в следующем порядке:

1. **`docs/BUNDLE_FACTORY_CONCEPT_v1_0.md`** — full concept (~30KB). 7-стадийный pipeline, brand strategy, JIT model, 14 phases. Это твой source of truth для понимания "почему".

2. **`docs/BUNDLE_FACTORY_SOURCING_MAP.md` v1.1** — 37 магазинов с координатами, telephones, часами, distances. Внизу есть `STORE_REGISTRY_SEED` TypeScript array — это твой seed data.

3. **`docs/BUNDLE_FACTORY_DATA_MODEL.md`** — Полная Prisma schema (14 моделей). Это твоё main reference document для миграции.

4. **`docs/marketplace-rules/README.md`** — структура KB

5. **`docs/marketplace-rules/amazon/gift-set-policy.md`** — фундамент legal strategy

6. **`docs/wiki/bundle-factory.md`** — wiki overview

7. **`docs/wiki/design/index.md`** — Salutem Design System (для UI компонентов)

8. **`CLAUDE.md`** — глобальный техспек проекта

---

## ✅ PHASE 1 SCOPE CHECKLIST

Это твой self-managed checklist. Помечай ✅ как выполнено в end-of-phase commit message.

### 1. Database — Prisma Schema + Migration

- [ ] **1.1** Обновить `prisma/schema.prisma` — добавить все 14 моделей из `BUNDLE_FACTORY_DATA_MODEL.md`:
  - MasterBundle
  - BundleComponent
  - ChannelSKU
  - ResearchPool
  - BundleDraft
  - StoreRegistry
  - ProductSourceFallback
  - StockCheckLog
  - UPCPool
  - GTINExemption
  - BrandAccount
  - GenerationJob
  - GenerationStage
  - MarketplaceRule
  - ErrorPattern
  - ListingLifecycleLog

- [ ] **1.2** Добавить все 9 enums из Data Model:
  - LifecycleState, ProductCategory, SalesChannel, CompositionType, PipelineStage, StageStatus, ErrorCategory, UPCStatus, StoreType, StoreTier, GTINExemptionStatus

- [ ] **1.3** Run миграция:
  ```bash
  npx prisma migrate dev --name bundle_factory_phase_1_initial
  ```

- [ ] **1.4** Validate миграция через `npx prisma studio` — все таблицы появились.

### 2. Pre-seed Data

- [ ] **2.1** Создать `prisma/seed/store-registry.ts` — экспортирующий `STORE_REGISTRY_SEED` array из 37 записей. Скопировать **полный** код из `BUNDLE_FACTORY_SOURCING_MAP.md` section "STORE REGISTRY (machine-readable seed)".

- [ ] **2.2** Создать `prisma/seed/brand-account.ts` — экспортирующий `BRAND_ACCOUNT_SEED` array (9 records). Скопировать из `BUNDLE_FACTORY_DATA_MODEL.md`.

- [ ] **2.3** Создать `prisma/seed/upc-pool-import.ts` — скрипт парсинга Active Listings Report:
  - Path: `Active_Listings_Report_05-17-2026__1_.txt` (Vladimir предоставит файл в `data/imports/`)
  - Parse columns: `seller-sku`, `product-id` (UPC)
  - Filter UPCs starting with `742259`, `789232`, `617261`
  - Status = `ASSIGNED` (если SKU active)
  - Создать DB records

- [ ] **2.4** Создать `prisma/seed/marketplace-rules-seed.ts` — top-30 rules. Скопировать из `BUNDLE_FACTORY_DATA_MODEL.md`.

- [ ] **2.5** Создать `prisma/seed/gtin-exemption-init.ts` — initial records (NOT_REQUESTED для каждой brand × channel × category combinations).

- [ ] **2.6** Update `prisma/seed.ts` — оркестрация всех 5 seed scripts.

- [ ] **2.7** Run seed:
  ```bash
  npx prisma db seed
  ```

- [ ] **2.8** Verify: открыть Prisma Studio → проверить что 37 stores, 9 brand accounts, и UPC pool populated.

### 3. API Endpoints

Создать в `src/app/api/bundle-factory/`:

- [ ] **3.1** `briefs/route.ts` — POST для создания BundleDraft, GET для listing. Use Prisma directly.

- [ ] **3.2** `research/route.ts` — POST для создания ResearchPool record (placeholder, no actual AI), GET для listing.

- [ ] **3.3** `drafts/route.ts` — CRUD для BundleDraft.

- [ ] **3.4** `master-bundles/route.ts` — CRUD для MasterBundle + `?status=DRAFT|RESEARCHED|APPROVED|LIVE` filter.

- [ ] **3.5** `channel-skus/route.ts` — CRUD для ChannelSKU.

- [ ] **3.6** `stores/route.ts` — GET для StoreRegistry, support `?chain=Walmart&tier=TIER_1` filters.

- [ ] **3.7** `upc-pool/route.ts` — GET для UPCPool, support `?status=AVAILABLE` filter; POST для reserving UPC.

- [ ] **3.8** `marketplace-rules/route.ts` — GET для MarketplaceRule cache.

- [ ] **3.9** `generation-jobs/route.ts` — CRUD для GenerationJob + GenerationStage.

- [ ] **3.10** `lifecycle-logs/route.ts` — GET-only, support `?entity_id=...` filter.

Use Next.js 16.2.2 App Router conventions:
```typescript
// src/app/api/bundle-factory/master-bundles/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  
  const bundles = await prisma.masterBundle.findMany({
    where: status ? { lifecycle_status: status as any } : {},
    include: { components: true, channel_skus: true }
  });
  
  return NextResponse.json(bundles);
}
```

### 4. UI Skeleton

Создать в `src/app/bundle-factory/`:

- [ ] **4.1** `page.tsx` — main page с tabs (Briefs, Drafts, Master Bundles, Live, Stores). Use shadcn/ui Tabs.

- [ ] **4.2** `briefs/page.tsx` — placeholder list view of BundleDraft с status DRAFT. Table component.

- [ ] **4.3** `drafts/page.tsx` — list of BundleDraft с status VARIATION_SELECTED+.

- [ ] **4.4** `master-bundles/page.tsx` — list of MasterBundle. Filter by lifecycle_status.

- [ ] **4.5** `live/page.tsx` — list ChannelSKU с lifecycle_status=LIVE. Group by channel.

- [ ] **4.6** `stores/page.tsx` — Table показывающий 37 StoreRegistry. Filter by chain/tier. Show map preview optionally.

- [ ] **4.7** `settings/page.tsx` — show:
  - GTINExemption table
  - BrandAccount mapping
  - UPCPool stats (X available, Y reserved, Z assigned)

**Стиль:** строго следовать **Salutem Design System v1.0**:
- Backgrounds: `--green-cream: #F0E8D0`, `--cream: #FFF9E8`
- Text: `--ink: #15201B` (НИКОГДА не использовать чёрный или `text-black`)
- Borders: `--ink/15`, radius 6/10/14px
- Sidebar 236px, topbar 56px
- Numbers с `tabular-nums`
- НЕТ красного для negative values

Сверяйся с `docs/wiki/design/index.md` для каждого component.

### 5. Sidebar Integration

- [ ] **5.1** Добавить пункт `Bundle Factory` в main sidebar (`src/components/AppShell/Sidebar.tsx`).
- [ ] **5.2** Icon: Package (lucide-react)
- [ ] **5.3** Children menu items:
  - Briefs
  - Drafts
  - Master Bundles
  - Live SKUs
  - Stores
  - Settings

### 6. Routing & Layout

- [ ] **6.1** `src/app/bundle-factory/layout.tsx` — wrap children с sub-navigation tabs.

### 7. Wiki Update

- [ ] **7.1** Update `docs/wiki/bundle-factory.md` — отметить Phase 1 как implementation in progress / complete.

- [ ] **7.2** Update `docs/wiki/CONNECTIONS.md` — confirm Bundle Factory section reflects new tables.

- [ ] **7.3** Update `docs/wiki/database-schema.md` (если существует) — добавить новые модели.

### 8. Testing

- [ ] **8.1** Manual smoke test:
  - Open `/bundle-factory` → loads без errors
  - Open `/bundle-factory/stores` → видит 37 магазинов в таблице
  - Open Prisma Studio → 14 таблиц, seed data correct

- [ ] **8.2** API smoke test через curl:
  ```bash
  curl http://localhost:3000/api/bundle-factory/stores
  curl http://localhost:3000/api/bundle-factory/upc-pool?status=AVAILABLE
  curl http://localhost:3000/api/bundle-factory/master-bundles
  ```

### 9. Git Commit & Push

- [ ] **9.1** Create branch:
  ```bash
  git checkout -b feat/bundle-factory-phase-1
  ```

- [ ] **9.2** Commit chunks (по mere фазам):
  - `feat(bundle-factory): add Prisma schema with 14 models`
  - `feat(bundle-factory): pre-seed 37 stores, 9 brand accounts, UPC pool`
  - `feat(bundle-factory): API endpoints for 10 routes`
  - `feat(bundle-factory): UI skeleton with 7 pages`
  - `feat(bundle-factory): sidebar integration`
  - `docs(bundle-factory): wiki update for Phase 1`

- [ ] **9.3** Push:
  ```bash
  git push -u origin feat/bundle-factory-phase-1
  ```

- [ ] **9.4** В terminal output для Vladimir — print final summary:
  - Total tables created: 14
  - Total seed records: 37 (stores) + 9 (brands) + N (UPCs) + 30 (rules)
  - API endpoints: 10
  - UI pages: 7
  - PR link (если automatic PR creation supported)

---

## 🎯 ACCEPTANCE CRITERIA

Phase 1 считается готовым, когда:

1. ✅ `npx prisma studio` показывает 14 таблиц с seed data
2. ✅ `localhost:3000/bundle-factory/stores` показывает 37 магазинов
3. ✅ All API endpoints return valid JSON (даже если empty arrays для tables без data yet)
4. ✅ UI uses Salutem Design System tokens (no `text-black`, no `bg-white`, only design system colors)
5. ✅ Branch pushed, commit messages clear, ready для PR

---

## ⚠️ ВАЖНЫЕ ПРАВИЛА

1. **DESIGN SYSTEM** — каждый component должен использовать только tokens из `docs/wiki/design/index.md`. Если sees a `text-black` — заменить на `text-[var(--ink)]`. Если `bg-white` на green background — заменить на `bg-[var(--green-cream)]`.

2. **TYPESCRIPT STRICT** — все Prisma queries должны быть typed. No `any` unless абсолютно необходимо.

3. **TABULAR NUMS** — каждое число в UI должно быть `font-mono` или с `tabular-nums` class.

4. **NO HARDCODED VALUES** — все store IDs, brand names, channel constants должны быть в database, не в code.

5. **ERROR HANDLING** — все API routes должны иметь try/catch с proper status codes (400 для bad input, 404 для not found, 500 для server error).

6. **PRESERVE EXISTING CODE** — не трогать existing modules (Customer Hub, Shipping Labels, etc.). Bundle Factory — net new module.

7. **PRISMA RELATIONS** — все relations должны иметь explicit `@relation` и backref. См. Data Model document.

8. **MIGRATIONS REVERSIBLE** — если что-то fails, можно rollback:
   ```bash
   npx prisma migrate reset  # WARNING: destroys data
   ```

---

## 🚧 IF YOU GET STUCK

1. **Schema error?** — read `BUNDLE_FACTORY_DATA_MODEL.md` line by line
2. **Seed fails?** — check JSON syntax в seed files, особенно in arrays
3. **UI doesn't match design?** — open existing module (например `app/customer-hub/`) и copy patterns
4. **TypeScript errors?** — run `npx prisma generate` after schema changes

---

## 📤 OUTPUT FORMAT (когда Phase 1 complete)

После завершения — write summary в `docs/PHASE_1_COMPLETION_REPORT.md`:

```markdown
# Bundle Factory Phase 1 — Completion Report

**Started:** [timestamp]
**Completed:** [timestamp]
**Duration:** Xh Ym

## ✅ Completed
- [x] 14 Prisma models created
- [x] 37 stores pre-seeded
- [x] ... etc

## 📊 Statistics
- Tables: 14
- Seed records: X total
- API endpoints: 10
- UI pages: 7
- Lines of code added: ~X

## 🐛 Issues encountered
- ...

## 🔜 Phase 2 readiness
- Database ready ✓
- UI placeholder ready ✓
- Ready для implementing AI pipeline ✓
```

---

## 📚 ССЫЛКИ

- Project repo: `kuzyvladimir-maker/ss-control-center`
- Filesystem MCP path: `/Users/vladimirkuznetsov/SS Command Center/`
- Next.js project: `ss-control-center/ss-control-center/`
- Database: SQLite через Prisma
- Design System: `docs/wiki/design/index.md`

---

**Удачи в реализации! После завершения отправь PR Vladimir-у с link на review.**

— Claude (in SS Command Center)
