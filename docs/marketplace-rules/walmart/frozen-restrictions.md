# Walmart Marketplace — Frozen Restrictions ⭐

> **Source:** Walmart Marketplace Seller Help + Vladimir's status
> **Last verified:** 2026-05-17
> **Priority:** P0

---

## TL;DR

Vladimir **не имеет** Frozen/Refrigerated approval на Walmart Marketplace. Это блокирует ~80% его Amazon Salutem Vita каталога от cross-listing на Walmart. Frozen approval — complex process, требующий warehouse certification, cold-chain documentation, и temperature-controlled shipping capabilities verification.

---

## Why Frozen is restricted

Walmart Marketplace's policy: sellers shipping frozen items must demonstrate:

1. **Cold chain infrastructure** — refrigerated storage at warehouse
2. **Temperature-controlled shipping** — specialized carriers
3. **Insurance** — coverage для spoilage claims
4. **Track record** — на other channels (Amazon Frozen experience помогает)
5. **Insurance liability** — special policy для cold-chain failures

Vladimir's reality:
- Warehouse 1162 Kapp Dr **не имеет** refrigerated storage (это JIT — components sourced same-day)
- Cold-chain shipping = Veeqo + cooler + gel packs (workaround, not pre-existing infrastructure)
- Track record на Amazon ✓ (1028 Salutem Vita frozen gift sets)
- Insurance — TBD

---

## Implications для Bundle Factory

### 1. Walmart channel — only shelf-stable bundles в MVP

ChannelSKU lifecycle:
- Frozen MasterBundle → Walmart ChannelSKU не создается (skipped в Stage 7)
- Shelf-stable MasterBundle → Walmart ChannelSKU создается normally

### 2. Sourcing неудачные components

Если Stage 2 (Research) находит mixed bundle (frozen + shelf-stable components) — Walmart distribution blocked.

### 3. Phase 2 — apply for Frozen approval

Bundle Factory должна иметь mechanism для Vladimir:
- Track Walmart category approval status в `BrandAccount` table
- Notify Vladimir когда apply window открыт
- Auto-create Walmart ChannelSKU для Frozen bundles ПОСЛЕ approval

---

## Walmart Marketplace Frozen approval application

Когда Vladimir готов apply:

1. Login Seller Center → Settings → Item Setup → Categories
2. Select **Frozen Foods** → "Apply to sell"
3. Submit:
   - Warehouse address (1162 Kapp Dr)
   - Cold-chain shipping plan
   - Sample tracking numbers from Amazon (proof of frozen FBM experience)
   - Insurance certificate
4. Wait 2-4 weeks для approval

После approval — Bundle Factory auto-detects через периодический check `BrandAccount.is_active` + capability flags.

---

## Workaround в MVP

Vladimir's MVP Bundle Factory:
- Primary channel = Amazon (5 accounts) — full Frozen support
- Secondary channel = Walmart — shelf-stable only
- 1 MasterBundle может generate 4-9 ChannelSKU (5 Amazon + 1 Walmart если shelf-stable)

Это OK — большинство bundle revenue будет от Amazon в любом случае.

---

## References

- https://sellercentral.walmart.com/help
- Internal: [`multipack-policy.md`](multipack-policy.md), [`category-grocery.md`](category-grocery.md), [`../amazon/category-frozen-grocery.md`](../amazon/category-frozen-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
