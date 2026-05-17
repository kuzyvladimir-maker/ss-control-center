# BUNDLE FACTORY — Sourcing Map v1.0

> **Date:** 2026-05-17
> **Warehouse:** 1162 Kapp Dr, Clearwater, FL 33765
> **Coordinates:** 27.9775467°N, -82.7512346°W
> **Sourcing radius:** 10 miles (28 stores), with 15-mile fallback
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

Приоритеты основаны на: delivery cost / quality / fit для bundle types / Vladimir's operational preference.

### Tier 1 — Primary (default outbound)

| Сеть | Зачем |
|---|---|
| **Walmart** (Supercenter + Neighborhood Market) | Главный source. WP+ = free delivery. Огромный grocery + frozen ассортимент. Самые низкие цены. Ежедневная доставка от 5 раз в день. |
| **BJ's Wholesale Club** | Multipack-формы которые отлично ложатся в gift sets (24-packs, 12-packs из коробки). Same-day delivery free over $50. Membership уже есть. |

### Tier 2 — Secondary (when Tier 1 out of stock)

| Сеть | Зачем |
|---|---|
| **Target** | Хорошая frozen-секция + premium brands недоступные в Walmart. Circle 360 = free delivery, иначе $9.99. |
| **Publix** | Premium specialty items, отличные cheeses/deli/bakery. InstaCart delivery (доплата). |

### Tier 3 — Bulk specialist (для large pack bundles)

| Сеть | Зачем |
|---|---|
| **Sam's Club** | Bulk-only форматы которые нужны для специфических high-count gift sets. Membership уже есть. |
| **Costco** | Premium bulk. Member-only. Резерв когда Sam's outage. |

### Tier 4 — Discount fallback

| Сеть | Зачем |
|---|---|
| **ALDI** | Прайс-точка ниже Walmart на multiple SKU. Не вся ассортимент перекрывается, но для бюджетных bundle вариантов — хороший вариант. |

### Tier 5 — Specialty / extended fallback

| Сеть | Зачем |
|---|---|
| **Whole Foods** | Organic/premium specialty. Через Amazon Fresh delivery (free Prime). Дорого, только когда нужно. |
| **Trader Joe's** | Уникальные SKUs не доступные нигде больше. Pickup only (нет delivery). Используется только при специфическом запросе bundle. |
| **The Fresh Market** | Аналог Whole Foods, более premium. Резерв. |
| **Winn-Dixie** | Низкие цены, иногда лучшие BOGO на canned/dry. Активный поглощается Aldi (часть магазинов конвертится). |

---

## 📊 ПОЛНЫЙ STORE REGISTRY (sorted by distance)

### Зона <2 миль от склада — **Tier 0** (одноминутная поездка)

| # | Store | Chain | Address | Distance | Open | Notes |
|---|---|---|---|---|---|---|
| 1 | Publix Beckett Lake Plaza | Publix | 1921 N Belcher Rd, Clearwater 33763 | **1.0 mi** | 7:00-22:00 ежедневно | Огромный, 2736 reviews |
| 2 | ALDI Gulf to Bay | ALDI | 2150 Gulf to Bay Blvd, Clearwater 33765 | **1.1 mi** | 8:30-20:00 | Discount fallback |
| 3 | **Walmart Supercenter US-19** | Walmart | 23106 US Hwy 19 N, Clearwater 33765 | **1.2 mi** | 6:00-23:00 ежедневно | ⭐ Главный source. 8399 reviews. Полный grocery + frozen |
| 4 | Walmart Neighborhood Market Gulf-to-Bay | Walmart | 2171 Gulf to Bay Blvd, Clearwater 33765 | **1.3 mi** | 6:00-23:00 | Только grocery, без electronics |
| 5 | Publix Gulf to Bay Plaza | Publix | 525 S Belcher Rd, Clearwater 33764 | **1.3 mi** | 7:00-22:00 | 3674 reviews, самый большой Publix в зоне |
| 6 | Walmart Neighborhood Market Highland | Walmart | 1803 N Highland Ave, Clearwater 33755 | **1.5 mi** | 6:00-23:00 | Grocery-only |
| 7 | Sam's Club Gulf-to-Bay | Sam's | 2575 Gulf to Bay Blvd, Clearwater 33765 | **1.7 mi** | 9:00-20:00 | Bulk only, membership |
| 8 | ALDI US-19 Safety Harbor | ALDI | 24756 US Hwy 19 N, Clearwater 33763 | **1.8 mi** | 8:30-20:00 | Discount fallback |

