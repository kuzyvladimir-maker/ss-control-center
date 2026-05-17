# Amazon Browse Nodes — Grocery & Food Gifts ⭐

> **Source:** Amazon.com category hierarchy (verified via web search 2026-05-17)
> **Last verified:** 2026-05-17
> **Priority:** **P0** — wrong browse node = Gift Basket Exception не применяется

---

## TL;DR

Для Vladimir's gift sets критически важен **12011207011** (Food Assortments & Variety Gifts) — единственный node, в котором gift basket exception работает наиболее надёжно. Указание browse node — обязательное поле в Listing Flat File.

---

## 🌳 Hierarchy — VERIFIED 2026-05-17 (all 13 sub-categories)

```
Grocery & Gourmet Food                              [16310101]
└── Food & Beverage Gifts                           [2255571011]
    ├── Advent Calendars (Food & Drink)             [78380725011]   ⚠️ NEW
    ├── Food Assortments & Variety Gifts            [12011207011]   ⭐ MAIN
    ├── Bakery & Dessert Gifts                      [2255576011]
    ├── Candy & Chocolate Gifts                     [2255572011]
    ├── Cheese & Charcuterie Gifts                  [2255573011]    (dual hierarchy)
    ├── Coffee Gifts                                [23900459011]
    ├── Fruit & Nut Gifts                           [2255577011]
    ├── Herb, Spice & Seasoning Gifts               [2255584011]
    ├── Jam, Jelly & Sweet Spread Gifts             [2255578011]
    ├── Meat & Seafood Gifts                        [2255579011]    (dual hierarchy)
    ├── Sauce, Gravy & Marinade Gifts               [2255580011]
    ├── Snack Food Gifts (UI: "Snack Gifts")        [2255582011]
    └── Tea Gifts (canonical: "Gourmet Tea Gifts")  [23700435011]
```

**Все IDs web-verified 2026-05-17 через прямой Amazon.com URL inspection.**

### Full confirmed table

| Browse Node ID | Display Name | URL slug |
|---|---|---|
| `16310101` | Grocery & Gourmet Food (grandparent) | `/b?node=16310101` |
| `2255571011` | Food & Beverage Gifts (parent) | `/b?node=2255571011` |
| `78380725011` | Food & Drink Advent Calendars ⚠️ NEW | `/Food-Drink-Advent-Calendars/b?node=78380725011` |
| **`12011207011`** | **Food Assortments & Variety Gifts** ⭐ | `/zgbs/grocery/12011207011` |
| `2255576011` | Bakery & Dessert Gifts | `/Bakery-Dessert-Gifts/b?node=2255576011` |
| `2255572011` | Candy & Chocolate Gifts | `/Candy-Chocolate-Gifts/b?node=2255572011` |
| `2255573011` | Cheese & Charcuterie Gifts | `/Cheese-Charcuterie-Gifts/b?node=2255573011` |
| `23900459011` | Coffee Gifts | `/Coffee-Gifts/b?node=23900459011` |
| `2255577011` | Fruit & Nut Gifts | `/Fruit-Nut-Gifts/b?node=2255577011` |
| `2255584011` | Herb, Spice & Seasoning Gifts | `/Herb-Spice-Seasoning-Gifts/b?node=2255584011` |
| `2255578011` | Jam, Jelly & Sweet Spread Gifts | `/Jam-Jelly-Sweet-Spread-Gifts/b?node=2255578011` |
| `2255579011` | Meat & Seafood Gifts | `/Meat-Seafood-Gifts/b?node=2255579011` |
| `2255580011` | Sauce, Gravy & Marinade Gifts | `/Sauce-Gravy-Marinade-Gifts/b?node=2255580011` |
| `2255582011` | Snack Food Gifts (UI: "Snack Gifts") | `/Snack-Food-Gifts/b?node=2255582011` |
| `23700435011` | Gourmet Tea Gifts (UI: "Tea Gifts") | `/Gourmet-Tea-Gifts/b?node=23700435011` |

### Dual-hierarchy notes

Две sub-categories доступны через **два пути** в Amazon's category tree (same node ID):

- **Cheese & Charcuterie Gifts** (`2255573011`):
  - Path A: `Grocery & Gourmet Food → Food & Beverage Gifts → Cheese & Charcuterie Gifts`
  - Path B: `Grocery & Gourmet Food → Meat & Seafood → Cheese & Charcuterie Gifts`
- **Meat & Seafood Gifts** (`2255579011`):
  - Path A: `Grocery & Gourmet Food → Food & Beverage Gifts → Meat & Seafood Gifts`
  - Path B: `Grocery & Gourmet Food → Meat & Seafood → Meat & Seafood Gifts`

Impл. для Stage 6 валидатора: подаём единый ID — Amazon индексирует в оба пути автоматически.

### Naming inconsistencies (UI vs canonical)

- Node `2255582011` отображается на parent странице как **"Snack Gifts"**, но canonical name (URL/Best Sellers/SP-API) — **"Snack Food Gifts"**. Использовать canonical везде в Bundle Factory mappings.
- Node `23700435011` показывается как **"Tea Gifts"** в parent breadcrumb, canonical/URL — **"Gourmet Tea Gifts"**.

### ID number ranges

У Amazon две группы нумерации для этих categories:
- **Старая (2255xxx)** — 10 категорий созданных одним batch'ем
- **Новая (23xxxxxxx — 78xxxxxxx)** — добавлены позднее: Coffee Gifts, Tea Gifts, Advent Calendars, Food Assortments & Variety Gifts

