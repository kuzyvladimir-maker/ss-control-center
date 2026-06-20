# 🤖 Phase 2.6.2 — Claude Content Rewrite

> **Started:** 2026-05-18 · **Bulk-run completed:** 2026-05-19
> **Outcome:** 1015 / 1038 listings PATCHed compliant (97.8% success rate)
> **Cost:** $14.14 (Claude Sonnet 4.5)
> **Full spec:** `docs/CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE.md`
> **Safety analysis:** `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md`

---

## TL;DR

Generate fresh compliant bullets + description from audit metadata using Claude Sonnet 4.5, then append a minimal curator disclaimer — replacing the in-plan content-generation step of [Phase 2.6.1](phase-2-6-1-disclaimer-injection.md) (regex scrub) which only passed 1/5 AMZCOM safety listings.

Claude's content is genuinely clean (no emojis, no `perfect`/`ultimate`, no HTML, factual brand-as-inventory phrasing). Initial safety re-test still failed 6/6, but the [disclaimer-isolation probe](#disclaimer-revision-the-unblock) proved Claude was clean — the **disclaimer text itself** was the trigger. After swapping to minimal Variant A wording, safety re-test was 10/10 (5 AMZCOM + 5 SALUTEM), and the full bulk run patched 1015 / 1038 listings compliant.

## Architecture

Pipeline is identical to [Phase 2.6.1](phase-2-6-1-disclaimer-injection.md): `plan → execute → verify → rollback`. Only the in-plan content-generation step changes:

| 2.6.1 (`--mode=scrub`) | 2.6.2 (`--mode=claude`, default) |
|---|---|
| Regex strip emojis/promo/HTML from existing copy | Sonnet 4.5 generates fresh bullets + description |
| Append Option C disclaimer | Append revised minimal disclaimer (see below) |
| Cost: $0 | Cost: ~1.4¢ per listing |

Smart Scrub stays in the tree as `--mode=scrub` fallback AND as a defensive belt-and-suspenders filter on Claude output.

## Module surface

`src/lib/bundle-factory/remediation/claude-rewrite.ts`

```typescript
export interface RewriteInput {
  asin: string;
  title: string;
  brand: string;
  browse_node: string | null;
  original_bullets: string[];
  original_description: string;
}

export interface RewriteOutput {
  bullets: string[];        // 4-9 factual bullets, validated
  description: string;      // ≤2000 chars, no HTML, validated
  cost_cents: number;
  cache_hit: boolean;
  error?: string;
}

export async function rewriteListingContent(input: RewriteInput): Promise<RewriteOutput>;
```

System prompt is cached (one ephemeral cache write per session, ≤5 min TTL). 22 tests in [`claude-rewrite.test.ts`](../../ss-control-center/src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts) — 21 pure-function (parse / validate / build / stub flows) + 1 live API (real Sonnet 4.5 call on the failed-content fixture). One corrective retry on JSON parse failure; validation rejects emoji / HTML / markers / bullet length out of range.

## Disclaimer revision (the unblock)

Initial safety re-test with Phase 2.6.1's Option C Defensive disclaimer failed **6/6** (0/5 AMZCOM + 0/1 SALUTEM probe). Isolation probe (`scripts/_diag-disclaimer-isolate.ts`) proved Claude content alone passed — the **disclaimer text itself** was the trigger:

| Variant | Bullets | Description | Result |
|---|---|---|---|
| A | Claude only | Claude only | **VALID** ✅ |
| B | Claude only | Claude + Option C paragraph | INVALID — desc 99300 |
| C | Claude + Option C bullet | Claude only | INVALID — bullet 99300 |
| D | Both | Both | INVALID — both 99300 |

Option C's affiliation-negation ("not affiliated with, sponsored by, or endorsed by"), trademark-property statement ("All trademarks … property of their respective owners"), and "authorized retailers" supply-chain claim each independently trip code 99300. Probed three minimal variants (`scripts/_diag-disclaimer-variants.ts`); all three returned status=VALID. Picked Variant A — preserves Gift Basket Exception positioning without the legalese:

**Bullet (43 chars):**
> Curated and assembled by Salutem Solutions LLC as a gift basket.

**Description paragraph:**
> This gift basket is curated and assembled by Salutem Solutions LLC. The included items are packaged by their original manufacturers.

After revision, safety re-test was **10/10** (5 AMZCOM + 5 SALUTEM real PATCH, not just preview).

`hasDisclaimerText()` matches both 2.6.2 and 2.6.1 wording so the one listing patched under Option C stays recognised as compliant.

## Cohort-scoped CLI