### Зона 2-3 миль

| # | Store | Chain | Address | Distance | Open | Notes |
|---|---|---|---|---|---|---|
| 9 | Costco Gulf-to-Bay | Costco | 2655 Gulf to Bay Blvd, Clearwater 33759 | **2.0 mi** | Mon-Fri 10:00-20:30, Sat 9:30-19:00, Sun 10:00-18:00 | Bulk premium, membership |
| 10 | **Target Gulf to Bay** | Target | 2747 Gulf to Bay Blvd, Clearwater 33759 | **2.1 mi** | 8:00-22:00 (Fri/Sat до 23:00) | ⭐ Основной Target |
| 11 | Publix Bayside Bridge Plaza | Publix | 1520 McMullen Booth Rd, Clearwater 33759 | **2.5 mi** | 7:00-22:00 | Восточный Clearwater |
| 12 | The Fresh Market US-19 | Fresh Market | 25961 US Hwy 19 N, Clearwater 33763 | **2.6 mi** | 8:00-21:00 | Premium specialty |
| 13 | Publix Clearwater Plaza | Publix | 1295 S Missouri Ave, Clearwater 33756 | **2.8 mi** | 7:00-22:00 | New store |
| 14 | **BJ's Wholesale Club US-19** | BJ's | 26996 US Hwy 19 N, Clearwater 33761 | **2.9 mi** | 8:00-22:00 (Sun до 21:00) | ⭐ Главный bulk-multipack source |
| 15 | Publix LaBelle Plaza | Publix | 1555 S Highland Ave, Clearwater 33756 | **2.9 mi** | 7:00-22:00 | Близко к складу |
| 16 | Whole Foods Market US-19 | Whole Foods | 27001 US Hwy 19 N, Clearwater 33761 | **2.9 mi** | 8:00-22:00 | Organic premium, Amazon Fresh delivery |

### Зона 3-5 миль

| # | Store | Chain | Address | Distance | Open | Notes |
|---|---|---|---|---|---|---|
| 17 | Publix Harbor Oaks | Publix | 619 S Ft Harrison Ave, Clearwater 33756 | **3.2 mi** | 7:00-22:00 | Downtown Clearwater |
| 18 | Publix Northwood Plaza | Publix | 2514 McMullen Booth Rd, Clearwater 33761 | **3.5 mi** | 7:00-22:00 | Северо-восток |
| 19 | Publix Island Village | Publix | 200 Island Way, Clearwater 33767 | **4.0 mi** | 7:00-22:00 | На Clearwater Beach side, parking garage |
| 20 | Walmart Supercenter Missouri/Largo | Walmart | 990 Missouri Ave N, Largo 33770 | **4.1 mi** | 6:00-23:00 | Largo location |
| 21 | Winn-Dixie Largo E Bay | Winn-Dixie | 2460 E Bay Dr, Largo 33771 | **4.1 mi** | 7:00-22:00 | Хороший BOGO на canned |
| 22 | Publix East Bay Dr Largo | Publix | 5000 E Bay Dr, Clearwater 33764 | **4.2 mi** | 7:00-22:00 | Largo border |
| 23 | Walmart Supercenter Roosevelt | Walmart | 2677 Roosevelt Blvd, Clearwater 33760 | **4.7 mi** | 6:00-23:00 | South Clearwater |

### Зона 5-10 миль

| # | Store | Chain | Address | Distance | Open | Notes |
|---|---|---|---|---|---|---|
| 24 | Target Largo Ulmerton | Target | 10500 Ulmerton Rd, Largo 33771 | **6.2 mi** | 8:00-22:00 | Largo Mall area |
| 25 | Target Palm Harbor | Target | 900 E Lake Rd S, Palm Harbor 34685 | **6.5 mi** | 8:00-22:00 | Северо-восток |
| 26 | Trader Joe's Palm Harbor | Trader Joe's | 33591 US Hwy 19 N, Palm Harbor 34684 | **7.0 mi** | 9:00-21:00 | Pickup only |
| 27 | Winn-Dixie Pinellas Park | Winn-Dixie | 6501 102nd Ave N, Pinellas Park 33782 | **7.9 mi** | 7:00-22:00 | Far south |
| 28 | Winn-Dixie Largo Seminole | Winn-Dixie | 10202 Seminole Blvd, Largo 33778 | **8.0 mi** | 7:00-22:00 | West Largo |

### Зона 10-15 миль (fallback only)

