# MAIN candidate QA — FR-AS6X-5KJY / B0H827V9DJ / candidate 03

Decision: **REJECTED_TEXT_INTEGRITY_UNPROVEN**. Production eligible: **no**.

GPT Image 2 removed the forbidden loose blue ice while preserving the correct visible `10 + 10 + 4 = 24` carton plan, the exact Chocolate Flavored Hazelnut Spread identity, and four gel packs. It is visually much closer to the intended result than a full regeneration.

It is still blocked. The model did not perform a byte-local inpaint: the output changed non-target pixels and reduced the source from 2048×2048 to 1254×1254. Magnified review and comparative Apple Vision OCR cannot prove the small blue carton count-badge copy, gel-pack slogan, and lower package microcopy character-exact. Some defects already existed in the live source; retaining them still fails the 100% production criterion.

- Source SHA-256: `025e677a6b5c69874bf43f640611b6201bfe019152a93cba5ac19f59fae7e895`
- Candidate SHA-256: `cb7e364ba7f2e0d4e681964d160073b41f7885f25f1d7b7df5ec0867bff1e063`
- Scaled source/candidate SSIM: `0.946141`
- Amazon writes: `0`
- ChannelMAX writes: `0`

Do not publish this file. It remains a rejected local QA artifact.
