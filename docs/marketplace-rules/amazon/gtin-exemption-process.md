# Amazon GTIN Exemption Process ⭐

> **Source:** https://sellercentral.amazon.com/help/hub/reference/external/G202119180
> **Last verified:** 2026-05-17
> **Applies to:** Brand Registry sellers, creating new bundles without manufacturer UPC
> **Priority:** P0 для bundle creation

---

## TL;DR

GTIN (Global Trade Item Number) — это барcode (UPC, EAN, JAN). Amazon требует GTIN для каждого ASIN. Vladimir покупает UPC из third-party pool (SpeedyBarCode prefixes 742259, 789232, 617261). Эти UPC могут получать GTIN validation errors при создании listings. **GTIN Exemption** — официальный путь, позволяющий Brand Registry owners listing'овать products без attached-to-manufacturer GTIN.

Без exemption — есть риск intermittent rejection. С exemption — bulletproof creation.

---

## 🎯 Когда нужна exemption

| Сценарий | Нужна exemption? |
|---|---|
| Vladimir создаёт bundle с UPC из SpeedyBarCode pool под Salutem Vita | **Да, рекомендуется** |
| Vladimir resell-ит existing Amazon ASIN (например Jimmy Dean) | Нет (uses manufacturer's GTIN) |
| Vladimir создаёт private label single product (не bundle) | Да |
| Multi-channel sync (создание same ASIN в Walmart/eBay) | Не для GTIN; для каждого канала свои rules |

**Vladimir's reality:** существующие 1028 Salutem Vita gift set listings были созданы без exemption — они проходят без проблем потому что Salutem Vita = brand registered. Но новые bundle types могут получить GTIN error → лучше получить exemption proactively.

---

## 📋 Eligibility requirements

Чтобы apply for GTIN exemption, нужно:

1. **Brand Registry approved brand** — Salutem Vita ✓, Starfit ✓
2. **Brand Registry approval status** — должна быть active
3. **One или more product images** для каждого product/bundle (минимум 2 images per item)
4. **Letter from brand owner** (для Salutem Vita = Salutem Solutions LLC; для Starfit = Sirius International LLC) — на bandblanket Vladimir можно использовать template

---

## 🔧 Application process

### Step 1: Подготовка documents

Per-category exemption application требует:

- **Brand name** (Salutem Vita или Starfit)
- **Category** (Food / Pet Food / Health & Beauty / etc.)
- **Letter of authorization** (signed by brand owner = Vladimir as company owner)
- **2-3 product images** showing brand на packaging
- **Manufacturer information** — Vladimir's own company как manufacturer

### Step 2: Submission через Seller Central

Path в Seller Central:
```
Catalog → Add Products → Add a Product → I'm adding a product not sold on Amazon
→ Apply for GTIN exemption (after brand selection)
```

Direct link: https://sellercentral.amazon.com/gtinx

### Step 3: Form filling

Form fields:
- Brand: `Salutem Vita`
- Product type: `Grocery` (start with this; later separately apply for `Pet Food`)
- Justification: `As Brand Registry owner of Salutem Vita, I create proprietary gift bundle products under this brand. Each bundle is a unique product packaged for gifting (Box arrangement) and assigned a unique UPC from my GS1-issued pool. No manufacturer UPC exists because these are custom-created bundles.`
- Upload 2 product images per bundle type

### Step 4: Wait для approval

Amazon usually responds в 24-48 hours. Status visible в `Case Log`. Possible outcomes:
- ✅ **Approved** — exemption granted; можно listing'овать без strict GTIN validation
- ❌ **Denied** — usually due to brand verification issues or insufficient images
- ⚠️ **Need more info** — Amazon requests additional documentation

### Step 5: Application per-category

GTIN exemption applies **per brand × per category**. Vladimir's matrix:

| Brand | Category | Status | Apply path |
|---|---|---|---|
| Salutem Vita | Grocery | Apply | Most listings |
| Salutem Vita | Pet Food | Apply | If Vladimir lists pet products |
| Salutem Vita | Health & Beauty | Apply | Phase 2 |
| Salutem Vita | Baby | Apply | Phase 2 |
| Starfit | Sports & Outdoors | Apply | For Starfit products |
| Starfit | Health & Beauty | Apply | If Starfit Vitamin-style |

В DB tracking: модель `GTINExemption` в Data Model (см. [`BUNDLE_FACTORY_DATA_MODEL.md`](../../BUNDLE_FACTORY_DATA_MODEL.md)).

---

## 📋 Template Letter of Authorization

(Used когда submission asks for brand owner letter):

```
[Letterhead: Salutem Solutions LLC, 1162 Kapp Dr, Clearwater, FL 33765]

[Date]

Amazon Services LLC
Seller Performance Team

Re: GTIN Exemption Application — Salutem Vita Brand

To Whom It May Concern,

I, Vladimir Kuznetsov, as the registered owner of the brand "Salutem Vita"
under Amazon Brand Registry (Brand Registry ID: [PROVIDE]), hereby authorize
Salutem Solutions LLC (Seller ID: [SELLER ID]) to list products under this
brand on Amazon.com without manufacturer-assigned GTINs.

Products listed under this brand are proprietary gift bundle products
manufactured and packaged by Salutem Solutions LLC. Each product is assigned
a unique GS1-registered UPC from our company's allocated pool.

Manufacturer information:
- Manufacturer: Salutem Solutions LLC
- Address: 1162 Kapp Dr, Clearwater, FL 33765, USA
- Federal Tax ID: [EIN]

Signature: ____________________
Vladimir Kuznetsov, Owner
Salutem Solutions LLC
```

Аналогично для Starfit (substituted `Sirius International LLC` как manufacturer entity).

---

## 🎯 Bundle Factory integration

После approval — `GTINExemption.status = APPROVED`. Stage 6 Validation проверяет:

```typescript
function validateGTIN(channelSku: ChannelSKU): ComplianceResult {
  const exemption = db.gtinExemption.findUnique({
    where: { brand_channel_category: { brand: channelSku.brand, channel: channelSku.channel, category: channelSku.category } }
  });

  if (exemption?.status === 'APPROVED') {
    return { passed: true, issues: [] };  // GTIN can be from any UPCPool
  }

  // Otherwise check that UPC из manufacturer's range (GEPIR check)
  const upcOwner = await gepirLookup(channelSku.upc);
  if (upcOwner !== channelSku.brand) {
    return { passed: false, issues: [`UPC ${channelSku.upc} не принадлежит brand ${channelSku.brand} per GEPIR. Apply for GTIN exemption.`] };
  }

  return { passed: true, issues: [] };
}
```

---

## 🚧 Vladimir's action items

1. **Phase 0 first action:** Apply for GTIN exemption на Salutem Vita × Grocery (highest priority — это где 95% bundles)
2. **Phase 0 second action:** Apply на Salutem Vita × Pet Food (для pet bundles)
3. **Phase 2:** Apply на Starfit × Sports & Outdoors

Bundle Factory UI должен показать `GTINExemption` status table в `/bundle-factory/settings` для tracking.

---

## 📚 References

- **Official:** https://sellercentral.amazon.com/help/hub/reference/external/G202119180
- **Direct apply link:** https://sellercentral.amazon.com/gtinx
- **Brand Registry:** https://brandservices.amazon.com/
- **Internal:** [`gift-set-policy.md`](gift-set-policy.md), [`BUNDLE_FACTORY_DATA_MODEL.md`](../../BUNDLE_FACTORY_DATA_MODEL.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