| # | Store | Chain | Address | Distance |
|---|---|---|---|---|
| 29 | Target Pinellas Park | Target | 7150 US Hwy 19 N, Pinellas Park 33781 | 10.6 mi |
| 30 | Target St Pete MLK | Target | 8151 Dr M.L.K. Jr St N, St. Petersburg | 11.2 mi |
| 31 | Target St Pete Park St | Target | 4450 Park St N, St. Petersburg 33709 | 11.4 mi |
| 32 | Trader Joe's St Pete 4th St | Trader Joe's | 2742 4th St N, St. Petersburg 33704 | 14.2 mi |

---

## 🚚 DELIVERY OPTIONS MATRIX

| Chain | Default delivery | Membership program | Cost | Notes |
|---|---|---|---|---|
| **Walmart** | Walmart+ | $98/year или $12.95/month | **$0 delivery, no tips required** | Главный canal. Frozen доставляют отдельно при необходимости |
| **BJ's** | Same-day | BJ's Inner Circle (стандарт) или Plus | Free over $50 (Inner Circle), Free Plus members | + tip ~$5 |
| **Target** | Shipt / Target Circle 360 | Circle 360 = $99/year | $0 (Circle 360) или $9.99 + tip | Same-day delivery |
| **Publix** | Instacart partnership | Через Instacart subscription | InstaCart fees + tip + markup | Дороже всего из-за markup |
| **Sam's Club** | Sam's Club Plus | $110/year | Plus = free shipping; otherwise paid | Bulk only |
| **Costco** | Costco Same-Day | Executive $130/year | Higher fees, often $9.99+ | Paid model |
| **ALDI** | Instacart partnership | Instacart sub | Instacart fees | Discount грабится markup |
| **Whole Foods** | Amazon Fresh | Prime ($14.99/mo) | **$0 for Prime members** over $35 | Через Amazon Fresh |

**Стратегия для Bundle Factory cost calc:**

- Для Walmart sourcing → cost includes `+$0 delivery`
- Для BJ's sourcing → cost includes `+$5 tip` (но free delivery)
- Для Target sourcing → branch on Circle 360 membership status: `+$0` if yes, `+$10` if no
- Для всех остальных → estimate `+$15` (delivery + tip + markup)

Это закладывается в `cost_breakdown.sourcing_overhead` поле MasterBundle.

---

## 🏛️ SPECIAL CONSIDERATIONS PER CHAIN

### Walmart paradox (handled)

Vladimir продаёт на Walmart Marketplace и одновременно покупает в Walmart store для перепродажи. Это не arbitrage конфликт, а **3PL-shipping** для small businesses, заказывающих по всей Америке. Walmart не препятствует — у Vladimir 4000+ approved listings.

**Bundle Factory правило:** для Walmart Marketplace channel — листим только **dry/shelf-stable bundles** (frozen категория у Vladimir ещё не открыта). Заводится отдельно как Phase 2 задача.

### BJ's membership

У Vladimir есть active membership. Bundle Factory cost calculator закладывает annual membership fee как amortized cost per bundle: $55 (annual) / ~500 bundles = $0.11 per bundle.

### Target Circle 360

Если у Vladimir его нет — стоит подключить. $99/year окупается на ~10 bundles в месяц (где Target = primary source). Bundle Factory должен опционально активировать это в settings.

### Costco / Sam's

Bulk-only. Используется только когда:
- Нужен очень large pack size
- Walmart/BJ's out of stock
- Vladimir специально едет лично

В research-стадии помечается как "premium fallback".

### Trader Joe's

**Только pickup** — нет delivery API ни на Instacart, ни напрямую. Включается в bundle только если Vladimir физически едет.

### ALDI и Aldi consolidation

ALDI выкупает многие Winn-Dixie магазины в Florida и конвертирует в ALDI brand. Это значит регулярно появляются новые ALDI locations. Bundle Factory должен **периодически re-scan** sourcing map (ежеквартально через `BUNDLE_FACTORY_SOURCING_MAP.md` update).

---

## 🗂️ STORE REGISTRY (machine-readable)

При imports в БД (Prisma model `StoreRegistry`):