ID соседних categories угадать нельзя — каждую verify отдельно.

---

## 🎯 Mapping для bundle content → browse node

| Bundle content | Browse node ID | Reasoning |
|---|---|---|
| Mixed content (≥ 2 product types или brands) | **`12011207011`** Food Assortments & Variety Gifts | Default для multi-product mix |
| Single product multipack в gift box | **`12011207011`** | Default safe choice (Lunchables 12-pack, Uncrustables set) |
| Cheese / Charcuterie set | `2255573011` Cheese & Charcuterie Gifts | Specific sub = better SEO |
| Coffee set | `23900459011` Coffee Gifts | Specific sub |
| Tea set | `23700435011` Gourmet Tea Gifts | Specific sub |
| Fruit & Nut variety | `2255577011` Fruit & Nut Gifts | Specific sub |
| Hot Sauce / BBQ variety | `2255580011` Sauce, Gravy & Marinade Gifts | Specific sub |
| Spice / seasoning gift set | `2255584011` Herb, Spice & Seasoning Gifts | Specific sub |
| Jam / jelly gift set | `2255578011` Jam, Jelly & Sweet Spread Gifts | Specific sub |
| Cookies / brownies gift basket | `2255576011` Bakery & Dessert Gifts | Specific sub |
| Candy / chocolate gift box | `2255572011` Candy & Chocolate Gifts | Specific sub |
| Snack gift box (mixed brands) | `2255582011` Snack Food Gifts | Specific sub для unbranded multi-vendor mix |
| Meat / seafood gift set | `2255579011` Meat & Seafood Gifts | Specific sub |
| Seasonal countdown gift | `78380725011` Food & Drink Advent Calendars | Premium seasonal category |

**Rule of thumb (refined):**
> 1. Bundle = mixed content (≥ 2 product types или ≥ 2 brands) → `12011207011` (Food Assortments & Variety Gifts)
> 2. Bundle = single category focus (только cheese / только coffee / только chocolate) → specific sub-node
> 3. Bundle = seasonal gift с countdown structure → `78380725011` (Advent Calendars)

---

## 📋 Gift Arrangement filter

В node 12011207011 атрибут `gift_arrangement`:
- **Basket** — wicker
- **Box** — cardboard ← Vladimir's style
- **Sampler**
- **Tin**

Для Vladimir всегда `Box`.

---

## 📋 Occasion filter

Browse filter `occasion_type` в 12011207011:
Anniversary, Birthday, Christmas, Congratulations, Diwali, Easter, Father's Day, Get Well, Halloween, Mother's Day, New Year's, St. Patrick's Day, Summer, Sympathy, Thank You & Appreciation, Thanksgiving, Valentine's Day.

Stage 4 AI определяет occasion из brief.

---

## ⚠️ Browse nodes БЕЗ gift exception

Vladimir **не должен** листить gift sets в эти nodes (это violation):

| Node | Категория |
|---|---|
| Frozen Sandwiches | Frozen Food |
| Frozen Breakfast Items | Frozen Food |
| Snack Food (вне Gifts) | Snacks |
| Crackers & Cookies | Bakery |
| Cheese (вне Cheese & Charcuterie Gifts) | Dairy |

**Простое правило:** если category name не содержит слово "Gift" — exception не применима.

---

## 🔧 Указание в Flat File / SP-API

Flat File columns:
- `recommended_browse_nodes` → `12011207011`
- `item_type` → `food-assortments-variety-gift`
- `gift_arrangement` → `Box`
- `occasion_type` → `Christmas` (опционально)

SP-API JSON Listings v2:
```json
{
  "productType": "GIFT_BASKET",
  "attributes": {
    "recommended_browse_nodes": [{ "value": "12011207011", "marketplace_id": "ATVPDKIKX0DER" }],
    "item_type_name": [{ "value": "food-assortments-variety-gift", "marketplace_id": "ATVPDKIKX0DER" }],
    "gift_arrangement": [{ "value": "Box", "marketplace_id": "ATVPDKIKX0DER" }]
  }
}
```

`ATVPDKIKX0DER` = Amazon.com US marketplace.

---

## 🔍 Post-publish verification

1. Wait 1-2 hours для processing
2. Fetch listing через `getListingsItem`
3. Check `attributes.parent_browse_nodes_path` — должно содержать "Food Assortments & Variety Gifts"
4. Если mismatch → Support case с reference на Product Bundling Policy

Stage 7 (Distribution) автоматизирует этот check.

---

## 📚 References

- https://www.amazon.com/Best-Sellers-Food-Assortments-Variety-Gifts/zgbs/grocery/12011207011
- https://developer-docs.amazon.com/sp-api/docs/product-type-definitions-api-reference
- Internal: [`gift-set-policy.md`](gift-set-policy.md), [`bundle-policy.md`](bundle-policy.md)

---

## 🚧 TODO

- [x] ✅ Fetch numeric IDs для всех sub-categories (2026-05-17 — все 13 web-verified, +2 неучтённых: Advent Calendars и dual hierarchy)
- [ ] Сравнить с Vladimir's 1028 existing Salutem Vita listings — какой node по факту? (Requires Active Listings Report или SP-API access)
- [ ] Document marketplace IDs других регионов (CA, UK) для Phase 2

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
