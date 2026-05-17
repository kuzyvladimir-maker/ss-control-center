# Bundle Factory — Phase 0 Completion Report

> **Date completed:** 2026-05-17
> **Duration:** 1 overnight session + morning deep-dive batch (~10-12 hours autonomous work)
> **Status:** ✅ **PHASE 0 COMPLETE** — ready for Phase 1 implementation

---

## 🎯 Phase 0 Goals (recap)

Phase 0 — это "design & planning" фаза перед implementation. Цель:
- Финализировать concept
- Спроектировать data model
- Собрать KB по правилам всех 4 marketplaces
- Подготовить executable prompts для Claude Code
- Sourcing infrastructure mapped

**Phase 0 не включает** написание кода — это всё Phase 1+.

---

## ✅ Deliverables (всё в `docs/`)

### Core documents (3 файла)

| # | File | Size | Purpose |
|---|---|---|---|
| 1 | `BUNDLE_FACTORY_CONCEPT_v1_0.md` | ~30KB | Master concept: 7-стадийный AI pipeline, brand strategy, 14 фаз rollout, cost calculator, JIT-модель |
| 2 | `BUNDLE_FACTORY_SOURCING_MAP.md` v1.1 | ~20KB | 37 магазинов в radius 10mi с координатами/часами/distances + machine-readable seed для Prisma |
| 3 | `BUNDLE_FACTORY_DATA_MODEL.md` | ~30KB | Полная Prisma schema: 14 моделей, 11 enums, pre-seed data |

### Marketplace Rules KB (`docs/marketplace-rules/`) — **45 файлов**

**Amazon (23 файла):**
1. `gift-set-policy.md` ⭐ — фундамент: Oct 2024 update + Gift Basket Exception
2. `bundle-policy.md` — общая Product Bundling Policy
3. `title-policy.md` — 200 chars max, structure, forbidden patterns
4. `bullet-points-policy.md` — 5 bullets, Vladimir's emoji pattern
5. `description-policy.md` — HTML support, A+ Content
6. `image-requirements.md` — 1000x1000+, white bg, AI prompt template
7. `browse-nodes-grocery.md` ⭐ — все 13 sub-categories verified (включая Advent Calendars + dual hierarchy)
8. `gtin-exemption-process.md` ⭐ — application + Letter of Authorization template
9. `category-frozen-grocery.md`
10. `category-refrigerated.md`
11. `category-shelf-stable.md`
12. `category-pet-food.md`
13. **`category-cheese-charcuterie.md`** 🆕 — dual hierarchy node 2255573011
14. **`category-coffee-tea.md`** 🆕 — nodes 23900459011 (Coffee) + 23700435011 (Tea)
15. **`category-candy.md`** 🆕 — heat-sensitive Florida summer warning
16. `compliance-grocery.md` — FDA Big 9 allergens
17. `restricted-products.md`
18. `brand-registry-benefits.md`
19. `fee-schedule.md`
20. **`prohibited-keywords.md`** 🆕 — consolidated TypeScript blocklists
21. **`sp-api-attribute-schemas.md`** 🆕 — JSON Listings v2 schemas для GIFT_BASKET productType
22. **`atoz-claim-avoidance.md`** 🆕 — 5 причин claims + listing-time prevention
23. **`buy-box-rules.md`** 🆕 — FBM vs FBA, cross-account strategy

**Walmart (11 файлов):**
1. `title-policy.md` — 75 chars max
2. `multipack-policy.md`
3. `images.md` — RGB 240+, ≥1500×1500
4. `category-grocery.md` — Vladimir's access matrix
5. `frozen-restrictions.md` ⭐
6. `prohibited-items.md`
7. `fee-schedule.md`
8. **`category-numeric-ids.md`** 🆕 — string-path classification vs Amazon's numeric
9. **`attribute-keys.md`** 🆕 — required attrs per category
10. **`food-gift-baskets-deep-dive.md`** 🆕 — Walmart's Gift Basket analog, Phase 1 shelf-stable strategy
11. **`wfs-implications.md`** 🆕 — WFS не подходит для JIT-bundle

**eBay (5 файлов):**
1. `basics.md`
2. `fee-schedule.md`
3. **`grocery-deep-dive.md`** 🆕 — niche audience, Item Specifics
4. **`sub-category-structure.md`** 🆕 — leaf categories: Gift Baskets 14282, Coffee 14302, etc.
5. **`selling-limits.md`** 🆕 — new account 10 items/$500 → unlimited Top Rated

**TikTok Shop (5 файлов):**
1. `basics.md`
2. `approval-process.md`
3. **`content-rules.md`** 🆕 — video 9:16, Commercial Music Library
4. **`food-compliance.md`** 🆕 — без frozen в MVP
5. **`affiliate-program.md`** 🆕 — creator-driven, commission tiers

**Global (1 файл):**
- **`CHANNEL_COMPARISON.md`** 🆕 — multi-channel deviation matrix через все 4 channels (title rules, image rules, fees, returns, affiliate, Buy Box)

