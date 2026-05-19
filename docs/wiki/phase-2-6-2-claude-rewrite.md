# 🤖 Phase 2.6.2 — Claude Content Rewrite

> **Started:** 2026-05-19
> **Status:** Implementation COMPLETE · safety re-test **PASSED 10/10** (5/5 AMZCOM + 5/5 SALUTEM) after disclaimer swap to Variant A. **Full execute of remaining ~1028 plan rows is gated behind Vladimir's explicit approval per spec.**
> **Cost so far:** ~$0.35 (~$0.18 first round + ~$0.17 re-test). Full replan still pending — projected ~$8.50 for the remaining 1028 listings at current avg of ~1.7¢/row.
> **Full spec:** `docs/CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE.md`
> **Canonical safety analysis:** `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md`

---

## TL;DR

Generate fresh compliant bullets+description from audit metadata using Claude Sonnet 4.5, then append the curator disclaimer — replacing the in-plan content-generation step of [Phase 2.6.1](phase-2-6-1-disclaimer-injection.md) which only passed 1/5 AMZCOM safety listings (regex scrub can't keep up with Amazon's ML-based PDP classifier on subjective language).

Claude's content is genuinely clean (no emojis, no `perfect`/`ultimate`, no HTML, factual brand-as-inventory phrasing) and the 4-variant isolation probe (`_diag-disclaimer-isolate.ts`) PROVED Claude's bullets+description pass Amazon's classifier on their own. The original 0/6 failure was caused by the **Option C Defensive disclaimer text** — specifically the affiliation/endorsement negation and trademark-property statements. After swapping to the minimal Variant A wording (`870a246`), 10/10 safety listings passed across both cohorts on real PATCH (not just VALIDATION_PREVIEW). Phase 2.6.2 strategy is now end-to-end proven.

## What's in place

| Component | File | Status |
|---|---|---|
| Claude rewrite module | `src/lib/bundle-factory/remediation/claude-rewrite.ts` | ✅ Works, 22 tests green |
| Unit + live-API tests | `src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts` | ✅ |
| `--mode=claude` flag on plan | `scripts/disclaimer-injection-plan.ts` | ✅ default |
| `--mode=scrub` fallback | same file | ✅ |
| Pass-through in replan | `scripts/disclaimer-injection-replan.ts` | ✅ |
| `--account` flag on plan/replan | both | ✅ |

## Architecture

Same plan → execute → verify → rollback pipeline as Phase 2.6.1; only the in-plan content-generation step changes.

```
audit metadata → rewriteListingContent() → validate → scrub (defensive) →
append disclaimer bullet + paragraph → persist as ListingRemediation row
```

`rewriteListingContent` wraps Sonnet 4.5 with prompt caching on the system block (~80% input cost reduction after first call), one corrective retry on JSON parse failure, validation rejecting emoji / HTML / markers / over-length, and cost/cache_hit telemetry.

## Safety test verdict (2026-05-19)

- AMZCOM 5/5 rejected by Amazon PDP code 99300 at VALIDATION_PREVIEW. Zero live listings modified (guard worked).
- SALUTEM full cohort not run per the 4/5 safety gate; 1-listing cross-account probe also rejected.
- Disclaimer-isolation probe (4 variants on same ASIN) revealed: Claude content alone → VALID; Claude + disclaimer → INVALID on whichever attribute carries the disclaimer.
- See `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md` for the full probe table + 5 strategy options for Vladimir.

## Cohort-scoped safety lesson

The spec's literal "full replan first, then safety test" path would have cost $8.50 + ~3 hours and would have produced 1037 plan rows that were ALL doomed to fail the same way. The `--account=AMZCOM --limit=5` short-circuit caught the failure for $0.06. Pattern worth keeping for future Claude-based remediation phases.

## Связанные

- [Listing Audit Tool](listing-audit-tool.md) — где формируются `risk_reasons`
- [Phase 2.6.1 Disclaimer Injection](phase-2-6-1-disclaimer-injection.md) — родительский pipeline, scrub-mode fallback
- [Bundle Factory](bundle-factory.md) — родительский модуль
- `docs/PHASE_2_6_2_SAFETY_TEST_REPORT.md` — изоляционная проба (4 варианта), root cause = disclaimer, 5 опций на выбор
- `docs/CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE.md` — оригинальный спек (для истории)
