# Phase 2.6.2 — Safety Re-Test Report

**Generated:** 2026-05-19
**Branch:** `feat/phase-2-6-2-claude-rewrite`
**Final outcome:** **10/10 PASS** after disclaimer swap to Variant A (5/5 AMZCOM + 5/5 SALUTEM, real PATCHes against live Amazon SP-API). Original test with Option C Defensive disclaimer: 0/5 AMZCOM, 0/1 SALUTEM probe. Investigation below explains the gap.

## Re-test result with Variant A disclaimer

After [`870a246`](../../commit/870a246) swapped the disclaimer constants to the minimal "Variant A" wording, the cohort-scoped safety tests were re-run end-to-end (replan with new constants → execute with --apply).

| Cohort | Planned (Claude) | Validation | Real PATCH | Result |
|---|---:|---:|---:|---|
| AMZCOM | 5/5 (avg 1.60¢) | 5/5 VALID | 5/5 success | **PASS** ✅ |
| SALUTEM | 5/5 (avg 1.80¢) | 5/5 VALID | 5/5 success | **PASS** ✅ |

Total Claude spend across both re-tests: $0.17. Real listings now carry the new Claude-rewritten bullets+description + Variant A disclaimer in production.

Both cohorts cleared the 4/5 (80%) per-cohort threshold per spec. Full execute of the remaining ~1028 plan rows is unblocked **pending Vladimir's explicit approval** (per spec safety gate — no autonomous full execute).

---

## Investigation that unblocked the strategy

(Original safety run with the Option C Defensive disclaimer failed 0/6. Section below documents how the disclaimer was identified as the sole blocker and how Variant A was chosen.)

## TL;DR

- Claude Sonnet 4.5 content rewrite is implemented and working — pure-function tests 21/21 green, live API integration test green, plan script integration validated end-to-end (canary + targeted cohort replan).
- 0/5 AMZCOM + 0/1 SALUTEM safety listings passed Amazon's PDP classifier (code 99300) with the full PATCH body (Claude content + Option C Defensive disclaimer).
- **Root cause is NOT Claude's content.** Isolation probe (4 VALIDATION_PREVIEW variants on the same ASIN) proves Claude's rewrite passes the classifier cleanly. The Option C Defensive disclaimer text is what trips 99300 on both `bullet_point` and `product_description`.
- Phase 2.6.2 strategy is sound; the disclaimer-text constants need revision (or removal) before any further execute attempt.

## Isolation probe — proof

Probed `B0F74NGS3B` (POULTRY productType, Oscar Mayer Rotisserie Chicken gift set) via `scripts/_diag-disclaimer-isolate.ts`. Same Claude-generated bullets + description in all 4 variants; only the disclaimer presence varies. All probes used VALIDATION_PREVIEW (no real PATCH, no listing mutation).

| Variant | Bullets | Description | Result |
|---|---|---|---|
| A | Claude only (no disclaimer bullet) | Claude only (no disclaimer paragraph) | **VALID** ✅ |
| B | Claude only | Claude + disclaimer paragraph | INVALID — `product_description` 99300 |
| C | Claude + disclaimer bullet | Claude only | INVALID — `bullet_point` 99300 |
| D | Claude + disclaimer bullet | Claude + disclaimer paragraph | INVALID — both attributes 99300 (matches production) |

Conclusion: Amazon's classifier rejects whichever attribute carries the disclaimer, independently. Variant A — Claude content alone — passes cleanly.

## Disclaimer-wording probe — 3 minimal variants all PASS

Follow-up probe via [`scripts/_diag-disclaimer-variants.ts`](../ss-control-center/scripts/_diag-disclaimer-variants.ts) tested 3 stripped-down disclaimer wordings against the same Claude content. Same ASIN (B0F74NGS3B), same VALIDATION_PREVIEW path. **All three variants pass in all three attachment patterns** (bullet only / description only / both).

