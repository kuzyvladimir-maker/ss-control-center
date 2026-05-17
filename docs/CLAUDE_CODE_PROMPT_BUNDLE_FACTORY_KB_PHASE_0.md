# CLAUDE CODE PROMPT — Bundle Factory KB Phase 0 (Research Agent)

> **For:** Claude Code (VS Code extension) running as research agent
> **Goal:** Дополнить и валидировать `docs/marketplace-rules/` KB через web research + проверку Vladimir's existing listings
> **Created:** 2026-05-17
> **Estimated work:** 2-4 hours autonomous

---

## 🎯 ТВОЯ ЗАДАЧА

В Phase 0 уже создана базовая структура `docs/marketplace-rules/` с 25 файлами (Amazon, Walmart, eBay, TikTok). Многие из них содержат TODO sections и неподтверждённые numeric IDs. Твоя задача — заполнить эти gaps через:

1. Web research (Amazon Help, Walmart Help, eBay Seller Center)
2. Анализ Vladimir's existing Active Listings Reports (extract patterns from real data)
3. SP-API queries для category trees (если у тебя есть API credentials)

**Главный output:** обновлённые KB files + DB seed для `MarketplaceRule` table.

---

## 📚 ИСТОЧНИКИ (читать первыми)

1. `docs/marketplace-rules/README.md` — структура KB
2. `docs/marketplace-rules/amazon/gift-set-policy.md` — фундамент
3. `docs/marketplace-rules/amazon/browse-nodes-grocery.md` — содержит TODO для sub-category IDs
4. `Active_Listings_Report_05-17-2026__1_.txt` (если Vladimir предоставит) — реальные patterns

---

## ✅ CHECKLIST

### A. Amazon Browse Nodes — Полная numeric ID карта

- [x] **A.1** ✅ **DONE 2026-05-17** (researched in Claude chat) — все sub-categories под Food & Beverage Gifts (parent: 2255571011) найдены и web-verified. Фактически 13 sub-categories (не 12): появилась новая Advent Calendars (`78380725011`). Полный список IDs:
  - Advent Calendars: `78380725011` ⚠️ NEW
  - Bakery & Dessert Gifts: `2255576011`
  - Candy & Chocolate Gifts: `2255572011`
  - Cheese & Charcuterie Gifts: `2255573011`
  - Coffee Gifts: `23900459011`
  - Fruit & Nut Gifts: `2255577011`
  - Herb, Spice & Seasoning Gifts: `2255584011`
  - Jam, Jelly & Sweet Spread Gifts: `2255578011`
  - Meat & Seafood Gifts: `2255579011`
  - Sauce, Gravy & Marinade Gifts: `2255580011`
  - Snack Food Gifts: `2255582011`
  - Tea Gifts: `23700435011`
  
  Обнаружены: 2 dual hierarchies (Cheese & Charcuterie + Meat & Seafood) в path `Grocery → Meat & Seafood → ...`; UI переименование Snack Food Gifts → "Snack Gifts" (node ID without changes). Подробности в `docs/marketplace-rules/amazon/browse-nodes-grocery.md`.

- [x] **A.2** ✅ **DONE 2026-05-17** — `docs/marketplace-rules/amazon/browse-nodes-grocery.md` полностью обновлён: добавлены все 13 numeric IDs, dual-hierarchy notes, ID number ranges, naming inconsistencies, refined bundle→node mapping (13 строк вместо 5).

- [ ] **A.3** ⏳ TODO (requires SP-API access или Active Listings Report) — cross-check какие из 1028 Salutem Vita listings реально используют какие browse nodes. Parse Active Listings Report column "browse_node" или fetch через `getListingsItem` API.

### B. Sub-category specifics

