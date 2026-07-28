# A+ Content — Conversion Playbook (baked into the generator)

From verified deep-research (2026-06-19; 25 claims adversarially checked → 13 confirmed,
12 killed). This is the playbook encoded in `src/lib/amazon/aplus/generator.ts` (SYSTEM
prompt + fixed storyboard). Companion: `aplus-content-knowledge-base.md` (technical),
`aplus-ip-giftset-rules.md` (IP gate). Re-verify on Amazon's live design guide ~6mo.

## Verified principles (high confidence unless noted)

- **Module cap: Basic A+ = 5 modules, Premium = 7.** [PRIMARY: Amazon design guide]
  → generator targets 5.
- **Image-led, mobile-first, scannable** — NOT text-heavy. Lifestyle / in-use / infographic
  visuals dominate high-performing pages; keep ≥1 clean contents shot. [PRIMARY + agencies]
- **Hero FIRST, headline = PRIMARY BENEFIT** (what the shopper gets), not just the name. A
  pretty lifestyle hero with no benefit underperforms. [agency consensus, 3-0]
- **Copy short & benefit-first:** lead with the benefit in the first words; ~2–3 short
  sentences per block; benefit cells = 1 sentence; bullets over paragraphs; write to answer
  buyer questions, NOT a keyword list. (Don't hard-code "30–40 words" — refuted.) [PRIMARY + agencies]
- **Never bake text into images** — embedded text reflows blurry on mobile (60%+ of traffic
  is mobile). All copy in live text fields; design each 300×300 to read standalone (they
  stack on mobile). [PRIMARY]
- **How-to / ways-to-serve module reduces purchase anxiety** ("how do I use it"). Keep it one
  consolidated usage module (don't split ingredients/instructions). [agency, medium]
- **Lead with why / emotional gifting framing — but keep short benefit copy**, filtered
  through our STRICT brand voice (factual, no promo adjectives/emojis/health claims). [medium]

## Default storyboard (best-supported; food/gift-set; 5 Basic modules)

Encoded order in the generator:
1. **Hero / header banner** (970×600) — headline states the primary benefit.
2. **Brand story** (side image) — short "why / who it's for" (gifting, sharing), factual curator role.
3. **Top 3 benefits** (3-image block, 300×300 each) — benefit headline + 1 sentence per cell.
4. **How-to / ways to serve** (side image) — concrete serving/usage.
5. **What's inside** (live text) — factual contents + counts ("Includes 8 Oscar Mayer…") + the curator disclaimer.

(Premium slots 6–7, if ever enabled: own-catalog comparison chart + occasions/gifting lifestyle.)

## Image specs (encode as generation/crop targets)
- Header-with-text 970×600 (keep text/faces out of bottom 20%); Three-images 300×300 each;
  Comparison 150×300; Company logo 600×180; Premium full-width ~1464×600. [PRIMARY templates PDF]
- Generate JPEG/PNG sRGB; appetizing premium food/lifestyle; logo-free.

## Gift-set handling (our IP constraint)
- "What's inside" = factual live-text portfolio (names + counts). Logo-free lifestyle/occasion
  food photography (table spreads, gifting moments). Convey value by showing the assortment
  together + an occasions/usage angle. Brands named in TEXT only, never logos in images.
  (Weakest-sourced angle — principled extrapolation from verified general rules.)

## Do / DON'T (conversion mistakes to avoid)
- ❌ Walls of text / dense paragraphs · ❌ text baked into images · ❌ generic stock photos ·
  ❌ low-contrast or tiny fonts · ❌ infographic-overload with unreadable text · ❌ pretty hero
  with no benefit message · ❌ keyword-stuffing.
- ✅ Benefit-first hero · ✅ short scannable copy · ✅ lifestyle/in-use imagery · ✅ a how-to/serve
  module · ✅ each mobile-stacked image reads standalone · ✅ one clear message per module.

## Killed myths (do NOT encode as fact)
- "Basic lifts 8% / Premium 20%" and "comparison charts convert best" — REFUTED 0-3.
- "70%+ of traffic is mobile" — refuted (real ≈53–61%; "60%+" is the safe statement).
- "70% visual / 30% text", "30–40 words per module", and several competing module orders — refuted.

## Sources & confidence
- [PRIMARY] Amazon A+ design guide `sell.amazon.com/blog/a-plus-content-design-guide`;
  Amazon Standard_A_Module_Templates.pdf (image dims).
- [AGENCY] Superfood Digital (food template), Emplicit (hero-first), Xena, SalesDuo, Sequence
  Commerce, Better World, Flairox, MyAmazonGuy. Module ORDER + conversion claims are
  agency/practitioner "best-supported default," NOT A/B-proven — treat as defaults, keep
  measuring lift via our diff-in-diff engine. Open: is Premium A+ enabled for store1/3?
