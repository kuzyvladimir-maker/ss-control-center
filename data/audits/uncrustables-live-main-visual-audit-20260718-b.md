# Uncrustables live Amazon MAIN visual audit — reviewer B

- Audit ID: `ULMVA-20260718-B`
- Source manifest: `data/audits/uncrustables-live-main-fetch-20260718-v1/manifest.json`
- Source manifest SHA-256: `47c2bbbc0c0f7c1cdfcbc52363012b527d3611755d90536a2f80a06ffe2d9f05`
- Source ledger SHA-256: `46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f`
- Scope: contact sheets 08–14, ordinals 85–164 (80 exact live MAIN images)
- Result: **62 KEEP**, **18 REGENERATE**, **0 NEEDS_EVIDENCE**
- Mutation safety: read-only visual audit; no Amazon, R2, database, listing, or production-code writes.

## Method and decision boundary

Every scoped contact sheet was inspected at original resolution. Information-dense, ambiguous, or potentially nonconforming cells were reopened as their exact immutable 2048×2048 asset. The recipe, effective total, package identity, Salutem cooler/gel-pack composition, retailer marks, and physical plausibility were checked together.

`KEEP` means no concrete pixel-visible defect was found; it does not claim cryptographic donor provenance. `REGENERATE` means at least one concrete visible defect was found. The original assets resolved all borderline cases, so no row remains `NEEDS_EVIDENCE`.

Important false-positive guard: the current genuine “Reduced Sugar ... on Wheat” package is accepted for catalog donors named “Whole Wheat.” Named seasonal/protein products were also accepted when their exact current manufacturer identity matched. A different gel-pack count alone did not fail an otherwise conforming legacy image, although four remains the preferred regeneration target.

## REGENERATE queue

