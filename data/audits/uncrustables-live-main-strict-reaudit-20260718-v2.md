# Uncrustables live MAIN strict re-audit — v2

- Audit ID: `ULMSR-20260718-V2`
- Reviewed: **164**
- Visual KEEP: **52**
- REPAIR: **112**
- NEEDS_EVIDENCE: **0**
- Newly discovered false KEEP: **79**
- Body SHA-256: `e345ae8a2727681c59f95eb5fbb6424a28c5922b6a0462d24aeb5087e6551458`

> Visual KEEP is not publish authorization. Every KEEP remains pending the separate GPT Image 2 provenance, ordered donor-byte, output-hash, and image-bound owner approval gates from v2.0.

## Newly discovered false KEEP

| Ordinal | SKU | ASIN | Reasons | Observation |
|---:|---|---|---|---|
| 1 | AC-AS4J-B64F | B0H82ZZS2P | RETAILER_BADGE_VISIBLE, MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR | Single flavor is represented as 10 + 10 + 4 retail cartons. The 10-count art also carries a visible Walmart badge. |
| 2 | AD-AS4H-QXZD | B0H82J6V9T | MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR | Single flavor is represented by mixed 10-count and 4-count carton designs (10 + 10 + 4), violating the one-design rule. |
| 3 | AG-ASKV-W9EN | B0H85B64V2 | CARTON_COUNT_MATH_MISMATCH, WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. At least one visible product/flavor is not the exact recipe product. At least one required recipe component is not visibly represented. Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. |
| 6 | AU-AS97-USX8 | B0H843Q9B5 | CARTON_COUNT_MATH_MISMATCH | Visible 4-count cartons imply 16 units of each component, not the required 12 + 12. |
| 9 | AZ-ASMY-VEQ2 | B0H788M8WM | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. |
| 11 | BD-ASGH-LREJ | B0H86Z59DW | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 14 | BH-ASVY-CR8H | B0H83S368B | CARTON_COUNT_MATH_MISMATCH | Ten visible 10-count raspberry cartons communicate 100 units, not the required 120. |
| 16 | BM-AS5J-3MQY | B0H83LSCQQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Beamin' Berry wrapper visibly retains an 8-count retail-carton badge. |
| 19 | BY-ASY2-8UJJ | B0H83789KC | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported individual whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge. |
| 21 | CK-ASUM-WT9W | B0H86PRTWS | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT | At least one visible product/flavor is not the exact recipe product. At least one required recipe component is not visibly represented. Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. Visible package text/nutrition identifies the wrong product variant. |
| 22 | CN-ASG6-892G | B0H8422DQ1 | RETAILER_BADGE_VISIBLE | Twelve 10-count cartons reconcile to 120, but every carton visibly carries the retailer-exclusive Walmart mark. |
| 23 | DA-ASF0-D7RG | B0H83VBTLT | CARTON_COUNT_MATH_MISMATCH | The image uses 4-count retail cartons for a 90-unit recipe; 90 / 4 is not exact. |
| 24 | DF-ASQT-BLUQ | B0H83FKSN6 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | A purported individual wrapper visibly retains a retail carton pack-count badge. Retail carton front art was shrunk onto a crimped pouch and presented as an individual wrapper. |
| 25 | DP-ASQ6-ZPZU | B0H83Y8JH7 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 26 | DY-AS8W-6MJG | B0H82MKPRJ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported blueberry wrapper visibly retains an 8-count retail-carton badge. |
| 27 | EF-AS4A-JCLU | B0H83XB855 | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. Visible package text/nutrition identifies the wrong product variant. |
| 30 | ES-AS8A-3W3M | B0H83D8TFQ | RETAILER_BADGE_VISIBLE | Three 10-count cartons reconcile to 30, but the cartons visibly say Only at Walmart. |
| 31 | EW-ASJ9-E79N | B0H82MT74H | RETAILER_BADGE_VISIBLE | Three 10-count cartons reconcile to 30, but the cartons visibly say Only at Walmart. |
| 33 | EX-ASC0-5CRL | B0H83JJW1F | RETAILER_BADGE_VISIBLE | Beamin' Berry cartons visibly retain Only at Target badges. |
| 34 | EZ-ASLA-Y7MZ | B0H83GBJLW | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported strawberry wrapper visibly retains a 4-count retail-carton badge. |
| 36 | FM-AS51-S4MT | B0H853VHRF | CARTON_COUNT_MATH_MISMATCH, MISSING_RECIPE_COMPONENT | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. At least one required recipe component is not visibly represented. |
| 38 | FR-AS6X-5KJY | B0H827V9DJ | MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR | Single flavor is represented as 10 + 10 + 4 retail cartons instead of one reviewed count/design. |
| 42 | GR-AS0R-YPCF | B0H82GJ292 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported peanut-butter wrapper visibly retains a 4-count retail-carton badge. |
| 45 | GX-ASTJ-WHV3 | B0H83XV9WX | CARTON_COUNT_MATH_MISMATCH, MISSING_RECIPE_COMPONENT | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. At least one required recipe component is not visibly represented. |
| 46 | HA-ASCR-ME3A | B0H85V287S | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 47 | HD-ASEQ-MFAY | B0H83QW85C | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | A purported individual wrapper visibly retains a retail carton pack-count badge. Retail carton front art was shrunk onto a crimped pouch and presented as an individual wrapper. |
| 48 | HR-AS7Q-7ZDF | B0H856RRRK | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART | Only five cartons are visible for a 12 + 12 mix; the selected chocolate source is 10ct, so 12 / 10 is not exact, and its printed counts are erased. |
| 49 | HU-ASMI-DN3X | B0H82YMT6K | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported blueberry wrapper visibly retains an 8-count retail-carton badge. |
| 55 | JS-AS5F-QB8T | B0H822TJ7C | GEL_PACK_COUNT_OR_LAYOUT_FAIL | Three gel packs are visible inside the cooler plus two outside (five total), not the required 2 + 2. |
| 60 | KD-AS12-8HZ3 | B0H845JBM6 | CARTON_COUNT_MATH_MISMATCH | Two 8-count cartons are shown for each component (16 + 16), not the required 12 + 12. |
| 61 | KN-ASYZ-ST4M | B0H83XBXHX | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 63 | LH-ASP7-KZR4 | B0H82XNFRW | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge. |
| 66 | LP-AS9J-HSVB | B0H82B7KK1 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 68 | ME-AS1I-SEX2 | B0H83RVHNF | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 70 | MP-ASYO-QNU2 | B0H84Z9KWL | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 72 | NC-ASPL-EXE8 | B0H83QRV43 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 74 | NM-ASEW-S2SK | B0H86TVN3C | RETAILER_BADGE_VISIBLE | Three 8-count cartons reconcile to 24, but each visibly carries Only at Target. |
| 75 | NS-ASSD-B3JJ | B0H82L945T | RETAILER_BADGE_VISIBLE | Six 4-count Red, White & Berry cartons reconcile to 24, but each visibly carries Only at Walmart. |
| 76 | NT-ASIL-V5LK | B0H84547PM | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 77 | NV-AS86-HD44 | B0H85KQJKS | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 79 | PJ-ASAX-6LTG | B0H82T12L7 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge. |
| 81 | PL-ASR9-U94A | B0H83RR2XQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Beamin' Berry wrapper visibly retains an 8-count retail-carton badge. |
| 82 | PP-AS23-SPLQ | B0H84CDNQG | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 83 | PR-AS79-8SDF | B0H82L74PL | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge. |
| 86 | PW-ASDZ-CSR8 | B0H839TPC5 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Up & Apple wrapper visibly retains the 8-count carton badge/NEW panel. |
| 89 | QE-ASEQ-4YV5 | B0H82CBLRM | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 94 | RB-ASVO-GYCY | B0H859N8VM | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE | Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. Visible package is generic or lacks authentic readable Smucker's/Uncrustables identity. |
| 95 | RH-ASWA-ER34 | B0H85JR6WN | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 98 | RN-ASLP-VH3X | B0H82JYZQH | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported grape wrapper visibly retains a 4-count retail-carton badge. |
| 100 | RQ-AS78-STLZ | B0H85GR968 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER, VISIBLE_UNIT_COUNT_NOT_RECONCILED | The purported wrappers retain 4-count retail-carton badges; only 8 + 8 visible units are shown for a 12 + 12 recipe. |
| 101 | RQ-ASM7-T9NN | B0H83HNB3B | VISIBLE_UNIT_COUNT_NOT_RECONCILED | Visible individual-unit quantities do not reconcile to the recipe quantity/components. |
| 102 | RR-ASG1-JVKV | B0H8361PYX | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported strawberry wrapper visibly retains a 4-count retail-carton badge. |
| 104 | RU-ASC3-4TUS | B0H83SJFR7 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 106 | RY-ASO3-24Q2 | B0H84XMG42 | VISIBLE_UNIT_COUNT_NOT_RECONCILED | Approximately 20 honey plus 20 mixed-berry wrappers are visible, not the required 12 + 12. |
| 108 | SA-ASCK-J2B2 | B0H82XP1MM | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Up & Apple wrapper retains the retail 8-count/NEW badge. |
| 109 | SA-ASDW-SNEW | B0H82SMZ2M | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Red, White & Berry wrapper visibly retains a 4-count retail-carton badge. |
| 111 | SG-AS32-LZ9Y | B0H8564C6D | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 112 | SG-ASLB-M2DG | B0H84PFKYC | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 114 | SS-AS9K-U9TV | B0H831889Q | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported peanut-butter chocolate wrapper visibly retains a 4-count retail-carton badge. |
| 115 | SU-ASS4-RV6R | B0H853HGHC | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART | At least one visible product/flavor is not the exact recipe product. At least one required recipe component is not visibly represented. Visible package art is fabricated, corrupted, or materially altered from reviewed genuine art. |
| 119 | TL-ASHN-ZRKG | B0H85P9F3R | VISIBLE_UNIT_COUNT_NOT_RECONCILED | Exactly 8 hazelnut and 8 mixed-berry wrappers are visible (16 total), not the required 12 + 12 (24). |
| 122 | TQ-ASC4-P2NP | B0H839G6RQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | The blackberry high-count wrapper scene uses carton-front/count-badge art rather than reviewed individual wrapper art. |
| 124 | UA-ASAO-RE7Q | B0H784LMG6 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 129 | UJ-ASQ1-9FNR | B0H82P651P | RETAILER_BADGE_VISIBLE | Three 8-count cartons reconcile to 24, but every carton visibly carries Only at Target. |
| 131 | VA-ASOK-QJCA | B0H85RZDX5 | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH | Two 8-count cartons per component communicate 16 + 16 rather than 12 + 12; Beamin' cartons also retain Target marks. |
| 132 | VC-ASQE-L5Z5 | B0H82QYM85 | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 133 | VC-ASV1-378P | B0H786L5MW | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 136 | VN-AS1A-D572 | B0H82PKK18 | NO_APPROVED_COOLER_SCENE | The approved Salutem cooler/gel-pack frozen-shipping scene is absent. |
| 141 | WK-AS7E-M3CE | B0H843R64X | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH | Two 8-count cartons per component communicate 16 + 16 rather than 12 + 12; Beamin' cartons also retain Target marks. |
| 144 | WR-ASR5-AVWE | B0H859VYXH | CARTON_COUNT_MATH_MISMATCH | Visible retail-carton count/pack-size arithmetic does not exactly reconcile to every recipe quantity. |
| 145 | WR-ASTH-TPXV | B0H85DRT93 | VISIBLE_UNIT_COUNT_NOT_RECONCILED | The visible Apple and Beamin' wrapper grids exceed 12 units per component, so the 24-count recipe is not reconciled. |
| 148 | XJ-ASVD-CDMW | B0H82MSTD9 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Bright-Eyed Berry wrapper visibly retains an 8-count retail-carton badge. |
| 151 | YA-ASX6-PZE7 | B0H82YB4PD | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Blackberry Boom wrapper visibly retains a 4-count retail-carton badge. |
| 154 | YH-ASQ8-45ED | B0H82QPCJL | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported peanut-butter wrapper visibly retains a 4-count retail-carton badge. |
| 156 | YV-AST8-LMKN | B0H859JMGJ | CARTON_COUNT_MATH_MISMATCH | Three 10-count cartons are visible for each component (30 + 30), not 12 + 12. |
| 157 | ZB-ASKL-9W8G | B0H82LKBYH | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported Blackberry Boom wrapper visibly retains a 4-count retail-carton badge. |
| 160 | ZH-AS8W-G5MN | B0H82LMD9Z | CARTON_COUNT_MATH_MISMATCH | Three 4-count grape cartons communicate 12 units, not the required 30. |
| 161 | ZP-ASJD-X7ZD | B0H85N7X8W | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH | Whole-wheat strawberry is 3 x 4 = 12, but Beamin' Berry is 2 x 8 = 16 and retains Target marks. |
| 162 | ZX-AS2C-GT8Q | B0H82L3LRT | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER | Every purported whole-wheat strawberry wrapper visibly retains a 4-count retail-carton badge. |