- [ ] **B.1** Создать `docs/marketplace-rules/amazon/category-cheese-charcuterie.md` — specifics для cheese/deli bundles
- [ ] **B.2** Создать `docs/marketplace-rules/amazon/category-coffee-tea.md` — coffee gift sets
- [ ] **B.3** Создать `docs/marketplace-rules/amazon/category-candy.md` — candy gift sets

Каждый file follow standard format: TL;DR, Hard rules, Soft rules, Examples, References.

### C. Walmart Marketplace — Verify and expand

- [ ] **C.1** Verify Walmart category IDs для:
  - Food → Gift Baskets (numeric ID)
  - Food → Snacks → Cookies (sub-id)
  - Через https://developer.walmart.com/api/us/mp/items — Items API documentation

- [ ] **C.2** Update `docs/marketplace-rules/walmart/category-grocery.md` — добавить numeric IDs.

- [ ] **C.3** Investigate Walmart's "Food Gift Baskets" category permissions:
  - Is это auto-approval?
  - Vladimir's status — verify через Seller Center

### D. eBay — UPC requirements

- [ ] **D.1** Research eBay UPC validation:
  - Когда "Does Not Apply" UPC принимается?
  - Когда required?
  - https://www.ebay.com/help/selling/listings/setting-listings-listings-product-identifiers

- [ ] **D.2** Update `docs/marketplace-rules/ebay/basics.md` с findings.

### E. TikTok Shop — Approval timeline reality

- [ ] **E.1** Найти 2025-2026 case studies / forums:
  - Реальный timeline для food category approval
  - Common rejection reasons
  - Sub-category restrictions

- [ ] **E.2** Update `docs/marketplace-rules/tiktok-shop/approval-process.md`.

### F. Cross-marketplace fee comparison

- [ ] **F.1** Создать `docs/marketplace-rules/CHANNEL_COMPARISON.md` — table:
  ```
  | Channel | Title | UPC | Frozen | Referral | Min Fee | Approval Time |
  ```

### G. Generate MarketplaceRule seed

- [ ] **G.1** На основе всех KB files — создать `prisma/seed/marketplace-rules-seed.ts` с **~50-100 records** (более comprehensive than initial 30).

- [ ] **G.2** Test seed работает: `npx prisma db seed` после migration.

### H. Compliance test scripts

- [ ] **H.1** Создать `tests/compliance/` directory.
- [ ] **H.2** Generate test cases на основе compliance check code в KB files:
  - `test-title-amazon.ts` — feeding 20 sample titles, expecting pass/fail correctly
  - `test-gift-set-policy.ts` — feeding 10 sample compositions
  - `test-image-requirements.ts` — feeding 10 sample images
- [ ] **H.3** Run tests, fix any code bugs in KB compliance functions.

---

## ⚠️ Constraints

1. **Не делать SP-API calls** unless API credentials явно предоставлены — фокус на public web research.
2. **Не trust everything** — Amazon Help docs иногда outdated; verify против actual Amazon.com behavior.
3. **Update timestamps** — каждый updated KB file должен иметь свежую `Last verified` date.
4. **Quote sources** — каждое утверждение в KB должно иметь URL source (где возможно).

---

## 📤 OUTPUT

После завершения:
1. `docs/marketplace-rules/KB_PHASE_0_COMPLETION_REPORT.md` — summary что found / changed
2. Updated KB files
3. Updated `prisma/seed/marketplace-rules-seed.ts`
4. Pushed commit: `docs(marketplace-rules): Phase 0 research completion`

---

## 🎯 SUCCESS CRITERIA

- ✅ Все 12 Amazon sub-category numeric IDs заполнены
- ✅ Walmart's Food Gift Baskets category verified
- ✅ MarketplaceRule seed has ≥50 records
- ✅ Cross-channel comparison document created
- ✅ Test suite passes

---

**Note:** Этот промпт — research-heavy task. Если ты не уверен в каком-то факте — лучше написать "TBD verify" чем угадывать. Confident facts > comprehensive guesses.

— Claude (in SS Command Center)
