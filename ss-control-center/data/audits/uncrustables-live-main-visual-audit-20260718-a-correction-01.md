# Correction addendum 01 — Uncrustables live MAIN audit A

This addendum corrects one interpretation in immutable audit A. The original A JSON/CSV/Markdown files are preserved unchanged.

## Correction

The owner-reviewed authenticity registry defines **Beamin' Berry Blend** as an approved alias and genuine package/name variant for **Morning Protein Peanut Butter & Mixed Berry Spread**. The earlier interpretation that these were different products was incorrect.

All six affected MAIN images were reinspected at original resolution. Their only recorded blocking reason in audit A was `PRODUCT_VARIANT_MISMATCH` caused by that incorrect alias interpretation. No other blocking defect remained, so all six decisions change from **REGENERATE** to **KEEP**.

## SHA-bound evidence

- Immutable audit A JSON: `data/audits/uncrustables-live-main-visual-audit-20260718-a.json`
- Immutable audit A JSON SHA-256: `287d74179e6dde4b7aea92d98aae3c629fff12a2fcd2f5ad04f9a2d5d1bb5a0f`
- Source manifest SHA-256: `47c2bbbc0c0f7c1cdfcbc52363012b527d3611755d90536a2f80a06ffe2d9f05`
- Owner-reviewed registry: `src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json`
- Registry file SHA-256: `10cc967a28643c86653e713729952cac12aba083d83dd2a2608be120e6aeae11`
- Registry ID: `uncrustables-us-reviewed-package-art-2026-07-18-v1`
- Registry flavor ID: `morning-protein-mixed-berry`
- Registry alias: `Beamin' Berry Blend`
- Approved product reference SHA-256: `177f2e781d838ff4f7076608ed78f6ec52d46b81efda9754593c6ddd54721f0e`
- Owner-approved KD-AS12-8HZ3 live example SHA-256: `3504b902388fddb7cc06d67e7cd648c0cd007f7d7ba35bf902a198f89835691f` (byte-identical to the audited ordinal 60 MAIN asset)

## Corrected totals

| Decision | Audit A | Adjustment | Corrected effective total |
|---|---:|---:|---:|
| KEEP | 62 | +6 | **68** |
| REGENERATE | 22 | -6 | **16** |
| NEEDS_EVIDENCE | 0 | 0 | **0** |
| Checked | 84 | 0 | **84** |

## Changed rows

| # | SKU | ASIN | Previous | Corrected | Basis |
|---:|---|---|---|---|---|
| 16 | `BM-AS5J-3MQY` | `B0H83LSCQQ` | REGENERATE | **KEEP** | The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread. Reinspection found no other blocking defect. |
| 33 | `EX-ASC0-5CRL` | `B0H83JJW1F` | REGENERATE | **KEEP** | The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread. Reinspection found no other blocking defect. |
| 60 | `KD-AS12-8HZ3` | `B0H845JBM6` | REGENERATE | **KEEP** | Bright-Eyed Berry and Beamin' Berry Blend are both visibly represented. The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread; no other blocking defect remains. |
| 71 | `MP-ASZ9-TKE7` | `B0H837HLKC` | REGENERATE | **KEEP** | The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread. Reinspection found no other blocking defect. |
| 74 | `NM-ASEW-S2SK` | `B0H86TVN3C` | REGENERATE | **KEEP** | The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread. Reinspection found no other blocking defect. |
| 81 | `PL-ASR9-U94A` | `B0H83RR2XQ` | REGENERATE | **KEEP** | The owner-reviewed registry confirms Beamin' Berry Blend is an authentic package/name alias for Morning Protein Peanut Butter & Mixed Berry Spread. Reinspection found no other blocking defect. |

## Remaining effective REGENERATE queue

| # | SKU | ASIN | Reason codes |
|---:|---|---|---|
| 4 | `AJ-ASRB-HKC3` | `B0H84G7DHC` | `MISSING_RECIPE_COMPONENT` |
| 5 | `AN-ASUW-49Y5` | `B0H8628LW3` | `MISSING_OWNER_APPROVED_COOLER_SCENE` |
| 10 | `BD-AS8P-XAW5` | `B0H85MXFH8` | `MISSING_OWNER_APPROVED_COOLER_SCENE` |
| 13 | `BH-ASTN-S4XJ` | `B0H83ZRNCS` | `PRODUCT_VARIANT_MISMATCH` |
| 17 | `BQ-ASUE-NT37` | `B0H842HL49` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 20 | `CE-ASGK-ZRHM` | `B0H84651LM` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 29 | `ER-ASRK-TPYQ` | `B0H84JH1WN` | `MISSING_RECIPE_COMPONENT` |
| 40 | `FX-AS2W-KHZT` | `B0H827J2XZ` | `GENERIC_OR_UNBRANDED_PACKAGING, PRODUCT_VARIANT_MISMATCH` |
| 51 | `HZ-ASPS-4L22` | `B0H857K38C` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 52 | `JC-ASM4-XXW7` | `B0H84ZL156` | `PACKAGE_TEXT_CONFLICT` |
| 58 | `JU-ASYC-SSJD` | `B0H854C7SZ` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 59 | `JY-ASPW-LB4K` | `B0H84621N6` | `MISSING_RECIPE_COMPONENT` |
| 65 | `LK-AS7X-K43B` | `B0H84CGGXL` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 67 | `LU-ASK0-LSDF` | `B0H84YZDB7` | `GENERIC_OR_UNBRANDED_PACKAGING` |
| 80 | `PJ-ASDX-E8LW` | `B0H85MGP35` | `MISSING_RECIPE_COMPONENT` |
| 84 | `PT-AS5B-Z2XH` | `B0H84Z6QWY` | `GENERIC_OR_UNBRANDED_PACKAGING` |

Effective interpretation: apply this addendum on top of immutable audit A; every unlisted A decision remains unchanged.

