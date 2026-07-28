# A+ / Gift-Set — IP & Legality Rules (the hard gate)

**⚠️ NOT LEGAL ADVICE.** This is a research synthesis (deep-research, adversarially
verified, 2026-06-19) of Amazon policy + US trademark law. Before we rely on it for
AUTOMATED publishing, the ruleset should get a real IP-attorney sanity check. Re-verify
the Amazon policy on Seller Central ~every 6 months — bundling policy is recent (2024)
and the "gift basket" category is ambiguous. Companion: `aplus-content-knowledge-base.md`.

This is the **qualification-gate + generator gate** for the A+ Content Factory: own-brand
gift baskets (Salutem Vita / Starfit) that contain genuine third-party-brand products.

## TL;DR — why we've likely been getting IP complaints

Effective **Oct 14 2024 (enforced Jan 1 2025), Amazon BANNED multi-brand consumables
bundles — EXCEPT a "gift-basket" exception.** Our food baskets are legal *only* if they
sit squarely inside that exception (gift-category placement, cohesive gift presentation,
own UPC/GTIN-exemption, actual products shown). Drift from those conditions — or using
third-party logos as marketing/hero imagery — is what triggers both Amazon takedowns and
rights-holder complaints. The fix is to keep every listing + its A+ strictly inside the
exception and never make a third-party brand the star. [PRIMARY]

## 1. GATE — a listing/A+ is eligible ONLY if (all true)

- Placed in the **gift-basket / gift category** with **cohesive gift presentation**
  (assembled as a gift, not a loose multi-pack). [PRIMARY · 3-0]
- Has its **own UPC, or a GTIN exemption** (do not reuse a component's UPC). [PRIMARY · 3-0]
- Contains **genuine items in their ORIGINAL, sealed manufacturer packaging** (no
  repackaging that creates a "material difference" — that voids first-sale protection). [LEGAL · 3-0]
- Title states **"Bundle" / "Gift Basket" + item count**; bullet 1 + description **factually
  identify** the included products. [PRIMARY · 3-0]
- Main image shows the **specific ACTUAL products** included — no representative/stock
  stand-ins. [PRIMARY · 3-0]

If any is false → do NOT generate/publish; route to manual review.

## 2. TEXT rules (generator + scrubber)

**DO:**
- Name third-party brands **only factually**, e.g. `Includes 8 Oscar Mayer Bun Length
  Franks`. Naming is protected by nominative fair use + first sale. [LEGAL · 3-0]
- Include the curator disclaimer (verified 2026-05-19, matches CLAUDE.md):
  - bullet: `Curated and assembled by Salutem Solutions LLC as a gift basket.`
  - description adds: `The included items are packaged by their original manufacturers.`

**DON'T:**
- ❌ Third-party brand in the **Brand field** or as the **lead/title brand** (brand =
  Salutem Vita / Starfit; third-party names appear only as factual contents).
- ❌ Words implying a relationship: **"authorized", "official", "endorsed", "partner",
  "licensed", "in collaboration with"**. [LEGAL · 3-0]
- ❌ Promo adjectives / emojis / health claims (existing brand-voice ban).
- ❌ PDP 99300 triggers — see §4.

## 3. IMAGE rules (CRITICAL for A+ generation)

**DO:**
- Show the **actual products as sold, in their original packaging**, inside the assembled
  basket. [PRIMARY/LEGAL · 3-0]
- Make the **hero** the assembled gift basket under OUR brand framing (Salutem Vita /
  Starfit), photographed as a cohesive gift.

**DON'T (these are what draw complaints):**
- ❌ **Never enlarge, isolate, recreate, or feature a third-party LOGO as the hero or
  focal point.** Using logos does NOT cleanly qualify as fair use (the "logos = fair use"
  claim was **REFUTED 0-3**). [LEGAL · refuted-against]
- ❌ No third-party logos in comparison charts, banners, or brand-story modules; **no
  co-branding** (don't present our brand alongside theirs as if affiliated). [LEGAL · 3-0]
- ❌ Do **not blur/erase** logos either — that can create a "material difference" /
  misrepresentation problem. The rule is: show the product **as-is**, but **never make
  the logo the subject of the image**. Logos appear only incidentally because they're on
  the genuine product in the shot. [LEGAL]
- ❌ AI-generated images must depict the **real included products** — do not invent or
  alter packaging (alteration = material difference, voids first-sale safe harbor).

Practical generation rule: the AI hero/lifestyle images frame OUR basket + OUR branding;
third-party products appear in-context in original packaging, never logo-forward.

## 4. Avoid PDP code 99300 (Amazon's promo/false-claims classifier)

Keep the disclaimer SHORT + factual. Do NOT add (these trigger 99300):
- ❌ Affiliation-negation ("not affiliated with / not endorsed by …").
- ❌ Trademark-property statements ("trademarks belong to their respective owners").
- ❌ Supply-chain claims ("sourced from authorized retailers").
- ❌ Long defensive legal paragraphs.

(Constants: `src/lib/bundle-factory/remediation/disclaimer-text.ts`.) [from CLAUDE.md, verified]

## 5. Legal basis (context, not advice)

- **First-sale doctrine** — you may resell genuine trademarked goods; protection needs
  adequate disclosure, no consumer confusion, no material difference (repackaging/altering
  can void it). Doing *more than resale* or implying authorization loses the safe harbor. [LEGAL · 3-0]
- **Nominative fair use** (New Kids, 9th Cir 1992; 3-factor test) — lets you *name* a brand
  to identify genuine goods; does **not** cleanly extend to **logo** usage. [LEGAL · 3-0]
- **Important limit:** these doctrines govern COURTS, not Amazon's private takedown system —
  Amazon can remove a listing on a rights-holder complaint regardless of legal merit. So
  the operational goal is *don't give anyone a reason to complain*. [LEGAL · noted]

## Myths this research KILLED (adversarially refuted 0-3)
- ❌ "Bundles must be branded by the highest-priced item" — false.
- ❌ "Bundles must be sold by the manufacturer that owns all the brands" — false (the
  gift-basket exception lets US assemble + brand them).
- ❌ "Self-repackaging different manufacturers' products into your own bundle is prohibited
  absent authorization" — false (allowed under the gift-basket exception).
- ❌ "Using brands' LOGOS qualifies as nominative fair use" — false / risky.

## Sources & how to re-verify
- **[PRIMARY]** Amazon Product Bundling Policy (PDF): `m.media-amazon.com/images/G/65/rainier/help./Product_Bundling_Policy.pdf` — the Oct-2024 bundling ban + gift-basket exception, UPC/title/image requirements.
- **[PRIMARY]** Amazon Ads brand-usage policy: `advertising.amazon.com/resources/ad-policy/brand-usage` — imagery/brand-usage in ads/marketing.
- **[PRIMARY/LEGAL]** Duke IP casebook ch.8 (New Kids nominative fair use): `web.law.duke.edu/cspd/papers/pdf/ipcasebook_chap-08.pdf`.
- **[SECONDARY/LEGAL]** Loeb — first-sale for resellers of end products w/ trademarked components: `loeb.com/en/insights/publications/2022/05/first-sale-doctrine-for-resellers-of-end-products-with-trademarked-products`.
- **[SECONDARY/LEGAL]** Vorys — material-difference exception; Sterne Kessler — "first sale is not a get-out-of-jail-free card"; GRSM — first-sale limitations.
- Verification: deep-research, 25 claims adversarially verified → 21 confirmed, 4 killed. Re-check the Amazon Bundling Policy PDF on Seller Central each refresh (policy is new + evolving).