## Invalid reuse donors

| Ordinal | Role | Status | Reason |
|---:|---|---|---|
| 60 | OWNER_APPROVED_LIVE_EXAMPLE | INVALID_FOR_REUSE | Component carton arithmetic is 16 + 16, not 12 + 12. |
| 71 | POTENTIAL_SINGLE_FLAVOR_DONOR | VISUAL_PASS_ONLY | Clean 30-unit single-flavor scene; reuse for another quantity still requires a new exact count plan and image-bound approval. |
| 100 | PRIOR_COMPOSITE_DONOR | INVALID_FOR_REUSE | Mini-carton wrappers and 8 + 8 rather than 12 + 12. |
| 106 | PRIOR_COMPOSITE_DONOR | INVALID_FOR_REUSE | Visible unit count greatly exceeds 12 + 12. |
| 119 | OWNER_REFERENCE_COMPOSITE | INVALID_FOR_24_COUNT_REUSE | Visible count is 8 + 8, not 12 + 12. |
| 161 | OWNER_APPROVED_LIVE_EXAMPLE | INVALID_FOR_REUSE | Component arithmetic is 12 + 16 and Target marks remain. |

## REPAIR rows

| Ordinal | SKU | ASIN | Reasons |
|---:|---|---|---|
| 1 | AC-AS4J-B64F | B0H82ZZS2P | RETAILER_BADGE_VISIBLE, MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR |
| 2 | AD-AS4H-QXZD | B0H82J6V9T | MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR |
| 3 | AG-ASKV-W9EN | B0H85B64V2 | CARTON_COUNT_MATH_MISMATCH, WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART |
| 4 | AJ-ASRB-HKC3 | B0H84G7DHC | MISSING_RECIPE_COMPONENT |
| 5 | AN-ASUW-49Y5 | B0H8628LW3 | NO_APPROVED_COOLER_SCENE |
| 6 | AU-AS97-USX8 | B0H843Q9B5 | CARTON_COUNT_MATH_MISMATCH |
| 9 | AZ-ASMY-VEQ2 | B0H788M8WM | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART |
| 10 | BD-AS8P-XAW5 | B0H85MXFH8 | NO_APPROVED_COOLER_SCENE |
| 11 | BD-ASGH-LREJ | B0H86Z59DW | CARTON_COUNT_MATH_MISMATCH |
| 13 | BH-ASTN-S4XJ | B0H83ZRNCS | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 14 | BH-ASVY-CR8H | B0H83S368B | CARTON_COUNT_MATH_MISMATCH |
| 16 | BM-AS5J-3MQY | B0H83LSCQQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 17 | BQ-ASUE-NT37 | B0H842HL49 | GENERIC_OR_UNBRANDED_PACKAGE |
| 19 | BY-ASY2-8UJJ | B0H83789KC | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 20 | CE-ASGK-ZRHM | B0H84651LM | GENERIC_OR_UNBRANDED_PACKAGE |
| 21 | CK-ASUM-WT9W | B0H86PRTWS | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 22 | CN-ASG6-892G | B0H8422DQ1 | RETAILER_BADGE_VISIBLE |
| 23 | DA-ASF0-D7RG | B0H83VBTLT | CARTON_COUNT_MATH_MISMATCH |
| 24 | DF-ASQT-BLUQ | B0H83FKSN6 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 25 | DP-ASQ6-ZPZU | B0H83Y8JH7 | CARTON_COUNT_MATH_MISMATCH |
| 26 | DY-AS8W-6MJG | B0H82MKPRJ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 27 | EF-AS4A-JCLU | B0H83XB855 | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 29 | ER-ASRK-TPYQ | B0H84JH1WN | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT |
| 30 | ES-AS8A-3W3M | B0H83D8TFQ | RETAILER_BADGE_VISIBLE |
| 31 | EW-ASJ9-E79N | B0H82MT74H | RETAILER_BADGE_VISIBLE |
| 33 | EX-ASC0-5CRL | B0H83JJW1F | RETAILER_BADGE_VISIBLE |
| 34 | EZ-ASLA-Y7MZ | B0H83GBJLW | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 36 | FM-AS51-S4MT | B0H853VHRF | CARTON_COUNT_MATH_MISMATCH, MISSING_RECIPE_COMPONENT |
| 38 | FR-AS6X-5KJY | B0H827V9DJ | MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR |
| 40 | FX-AS2W-KHZT | B0H827J2XZ | WRONG_FLAVOR_VISIBLE, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT, GENERIC_OR_UNBRANDED_PACKAGE |
| 42 | GR-AS0R-YPCF | B0H82GJ292 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 45 | GX-ASTJ-WHV3 | B0H83XV9WX | CARTON_COUNT_MATH_MISMATCH, MISSING_RECIPE_COMPONENT |
| 46 | HA-ASCR-ME3A | B0H85V287S | CARTON_COUNT_MATH_MISMATCH |
| 47 | HD-ASEQ-MFAY | B0H83QW85C | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 48 | HR-AS7Q-7ZDF | B0H856RRRK | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART |
| 49 | HU-ASMI-DN3X | B0H82YMT6K | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 51 | HZ-ASPS-4L22 | B0H857K38C | GENERIC_OR_UNBRANDED_PACKAGE |
| 52 | JC-ASM4-XXW7 | B0H84ZL156 | WRONG_NUTRITION_OR_VARIANT_TEXT |
| 55 | JS-AS5F-QB8T | B0H822TJ7C | GEL_PACK_COUNT_OR_LAYOUT_FAIL |
| 58 | JU-ASYC-SSJD | B0H854C7SZ | GENERIC_OR_UNBRANDED_PACKAGE, PRODUCT_PHYSICAL_SEATING_FAIL |
| 59 | JY-ASPW-LB4K | B0H84621N6 | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT |
| 60 | KD-AS12-8HZ3 | B0H845JBM6 | CARTON_COUNT_MATH_MISMATCH |
| 61 | KN-ASYZ-ST4M | B0H83XBXHX | CARTON_COUNT_MATH_MISMATCH |
| 63 | LH-ASP7-KZR4 | B0H82XNFRW | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 65 | LK-AS7X-K43B | B0H84CGGXL | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 66 | LP-AS9J-HSVB | B0H82B7KK1 | CARTON_COUNT_MATH_MISMATCH |
| 67 | LU-ASK0-LSDF | B0H84YZDB7 | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 68 | ME-AS1I-SEX2 | B0H83RVHNF | CARTON_COUNT_MATH_MISMATCH |
| 70 | MP-ASYO-QNU2 | B0H84Z9KWL | CARTON_COUNT_MATH_MISMATCH |
| 72 | NC-ASPL-EXE8 | B0H83QRV43 | CARTON_COUNT_MATH_MISMATCH |
| 74 | NM-ASEW-S2SK | B0H86TVN3C | RETAILER_BADGE_VISIBLE |
| 75 | NS-ASSD-B3JJ | B0H82L945T | RETAILER_BADGE_VISIBLE |
| 76 | NT-ASIL-V5LK | B0H84547PM | CARTON_COUNT_MATH_MISMATCH |
| 77 | NV-AS86-HD44 | B0H85KQJKS | CARTON_COUNT_MATH_MISMATCH |
| 79 | PJ-ASAX-6LTG | B0H82T12L7 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 80 | PJ-ASDX-E8LW | B0H85MGP35 | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT |
| 81 | PL-ASR9-U94A | B0H83RR2XQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 82 | PP-AS23-SPLQ | B0H84CDNQG | CARTON_COUNT_MATH_MISMATCH |
| 83 | PR-AS79-8SDF | B0H82L74PL | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 84 | PT-AS5B-Z2XH | B0H84Z6QWY | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 86 | PW-ASDZ-CSR8 | B0H839TPC5 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 89 | QE-ASEQ-4YV5 | B0H82CBLRM | CARTON_COUNT_MATH_MISMATCH |
| 90 | QP-ASAD-PTLX | B0H85DG2JQ | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 94 | RB-ASVO-GYCY | B0H859N8VM | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 95 | RH-ASWA-ER34 | B0H85JR6WN | CARTON_COUNT_MATH_MISMATCH |
| 96 | RL-AS64-Q8QX | B0H82LZLM2 | FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 97 | RM-ASCV-DVA5 | B0H822CVVL | RETAILER_BADGE_VISIBLE, MIXED_CARTON_PACK_COUNTS_SINGLE_FLAVOR |
| 98 | RN-ASLP-VH3X | B0H82JYZQH | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 99 | RQ-AS0L-9B45 | B0H85MQLHG | WRONG_NUTRITION_OR_VARIANT_TEXT, VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 100 | RQ-AS78-STLZ | B0H85GR968 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER, VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 101 | RQ-ASM7-T9NN | B0H83HNB3B | VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 102 | RR-ASG1-JVKV | B0H8361PYX | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 103 | RS-AS47-M3K3 | B0H87748WJ | NO_APPROVED_COOLER_SCENE |
| 104 | RU-ASC3-4TUS | B0H83SJFR7 | CARTON_COUNT_MATH_MISMATCH |
| 106 | RY-ASO3-24Q2 | B0H84XMG42 | VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 108 | SA-ASCK-J2B2 | B0H82XP1MM | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 109 | SA-ASDW-SNEW | B0H82SMZ2M | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 110 | SC-ASH8-4RQG | B0H856DWVS | MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 111 | SG-AS32-LZ9Y | B0H8564C6D | CARTON_COUNT_MATH_MISMATCH |
| 112 | SG-ASLB-M2DG | B0H84PFKYC | CARTON_COUNT_MATH_MISMATCH |
| 113 | SH-ASO0-PW37 | B0H83ZH3TB | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 114 | SS-AS9K-U9TV | B0H831889Q | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 115 | SU-ASS4-RV6R | B0H853HGHC | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART |
| 116 | SV-AS87-D6SV | B0H83ZGN22 | FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT, GENERIC_OR_UNBRANDED_PACKAGE |
| 119 | TL-ASHN-ZRKG | B0H85P9F3R | VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 122 | TQ-ASC4-P2NP | B0H839G6RQ | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 123 | TY-AST2-JE9P | B0H84WQRXB | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT |
| 124 | UA-ASAO-RE7Q | B0H784LMG6 | CARTON_COUNT_MATH_MISMATCH |
| 129 | UJ-ASQ1-9FNR | B0H82P651P | RETAILER_BADGE_VISIBLE |
| 131 | VA-ASOK-QJCA | B0H85RZDX5 | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH |
| 132 | VC-ASQE-L5Z5 | B0H82QYM85 | CARTON_COUNT_MATH_MISMATCH |
| 133 | VC-ASV1-378P | B0H786L5MW | CARTON_COUNT_MATH_MISMATCH |
| 134 | VH-ASHZ-TJEE | B0H856VWD6 | WRONG_FLAVOR_VISIBLE, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 135 | VK-ASSB-3YFK | B0H85FY28F | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE, GEL_PACK_COUNT_OR_LAYOUT_FAIL, GEL_PACK_BRANDING_FAIL, SALUTEM_BRANDING_FAIL |
| 136 | VN-AS1A-D572 | B0H82PKK18 | NO_APPROVED_COOLER_SCENE |
| 138 | VT-ASTH-B6LM | B0H85CL8JD | WRONG_FLAVOR_VISIBLE, MISSING_RECIPE_COMPONENT, FICTIONAL_OR_ALTERED_PACKAGE_ART |
| 140 | WK-AS2R-FJUW | B0H82XBNVN | NO_APPROVED_COOLER_SCENE |
| 141 | WK-AS7E-M3CE | B0H843R64X | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH |
| 142 | WK-ASPD-G9HL | B0H85CF81Y | WRONG_FLAVOR_VISIBLE, FICTIONAL_OR_ALTERED_PACKAGE_ART, WRONG_NUTRITION_OR_VARIANT_TEXT |
| 144 | WR-ASR5-AVWE | B0H859VYXH | CARTON_COUNT_MATH_MISMATCH |
| 145 | WR-ASTH-TPXV | B0H85DRT93 | VISIBLE_UNIT_COUNT_NOT_RECONCILED |
| 146 | WZ-ASXK-ZFAS | B0H85DF1R7 | FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |
| 148 | XJ-ASVD-CDMW | B0H82MSTD9 | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 151 | YA-ASX6-PZE7 | B0H82YB4PD | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 154 | YH-ASQ8-45ED | B0H82QPCJL | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 156 | YV-AST8-LMKN | B0H859JMGJ | CARTON_COUNT_MATH_MISMATCH |
| 157 | ZB-ASKL-9W8G | B0H82LKBYH | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 159 | ZE-AS5W-FKH3 | B0H8531B8B | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH |
| 160 | ZH-AS8W-G5MN | B0H82LMD9Z | CARTON_COUNT_MATH_MISMATCH |
| 161 | ZP-ASJD-X7ZD | B0H85N7X8W | RETAILER_BADGE_VISIBLE, CARTON_COUNT_MATH_MISMATCH |
| 162 | ZX-AS2C-GT8Q | B0H82L3LRT | INDIVIDUAL_WRAPPER_HAS_CARTON_COUNT_BADGE, MINI_CARTON_PRESENTED_AS_WRAPPER |
| 163 | ZX-ASQU-TKU9 | B0H84PVG1G | CARTON_COUNT_MATH_MISMATCH, FICTIONAL_OR_ALTERED_PACKAGE_ART, GENERIC_OR_UNBRANDED_PACKAGE |