```typescript
const STORES: StoreRegistry[] = [
  // Tier 0 (<2 mi)
  { id: 'walmart_supercenter_us19', name: 'Walmart Supercenter US-19', chain: 'Walmart', subtype: 'Supercenter', address: '23106 US Hwy 19 N, Clearwater, FL 33765', lat: 27.9827016, lng: -82.7325222, distance_mi: 1.2, tier: 1, priority: 1, place_id: 'ChIJ29AO4SbuwogRkIbpV9gJTMY', phone: '+1 727-724-7777', hours: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost: 0, notes: 'PRIMARY SOURCE. Full grocery + frozen + electronics.' },
  { id: 'walmart_nm_gulf_to_bay', name: 'Walmart Neighborhood Market Gulf-to-Bay', chain: 'Walmart', subtype: 'Neighborhood Market', address: '2171 Gulf to Bay Blvd, Clearwater, FL 33765', lat: 27.9592073, lng: -82.748287, distance_mi: 1.3, tier: 1, priority: 2, place_id: 'ChIJ45SNWTDwwogRuNlu9TNS4_c', phone: '+1 727-431-4900', hours: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost: 0, notes: 'Grocery only, no electronics.' },
  { id: 'walmart_nm_highland', name: 'Walmart Neighborhood Market Highland', chain: 'Walmart', subtype: 'Neighborhood Market', address: '1803 N Highland Ave, Clearwater, FL 33755', lat: 27.9871928, lng: -82.7740266, distance_mi: 1.5, tier: 1, priority: 3, place_id: 'ChIJM4jQK6fxwogRlQxUtk8Xjgw', phone: '+1 727-441-4320', hours: '6:00-23:00 daily', delivery_program: 'Walmart+', delivery_cost: 0, notes: 'Grocery only.' },
  { id: 'bjs_us19', name: "BJ's Wholesale Club US-19", chain: "BJ's", subtype: 'Warehouse Club', address: '26996 US Hwy 19 N, Clearwater, FL 33761', lat: 28.0185015, lng: -82.7399506, distance_mi: 2.9, tier: 1, priority: 4, place_id: 'ChIJcdSnT_7zwogRs1BRj-JQXRg', phone: '+1 727-286-4625', hours: '8:00-22:00 daily', delivery_program: "BJ's Inner Circle", delivery_cost: 0, notes: 'BULK MULTIPACK SOURCE. Member only. Same-day free over $50.' },
  { id: 'target_gulf_to_bay', name: 'Target Gulf to Bay', chain: 'Target', subtype: 'Standard', address: '2747 Gulf to Bay Blvd, Clearwater, FL 33759', lat: 27.9585891, lng: -82.7240926, distance_mi: 2.1, tier: 2, priority: 5, place_id: 'ChIJWQTa89HvwogRvpFL7J5VElE', phone: '+1 727-431-0231', hours: '8:00-22:00 (Fri-Sat 23:00)', delivery_program: 'Target Circle 360 / Shipt', delivery_cost: 0, notes: 'PRIMARY TARGET. Frozen + refrigerated. Circle 360 free delivery.' },
  // ... (полный список генерируется Phase 1 миграцией)
];
```

Полный set из 32 stores → `BUNDLE_FACTORY_DATA_MODEL.md` (Phase 1).

---

## 🔗 СВЯЗИ

```
Sourcing Map
    ↑ places_search (Google Places API) — research stage
    ↑ Web scrapers per chain (для stock checking в Stage 2 Research)
    ↓ → Bundle Factory Stage 2 (Research) — filter products by source availability
    ↓ → Bundle Factory Stage 7 (Distribution) — populate SKUStorePriority
    ↓ → Procurement Module — actual purchase workflow
    ⇔ Cost Calculator — delivery cost per source
```

---

## 📝 OPERATIONAL NOTES

- **Quarterly re-scan** map: обновлять список ежеквартально (магазины открываются/закрываются)
- **Stock monitoring**: НЕ continuous, только pre-publication re-check
- **Manual override**: если Vladimir хочет временно excluded магазин (например, ремонт, плохой опыт) — отметка `inactive: true` на конкретном записи
- **Substitute graph**: при out-of-stock в Tier 1 → cycle through Tier 2 → Tier 3 → manual decision

---

## 🚧 РОДСТВЕННЫЕ ДОКУМЕНТЫ

- [`BUNDLE_FACTORY_CONCEPT_v1_0.md`](BUNDLE_FACTORY_CONCEPT_v1_0.md) — master concept
- [`docs/wiki/bundle-factory.md`](wiki/bundle-factory.md) — wiki overview
- `BUNDLE_FACTORY_DATA_MODEL.md` (Phase 1) — Prisma schema, включая `StoreRegistry`
- [`procurement-module.md`](wiki/procurement-module.md) — следующий звено цепочки (SKUStorePriority)

---

**End of Sourcing Map v1.0** — 2026-05-17
