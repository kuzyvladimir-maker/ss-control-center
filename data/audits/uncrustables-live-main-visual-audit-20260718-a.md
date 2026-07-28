# Uncrustables live MAIN manual visual audit A — sheets 01–07

Completed manual image-by-image review of ordinals 1–84. This audit is read-only and SHA-bound to the fetched live MAIN manifest.

## Provenance

- Audit ID: `ULMVA-20260718-A`
- Reviewed at: `2026-07-18T03:58:39.771Z`
- Source manifest: `data/audits/uncrustables-live-main-fetch-20260718-v1/manifest.json`
- Source manifest SHA-256: `47c2bbbc0c0f7c1cdfcbc52363012b527d3611755d90536a2f80a06ffe2d9f05`
- Source manifest body SHA-256: `496edff7b110ce9341a5325bb2e51678e90cad582a1d132d6c50a8dd753027db`
- Source ledger SHA-256: `46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f`
- Scope: contact sheets 01–07, ordinals 1–84

## Summary

| Decision | Count |
|---|---:|
| KEEP | 62 |
| REGENERATE | 22 |
| NEEDS_EVIDENCE | 0 |
| **Checked** | **84** |

A REGENERATE verdict is blocking: do not reuse that live MAIN image for the surgical repair without replacing or correcting it. No image in this scope remained ambiguous enough to require NEEDS_EVIDENCE.

## Owner-approved standard used

- White EPS cooler in three-quarter view, lid behind.
- Ornate green Salutem emblem with black wordmark/slogan.
- Blue-header frozen gel packs; four preferred.
- Every exact recipe component visible as genuine Smucker’s Uncrustables packaging.
- Products physically seated; no floating or pasted appearance.
- Clean white background.
- No invented/lookalike products, retailer marks, mismatches, or contradictory package claims.

Interpretation guardrails: otherwise-good older live images were not rejected merely for differing from the new approved previews; generic package backs without readable Smucker’s/Uncrustables identity fail authentication; Beamin’ Berry Blend is not Morning Protein Mixed Berry; Bright-Eyed Berry is accepted as Protein Strawberry.

## Blocking regeneration queue