## Visual KEEP rows

| Ordinal | SKU | ASIN | Units |
|---:|---|---|---:|
| 7 | AV-AS7X-8EXK | B0H82JTY19 | 45 |
| 8 | AY-AS5F-JEY9 | B0H83MWTM7 | 120 |
| 12 | BH-AS7H-D4FV | B0H853MCYZ | 24 |
| 15 | BK-AS5Z-8UY5 | B0H85JF1V1 | 24 |
| 18 | BX-AS5P-6WQV | B0H83NM5PX | 120 |
| 28 | EJ-ASCD-8K87 | B0H82PXWKS | 90 |
| 32 | EW-ASWP-PMZX | B0H891WSZ9 | 30 |
| 35 | FK-AS6B-6G25 | B0H8259J9G | 24 |
| 37 | FN-ASVM-UWAG | B0H85J88LJ | 24 |
| 39 | FV-AS47-EJZW | B0H82SZSYJ | 45 |
| 41 | GG-ASNC-C9WA | B0H8219Z7T | 30 |
| 43 | GR-AS1P-DBB2 | B0H82S7TFG | 24 |
| 44 | GU-ASQ1-S7M6 | B0H828GQLP | 30 |
| 50 | HX-ASO8-XCL2 | B0H832SD15 | 45 |
| 53 | JH-ASV9-Z46X | B0H8369PMK | 24 |
| 54 | JL-ASUC-JUZE | B0H831MXGD | 45 |
| 56 | JT-ASKD-KS8T | B0H83Z6S3Q | 120 |
| 57 | JU-ASM0-KV4Z | B0H8462L4S | 24 |
| 62 | KP-ASYC-RN84 | B0H83FYZR3 | 90 |
| 64 | LJ-ASYO-FWJK | B0H853SHVC | 24 |
| 69 | MF-AS0J-YRT4 | B0H82NHQCL | 24 |
| 71 | MP-ASZ9-TKE7 | B0H837HLKC | 30 |
| 73 | NJ-ASAC-PTK2 | B0H82X48CD | 24 |
| 78 | PB-ASAF-G2T6 | B0H82K7Y7S | 24 |
| 85 | PU-AS3D-SA5Z | B0H83H71F8 | 120 |
| 87 | PY-ASBM-WX6W | B0H82B7GV5 | 24 |
| 88 | QC-ASX2-RHPA | B0H83TQPJB | 120 |
| 91 | QW-ASRZ-SYKC | B0H83MDDBL | 120 |
| 92 | QX-AS89-H8YC | B0H82RQ226 | 24 |
| 93 | QX-ASS6-4T4F | B0H83B6TYP | 90 |
| 105 | RY-ASMO-6N4F | B0H8493HNR | 24 |
| 107 | RZ-AS26-WLRM | B0H85PJ516 | 24 |
| 117 | SZ-ASPI-JFAT | B0H776M5B5 | 24 |
| 118 | TH-AS6D-CCES | B0H845HSDZ | 24 |
| 120 | TP-AS91-8PAZ | B0H835T5HN | 30 |
| 121 | TQ-ASBR-96TC | B0H82BCZ44 | 24 |
| 125 | UD-AS9J-QNY6 | B0H834L7P6 | 90 |
| 126 | UE-ASA6-CLLY | B0H83ZHZ4S | 24 |
| 127 | UF-ASA1-GN5P | B0H854DM3X | 24 |
| 128 | UG-ASUO-L4D9 | B0H83FP8WW | 90 |
| 130 | UY-AS5N-A2E4 | B0H83R4M3R | 120 |
| 137 | VN-AS6Q-5AE9 | B0H8538L32 | 24 |
| 139 | WC-ASH5-EFN6 | B0H833W54L | 30 |
| 143 | WN-AS33-UFEA | B0H83RCTVV | 120 |
| 147 | XE-ASK1-BNRB | B0H81WMJBP | 45 |
| 149 | XV-ASEU-GDUX | B0H82YRTS3 | 45 |
| 150 | XW-ASSI-SZZT | B0H858GF4N | 24 |
| 152 | YF-ASZJ-8BBH | B0H822MPKC | 30 |
| 153 | YG-ASH6-BCXX | B0H8511Y5G | 24 |
| 155 | YM-AS7P-ZX44 | B0H83S1LDG | 120 |
| 158 | ZC-ASDC-3QMV | B0H83TSB5J | 120 |
| 164 | ZY-ASZ4-QM5U | B0H83T9QZV | 120 |