| Ord | Sheet/cell | SKU | ASIN | Units | Failed criteria | Reviewer finding |
|---:|:---:|---|---|---:|---|---|
| 90 | 08/R2C2 | QP-ASAD-PTLX | B0H85DG2JQ | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Reduced Sugar/On Wheat peanut butter & strawberry plus Up & Apple. The image instead shows classic red strawberry packaging plus Up & Apple, so the required wheat/reduced-sugar strawberry donor is replaced by the wrong variant. |
| 96 | 08/R3C4 | RL-AS64-Q8QX | B0H82LZLM2 | 30 | GENUINE_PACKAGE_CONFIGURATION | The image depicts two Beamin' Berry Blend 15-count cartons to reach 30 units. The audited donor is the genuine 22.4 oz/8-count product, and current manufacturer evidence supports the 8-count carton—not this generated 15-count carton—so the package configuration is fabricated even though the flavor name is real. |
| 97 | 09/R1C1 | RM-ASCV-DVA5 | B0H822CVVL | 24 | RETAILER_MARK_FREE | The product is genuine, but its carton visibly carries a retailer-exclusive “Only at Walmart” badge. Retailer marks are disallowed in the reusable Amazon MAIN scene. |
| 99 | 09/R1C3 | RQ-AS0L-9B45 | B0H85MQLHG | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Honey plus the 12g-protein Up & Apple product. The image uses Honey with legacy Apple Cinnamon 6g packaging, not the specified Up & Apple protein variant. |
| 103 | 09/R2C3 | RS-AS47-M3K3 | B0H87748WJ | 24 | SALUTEM_SHIPPING_COMPOSITION | The image is an isolated six-carton grid on white. It omits the open white EPS cooler, Salutem branding, gel packs, and physically packed frozen-shipping scene required for this MAIN-image family. |
| 110 | 10/R1C2 | SC-ASH8-4RQG | B0H856DWVS | 24 | GENUINE_PRODUCT_IDENTITY, EXACT_RECIPE_COMPONENT_IDENTITY | Expected Up & Apple plus Burstin' Blueberry. Only generic orange/blue wrapper backs are visible; no readable Smucker's/Uncrustables or flavor identity proves either required component. |
| 113 | 10/R2C1 | SH-ASO0-PW37 | B0H83ZH3TB | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Bright-Eyed Berry strawberry-protein plus classic grape. The image shows only Red, White & Berry mixed-berry wrappers; both recipe components are absent. |
| 116 | 10/R2C4 | SV-AS87-D6SV | B0H83ZGN22 | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Bright-Eyed Berry strawberry-protein plus classic strawberry. Only Bright-Eyed Berry is shown, so the classic strawberry half of the recipe is missing. |
| 120 | 10/R3C4 | TP-AS91-8PAZ | B0H835T5HN | 30 | GENUINE_PRODUCT_IDENTITY, EXACT_RECIPE_COMPONENT_IDENTITY | Expected peanut butter & mixed berry spread. The scene exposes only red gingham wrapper backs/side panels with no readable Smucker's/Uncrustables or mixed-berry identity; the exact required flavor cannot be verified and visually resembles strawberry packaging. |
| 123 | 11/R1C3 | TY-AST2-JE9P | B0H84WQRXB | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Raspberry plus Morning Protein/Beamin' Berry mixed berry. The image contains only raspberry cartons; the mixed-berry component is absent. |
| 134 | 12/R1C2 | VH-ASHZ-TJEE | B0H856VWD6 | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected Reduced Sugar/On Wheat strawberry plus Beamin' Berry mixed berry. The image contains only genuine reduced-sugar strawberry cartons; the mixed-berry component is absent. |
| 135 | 12/R1C3 | VK-ASSB-3YFK | B0H85FY28F | 24 | GENUINE_PRODUCT_IDENTITY, GEL_PACK_BRANDING | The supposed Honey and Reduced Sugar/On Wheat grape cartons are generic, with no readable Smucker's/Uncrustables identity. The gel packs also use nonstandard green-only labeling instead of the approved blue-header Salutem design. |
| 138 | 12/R2C2 | VT-ASTH-B6LM | B0H85CL8JD | 24 | EXACT_RECIPE_COMPONENT_IDENTITY, NO_UNEXPECTED_PRODUCTS | Expected peanut-butter-only plus Up & Apple. The image instead includes peanut butter, grape, and strawberry wrappers; Up & Apple is missing and two unrequested flavors are present. |
| 140 | 12/R2C4 | WK-AS2R-FJUW | B0H82XBNVN | 90 | SALUTEM_SHIPPING_COMPOSITION | The image is an isolated retail-box grid. It omits the open white EPS cooler, Salutem branding, gel packs, and packed frozen-shipping composition. |
| 142 | 12/R3C2 | WK-ASPD-G9HL | B0H85CF81Y | 24 | GENUINE_PRODUCT_IDENTITY, EXACT_RECIPE_COMPONENT_IDENTITY | The Reduced Sugar/On Wheat strawberry cartons are plausible, but the required peanut-butter-only component is rendered as purple “Peanut Butter Sandwich” cartons with grape-colored art/filling. Genuine peanut-butter-only packaging is orange, so this component is invented/wrong. |
| 146 | 13/R1C2 | WZ-ASXK-ZFAS | B0H85DF1R7 | 24 | GENUINE_PRODUCT_IDENTITY, EXACT_RECIPE_COMPONENT_IDENTITY | Expected Honey plus Burstin' Blueberry. Only generic orange/blue package backs are visible; no readable Smucker's/Uncrustables or flavor identity proves either component. |
| 159 | 14/R1C3 | ZE-AS5W-FKH3 | B0H8531B8B | 24 | EXACT_RECIPE_COMPONENT_IDENTITY | Expected peanut-butter-only plus Morning Protein/Beamin' Berry mixed berry. The image contains only peanut-butter-only cartons; the mixed-berry component is absent. |
| 163 | 14/R2C3 | ZX-ASQU-TKU9 | B0H84PVG1G | 24 | GENUINE_PRODUCT_IDENTITY, EXACT_RECIPE_COMPONENT_IDENTITY | Expected Reduced Sugar/On Wheat strawberry plus classic strawberry. The cartons are generic lookalikes without readable Smucker's/Uncrustables identity and show inconsistent generated count markings, so neither exact component is trustworthy. |

## Full classification ledger