| # | SKU | ASIN | Reason codes | Reviewer finding |
|---:|---|---|---|---|
| 4 | `AJ-ASRB-HKC3` | `B0H84G7DHC` | `MISSING_RECIPE_COMPONENT` | Only Raspberry wrappers are visible; the Morning Protein Peanut Butter & Mixed Berry recipe component is absent. |
| 5 | `AN-ASUW-49Y5` | `B0H8628LW3` | `MISSING_OWNER_APPROVED_COOLER_SCENE` | The products are isolated on white, but the owner-approved Salutem cooler and blue-header gel-pack shipping scene is absent. |
| 10 | `BD-AS8P-XAW5` | `B0H85MXFH8` | `MISSING_OWNER_APPROVED_COOLER_SCENE` | This is a product-only donor layout; the owner-approved Salutem cooler and blue-header gel-pack shipping scene is absent. |
| 13 | `BH-ASTN-S4XJ` | `B0H83ZRNCS` | `PRODUCT_VARIANT_MISMATCH` | The image shows ordinary Peanut Butter & Strawberry wrappers with Blackberry; the required 12g Protein Strawberry (Bright-Eyed Berry) component is not shown. |
| 16 | `BM-AS5J-3MQY` | `B0H83LSCQQ` | `PRODUCT_VARIANT_MISMATCH` | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 17 | `BQ-ASUE-NT37` | `B0H842HL49` | `GENERIC_OR_UNBRANDED_PACKAGING` | The red and blue gingham wrapper backs have no readable Smucker’s/Uncrustables identity; the exact Protein Strawberry and Whole Wheat Grape components cannot be authenticated. |
| 20 | `CE-ASGK-ZRHM` | `B0H84651LM` | `GENERIC_OR_UNBRANDED_PACKAGING` | The red and blue wrapper backs have no readable Smucker’s/Uncrustables identity; the exact Protein Strawberry and Blueberry components cannot be authenticated. |
| 29 | `ER-ASRK-TPYQ` | `B0H84JH1WN` | `MISSING_RECIPE_COMPONENT` | Only Raspberry wrappers are visible; the Blueberry recipe component is absent. |
| 33 | `EX-ASC0-5CRL` | `B0H83JJW1F` | `PRODUCT_VARIANT_MISMATCH` | Beamin’ Berry Blend boxes are shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 40 | `FX-AS2W-KHZT` | `B0H827J2XZ` | `GENERIC_OR_UNBRANDED_PACKAGING, PRODUCT_VARIANT_MISMATCH` | Generic unbranded “soft bread” cartons are shown; they are not identifiable genuine Uncrustables packaging, and the required Bright-Eyed Berry 12g Protein product is absent. |
| 51 | `HZ-ASPS-4L22` | `B0H857K38C` | `GENERIC_OR_UNBRANDED_PACKAGING` | Generic red and blue wrapper backs have no readable Smucker’s/Uncrustables or flavor identity; Whole Wheat Strawberry and Blueberry cannot be authenticated. |
| 52 | `JC-ASM4-XXW7` | `B0H84ZL156` | `PACKAGE_TEXT_CONFLICT` | The Up & Apple wrappers visibly state 6G PROTEIN, conflicting with the exact selected 12g Protein recipe component. |
| 58 | `JU-ASYC-SSJD` | `B0H854C7SZ` | `GENERIC_OR_UNBRANDED_PACKAGING` | Displayed carton backs/pseudo-panels lack readable Smucker’s/Uncrustables identity; exact Whole Wheat Strawberry and Whole Wheat Grape packaging cannot be authenticated. |
| 59 | `JY-ASPW-LB4K` | `B0H84621N6` | `MISSING_RECIPE_COMPONENT` | Only Raspberry wrappers are visible; the Up & Apple recipe component is absent. |
| 60 | `KD-AS12-8HZ3` | `B0H845JBM6` | `PRODUCT_VARIANT_MISMATCH` | Bright-Eyed Berry is correct, but Beamin’ Berry Blend substitutes for the required Morning Protein Peanut Butter & Mixed Berry Spread component. |
| 65 | `LK-AS7X-K43B` | `B0H84CGGXL` | `GENERIC_OR_UNBRANDED_PACKAGING` | Brandless lookalike Raspberry/Strawberry carton faces have no readable Smucker’s/Uncrustables identity, so the products cannot be authenticated. |
| 67 | `LU-ASK0-LSDF` | `B0H84YZDB7` | `GENERIC_OR_UNBRANDED_PACKAGING` | Pseudo-carton faces show generic product names but no readable Smucker’s/Uncrustables identity; the exact Peanut Butter and Grape components cannot be authenticated. |
| 71 | `MP-ASZ9-TKE7` | `B0H837HLKC` | `PRODUCT_VARIANT_MISMATCH` | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 74 | `NM-ASEW-S2SK` | `B0H86TVN3C` | `PRODUCT_VARIANT_MISMATCH` | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 80 | `PJ-ASDX-E8LW` | `B0H85MGP35` | `MISSING_RECIPE_COMPONENT` | Only Peanut Butter & Honey cartons are visible; the Morning Protein Peanut Butter & Mixed Berry recipe component is absent. |
| 81 | `PL-ASR9-U94A` | `B0H83RR2XQ` | `PRODUCT_VARIANT_MISMATCH` | Beamin’ Berry Blend wrappers are shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 84 | `PT-AS5B-Z2XH` | `B0H84Z6QWY` | `GENERIC_OR_UNBRANDED_PACKAGING` | Generic brandless “soft bread strawberry/grape sandwich” boxes are lookalike packaging with no readable Smucker’s/Uncrustables identity. |

## Complete 84-SKU decision ledger

