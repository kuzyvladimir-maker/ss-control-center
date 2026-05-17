# BUNDLE FACTORY — Sourcing Map v1.1

> **Date:** 2026-05-17 (v1.1 — corrected Walmart count from Vladimir's Walmart Business account)
> **Warehouse:** 1162 Kapp Dr, Clearwater, FL 33765
> **Coordinates:** 27.9775467°N, -82.7512346°W
> **Sourcing radius:** 10 miles → **37 stores total**, with 15-mile fallback
> **Related:** [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](BUNDLE_FACTORY_CONCEPT_v1_0.md), [`docs/wiki/bundle-factory.md`](wiki/bundle-factory.md)

---

## 🎯 ЦЕЛЬ ДОКУМЕНТА

Полный реестр магазинов, в которых Bundle Factory может закупать товар для упаковки в gift sets. Используется на двух стадиях pipeline:

1. **Stage 2 (Research)** — AI-agent при поиске продуктов фильтрует доступность по этому списку с приоритетами
2. **Stage 7 (Distribution → Procurement handoff)** — при создании ChannelSKU, в `SKUStorePriority` записывается default порядок магазинов из этого реестра

Реестр — **живой документ**. При смене склада, открытии/закрытии магазинов в зоне, или изменении приоритетов — обновляется здесь.

---

## 📍 WAREHOUSE LOCATION

| Поле | Значение |
|---|---|
| Адрес | 1162 Kapp Dr, Clearwater, FL 33765 |
| Координаты | 27.9775467°N, -82.7512346°W |
| Light-industrial zone | Kapp Dr (дома 1120, 1151, 1154, 1156, 1162) — небольшой business park |
| Sourcing radius (default) | 10 миль / ~16 км |
| Sourcing radius (fallback) | 15 миль / ~24 км |

Все 6 главных wholesale-цепочек (Walmart, BJ's, Sam's, Costco, Target, Publix) находятся в радиусе 2-3 миль от склада — это огромное преимущество для JIT-модели.

---

## 🏆 SOURCING TIERS

### Tier 1 — Primary (default outbound)

| Сеть | Stores | Зачем |
|---|---|---|
| **Walmart** (Supercenter + Neighborhood Market) | **14** | Главный source. WP+ = free delivery. Огромный grocery + frozen ассортимент. Самые низкие цены. Ежедневная доставка от 5 раз в день. |
| **BJ's Wholesale Club** | 1 | Multipack-формы которые отлично ложатся в gift sets (24-packs, 12-packs из коробки). Same-day delivery free over $50. Membership уже есть. |

### Tier 2 — Secondary (when Tier 1 out of stock)

| Сеть | Stores | Зачем |
|---|---|---|
| **Target** | 3 | Хорошая frozen-секция + premium brands недоступные в Walmart. Circle 360 = free delivery, иначе $9.99. |
| **Publix** | 9 | Premium specialty items, отличные cheeses/deli/bakery. InstaCart delivery (доплата). |

### Tier 3 — Bulk specialist

| Сеть | Stores | Зачем |
|---|---|---|
| **Sam's Club** | 1 | Bulk-only форматы которые нужны для специфических high-count gift sets. Membership уже есть. |
| **Costco** | 1 | Premium bulk. Member-only. Резерв когда Sam's outage. |

### Tier 4 — Discount fallback

| Сеть | Stores | Зачем |
|---|---|---|
| **ALDI** | 2 | Прайс-точка ниже Walmart на multiple SKU. |

### Tier 5 — Specialty / extended fallback

| Сеть | Stores | Зачем |
|---|---|---|
| **Whole Foods** | 1 | Organic/premium specialty. Amazon Fresh delivery (free Prime). |
| **Trader Joe's** | 1 | Уникальные SKUs не доступные нигде больше. Pickup only. |
| **The Fresh Market** | 1 | Premium specialty, резерв. |
| **Winn-Dixie** | 3 | Низкие цены, лучшие BOGO. Частично поглощается ALDI. |

**Итого в радиусе 10 миль: 37 магазинов** (14 Walmart + 1 BJ's + 3 Target + 9 Publix + 1 Sam's + 1 Costco + 2 ALDI + 1 Whole Foods + 1 Trader Joe's + 1 Fresh Market + 3 Winn-Dixie).

---

## 🛒 WALMART НА ОСНОВЕ VLADIMIR'S WALMART BUSINESS ACCOUNT

Этот раздел — authoritative source. Distances из Vladimir's Walmart Business account (по zip 33765), координаты verified через Google Places.

| # | Store | Type | Address | Distance | Pickup options |
|---|---|---|---|---|---|
| 1 | **Clearwater US-19 N Supercenter** | Supercenter | 23106 US Hwy 19 N, Clearwater, FL 33765 | **0.8 mi** ⭐ | Curbside, In-store |
| 2 | Clearwater Gulf to Bay NM | Neighborhood Market | 2171 Gulf to Bay Blvd, Clearwater, FL 33765 | 1.2 mi | Curbside, In-store |
| 3 | Clearwater N Highland NM | Neighborhood Market | 1803 N Highland Ave, Clearwater, FL 33755 | 2.0 mi | Curbside, In-store |
| 4 | Dunedin NM | Neighborhood Market | 2102 Main St, Dunedin, FL 34698 | 3.1 mi | Curbside, In-store |
| 5 | Largo Missouri Ave Supercenter | Supercenter | 990 Missouri Ave N, Largo, FL 33770 | 4.3 mi | Curbside, In-store |
| 6 | Largo Roosevelt Supercenter | Supercenter | 2677 Roosevelt Blvd, Largo, FL 33760 | 4.5 mi | Curbside, In-store |
| 7 | Largo Ulmerton NM | Neighborhood Market | 9020 Ulmerton Rd, Largo, FL 33771 | 5.9 mi | Curbside, In-store |
| 8 | Palm Harbor E Lake NM | Neighborhood Market | 3400 E Lake Rd S, Palm Harbor, FL 34685 | 6.2 mi | Curbside, In-store |
| 9 | Oldsmar Supercenter | Supercenter | 3801 Tampa Rd, Oldsmar, FL 34677 | 6.3 mi | Curbside, In-store |
| 10 | Palm Harbor US-19 Supercenter | Supercenter | 35404 US Hwy 19 N, Palm Harbor, FL 34684 | 8.2 mi | Curbside, In-store |
| 11 | Largo Walsingham NM | Neighborhood Market | 13817 Walsingham Rd, Largo, FL 33774 | 8.4 mi | Curbside, In-store |
| 12 | Tampa Elliot Drive NM | Neighborhood Market | 6216 Elliot Dr, Tampa, FL 33615 | 9.0 mi | Curbside, In-store |
| 13 | Pinellas Park 66th St NM | Neighborhood Market | 7500 66th St N, Pinellas Park, FL 33781 | 9.5 mi | Curbside, In-store |
| 14 | Pinellas Park US-19 Supercenter | Supercenter | 8001 US Hwy 19 N, Pinellas Park, FL 33781 | 9.7 mi | Curbside, In-store |

**Totals:**
- **Walmart Supercenter:** 6 stores (full grocery + electronics + apparel + frozen)
- **Walmart Neighborhood Market:** 8 stores (grocery + frozen only)
- **All 14 Walmart use WP+ delivery program** — free delivery over $35 для members
- **All open 6:00 AM - 11:00 PM daily** (по данным Google Places)

---

## 📊 ПОЛНЫЙ STORE REGISTRY (sorted by distance)

### Zone 0 (<2 миль от склада) — одноминутная поездка

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 1 | Publix Beckett Lake Plaza | Publix | 1921 N Belcher Rd, Clearwater 33763 | 1.0 mi |
| 2 | ALDI Gulf to Bay | ALDI | 2150 Gulf to Bay Blvd, Clearwater 33765 | 1.1 mi |
| 3 | **Walmart Supercenter US-19** ⭐ | Walmart | 23106 US Hwy 19 N, Clearwater 33765 | **0.8 mi** |
| 4 | Walmart NM Gulf-to-Bay | Walmart | 2171 Gulf to Bay Blvd, Clearwater 33765 | 1.2 mi |
| 5 | Publix Gulf to Bay Plaza | Publix | 525 S Belcher Rd, Clearwater 33764 | 1.3 mi |
| 6 | Sam's Club | Sam's | 2575 Gulf to Bay Blvd, Clearwater 33765 | 1.7 mi |
| 7 | ALDI US-19 | ALDI | 24756 US Hwy 19 N, Clearwater 33763 | 1.8 mi |

### Zone 1 (2-3 миль)

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 8 | Walmart NM N Highland | Walmart | 1803 N Highland Ave, Clearwater 33755 | 2.0 mi |
| 9 | Costco | Costco | 2655 Gulf to Bay Blvd, Clearwater 33759 | 2.0 mi |
| 10 | Target Gulf to Bay | Target | 2747 Gulf to Bay Blvd, Clearwater 33759 | 2.1 mi |
| 11 | Publix Bayside Bridge | Publix | 1520 McMullen Booth Rd, Clearwater 33759 | 2.5 mi |
| 12 | The Fresh Market | Fresh Market | 25961 US Hwy 19 N, Clearwater 33763 | 2.6 mi |
| 13 | Publix Clearwater Plaza | Publix | 1295 S Missouri Ave, Clearwater 33756 | 2.8 mi |
| 14 | **BJ's Wholesale Club** ⭐ | BJ's | 26996 US Hwy 19 N, Clearwater 33761 | 2.9 mi |
| 15 | Publix LaBelle Plaza | Publix | 1555 S Highland Ave, Clearwater 33756 | 2.9 mi |
| 16 | Whole Foods | Whole Foods | 27001 US Hwy 19 N, Clearwater 33761 | 2.9 mi |

### Zone 2 (3-5 миль)

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 17 | Walmart NM Dunedin | Walmart | 2102 Main St, Dunedin 34698 | 3.1 mi |
| 18 | Publix Harbor Oaks | Publix | 619 S Ft Harrison Ave, Clearwater 33756 | 3.2 mi |
| 19 | Publix Northwood Plaza | Publix | 2514 McMullen Booth Rd, Clearwater 33761 | 3.5 mi |
| 20 | Publix Island Village | Publix | 200 Island Way, Clearwater 33767 | 4.0 mi |
| 21 | Winn-Dixie Largo E Bay | Winn-Dixie | 2460 E Bay Dr, Largo 33771 | 4.1 mi |
| 22 | Publix East Bay Largo | Publix | 5000 E Bay Dr, Clearwater 33764 | 4.2 mi |
| 23 | Walmart Supercenter Missouri | Walmart | 990 Missouri Ave N, Largo 33770 | 4.3 mi |
| 24 | Walmart Supercenter Roosevelt | Walmart | 2677 Roosevelt Blvd, Largo 33760 | 4.5 mi |

### Zone 3 (5-7 миль)

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 25 | Walmart NM Ulmerton | Walmart | 9020 Ulmerton Rd, Largo 33771 | 5.9 mi |
| 26 | Walmart NM Palm Harbor E Lake | Walmart | 3400 E Lake Rd S, Palm Harbor 34685 | 6.2 mi |
| 27 | Target Largo Ulmerton | Target | 10500 Ulmerton Rd, Largo 33771 | 6.2 mi |
| 28 | Walmart Supercenter Oldsmar | Walmart | 3801 Tampa Rd, Oldsmar 34677 | 6.3 mi |
| 29 | Target Palm Harbor | Target | 900 E Lake Rd S, Palm Harbor 34685 | 6.5 mi |
| 30 | Trader Joe's Palm Harbor | Trader Joe's | 33591 US Hwy 19 N, Palm Harbor 34684 | 7.0 mi |

### Zone 4 (7-10 миль)

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 31 | Winn-Dixie Pinellas Park | Winn-Dixie | 6501 102nd Ave N, Pinellas Park 33782 | 7.9 mi |
| 32 | Winn-Dixie Largo Seminole | Winn-Dixie | 10202 Seminole Blvd, Largo 33778 | 8.0 mi |
| 33 | Walmart Supercenter Palm Harbor US-19 | Walmart | 35404 US Hwy 19 N, Palm Harbor 34684 | 8.2 mi |
| 34 | Walmart NM Walsingham | Walmart | 13817 Walsingham Rd, Largo 33774 | 8.4 mi |
| 35 | Walmart NM Tampa Elliot | Walmart | 6216 Elliot Dr, Tampa 33615 | 9.0 mi |
| 36 | Walmart NM Pinellas Park 66th | Walmart | 7500 66th St N, Pinellas Park 33781 | 9.5 mi |
| 37 | Walmart Supercenter Pinellas Park US-19 | Walmart | 8001 US Hwy 19 N, Pinellas Park 33781 | 9.7 mi |

---

## 🚚 DELIVERY OPTIONS MATRIX

| Chain | Default delivery | Membership | Cost | Notes |
|---|---|---|---|---|
| **Walmart** | Walmart+ | $98/year или $12.95/month | **$0 delivery** | 14 stores in radius. Главный canal. |
| **BJ's** | Same-day | BJ's Inner Circle | Free over $50 | + tip ~$5 |
| **Target** | Shipt / Target Circle 360 | $99/year | $0 (Circle 360) или $9.99 | Same-day |
| **Publix** | Instacart partnership | Instacart sub | Instacart fees + markup | Дороже всего |
| **Sam's Club** | Sam's Plus | $110/year | Plus = free | Bulk only |
| **Costco** | Costco Same-Day | Executive $130/year | $9.99+ | Paid model |
| **ALDI** | Instacart partnership | Instacart sub | Instacart fees | Discount вычитается markup |
| **Whole Foods** | Amazon Fresh | Prime ($14.99/mo) | **$0 для Prime** > $35 | Через Amazon Fresh |

**Стратегия для cost calc:**

- Для Walmart sourcing → cost includes `+$0 delivery`
- Для BJ's sourcing → cost includes `+$5 tip` (но free delivery)
- Для Target sourcing → `+$0` (Circle 360) или `+$10` (без)
- Для всех остальных → estimate `+$15`

---

## 🏛️ SPECIAL CONSIDERATIONS PER CHAIN

### Walmart paradox (resolved)

Vladimir продаёт на Walmart Marketplace и одновременно покупает в Walmart store для перепродажи. Это не arbitrage конфликт, а **3PL-shipping** для small businesses, заказывающих по всей Америке. Walmart не препятствует — у Vladimir 4000+ approved listings.

**Bundle Factory правило:** для Walmart Marketplace channel — листим только **dry/shelf-stable bundles** (frozen у Vladimir ещё не открыта). Frozen access = Phase 2 задача.

**14 Walmart stores = огромная избыточность.** Если primary US-19 (0.8 mi) out-of-stock, есть 13 fallback options. Stage 6 stock-recheck pipeline должен использовать этот substitute graph.

### BJ's membership

Active. Amortize annual $55 / ~500 bundles = $0.11 per bundle.

### Target Circle 360

Если у Vladimir нет — стоит подключить. $99/year окупается на ~10 bundles/мес где Target = primary source.

### Trader Joe's

Только pickup — нет delivery. Используется только если Vladimir физически едет.

### ALDI / Winn-Dixie consolidation

ALDI выкупает Winn-Dixie в Florida. Re-scan карты ежеквартально.

---

## 🗂️ STORE REGISTRY (machine-readable seed для Prisma)

Полный seed файл `prisma/seed/store-registry.ts` генерируется в Phase 1. 37 records.

```typescript
export const STORE_REGISTRY_SEED = [
  // === WALMART (14 stores) ===
  { id: 'walmart_sc_us19', name: 'Clearwater US-19 N Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '23106 US Hwy 19 N, Clearwater, FL 33765', lat: 27.9827016, lng: -82.7325222, distance_mi: 0.8, place_id: 'ChIJ29AO4SbuwogRkIbpV9gJTMY', phone: '+1 727-724-7777', hours_text: '6:00-23:00 daily', website_url: 'https://www.walmart.com/store/2081-clearwater-fl/', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 1, notes: 'PRIMARY SOURCE. Full grocery + frozen + electronics.' },
  { id: 'walmart_nm_gulf_to_bay', name: 'Clearwater Gulf to Bay NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '2171 Gulf to Bay Blvd, Clearwater, FL 33765', lat: 27.9592073, lng: -82.7482870, distance_mi: 1.2, place_id: 'ChIJ45SNWTDwwogRuNlu9TNS4_c', phone: '+1 727-431-4900', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 2, notes: 'Grocery only.' },
  { id: 'walmart_nm_highland', name: 'Clearwater N Highland NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '1803 N Highland Ave, Clearwater, FL 33755', lat: 27.9871928, lng: -82.7740266, distance_mi: 2.0, place_id: 'ChIJM4jQK6fxwogRlQxUtk8Xjgw', phone: '+1 727-441-4320', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 3, notes: 'Grocery only.' },
  { id: 'walmart_nm_dunedin', name: 'Dunedin NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '2102 Main St, Dunedin, FL 34698', lat: 28.0204937, lng: -82.7504749, distance_mi: 3.1, place_id: 'ChIJUUWiqR7ywogRbhL2YAN1YUw', phone: '+1 727-431-0152', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 4 },
  { id: 'walmart_sc_largo_missouri', name: 'Largo Missouri Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '990 Missouri Ave N, Largo, FL 33770', lat: 27.9265193, lng: -82.7857758, distance_mi: 4.3, place_id: 'ChIJ33xyKp3wwogRrj1xnMe7-X4', phone: '+1 727-587-7822', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 5 },
  { id: 'walmart_sc_largo_roosevelt', name: 'Largo Roosevelt Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '2677 Roosevelt Blvd, Largo, FL 33760', lat: 27.9129110, lng: -82.7278019, distance_mi: 4.5, place_id: 'ChIJv6rrIlHlwogRmsD9s92MrZI', phone: '+1 727-431-5917', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 6 },
  { id: 'walmart_nm_ulmerton', name: 'Largo Ulmerton NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '9020 Ulmerton Rd, Largo, FL 33771', lat: 27.893061, lng: -82.7641418, distance_mi: 5.9, place_id: 'ChIJ0e_Oge76wogRqio2Le9f38g', phone: '+1 727-431-5016', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 7 },
  { id: 'walmart_nm_palm_harbor_elake', name: 'Palm Harbor E Lake NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '3400 E Lake Rd S, Palm Harbor, FL 34685', lat: 28.0601298, lng: -82.7061845, distance_mi: 6.2, place_id: 'ChIJdz9GEAntwogRBdcypnDCMZI', phone: '+1 727-431-1417', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 8 },
  { id: 'walmart_sc_oldsmar', name: 'Oldsmar Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '3801 Tampa Rd, Oldsmar, FL 34677', lat: 28.0439791, lng: -82.6735148, distance_mi: 6.3, place_id: 'ChIJq--upkPswogRGDOFQbVgxBo', phone: '+1 813-854-3261', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 9 },
  { id: 'walmart_sc_palm_harbor_us19', name: 'Palm Harbor US-19 Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '35404 US Hwy 19 N, Palm Harbor, FL 34684', lat: 28.0951426, lng: -82.740509, distance_mi: 8.2, place_id: 'ChIJK34zKKnywogRvxFEkWV3Y6A', phone: '+1 727-784-8797', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 10 },
  { id: 'walmart_nm_walsingham', name: 'Largo Walsingham NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '13817 Walsingham Rd, Largo, FL 33774', lat: 27.8816779, lng: -82.8300336, distance_mi: 8.4, place_id: 'ChIJa9LH5oL5wogRor9HpEbAGTs', phone: '+1 727-593-9294', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 11 },
  { id: 'walmart_nm_tampa_elliot', name: 'Tampa Elliot Drive NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '6216 Elliot Dr, Tampa, FL 33615', lat: 28.0063612, lng: -82.5986049, distance_mi: 9.0, place_id: 'ChIJ______PpwogRo7SW868dasM', phone: '+1 813-249-3145', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 12 },
  { id: 'walmart_nm_pinellas_park_66th', name: 'Pinellas Park 66th St NM', chain: 'Walmart', store_type: 'NEIGHBORHOOD_MARKET', tier: 'TIER_1', address: '7500 66th St N, Pinellas Park, FL 33781', lat: 27.8399903, lng: -82.7298762, distance_mi: 9.5, place_id: 'ChIJRfzX8bHkwogRWiny43OlyOY', phone: '+1 727-202-3101', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 13 },
  { id: 'walmart_sc_pinellas_park_us19', name: 'Pinellas Park US-19 Supercenter', chain: 'Walmart', store_type: 'SUPERCENTER', tier: 'TIER_1', address: '8001 US Hwy 19 N, Pinellas Park, FL 33781', lat: 27.845092, lng: -82.6849637, distance_mi: 9.7, place_id: 'ChIJTXbF12bkwogRclf-mEeNsu8', phone: '+1 727-576-1770', hours_text: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost_cents: 0, default_priority: 14 },

  // === BJ'S WHOLESALE CLUB (1 store) ===
  { id: 'bjs_us19', name: "BJ's Wholesale Club US-19", chain: "BJ's", store_type: 'WAREHOUSE_CLUB', tier: 'TIER_1', address: '26996 US Hwy 19 N, Clearwater, FL 33761', lat: 28.0185015, lng: -82.7399506, distance_mi: 2.9, place_id: 'ChIJcdSnT_7zwogRs1BRj-JQXRg', phone: '+1 727-286-4625', hours_text: '8:00-22:00 daily', delivery_program: "BJ's Inner Circle", delivery_cost_cents: 0, is_membership_required: true, membership_active: true, default_priority: 15, notes: 'BULK MULTIPACK SOURCE.' },

  // === TARGET (3 stores) ===
  { id: 'target_gulf_to_bay', name: 'Target Gulf to Bay', chain: 'Target', store_type: 'DEPARTMENT_STORE', tier: 'TIER_2', address: '2747 Gulf to Bay Blvd, Clearwater, FL 33759', lat: 27.9585891, lng: -82.7240926, distance_mi: 2.1, place_id: 'ChIJWQTa89HvwogRvpFL7J5VElE', phone: '+1 727-431-0231', hours_text: '8:00-22:00 (Fri-Sat 23:00)', delivery_program: 'Target Circle 360 / Shipt', delivery_cost_cents: 0, default_priority: 16, notes: 'PRIMARY TARGET.' },
  { id: 'target_largo_ulmerton', name: 'Target Largo Ulmerton', chain: 'Target', store_type: 'DEPARTMENT_STORE', tier: 'TIER_2', address: '10500 Ulmerton Rd, Largo, FL 33771', lat: 27.8925232, lng: -82.7849495, distance_mi: 6.2, place_id: 'ChIJmboid1v6wogRyl2jJSgtBhY', phone: '+1 727-581-6000', hours_text: '8:00-22:00 daily', delivery_program: 'Target Circle 360 / Shipt', delivery_cost_cents: 0, default_priority: 17 },
  { id: 'target_palm_harbor', name: 'Target Palm Harbor', chain: 'Target', store_type: 'DEPARTMENT_STORE', tier: 'TIER_2', address: '900 E Lake Rd S, Palm Harbor, FL 34685', lat: 28.0634006, lng: -82.7076828, distance_mi: 6.5, place_id: 'ChIJ01-yXQntwogRWFwk7TcsR40', phone: '+1 727-786-6969', hours_text: '8:00-22:00 daily', delivery_program: 'Target Circle 360 / Shipt', delivery_cost_cents: 0, default_priority: 18 },

  // === PUBLIX (9 stores) ===
  { id: 'publix_beckett_lake', name: 'Publix Beckett Lake', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '1921 N Belcher Rd, Clearwater, FL 33763', lat: 27.9906485, lng: -82.7427533, distance_mi: 1.0, place_id: 'ChIJ97u1f93xwogRP16TfSkruNE', phone: '+1 727-712-3450', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 19 },
  { id: 'publix_gulf_to_bay', name: 'Publix Gulf to Bay Plaza', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '525 S Belcher Rd, Clearwater, FL 33764', lat: 27.9595953, lng: -82.7445571, distance_mi: 1.3, place_id: 'ChIJN0Q7Li7wwogRGUSXlL8W1HI', phone: '+1 727-791-0138', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 20 },
  { id: 'publix_bayside_bridge', name: 'Publix Bayside Bridge', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '1520 McMullen Booth Rd, Clearwater, FL 33759', lat: 27.9800723, lng: -82.7109165, distance_mi: 2.5, place_id: 'ChIJPRwgAkfuwogRK5o0khDsdBk', phone: '+1 727-725-4900', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 21 },
  { id: 'publix_clearwater_plaza', name: 'Publix Clearwater Plaza', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '1295 S Missouri Ave, Clearwater, FL 33756', lat: 27.9509957, lng: -82.7860038, distance_mi: 2.8, place_id: 'ChIJm-bGgOnxwogRMOvAW9emZxw', phone: '+1 727-241-6723', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 22 },
  { id: 'publix_labelle', name: 'Publix LaBelle Plaza', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '1555 S Highland Ave, Clearwater, FL 33756', lat: 27.9401903, lng: -82.7737645, distance_mi: 2.9, place_id: 'ChIJT0Ti1WPwwogR04_cisqT1H8', phone: '+1 727-442-5511', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 23 },
  { id: 'publix_harbor_oaks', name: 'Publix Harbor Oaks', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '619 S Ft Harrison Ave, Clearwater, FL 33756', lat: 27.9592477, lng: -82.7990053, distance_mi: 3.2, place_id: 'ChIJ7aAGUqDxwogRr0lix821c2E', phone: '+1 727-443-5700', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 24 },
  { id: 'publix_northwood', name: 'Publix Northwood Plaza', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '2514 McMullen Booth Rd, Clearwater, FL 33761', lat: 28.0130977, lng: -82.7114994, distance_mi: 3.5, place_id: 'ChIJ6yHvX9_twogRFPIJ8zrkK0E', phone: '+1 727-723-0281', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 25 },
  { id: 'publix_island_village', name: 'Publix Island Village', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '200 Island Way, Clearwater, FL 33767', lat: 27.9788924, lng: -82.8172107, distance_mi: 4.0, place_id: 'ChIJZz3nqPLxwogR6c2EcqmgfX4', phone: '+1 727-298-8618', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 26 },
  { id: 'publix_east_bay', name: 'Publix East Bay Largo', chain: 'Publix', store_type: 'STANDARD_GROCERY', tier: 'TIER_2', address: '5000 E Bay Dr, Clearwater, FL 33764', lat: 27.9180546, lng: -82.7350357, distance_mi: 4.2, place_id: 'ChIJlfWcNav6wogR2XZYhrYGm34', phone: '+1 727-538-8500', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 27 },

  // === SAM'S CLUB / COSTCO (2 stores) ===
  { id: 'sams_club_gulf_to_bay', name: "Sam's Club Gulf-to-Bay", chain: "Sam's", store_type: 'WAREHOUSE_CLUB', tier: 'TIER_3', address: '2575 Gulf to Bay Blvd, Clearwater, FL 33765', lat: 27.9591686, lng: -82.7321206, distance_mi: 1.7, place_id: 'ChIJSdLV_dbvwogRYurJDH26Doc', phone: '+1 727-791-8081', hours_text: '9:00-20:00 daily', delivery_program: "Sam's Plus", delivery_cost_cents: 0, is_membership_required: true, membership_active: true, default_priority: 28 },
  { id: 'costco_gulf_to_bay', name: 'Costco Gulf-to-Bay', chain: 'Costco', store_type: 'WAREHOUSE_CLUB', tier: 'TIER_3', address: '2655 Gulf to Bay Blvd, Clearwater, FL 33759', lat: 27.9561733, lng: -82.7287016, distance_mi: 2.0, place_id: 'ChIJ5enxZdHvwogRP5b0gMf48Tc', phone: '+1 727-373-1951', hours_text: 'Mon-Fri 10:00-20:30, Sat 9:30-19:00, Sun 10:00-18:00', delivery_program: 'Costco Same-Day', delivery_cost_cents: 1000, is_membership_required: true, default_priority: 29 },

  // === ALDI (2 stores) ===
  { id: 'aldi_gulf_to_bay', name: 'ALDI Gulf to Bay', chain: 'ALDI', store_type: 'DISCOUNT_GROCERY', tier: 'TIER_4', address: '2150 Gulf to Bay Blvd, Clearwater, FL 33765', lat: 27.961729, lng: -82.747783, distance_mi: 1.1, place_id: 'ChIJ4y5J5tvxwogRQHDIbICatDs', phone: '+1 855-955-2534', hours_text: '8:30-20:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 30 },
  { id: 'aldi_us19', name: 'ALDI US-19 Safety Harbor', chain: 'ALDI', store_type: 'DISCOUNT_GROCERY', tier: 'TIER_4', address: '24756 US Hwy 19 N, Clearwater, FL 33763', lat: 27.996798, lng: -82.730403, distance_mi: 1.8, place_id: 'ChIJeTcdGhzuwogRxcSKB98ztIo', phone: '+1 855-955-2534', hours_text: '8:30-20:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 31 },

  // === PREMIUM SPECIALTY (3 stores) ===
  { id: 'whole_foods_us19', name: 'Whole Foods US-19', chain: 'Whole Foods', store_type: 'PREMIUM_GROCERY', tier: 'TIER_5', address: '27001 US Hwy 19 N, Clearwater, FL 33761', lat: 28.0169803, lng: -82.735839, distance_mi: 2.9, place_id: 'ChIJVbYOe__twogRRvEOd-oSXGE', phone: '+1 727-724-7100', hours_text: '8:00-22:00 daily', delivery_program: 'Amazon Fresh', delivery_cost_cents: 0, default_priority: 32 },
  { id: 'fresh_market_us19', name: 'The Fresh Market US-19', chain: 'Fresh Market', store_type: 'PREMIUM_GROCERY', tier: 'TIER_5', address: '25961 US Hwy 19 N, Clearwater, FL 33763', lat: 28.008698, lng: -82.728766, distance_mi: 2.6, place_id: 'ChIJbRPNUR_uwogRqyNx8qIhb-s', phone: '+1 727-669-6111', hours_text: '8:00-21:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 33 },
  { id: 'trader_joes_palm_harbor', name: "Trader Joe's Palm Harbor", chain: "Trader Joe's", store_type: 'PREMIUM_GROCERY', tier: 'TIER_5', address: '33591 US Hwy 19 N, Palm Harbor, FL 34684', lat: 28.077872, lng: -82.7375949, distance_mi: 7.0, place_id: 'ChIJ86jxOwDzwogRiEEwd91IXCo', phone: '+1 727-436-4019', hours_text: '9:00-21:00 daily', delivery_program: 'Pickup only', delivery_cost_cents: 0, default_priority: 34, notes: 'No delivery API.' },

  // === WINN-DIXIE (3 stores) ===
  { id: 'winn_dixie_largo_ebay', name: 'Winn-Dixie Largo E Bay', chain: 'Winn-Dixie', store_type: 'STANDARD_GROCERY', tier: 'TIER_5', address: '2460 E Bay Dr, Largo, FL 33771', lat: 27.9185323, lng: -82.7614789, distance_mi: 4.1, place_id: 'ChIJGWYVIJz6wogRXeAbvA2_C9U', phone: '+1 727-535-1322', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 35 },
  { id: 'winn_dixie_pinellas_park', name: 'Winn-Dixie Pinellas Park', chain: 'Winn-Dixie', store_type: 'STANDARD_GROCERY', tier: 'TIER_5', address: '6501 102nd Ave N, Pinellas Park, FL 33782', lat: 27.8657832, lng: -82.7270196, distance_mi: 7.9, place_id: 'ChIJcyC8BNHkwogRaK9ngU6kkDg', phone: '+1 727-541-2070', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 36 },
  { id: 'winn_dixie_largo_seminole', name: 'Winn-Dixie Largo Seminole', chain: 'Winn-Dixie', store_type: 'STANDARD_GROCERY', tier: 'TIER_5', address: '10202 Seminole Blvd, Largo, FL 33778', lat: 27.8665765, lng: -82.7884306, distance_mi: 8.0, place_id: 'ChIJgVqX5q_7wogRHEuzQ_aqrbs', phone: '+1 727-392-8211', hours_text: '7:00-22:00 daily', delivery_program: 'Instacart', delivery_cost_cents: 1500, default_priority: 37 },
];
```

---

## 🔗 СВЯЗИ

```
Sourcing Map (37 stores)
    ↑ Vladimir's Walmart Business account (authoritative для Walmart distances)
    ↑ places_search (Google Places API) — для coordinates + ratings + photos
    ↓ → Bundle Factory Stage 2 (Research) — filter products by source availability
    ↓ → Bundle Factory Stage 7 (Distribution) — populate SKUStorePriority
    ↓ → Procurement Module — actual purchase workflow
    ⇔ Cost Calculator — delivery cost per source
```

---

## 📝 OPERATIONAL NOTES

- **Quarterly re-scan map:** обновлять список ежеквартально
- **Stock monitoring:** НЕ continuous, только pre-publication re-check
- **Manual override:** Vladimir может временно отключить магазин — отметка `is_active: false`
- **Substitute graph:** при out-of-stock в primary → Stage 6 циклит через нижние priority — у Walmart 13 fallback options

---

## 🚧 РОДСТВЕННЫЕ ДОКУМЕНТЫ

- [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](BUNDLE_FACTORY_CONCEPT_v1_0.md) — master concept
- [`BUNDLE_FACTORY_DATA_MODEL.md`](BUNDLE_FACTORY_DATA_MODEL.md) — Prisma schema
- [`docs/wiki/bundle-factory.md`](wiki/bundle-factory.md) — wiki overview
- [`procurement-module.md`](wiki/procurement-module.md) — следующее звено цепочки (SKUStorePriority)

---

**End of Sourcing Map v1.1** — 2026-05-17 (исправлено: 14 Walmart, не 5)