Phase 2.6.1 had no way to target one account for a cheap safety test without paying the full ~$8 to plan all 1038 rows. Commit [`3d81871`](https://github.com/kuzyvladimir-maker/ss-control-center/commit/3d81871) added `--account=NAME` to plan + replan, so the safety sequence is:

```bash
# 5 AMZCOM only (~$0.07, ~1 min)
npx tsx scripts/disclaimer-injection-replan.ts <scan> --confirm --account=AMZCOM --limit=5
npx tsx scripts/disclaimer-injection-execute.ts <scan> --apply --batch-size=5 --account=AMZCOM --limit=5

# 5 SALUTEM only (~$0.07, ~1 min)
npx tsx scripts/disclaimer-injection-replan.ts <scan> --confirm --account=SALUTEM --limit=5
npx tsx scripts/disclaimer-injection-execute.ts <scan> --apply --batch-size=5 --account=SALUTEM --limit=5

# Full bulk (~$14 plan + ~50 min execute over 1027 rows)
npx tsx scripts/disclaimer-injection-replan.ts <scan> --confirm
npx tsx scripts/disclaimer-injection-execute.ts <scan> --apply --batch-size=25 --max-error-rate=0.30
```

The cohort-scoped safety lesson is the headline: the spec's literal "full replan → full safety test" path would have spent $14 + ~3 hours on plan rows that were ALL doomed to fail the same way before the disclaimer fix. `--account=AMZCOM --limit=5` short-circuited that for $0.07.

## Bulk-run breakdown (2026-05-19)

Scan `cmpaisoq80000wlfz4llxuo5k`:

| Bucket | Count | % |
|---|---:|---:|
| Completed (PATCHed live) | 1015 | 97.8% |
| Failed at VALIDATION_PREVIEW | 23 | 2.2% |
| **Total planned** | **1038** | **100%** |

By account:

| Account | Completed | Failed | Total |
|---|---:|---:|---:|
| AMZCOM | 39 | 1 | 40 |
| SALUTEM | 976 | 22 | 998 |

Failure breakdown:

| Code | Count | Meaning | Out-of-scope for 2.6.2? |
|---|---:|---|---|
| 99300 | 19 | Claude content still trips PDP classifier on this specific listing | No — prompt-tuning candidate for 2.6.2.1 |
| 100339 | 1 | HTML/JS in attribute we don't touch (`serving_recommendation`, `specialty`) | Yes (pre-existing) |
| 5665 | 1 | "Salutem Vita" brand requires Amazon brand approval | Yes (Brand Registry) |
| 8541 | 1 | UPC/ASIN catalog data conflict | Yes (catalog cleanup) |
| 90197 | 1 | Variant constraint mismatch | Yes |

Only 19 listings (~1.8% of total) need further Claude prompt tuning; the other 4 (~0.4%) are out-of-scope (brand approval, catalog mismatch, HTML in fields the script doesn't touch). Per Vladimir's wiki-notes feedback rule: all original bullets / descriptions / images are preserved on each `ListingRemediation` row → rollback remains possible if needed.

## Cost telemetry

| Item | Per listing | Total |
|---|---:|---:|
| Claude Sonnet 4.5 (planning) | ~1.37¢ avg | **$14.14** |
| SP-API GET + VALIDATION_PREVIEW + PATCH | 0 (free) | $0 |

Cache hit rate was 0% across the bulk replan — the ≤5-min ephemeral cache TTL expired between Claude calls because the serial cadence (~10s/call × 1027 calls = ~3 hr) outran it. Cache caught successfully on the smaller cohort runs where 5 calls completed inside the TTL window. Future runs with parallel workers could capture cache benefits.

## What changed in code

- `src/lib/bundle-factory/remediation/claude-rewrite.ts` — Sonnet 4.5 wrapper
- `src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts` — 22 tests
- `src/lib/bundle-factory/remediation/disclaimer-text.ts` — Variant A wording + multi-substring detection
- `scripts/disclaimer-injection-plan.ts` — `--mode=claude` default, `--account=` cohort filter
- `scripts/disclaimer-injection-replan.ts` — pass-through `--mode` / `--limit` / `--account`
- `scripts/_diag-disclaimer-isolate.ts` — Option C failure proof
- `scripts/_diag-disclaimer-variants.ts` — replacement-wording probe
- `scripts/_inspect-final-state.ts` — post-run breakdown

## Связанные

- [Phase 2.6.1 Disclaimer Injection](phase-2-6-1-disclaimer-injection.md) — parent module / regex-scrub fallback
- [Listing Audit Tool](listing-audit-tool.md) — source of `risk_reasons` that drive remediation
- [Bundle Factory](bundle-factory.md) — root module
- `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md` — isolation-probe analysis
- `docs/CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE.md` — original spec

## Deferred follow-ups

- **Phase 2.6.2.1 (optional):** prompt-tune for the 19 listings whose Claude rewrite still tripped 99300. Inspect their original copy patterns, expand banned-word list in system prompt, re-run failed rows only.
- **Phase 2.6.3:** title rewrite — title still contains foreign brand names ("Cheez-It", "Hamburger Helper" under "Salutem Vita") on a subset of listings. Higher Brand Registry sensitivity.
- **Phase 2.6.4:** image regen — Vision-flagged listings need main image rebuild via image generation API.
- **Brand approval (separate workstream):** the 1 listing failing on 5665 surfaces that "Salutem Vita" brand contributions need Amazon brand approval. Apply via Seller Central → Brand Approval form.