| Variant | Bullet text | Paragraph text | Result (all 3 patterns) |
|---|---|---|---|
| A — minimal | "Curated and assembled by Salutem Solutions LLC as a gift basket." | "This gift basket is curated and assembled by Salutem Solutions LLC. The included items are packaged by their original manufacturers." | **VALID** ✅ |
| B — shorter | "Assembled by Salutem Solutions LLC as a gift basket." | "Assembled by Salutem Solutions LLC. Each item is packaged by its original manufacturer." | **VALID** ✅ |
| C — no LLC | "Gift basket curated by Salutem Solutions." | "This is a curated gift basket. Each included item is packaged by its original manufacturer." | **VALID** ✅ |

What's REMOVED relative to Option C Defensive (the rejecting version):

- Affiliation/endorsement negation ("not affiliated with, sponsored by, or endorsed by any of the brands…")
- Trademark-property statement ("All trademarks, brand names, logos, and packaging visible in the product images are the property of their respective owners…")
- Modification-status statement ("This product is intended as a gift basket; included items are not modified, repackaged into branded materials, or altered in any way…")
- Sourcing-authority claim ("individual items are sourced from authorized retailers")

What's KEPT in all three variants:

- Salutem identity as curator/assembler
- Gift-basket framing
- Acknowledgement that items are packaged by their original manufacturer

**Recommendation:** swap [DISCLAIMER_BULLET](../ss-control-center/src/lib/bundle-factory/remediation/disclaimer-text.ts) and [DISCLAIMER_DESCRIPTION](../ss-control-center/src/lib/bundle-factory/remediation/disclaimer-text.ts) to Variant A (most informative of the three; explicitly mentions LLC entity), re-run safety test of 5 AMZCOM, and if ≥4/5 proceed to 5 SALUTEM per original gate. Expected outcome: all 5 pass (probe ran VALID on 9/9 disclaimer-bearing patches, the safety test will be the first multi-listing confirmation).

⚠ **Legal/compliance check before swap:** Option C Defensive was added after the 2026-05-17 Retailer Distributor ban specifically to strengthen the Gift Basket Exception positioning under Amazon's policy (see [BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md](BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md) if it exists). The minimal variants drop the explicit "not affiliated/endorsed" language. Vladimir should confirm whether the simpler wording still meets the compliance objective. If not, alternative path is to keep the legalese text in `hasDisclaimerText`-detectable form but inject it OUTSIDE bullets/description (e.g., via product attribute fields not subject to PDP classifier, or via the Brand Story / A+ Content path).

## The disclaimer text Amazon is rejecting

Both blocks live in [src/lib/bundle-factory/remediation/disclaimer-text.ts](../ss-control-center/src/lib/bundle-factory/remediation/disclaimer-text.ts):

```
DISCLAIMER_BULLET:
Curated and packaged by Salutem Solutions LLC as a gift basket assembly.
This is not a manufacturer's product; individual items are sourced from
authorized retailers and assembled for buyer convenience.

DISCLAIMER_DESCRIPTION (paragraph):
About this gift basket: This product is a curated assembly created by
Salutem Solutions LLC, a third-party curator. Salutem Solutions LLC is
not affiliated with, sponsored by, or endorsed by any of the brands
included in this collection. Each item is independently sourced from
authorized retailers and assembled into this gift basket for buyer
convenience. All trademarks, brand names, logos, and packaging visible
in the product images are the property of their respective owners.
This product is intended as a gift basket; included items are not
modified, repackaged into branded materials, or altered in any way.
```

Likely triggers for code 99300 ("false/promotional claims or external links"):

- **Affiliation/endorsement language** ("not affiliated with, sponsored by, or endorsed by") — Amazon's classifier may treat any endorsement claim, even a defensive negation, as a "false claim".
- **Trademark-property statements** ("All trademarks … are the property of their respective owners") — similar pattern: an unsolicited claim about IP status is treated as an external/legal claim.
- **"Sourced from authorized retailers"** — claim about supply chain that the classifier can't verify.

The 1 Phase 2.6.1 listing that passed (B0F795H56B, hot dog gift set) carries the same disclaimer. Best theory: Amazon's classifier is non-deterministic above some confidence threshold and that listing happened to fall under. Today's 6/6 across two cohorts is a much stronger signal than 1/5 was.

## What worked — Phase 2.6.2 implementation status