| # | Sheet | SKU | ASIN | Units | Decision | Reviewer note |
|---:|---:|---|---|---:|---|---|
| 1 | 01 | `AC-AS4J-B64F` | `B0H82ZZS2P` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 2 | 01 | `AD-AS4H-QXZD` | `B0H82J6V9T` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 3 | 01 | `AG-ASKV-W9EN` | `B0H85B64V2` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 4 | 01 | `AJ-ASRB-HKC3` | `B0H84G7DHC` | 24 | **REGENERATE** | Only Raspberry wrappers are visible; the Morning Protein Peanut Butter & Mixed Berry recipe component is absent. |
| 5 | 01 | `AN-ASUW-49Y5` | `B0H8628LW3` | 24 | **REGENERATE** | The products are isolated on white, but the owner-approved Salutem cooler and blue-header gel-pack shipping scene is absent. |
| 6 | 01 | `AU-AS97-USX8` | `B0H843Q9B5` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 7 | 01 | `AV-AS7X-8EXK` | `B0H82JTY19` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 8 | 01 | `AY-AS5F-JEY9` | `B0H83MWTM7` | 120 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 9 | 01 | `AZ-ASMY-VEQ2` | `B0H788M8WM` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 10 | 01 | `BD-AS8P-XAW5` | `B0H85MXFH8` | 24 | **REGENERATE** | This is a product-only donor layout; the owner-approved Salutem cooler and blue-header gel-pack shipping scene is absent. |
| 11 | 01 | `BD-ASGH-LREJ` | `B0H86Z59DW` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 12 | 01 | `BH-AS7H-D4FV` | `B0H853MCYZ` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 13 | 02 | `BH-ASTN-S4XJ` | `B0H83ZRNCS` | 24 | **REGENERATE** | The image shows ordinary Peanut Butter & Strawberry wrappers with Blackberry; the required 12g Protein Strawberry (Bright-Eyed Berry) component is not shown. |
| 14 | 02 | `BH-ASVY-CR8H` | `B0H83S368B` | 120 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 15 | 02 | `BK-AS5Z-8UY5` | `B0H85JF1V1` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 16 | 02 | `BM-AS5J-3MQY` | `B0H83LSCQQ` | 90 | **REGENERATE** | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 17 | 02 | `BQ-ASUE-NT37` | `B0H842HL49` | 24 | **REGENERATE** | The red and blue gingham wrapper backs have no readable Smucker’s/Uncrustables identity; the exact Protein Strawberry and Whole Wheat Grape components cannot be authenticated. |
| 18 | 02 | `BX-AS5P-6WQV` | `B0H83NM5PX` | 120 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 19 | 02 | `BY-ASY2-8UJJ` | `B0H83789KC` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 20 | 02 | `CE-ASGK-ZRHM` | `B0H84651LM` | 24 | **REGENERATE** | The red and blue wrapper backs have no readable Smucker’s/Uncrustables identity; the exact Protein Strawberry and Blueberry components cannot be authenticated. |
| 21 | 02 | `CK-ASUM-WT9W` | `B0H86PRTWS` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 22 | 02 | `CN-ASG6-892G` | `B0H8422DQ1` | 120 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 23 | 02 | `DA-ASF0-D7RG` | `B0H83VBTLT` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 24 | 02 | `DF-ASQT-BLUQ` | `B0H83FKSN6` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 25 | 03 | `DP-ASQ6-ZPZU` | `B0H83Y8JH7` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 26 | 03 | `DY-AS8W-6MJG` | `B0H82MKPRJ` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 27 | 03 | `EF-AS4A-JCLU` | `B0H83XB855` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 28 | 03 | `EJ-ASCD-8K87` | `B0H82PXWKS` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 29 | 03 | `ER-ASRK-TPYQ` | `B0H84JH1WN` | 24 | **REGENERATE** | Only Raspberry wrappers are visible; the Blueberry recipe component is absent. |
| 30 | 03 | `ES-AS8A-3W3M` | `B0H83D8TFQ` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 31 | 03 | `EW-ASJ9-E79N` | `B0H82MT74H` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 32 | 03 | `EW-ASWP-PMZX` | `B0H891WSZ9` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 33 | 03 | `EX-ASC0-5CRL` | `B0H83JJW1F` | 120 | **REGENERATE** | Beamin’ Berry Blend boxes are shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 34 | 03 | `EZ-ASLA-Y7MZ` | `B0H83GBJLW` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 35 | 03 | `FK-AS6B-6G25` | `B0H8259J9G` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 36 | 03 | `FM-AS51-S4MT` | `B0H853VHRF` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 37 | 04 | `FN-ASVM-UWAG` | `B0H85J88LJ` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 38 | 04 | `FR-AS6X-5KJY` | `B0H827V9DJ` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 39 | 04 | `FV-AS47-EJZW` | `B0H82SZSYJ` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 40 | 04 | `FX-AS2W-KHZT` | `B0H827J2XZ` | 24 | **REGENERATE** | Generic unbranded “soft bread” cartons are shown; they are not identifiable genuine Uncrustables packaging, and the required Bright-Eyed Berry 12g Protein product is absent. |
| 41 | 04 | `GG-ASNC-C9WA` | `B0H8219Z7T` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 42 | 04 | `GR-AS0R-YPCF` | `B0H82GJ292` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 43 | 04 | `GR-AS1P-DBB2` | `B0H82S7TFG` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 44 | 04 | `GU-ASQ1-S7M6` | `B0H828GQLP` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 45 | 04 | `GX-ASTJ-WHV3` | `B0H83XV9WX` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 46 | 04 | `HA-ASCR-ME3A` | `B0H85V287S` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 47 | 04 | `HD-ASEQ-MFAY` | `B0H83QW85C` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 48 | 04 | `HR-AS7Q-7ZDF` | `B0H856RRRK` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 49 | 05 | `HU-ASMI-DN3X` | `B0H82YMT6K` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 50 | 05 | `HX-ASO8-XCL2` | `B0H832SD15` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 51 | 05 | `HZ-ASPS-4L22` | `B0H857K38C` | 24 | **REGENERATE** | Generic red and blue wrapper backs have no readable Smucker’s/Uncrustables or flavor identity; Whole Wheat Strawberry and Blueberry cannot be authenticated. |
| 52 | 05 | `JC-ASM4-XXW7` | `B0H84ZL156` | 24 | **REGENERATE** | The Up & Apple wrappers visibly state 6G PROTEIN, conflicting with the exact selected 12g Protein recipe component. |
| 53 | 05 | `JH-ASV9-Z46X` | `B0H8369PMK` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 54 | 05 | `JL-ASUC-JUZE` | `B0H831MXGD` | 45 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 55 | 05 | `JS-AS5F-QB8T` | `B0H822TJ7C` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 56 | 05 | `JT-ASKD-KS8T` | `B0H83Z6S3Q` | 120 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 57 | 05 | `JU-ASM0-KV4Z` | `B0H8462L4S` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 58 | 05 | `JU-ASYC-SSJD` | `B0H854C7SZ` | 24 | **REGENERATE** | Displayed carton backs/pseudo-panels lack readable Smucker’s/Uncrustables identity; exact Whole Wheat Strawberry and Whole Wheat Grape packaging cannot be authenticated. |
| 59 | 05 | `JY-ASPW-LB4K` | `B0H84621N6` | 24 | **REGENERATE** | Only Raspberry wrappers are visible; the Up & Apple recipe component is absent. |
| 60 | 05 | `KD-AS12-8HZ3` | `B0H845JBM6` | 24 | **REGENERATE** | Bright-Eyed Berry is correct, but Beamin’ Berry Blend substitutes for the required Morning Protein Peanut Butter & Mixed Berry Spread component. |
| 61 | 06 | `KN-ASYZ-ST4M` | `B0H83XBXHX` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 62 | 06 | `KP-ASYC-RN84` | `B0H83FYZR3` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 63 | 06 | `LH-ASP7-KZR4` | `B0H82XNFRW` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 64 | 06 | `LJ-ASYO-FWJK` | `B0H853SHVC` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 65 | 06 | `LK-AS7X-K43B` | `B0H84CGGXL` | 24 | **REGENERATE** | Brandless lookalike Raspberry/Strawberry carton faces have no readable Smucker’s/Uncrustables identity, so the products cannot be authenticated. |
| 66 | 06 | `LP-AS9J-HSVB` | `B0H82B7KK1` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 67 | 06 | `LU-ASK0-LSDF` | `B0H84YZDB7` | 24 | **REGENERATE** | Pseudo-carton faces show generic product names but no readable Smucker’s/Uncrustables identity; the exact Peanut Butter and Grape components cannot be authenticated. |
| 68 | 06 | `ME-AS1I-SEX2` | `B0H83RVHNF` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 69 | 06 | `MF-AS0J-YRT4` | `B0H82NHQCL` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 70 | 06 | `MP-ASYO-QNU2` | `B0H84Z9KWL` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 71 | 06 | `MP-ASZ9-TKE7` | `B0H837HLKC` | 30 | **REGENERATE** | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 72 | 06 | `NC-ASPL-EXE8` | `B0H83QRV43` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 73 | 07 | `NJ-ASAC-PTK2` | `B0H82X48CD` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 74 | 07 | `NM-ASEW-S2SK` | `B0H86TVN3C` | 24 | **REGENERATE** | Beamin’ Berry Blend is shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 75 | 07 | `NS-ASSD-B3JJ` | `B0H82L945T` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 76 | 07 | `NT-ASIL-V5LK` | `B0H84547PM` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 77 | 07 | `NV-AS86-HD44` | `B0H85KQJKS` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 78 | 07 | `PB-ASAF-G2T6` | `B0H82K7Y7S` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 79 | 07 | `PJ-ASAX-6LTG` | `B0H82T12L7` | 90 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 80 | 07 | `PJ-ASDX-E8LW` | `B0H85MGP35` | 24 | **REGENERATE** | Only Peanut Butter & Honey cartons are visible; the Morning Protein Peanut Butter & Mixed Berry recipe component is absent. |
| 81 | 07 | `PL-ASR9-U94A` | `B0H83RR2XQ` | 45 | **REGENERATE** | Beamin’ Berry Blend wrappers are shown instead of the required Morning Protein Peanut Butter & Mixed Berry Spread product. |
| 82 | 07 | `PP-AS23-SPLQ` | `B0H84CDNQG` | 24 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 83 | 07 | `PR-AS79-8SDF` | `B0H82L74PL` | 30 | **KEEP** | All listed recipe components are visibly represented with sufficiently identifiable genuine Smucker’s Uncrustables packaging; the cooler, Salutem branding, gel-pack and white-background composition is acceptable. |
| 84 | 07 | `PT-AS5B-Z2XH` | `B0H84Z6QWY` | 24 | **REGENERATE** | Generic brandless “soft bread strawberry/grape sandwich” boxes are lookalike packaging with no readable Smucker’s/Uncrustables identity. |

Machine-readable row-level recipe components, asset hashes, contact-sheet hashes, reason codes and recommendations are preserved in the sibling JSON and CSV artifacts.
