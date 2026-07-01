# Amazon Product Type attribute schemas (authoritative)

Pulled **live** from the Amazon SP-API **Product Type Definitions** API
(`getDefinitionsProductType`) for marketplace `ATVPDKIKX0DER` (US),
`requirements=LISTING`, `locale=en_US`, on **2026-06-27** via STORE1 creds.

This is the same data behind Amazon's flat-file Excel templates — every
attribute (column) a listing of that product type can carry, with the
hard-`required` set marked.

## Files

- `<TYPE>.schema.json` — the full raw JSON Schema (machine source of truth).
- `<TYPE>.md` — human digest: attribute name + label, split Required / Optional.

## Product types pulled (food-relevant)

| Type | Attributes | When to use |
|---|---|---|
| `GROCERY` | 98 | single-product multipacks (e.g. 6× Uncrustables) |
| `FOOD` | 117 | generic food |
| `GOURMET_FOOD` | 81 | gourmet / gift-style food sets |
| `SNACK_FOOD` | 90 | snacks |
| `CHOCOLATE_CANDY` | 110 | chocolate gift boxes |
| `COFFEE` | 113 | coffee |
| `TEA` | 113 | tea |

## ⚠️ Key finding

There is **NO `GIFT_BASKET` product type** in Amazon's live definitions (checked
against all 1871 types). Our older KB (`../sp-api-attribute-schemas.md`) and the
current publish code assume `GIFT_BASKET` — that is wrong. The real product type
for our bundles is `GROCERY` / `FOOD` / `GOURMET_FOOD`; "gift basket" is a
**browse-node / positioning** concept (the Gift Basket Exception), not a product
type. This is central to the open GROCERY-vs-gift-basket decision.

## Refresh

Re-pull with a standalone script that LWA-exchanges `AMAZON_SP_*_STORE1` from
`.env.local`, then GETs `/definitions/2020-09-01/productTypes/<TYPE>` and fetches
`schema.link.resource`.