- `claude-rewrite.ts` module — Sonnet 4.5 wrapper with prompt caching, JSON contract + one corrective retry, validation guards (bullet count/length, emoji/HTML/marker rejection)
- Tests: 21/21 pure-function (parse/validate/build/stub flows) + 1/1 live integration (real Sonnet 4.5 call on the failed-content fixture)
- `disclaimer-injection-plan.ts` — `--mode=claude` default, `--account=` cohort filter, `--limit=N`, per-row failure handling (Claude error → plan row with `sp_api_error`), running cost log every 25 rows
- `disclaimer-injection-replan.ts` — pass-through `--mode` / `--limit` / `--account` to plan subprocess
- Claude content for the 6 safety samples is genuinely compliant — factual bullets, plain-text descriptions, brand mentions as inventory (Oscar Mayer Bun-Length Franks, Rotisserie Chicken, Beef Bologna), no emoji/promo/HTML
- Cost telemetry working: avg 1–2¢ per listing, first call cache_write at $0.04, subsequent calls cheaper

## Cost spent on the safety re-test

- Claude API: $0.18 (canary 2 + AMZCOM 5 + AMZCOM 5 re-do + SALUTEM 1 + cohort overhead)
- SP-API: 6 VALIDATION_PREVIEW + 4 disclaimer-isolation probes = 10 calls (free, no PATCH applied)
- Listings actually modified: 0 (every PATCH blocked at VALIDATION_PREVIEW stage)

## Recommended next steps (decisions for Vladimir)

Pick one — none should be run without your sign-off:

1. **Revise disclaimer text** to remove the affiliation/endorsement negation and trademark-property statements; keep only the curator/assembly statement. Re-run safety test of 5 AMZCOM with new text. **Smallest change, fastest answer.** Estimated effort: 30 min + safety re-test ~$0.05 + ~2 min.

2. **Drop disclaimer entirely** for Phase 2.6.2. Claude's rewrite alone passes the classifier. The disclaimer was Option C Defensive added for Gift Basket Exception positioning after the 2026-05-17 ban; if it's blocking the very content it's protecting, the cost/benefit may have flipped. Talk to legal/compliance before this one.

3. **Test alternative disclaimer wordings** (Option A Minimal, Option B Curator-Only) per `docs/BUNDLE_FACTORY_PHASE_2_6_1_DISCLAIMER_INJECTION.md` if those exist; isolation probe each before bulk run.

4. **Tune Claude prompt** to bake the curator-assembler statement into the bullets and description style itself (no separate appended block) so it reads as inventory description rather than a legal disclaimer. Higher risk: shifts the disclaimer from defensive constants you control to AI-generated text.

5. **Defer Phase 2.6.2 execute** entirely and move to Phase 2.6.3 (title rewrite) or Phase 2.6.4 (image regeneration) first, since those address the high-risk listings the audit flagged independent of disclaimer text.

## What I did NOT do (per spec)

- No full 1038-listing replan ($8.50, ~4 hours) — would have been wasted given safety test failure
- No SALUTEM 5-listing safety test — gated behind AMZCOM passing per spec; ran only 1-listing probe for cross-account confirmation
- No full execute — gated behind Vladimir's explicit approval per spec

## Files in this commit

- `ss-control-center/src/lib/bundle-factory/remediation/claude-rewrite.ts` — module
- `ss-control-center/src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts` — 22 tests
- `ss-control-center/scripts/disclaimer-injection-plan.ts` — `--mode=claude` integration
- `ss-control-center/scripts/disclaimer-injection-replan.ts` — pass-through flags
- `ss-control-center/.env` (local only, gitignored) — corrected `AMAZON_SP_SELLER_ID_STORE1=A3A7A0RDFUSGBS` and `_STORE3=A2ON382ZMCWPCT` to the real US sellerIds (auto-discovered via Invoicing Shadow MP). The previous values were sellerIds for non-US marketplaces and made every `GET /listings` return 400 InvalidInput. **Vercel env vars need the same fix before any production execute.**
- `ss-control-center/scripts/_diag-disclaimer-isolate.ts` — disclaimer-isolation probe (the diagnostic that produced the table above)
- `ss-control-center/scripts/_inspect-plan-state.ts` — quick state dump for plan rows
- `docs/PHASE_2_6_2_PLAN_REPORT.md` — latest plan report (5 SALUTEM rows from the cohort replan probe)
- `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md` — this document
