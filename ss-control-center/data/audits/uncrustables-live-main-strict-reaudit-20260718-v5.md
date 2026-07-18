# Uncrustables live MAIN strict re-audit — v5 carton-rule correction

- Audit ID: `ULMSR-20260718-V5-CARTON-RULE-CORRECTION`
- Reviewed: **164**
- Visual KEEP: **52**
- REPAIR: **112**
- False mixed-carton reasons removed: **4**
- Decision changes: **0**
- Body SHA-256: `a562c9c1b79d555712124e8e644210f7bc2d2aac7b4bc1549a88712f5c0d649c`

> Exact 10 + 10 + 4 single-flavor carton math is allowed. Ordinals 1/97 remain REPAIR for retailer badges; ordinals 2/38 remain REPAIR for forbidden loose ice. This audit authorizes no marketplace write.

| Ordinal | SKU | ASIN | Correct v5 reason |
|---:|---|---|---|
| 1 | AC-AS4J-B64F | B0H82ZZS2P | RETAILER_BADGE_VISIBLE |
| 2 | AD-AS4H-QXZD | B0H82J6V9T | LOOSE_ICE_VISIBLE |
| 38 | FR-AS6X-5KJY | B0H827V9DJ | LOOSE_ICE_VISIBLE, VISIBLE_TEXT_INTEGRITY_FAIL |
| 97 | RM-ASCV-DVA5 | B0H822CVVL | RETAILER_BADGE_VISIBLE |
