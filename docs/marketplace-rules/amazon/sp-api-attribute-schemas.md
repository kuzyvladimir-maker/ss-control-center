# Amazon SP-API JSON Listings — Attribute Schemas

> **Source:** SP-API Listings Items v2021-08-01 + Product Type Definitions API
> **Last verified:** 2026-05-17
> **Priority:** P0 для Stage 7 (Distribution) implementation

---

## TL;DR

SP-API использует **JSON Listings v2** для submission. Каждый Product Type (FOOD_DISPLAY_TRAY, GIFT_BASKET, и т.д.) имеет свою JSON Schema с required + optional attributes. Этот файл — практический cheat sheet для Vladimir's relevant types.

---

## 🧬 Product Type выбор

Для Vladimir's bundles primary candidates:

| Product Type | When to use |
|---|---|
| **GIFT_BASKET** | Default для multi-component gift sets (Vladimir's MVP) |
| **GROCERY** | Single-product multipacks |
| **FOOD_DISPLAY_TRAY** | Specific shelf display SKUs (не Vladimir's case) |
| **CHOCOLATE_CANDY** | Pure chocolate gift boxes |
| **PET_FOOD** | Pet bundles |

Fetch full list через `getDefinitionsProductTypes` SP-API endpoint:
```
GET /definitions/2020-09-01/productTypes?marketplaceIds=ATVPDKIKX0DER
```

---

## 📋 GIFT_BASKET attribute schema (Vladimir's primary)

### Required attributes

```json
{
  "productType": "GIFT_BASKET",
  "requirements": "LISTING",
  "attributes": {
    "item_name": [
      {
        "value": "Salutem Vita – Pizza with Pepperoni Lunch Kit, 4.3 oz, Gift Set – Pack of 12",
        "language_tag": "en_US",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "brand": [
      {
        "value": "Salutem Vita",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "manufacturer": [
      {
        "value": "Salutem Solutions LLC",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "externally_assigned_product_identifier": [
      {
        "type": "upc",
        "value": "743269733851",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "product_description": [
      {
        "value": "<p>The Salutem Vita Pizza Lunch Kit Gift Set...</p>",
        "language_tag": "en_US",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "bullet_point": [
      { "value": "🍕 Includes Lunchables Pizza with Pepperoni...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "✅ Comes with ready-to-assemble pizza kit...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "📦 Conveniently packaged...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "🎉 No need for cooking...", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "🛡️ Individually wrapped... Makes a delightful gift set for pizza lovers 🎁", "language_tag": "en_US", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "recommended_browse_nodes": [
      {
        "value": "12011207011",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "item_type_keyword": [
      {
        "value": "food-assortments-variety-gift",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "list_price": [
      {
        "value_with_tax": 6151,
        "currency": "USD",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ],
    "main_product_image_locator": [
      {
        "media_location": "https://images.salutemsolutions.info/main/B0FH2NX7J9.jpg",
        "marketplace_id": "ATVPDKIKX0DER"
      }
    ]
  }
}
```

### Highly recommended (boost SEO + classifier)

```json
{
  "attributes": {
    "gift_arrangement": [
      { "value": "Box", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "occasion_type": [
      { "value": "Birthday", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "Christmas", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "Thank You & Appreciation", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "is_gift": [
      { "value": true, "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "is_kosher": [
      { "value": false, "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "country_of_origin": [
      { "value": "US", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "storage_temperature": [
      { "value": "Frozen", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "allergen_information": [
      { "value": "Milk", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "Wheat", "marketplace_id": "ATVPDKIKX0DER" },
      { "value": "Soybeans", "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "is_expiration_dated_product": [
      { "value": true, "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "number_of_items": [
      { "value": 12, "marketplace_id": "ATVPDKIKX0DER" }
    ],
    "supplier_declared_dg_hz_regulation": [
      { "value": "not_applicable", "marketplace_id": "ATVPDKIKX0DER" }
    ]
  }
}
```

### Image gallery (other_product_image_locator_*)

```json
{
  "other_product_image_locator_1": [
    { "media_location": "https://images.salutemsolutions.info/sec/B0FH2NX7J9-1.jpg", "marketplace_id": "ATVPDKIKX0DER" }
  ],
  "other_product_image_locator_2": [...],
  // up to other_product_image_locator_8
}
```

---

## 📋 GROCERY attribute schema (single-product multipacks)

Different от GIFT_BASKET в:
- `item_type_keyword` = specific food type (например `frozen-prepared-meal`)
- Browse node не обязательно gift basket
- `gift_arrangement` не applicable

Дополнительные required:
```json
{
  "fda_food_facility_registration": [{ "value": "REG_NUMBER", "marketplace_id": "..." }],  // если applicable
  "nutritional_panel_image_locator": [{ "media_location": "...", "marketplace_id": "..." }]  // recommended
}
```

---

## 📋 Submission flow (Stage 7)

```typescript
import { SellingPartner } from 'amazon-sp-api';

async function publishChannelSku(channelSku: ChannelSKU, masterBundle: MasterBundle) {
  const sp = new SellingPartner({
    region: 'na',
    credentials: getCredentialsForChannel(channelSku.channel),
  });

  const productType = determineProductType(masterBundle); // GIFT_BASKET для большинства

  const requestBody = buildAttributesPayload(masterBundle, channelSku, productType);

  const response = await sp.callAPI({
    operation: 'putListingsItem',
    endpoint: 'listingsItems',
    path: {
      sellerId: sp.merchantId,
      sku: channelSku.sku,
    },
    query: {
      marketplaceIds: ['ATVPDKIKX0DER'],
      issueLocale: 'en_US',
    },
    body: {
      productType,
      requirements: 'LISTING',
      attributes: requestBody.attributes,
    },
  });

  return response;
}
```

---

## 📋 Validation through getDefinitionsProductTypes

Перед submission — fetch schema:

```typescript
async function validateAgainstSchema(payload: any, productType: string) {
  const sp = new SellingPartner({ region: 'na' });
  
  const schema = await sp.callAPI({
    operation: 'getDefinitionsProductType',
    endpoint: 'productTypeDefinitions',
    path: { productType },
    query: { marketplaceIds: ['ATVPDKIKX0DER'] },
  });

  // Use AJV или similar JSON Schema validator
  const ajv = new Ajv();
  const validate = ajv.compile(schema.schema);
  
  return {
    valid: validate(payload),
    errors: validate.errors,
  };
}
```

Stage 6 (Validation) использует это до actual submission.

---

## 🔄 Per-channel adaptation

Vladimir's 5 Amazon accounts share same SP-API JSON schema, но `marketplace_id` всегда `ATVPDKIKX0DER` (US). Different `sellerId` (Salutem Solutions vs AMZ Commerce vs etc.).

Walmart Items API использует **different JSON structure** (см. [`walmart/attribute-keys.md`](../walmart/attribute-keys.md)).

---

## References

- **SP-API Listings Items v2021-08-01:** https://developer-docs.amazon.com/sp-api/docs/listings-items-api-v2021-08-01-reference
- **Product Type Definitions:** https://developer-docs.amazon.com/sp-api/docs/product-type-definitions-api-reference
- **JSON Schema validation:** https://json-schema.org/
- Internal: [`gift-set-policy.md`](gift-set-policy.md), [`browse-nodes-grocery.md`](browse-nodes-grocery.md)

---

**Maintained by:** Vladimir + Claude · **Last reviewed:** 2026-05-17