| Ord | Sheet/cell | SKU | ASIN | Units | Decision |
|---:|:---:|---|---|---:|---|
| 85 | 08/R1C1 | PU-AS3D-SA5Z | B0H83H71F8 | 120 | KEEP |
| 86 | 08/R1C2 | PW-ASDZ-CSR8 | B0H839TPC5 | 45 | KEEP |
| 87 | 08/R1C3 | PY-ASBM-WX6W | B0H82B7GV5 | 24 | KEEP |
| 88 | 08/R1C4 | QC-ASX2-RHPA | B0H83TQPJB | 120 | KEEP |
| 89 | 08/R2C1 | QE-ASEQ-4YV5 | B0H82CBLRM | 24 | KEEP |
| 90 | 08/R2C2 | QP-ASAD-PTLX | B0H85DG2JQ | 24 | REGENERATE |
| 91 | 08/R2C3 | QW-ASRZ-SYKC | B0H83MDDBL | 120 | KEEP |
| 92 | 08/R2C4 | QX-AS89-H8YC | B0H82RQ226 | 24 | KEEP |
| 93 | 08/R3C1 | QX-ASS6-4T4F | B0H83B6TYP | 90 | KEEP |
| 94 | 08/R3C2 | RB-ASVO-GYCY | B0H859N8VM | 24 | KEEP |
| 95 | 08/R3C3 | RH-ASWA-ER34 | B0H85JR6WN | 24 | KEEP |
| 96 | 08/R3C4 | RL-AS64-Q8QX | B0H82LZLM2 | 30 | REGENERATE |
| 97 | 09/R1C1 | RM-ASCV-DVA5 | B0H822CVVL | 24 | REGENERATE |
| 98 | 09/R1C2 | RN-ASLP-VH3X | B0H82JYZQH | 30 | KEEP |
| 99 | 09/R1C3 | RQ-AS0L-9B45 | B0H85MQLHG | 24 | REGENERATE |
| 100 | 09/R1C4 | RQ-AS78-STLZ | B0H85GR968 | 24 | KEEP |
| 101 | 09/R2C1 | RQ-ASM7-T9NN | B0H83HNB3B | 90 | KEEP |
| 102 | 09/R2C2 | RR-ASG1-JVKV | B0H8361PYX | 45 | KEEP |
| 103 | 09/R2C3 | RS-AS47-M3K3 | B0H87748WJ | 24 | REGENERATE |
| 104 | 09/R2C4 | RU-ASC3-4TUS | B0H83SJFR7 | 24 | KEEP |
| 105 | 09/R3C1 | RY-ASMO-6N4F | B0H8493HNR | 24 | KEEP |
| 106 | 09/R3C2 | RY-ASO3-24Q2 | B0H84XMG42 | 24 | KEEP |
| 107 | 09/R3C3 | RZ-AS26-WLRM | B0H85PJ516 | 24 | KEEP |
| 108 | 09/R3C4 | SA-ASCK-J2B2 | B0H82XP1MM | 45 | KEEP |
| 109 | 10/R1C1 | SA-ASDW-SNEW | B0H82SMZ2M | 45 | KEEP |
| 110 | 10/R1C2 | SC-ASH8-4RQG | B0H856DWVS | 24 | REGENERATE |
| 111 | 10/R1C3 | SG-AS32-LZ9Y | B0H8564C6D | 24 | KEEP |
| 112 | 10/R1C4 | SG-ASLB-M2DG | B0H84PFKYC | 24 | KEEP |
| 113 | 10/R2C1 | SH-ASO0-PW37 | B0H83ZH3TB | 24 | REGENERATE |
| 114 | 10/R2C2 | SS-AS9K-U9TV | B0H831889Q | 45 | KEEP |
| 115 | 10/R2C3 | SU-ASS4-RV6R | B0H853HGHC | 24 | KEEP |
| 116 | 10/R2C4 | SV-AS87-D6SV | B0H83ZGN22 | 24 | REGENERATE |
| 117 | 10/R3C1 | SZ-ASPI-JFAT | B0H776M5B5 | 24 | KEEP |
| 118 | 10/R3C2 | TH-AS6D-CCES | B0H845HSDZ | 24 | KEEP |
| 119 | 10/R3C3 | TL-ASHN-ZRKG | B0H85P9F3R | 24 | KEEP |
| 120 | 10/R3C4 | TP-AS91-8PAZ | B0H835T5HN | 30 | REGENERATE |
| 121 | 11/R1C1 | TQ-ASBR-96TC | B0H82BCZ44 | 24 | KEEP |
| 122 | 11/R1C2 | TQ-ASC4-P2NP | B0H839G6RQ | 90 | KEEP |
| 123 | 11/R1C3 | TY-AST2-JE9P | B0H84WQRXB | 24 | REGENERATE |
| 124 | 11/R1C4 | UA-ASAO-RE7Q | B0H784LMG6 | 45 | KEEP |
| 125 | 11/R2C1 | UD-AS9J-QNY6 | B0H834L7P6 | 90 | KEEP |
| 126 | 11/R2C2 | UE-ASA6-CLLY | B0H83ZHZ4S | 24 | KEEP |
| 127 | 11/R2C3 | UF-ASA1-GN5P | B0H854DM3X | 24 | KEEP |
| 128 | 11/R2C4 | UG-ASUO-L4D9 | B0H83FP8WW | 90 | KEEP |
| 129 | 11/R3C1 | UJ-ASQ1-9FNR | B0H82P651P | 24 | KEEP |
| 130 | 11/R3C2 | UY-AS5N-A2E4 | B0H83R4M3R | 120 | KEEP |
| 131 | 11/R3C3 | VA-ASOK-QJCA | B0H85RZDX5 | 24 | KEEP |
| 132 | 11/R3C4 | VC-ASQE-L5Z5 | B0H82QYM85 | 45 | KEEP |
| 133 | 12/R1C1 | VC-ASV1-378P | B0H786L5MW | 90 | KEEP |
| 134 | 12/R1C2 | VH-ASHZ-TJEE | B0H856VWD6 | 24 | REGENERATE |
| 135 | 12/R1C3 | VK-ASSB-3YFK | B0H85FY28F | 24 | REGENERATE |
| 136 | 12/R1C4 | VN-AS1A-D572 | B0H82PKK18 | 45 | KEEP |
| 137 | 12/R2C1 | VN-AS6Q-5AE9 | B0H8538L32 | 24 | KEEP |
| 138 | 12/R2C2 | VT-ASTH-B6LM | B0H85CL8JD | 24 | REGENERATE |
| 139 | 12/R2C3 | WC-ASH5-EFN6 | B0H833W54L | 30 | KEEP |
| 140 | 12/R2C4 | WK-AS2R-FJUW | B0H82XBNVN | 90 | REGENERATE |
| 141 | 12/R3C1 | WK-AS7E-M3CE | B0H843R64X | 24 | KEEP |
| 142 | 12/R3C2 | WK-ASPD-G9HL | B0H85CF81Y | 24 | REGENERATE |
| 143 | 12/R3C3 | WN-AS33-UFEA | B0H83RCTVV | 120 | KEEP |
| 144 | 12/R3C4 | WR-ASR5-AVWE | B0H859VYXH | 24 | KEEP |
| 145 | 13/R1C1 | WR-ASTH-TPXV | B0H85DRT93 | 24 | KEEP |
| 146 | 13/R1C2 | WZ-ASXK-ZFAS | B0H85DF1R7 | 24 | REGENERATE |
| 147 | 13/R1C3 | XE-ASK1-BNRB | B0H81WMJBP | 45 | KEEP |
| 148 | 13/R1C4 | XJ-ASVD-CDMW | B0H82MSTD9 | 45 | KEEP |
| 149 | 13/R2C1 | XV-ASEU-GDUX | B0H82YRTS3 | 45 | KEEP |
| 150 | 13/R2C2 | XW-ASSI-SZZT | B0H858GF4N | 24 | KEEP |
| 151 | 13/R2C3 | YA-ASX6-PZE7 | B0H82YB4PD | 30 | KEEP |
| 152 | 13/R2C4 | YF-ASZJ-8BBH | B0H822MPKC | 30 | KEEP |
| 153 | 13/R3C1 | YG-ASH6-BCXX | B0H8511Y5G | 24 | KEEP |
| 154 | 13/R3C2 | YH-ASQ8-45ED | B0H82QPCJL | 45 | KEEP |
| 155 | 13/R3C3 | YM-AS7P-ZX44 | B0H83S1LDG | 120 | KEEP |
| 156 | 13/R3C4 | YV-AST8-LMKN | B0H859JMGJ | 24 | KEEP |
| 157 | 14/R1C1 | ZB-ASKL-9W8G | B0H82LKBYH | 45 | KEEP |
| 158 | 14/R1C2 | ZC-ASDC-3QMV | B0H83TSB5J | 120 | KEEP |
| 159 | 14/R1C3 | ZE-AS5W-FKH3 | B0H8531B8B | 24 | REGENERATE |
| 160 | 14/R1C4 | ZH-AS8W-G5MN | B0H82LMD9Z | 30 | KEEP |
| 161 | 14/R2C1 | ZP-ASJD-X7ZD | B0H85N7X8W | 24 | KEEP |
| 162 | 14/R2C2 | ZX-AS2C-GT8Q | B0H82L3LRT | 30 | KEEP |
| 163 | 14/R2C3 | ZX-ASQU-TKU9 | B0H84PVG1G | 24 | REGENERATE |
| 164 | 14/R2C4 | ZY-ASZ4-QM5U | B0H83T9QZV | 120 | KEEP |

## Manufacturer references used only to resolve package-identity questions

- [Whole Wheat strawberry/current Reduced Sugar on Wheat identity](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-strawberry-jam-on-wheat)
- [Whole Wheat grape/current Reduced Sugar on Wheat identity](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-grape-jelly-on-wheat)
- [Red, White & Berry genuine mixed-berry identity](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-mixed-berry-rwb)
- [Beamin' Berry Blend genuine product and 8-count package evidence](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-mixed-berry-protein)
- [Raspberry genuine product and current package sizes](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-raspberry)
- [Peanut butter & chocolate genuine retailer-exclusive product identity](https://www.smuckersuncrustables.com/sandwiches/peanut-butter-and-chocolate)
- [Current manufacturer product-name cross-check](https://www.smuckersuncrustables.com/sandwiches)

The row-level JSON preserves the exact asset SHA-256, contact-sheet SHA-256/cell, full recipe components, failed criteria, and reviewer note for every SKU. The CSV is the compact operational export.