**Plus README.md** в parent dir с актуальной картой 45 файлов.

**Из них 17 новых файлов созданы 2026-05-17 в deep-dive batch update.**

### Executable prompts for Claude Code (2 файла)

| File | Purpose |
|---|---|
| `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md` | Implementation промпт: Prisma migration + 5 seed scripts + 10 API endpoints + 7 UI pages + sidebar integration + git workflow |
| `CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_KB_PHASE_0.md` | Research-агент промпт (Section A — Amazon browse nodes — выполнено, остальные секции отражают актуальный статус) |

---

## 🔄 Wiki updates

- `docs/wiki/bundle-factory.md` — обновлён 4x (концепт → +Sourcing → +Data Model → +KB → +Phase 1 prompt → +deep-dive batch)
- `docs/wiki/CONNECTIONS.md` — Bundle Factory section reflects Phase 0 completion
- `docs/wiki/index.md` — Bundle Factory entry показывает Phase 0 завершён
- `docs/wiki/database-schema.md` — добавлены 14 новых моделей в спецификацию (33 total после миграции)

---

## 📊 Key numbers (final)

| Metric | Value |
|---|---|
| **Total Phase 0 documents created** | **51** (3 core + 45 KB + 2 prompts + 1 this report) |
| Prisma models designed | 14 |
| Enums designed | 11 |
| Stores in registry | 37 |
| Walmart stores (Vladimir's Walmart Business — authoritative) | **14** (6 Supercenter + 8 NM) |
| Brand × channel mappings | 9 |
| Marketplace rules to seed (expanded scope) | ~100 (vs initial 30) |
| UPC pool size (from Active Listings) | ~1500+ (TBD verify import) |
| Channel types supported | 9 (5 Amazon + Walmart + eBay + 2 TikTok) |
| KB files (Marketplace Rules) | **45** (Amazon 23 + Walmart 11 + eBay 5 + TikTok 5 + global 1) |

---

## 🎓 Key learnings & decisions

### Strategic decisions made

1. **JIT inventory model** — no warehouse stock; order → 2 days handling → sourcing → packing → shipping. Главное преимущество — нет capital tie-up.

2. **Gift Basket Exception strategy** — на Amazon Oct 2024 policy update запрещает multi-brand bundles, но Food Assortments & Variety Gifts category (12011207011) сохраняет exception. Это юридический фундамент всей стратегии Salutem Vita.

3. **Master Bundle / ChannelSKU split** — один recipe (MasterBundle) генерирует N listings на разных каналах. Lifecycle отдельный для каждого ChannelSKU.

4. **Sticky products thesis** — топовые brand-products в стоке месяцами → one-shot research + pre-publication re-check; никаких continuous monitoring.

5. **Walmart frozen-blocked acknowledgment** — Vladimir не имеет Frozen access на Walmart → ChannelSKU создаётся только для shelf-stable bundles на Walmart. Frozen bundles живут только на Amazon (5 accounts).

6. **TikTok Shop MVP = shelf-stable only** — frozen/refrigerated не поддерживается TikTok logistics. Phase 2+ expansion.

7. **Buy Box monopoly strategy** — каждый bundle = unique ASIN, защищён Brand Registry. 5 Vladimir's accounts могут share offers с synced pricing.

8. **TikTok Affiliate primary growth lever** — 80% TikTok Shop sales идут через creators; Vladimir's commission strategy: Standard 15% / Premium 20-25% / Bestseller 10-12%.

### Corrections during Phase 0

1. **Walmart count: 14, not 5 or 12** — Vladimir's Walmart Business account показал authoritative данные.

2. **Closest Walmart: 0.8 mi (not 1.2)** — Walmart's official distance calc от 33765 zip.

3. **Sourcing radius widened to 37 stores** — после Walmart correction.

4. **Amazon sub-categories: 13 not 11** — discovered Advent Calendars (78380725011) + dual hierarchies для Cheese & Charcuterie и Meat & Seafood.

5. **Walmart использует category paths (strings), не numeric IDs** — отличается от Amazon's browse_node IDs.

---

## 🚧 Known TODOs (для Phase 1+)

### Critical для Phase 1 (Vladimir's manual actions)

- [ ] **Apply for GTIN exemption** на Salutem Vita × Grocery (Vladimir's manual action в Seller Central)
- [ ] **Verify Amazon Frozen ungating** на все 5 accounts (только Salutem Solutions подтверждён)
- [ ] **Verify Walmart shelf-stable category** access точно

### Phase 0 follow-up — **ПОЛНОСТЬЮ ВЫПОЛНЕНО 2026-05-17** ✅

- [x] ✅ **Fetch numeric IDs для Amazon sub-categories** — все 13 verified в research-сессии "ResearchKB Sub-Categories Numeric IDs"
- [x] ✅ **Specific sub-category files** (cheese-charcuterie, coffee-tea, candy)
- [x] ✅ **Prohibited keywords consolidated** — `marketplace-rules/amazon/prohibited-keywords.md`
- [x] ✅ **SP-API attribute schemas** — JSON Listings v2 schemas
- [x] ✅ **A-to-Z claim avoidance** — listing-time prevention
- [x] ✅ **Buy Box rules** — FBM vs FBA dynamics
- [x] ✅ **Walmart category numeric IDs** (corrected: string-paths, not numeric)
- [x] ✅ **Walmart attribute keys**
- [x] ✅ **Walmart Food Gift Baskets deep dive**
- [x] ✅ **WFS implications**
- [x] ✅ **eBay grocery deep dive**
- [x] ✅ **eBay sub-category structure**
- [x] ✅ **eBay selling limits**
- [x] ✅ **TikTok content rules**
- [x] ✅ **TikTok food compliance**
- [x] ✅ **TikTok Affiliate Program**
- [x] ✅ **Multi-channel deviation matrix** — `CHANNEL_COMPARISON.md`

### Остаётся (отложено или Phase 2+)

- [ ] Cross-check browse_node usage в Vladimir's 1028 existing Salutem Vita listings (нужен Active Listings Report; полезно но не блокер)
- [ ] **Region-specific rules** (Canada/UK/EU) — Phase 2+ expansion
- [ ] **Brand-specific seller authorization lists** — Phase 3+ (research-heavy per-brand)
- [ ] **Compliance validation code в проекте** (не KB pseudocode) — это Phase 1 implementation в Claude Code (uses KB как source)

### Phase 2+ business roadmap

- [ ] Bundle Factory Phase 2 — actual AI generation pipeline (Stages 1-7)
- [ ] Image generation через OpenAI GPT-Image API + Higgsfield (для TikTok videos)
- [ ] SP-API listings creation
- [ ] Walmart Items API listings creation
- [ ] Stock-recheck pipeline (Stage 6 of generation)
- [ ] eBay launch (Phase 2+ — после Phase 1 stable)
- [ ] TikTok Shop launch (Phase 2-3+ — после approval)

---

## 🎯 Phase 1 readiness checklist

Готовность к Phase 1 implementation:

- [x] Concept finalized ✓
- [x] Data model designed ✓
- [x] Sourcing map populated ✓
- [x] Marketplace KB drafted ✓ (45 файлов)
- [x] Executable prompt created ✓
- [x] Wiki синхронизировано ✓
- [ ] **GTIN exemption applied** (Vladimir manual action — параллельно с Phase 1)
- [x] **Phase 1 prompt передан Claude Code** ✓ (Vladimir передал)

**Текущий статус:** Claude Code работает над Phase 1 implementation автономно в VS Code.

После Phase 1:
- 14 Prisma таблиц в SQLite (33 модели total)
- 37 магазинов в `StoreRegistry`
- ~100 правил в `MarketplaceRule` cache
- Базовая UI на `/bundle-factory`
- Ready для Phase 2 (AI pipeline)

---

## 📚 Document index

Все Phase 0 артефакты в `/Users/vladimirkuznetsov/SS Command Center/docs/`:

```
docs/
├── BUNDLE_FACTORY_CONCEPT_v1_0.md
├── BUNDLE_FACTORY_SOURCING_MAP.md (v1.1)
├── BUNDLE_FACTORY_DATA_MODEL.md
├── CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_1.md
├── CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_KB_PHASE_0.md
├── BUNDLE_FACTORY_PHASE_0_COMPLETION_REPORT.md (этот файл)
├── marketplace-rules/                            ⭐ 45 файлов
│   ├── README.md (карта всех файлов)
│   ├── CHANNEL_COMPARISON.md                     ⭐ multi-channel deviation matrix
│   ├── amazon/ (23 файла)
│   ├── walmart/ (11 файлов)
│   ├── ebay/ (5 файлов)
│   └── tiktok-shop/ (5 файлов)
└── wiki/
    ├── bundle-factory.md (updated)
    ├── CONNECTIONS.md (updated)
    ├── index.md (updated)
    └── database-schema.md (updated — 33 модели total)
```

---

## 🙏 Acknowledgments

Этот session — самый продуктивный по объёму doc generation за всю историю проекта:
- **51 документ создан/обновлён** в total
- **45 KB файлов** покрывающих все 4 marketplaces детально
- **Multi-channel deviation matrix** показывающий где правила различаются
- **Vladimir's Walmart Business authoritative data** для accurate sourcing (14 stores)

Спасибо Vladimir-у за:
- Trust в autonomous execution
- Authoritative Walmart Business data (без неё была бы 5-Walmart ошибка в seed)
- Reminder о research-сессии "ResearchKB Sub-Categories Numeric IDs" — без него Amazon sub-category IDs остались бы TBD
- Push на deep-dive KB completion вместо движения далее с частичным покрытием

Следующий этап — **execute Phase 1** через Claude Code в VS Code (уже в процессе).

---

**End of Phase 0** — 2026-05-17 ✅
