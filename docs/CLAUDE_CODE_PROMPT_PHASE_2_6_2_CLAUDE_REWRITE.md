# CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE

> **Контекст:** Phase 2.6.1 Smart Scrub отработал технически (5 commits + replan + safety test, 1/5 AMZCOM listings passed after the scrub+disclaimer pipeline). Anchor finding — Amazon's PDP code 99300 fires on subjective/promotional language that's outside any deterministic regex wordlist ("high-quality", "hassle-free", "discover", "experience the ease", etc.). Regex-based scrub will never match Amazon's ML classifier. Phase 2.6.2 swaps the in-plan content transformation from scrub to **Claude rewrite** — generate fresh compliant content from audit metadata + the original copy as reference, instead of trying to sanitise the legacy AMZCOM/SALUTEM template line by line.
>
> **Architecture is the same** as Phase 2.6.1: plan → execute → verify → rollback. The only thing that changes is the content-generation step inside `disclaimer-injection-plan.ts`. Everything downstream (VALIDATION_PREVIEW, real PATCH, error-rate abort, rollback) stays bit-for-bit identical.

---

## TARGET

- **Scan:** `cmpaisoq80000wlfz4llxuo5k` (same as 2.6.0, 2.6.1)
- **Bucket:** every `ListingAuditResult` whose `risk_reasons` contains `"Missing curator/assembler disclaimer"` — 1038 rows on this scan (998 SALUTEM + 40 AMZCOM).
- **Skip:** listings whose existing content already passes Amazon's classifier and contains the disclaimer (rare — most are dirty). The plan script's existing `hasDisclaimerText` skip stays.

---

## DESIGN DECISIONS (locked unless reviewer overrides)

1. **Scope:** bullets + description only. **Title is NOT rewritten** in 2.6.2. Some titles contain foreign brand names (Cheez-It, Hamburger Helper, …) that should be cleaned, but title-rewrite has Brand Registry implications + needs ASIN-by-ASIN review. Defer to Phase 2.6.3.
2. **Model:** Claude Sonnet 4.5 (already in use for vision-check, ANTHROPIC_API_KEY in env). Sonnet > Haiku for compliance-sensitive content; Opus is overkill for a structural rewrite.
3. **Prompt caching:** system prompt + brand-voice rules + audit-metadata schema are cached (one cache write per session, ≤5 min TTL); per-listing user message stays uncached. Cuts cost ~80% on system tokens.
4. **Disclaimer:** still always appended as the last bullet + a final paragraph in description (same constants from `disclaimer-text.ts`). Claude doesn't generate the disclaimer text — we own that.
5. **Smart Scrub kept as defensive filter** on Claude's output. Even if Claude leaks an emoji or "perfect", scrub strips it before we hit SP-API. Belt + suspenders.
6. **Failure modes:**
   - Claude API failure → row stays in `status='plan'`, error logged in `sp_api_error`, scan continues. Re-run picks it up.
   - Claude returns invalid JSON → retry once with a stricter parse hint; on second failure, skip and log.
   - Claude output still triggers Amazon 99300 → caught by execute's existing VALIDATION_PREVIEW guard.

---

## COST PROJECTION

| Item | Per listing | × 1038 |
|---|---:|---:|
| Sonnet 4.5 input | ~1.2k tokens × $3/MTok = $0.0036 | $3.74 |
| Sonnet 4.5 output | ~500 tokens × $15/MTok = $0.0075 | $7.79 |
| Cache write (system prompt, once per session) | — | ~$0.05 |
| Cache reads (~80% of input is cached) | savings ~$2.99 | savings |
| **Net** | **~$0.008** | **~$8.50** |

Budget: under $10 for full Phase 2.6.2 rewrite of all 1038 plan rows. If safety test reveals issues and we replan + re-rewrite, double that ceiling.

---

## STEP 1 — `claude-rewrite.ts` module

Create `src/lib/bundle-factory/remediation/claude-rewrite.ts`.

### Public surface

```typescript
export interface RewriteInput {
  asin: string;
  title: string;
  brand: string;                  // "Salutem Vita" / "Starfit"
  browse_node: string | null;     // Amazon category id
  original_bullets: string[];     // legacy AMZCOM/SALUTEM template
  original_description: string;
}

export interface RewriteOutput {
  bullets: string[];              // 4–9 factual bullets, plain text, no emojis/promo
  description: string;            // plain-text paragraph(s), no HTML
  cost_cents: number;             // measured from Anthropic usage
  cache_hit: boolean;             // true after the first call in a session
  error?: string;                 // if anything went wrong; bullets/description empty
}

export async function rewriteListingContent(input: RewriteInput): Promise<RewriteOutput>;
```

### System prompt (cached)

```
You rewrite Amazon product listings owned by Salutem Solutions LLC into
compliant, factual copy that passes Amazon's Product Detail Page (PDP)
policy classifier (code 99300 — "false/promotional claims or external
links").

HARD RULES (every output bullet + description must satisfy ALL):
1. No emojis or pictograph symbols of any kind.
2. No manual bullet markers (•, ●, ►, ▪, ○, etc.). Amazon renders
   bullets automatically; markers are forbidden.
3. No subjective/promotional adjectives. Banned words include but are
   not limited to: ultimate, perfect, delightful, delicious, ideal,
   amazing, incredible, premium, exclusive, must-have, best, finest,
   exceptional, outstanding, magnificent, wonderful, fantastic,
   superior, top-quality, world-class, awesome, high-quality, optimal,
   hassle-free, expertly, satisfying, experience, discover.
4. No HTML tags anywhere. Use plain text only. Paragraph breaks via
   blank lines.
5. No URLs or links of any kind.
6. No health/medical claims (cure, treat, prevent, boost, weight loss,
   detox, antioxidant, immune, etc.) — these are FDA territory and
   Salutem Vita gift sets are food bundles, not supplements.
7. No first-person CTAs ("order now", "buy today", "we recommend",
   "experience the ease").

WHAT TO INCLUDE (factual content only):
- What's in the box: brand names of contained items, quantities, sizes.
  Mention foreign brand names FACTUALLY (e.g. "Includes 8 Oscar Mayer
  Bun-Length Franks, 14 oz") — this is allowed when stated as inventory.
- Size, weight, packaging type.
- How to store (refrigerated / frozen / shelf-stable).
- How to use (preparation hints, serving suggestions, occasions).
- Compatibility (sandwich bun length, etc.).

OUTPUT FORMAT — return ONLY valid JSON, no preamble, no markdown
fences, no commentary:

{
  "bullets": [
    "Bullet 1 (factual statement)",
    "Bullet 2",
    ...
  ],
  "description": "Plain-text paragraph 1.\n\nPlain-text paragraph 2."
}

BULLET CONSTRAINTS:
- Between 4 and 9 bullets (you must leave at least one slot for the
  caller's appended disclaimer bullet → Amazon's 10-bullet cap).
- Each bullet ≤ 500 characters.
- Capitalised first letter, no trailing period required.

DESCRIPTION CONSTRAINTS:
- 2–4 short paragraphs (≤200 chars each).
- ≤ 2000 characters total.
- Plain text; paragraph break = "\n\n".
```

### User message (per-listing, NOT cached)

```
ASIN: <asin>
Brand: <brand>
Browse node (Amazon category id): <browse_node or "unknown">
Original title (for context only — do NOT rewrite or restate verbatim):
  <title>

Original bullets (for inventory reference — these are policy-violating
and must NOT be reused verbatim):
  - <bullet 1>
  - <bullet 2>
  ...

Original description (for inventory reference only):
  <description>

Generate compliant replacement bullets and description per the rules
above.
```

### Implementation notes

- Use `@anthropic-ai/sdk` (already vendored, used by `vision-check.ts`).
- Use `client.messages.create` with `cache_control: { type: "ephemeral" }` on the system prompt block.
- Model: `"claude-sonnet-4-5"`.
- `max_tokens: 1500` (enough for 9 bullets + 4 paragraphs description).
- Parse `response.content[0].text` as JSON. Strip ` ```json ` fence if present, but the system prompt explicitly forbids fences.
- On JSON parse failure: retry once with a corrective follow-up message ("Your previous response wasn't valid JSON. Return ONLY the JSON object, no fences."). On second failure → return `{ ...empty, error }`.
- Validation:
  - `bullets`: array of strings, length 4–9, each ≤500 chars.
  - `description`: string, ≤2000 chars, no `<` `>` `&lt;` `&gt;`.
  - On validation failure → return error, caller falls back to scrub-only path.

### Cost extraction

```typescript
const inputCost = (usage.input_tokens / 1_000_000) * 3.0;
const cachedInputCost = (usage.cache_read_input_tokens / 1_000_000) * 0.30; // 10× cheaper
const outputCost = (usage.output_tokens / 1_000_000) * 15.0;
const totalUsd = inputCost + cachedInputCost + outputCost;
const cost_cents = Math.ceil(totalUsd * 100);
const cache_hit = (usage.cache_read_input_tokens ?? 0) > 0;
```

---

## STEP 2 — Unit / integration tests

Create `src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts`.

**Live integration test** (gated by `ANTHROPIC_API_KEY`):
- `rewriteListingContent` on a hand-picked fixture (the same B0F794DNK5 Oscar Mayer Bun Length Franks dump from `PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md`).
- Assert:
  - Returned `bullets.length` between 4 and 9.
  - No bullet contains an emoji (use `EMOJI_AND_SYMBOL_REGEX`).
  - No bullet contains any of the banned promo words (case-insensitive).
  - No bullet contains a manual bullet marker.
  - Description ≤ 2000 chars, no HTML tags.
  - `cost_cents > 0` on first call, `cache_hit === false` on first, `=== true` on second.

**Pure-function tests:**
- JSON parsing tolerance (extra whitespace, trailing newline).
- Validation rejects bullet > 500 chars.
- Validation rejects emoji-containing output.
- Validation rejects HTML in description.

Run with:
```bash
set -a; source .env.local; set +a
npx tsx --test src/lib/bundle-factory/remediation/__tests__/claude-rewrite.test.ts
```

---

## STEP 3 — Integrate into plan script

Edit `scripts/disclaimer-injection-plan.ts`:

1. Add import:
   ```typescript
   import { rewriteListingContent } from "@/lib/bundle-factory/remediation/claude-rewrite";
   ```

2. Add CLI flag: `--mode=scrub|claude` (default `claude` for Phase 2.6.2).
   - `mode=scrub` → existing 2.6.1 behaviour
   - `mode=claude` → call Claude, use returned content, scrub-as-safety on output

3. Per-row pipeline in `claude` mode:
   ```typescript
   const rewrite = await rewriteListingContent({
     asin: r.asin,
     title: r.title,
     brand: r.brand,
     browse_node: r.browse_node,
     original_bullets: originalBullets,
     original_description: originalDescription,
   });
   if (rewrite.error) {
     // Log, mark row's sp_api_error, leave status='plan' for retry, skip
     await prisma.listingRemediation.upsert({
       where: { audit_result_id: r.id },
       create: { ...basic, status: 'plan', sp_api_error: rewrite.error, ai_cost_cents: 0 },
       update: { sp_api_error: rewrite.error },
     });
     continue;
   }
   // Defensive scrub on Claude output
   const finalBullets = scrubBulletArray(rewrite.bullets);
   const finalDescription = scrubDescription(rewrite.description);
   // Append disclaimer (last bullet, last paragraph)
   const cappedBullets = finalBullets.slice(0, 9);
   const newBullets = [...cappedBullets, DISCLAIMER_BULLET];
   const newDescription = (finalDescription.trim() + "\n\n" + DISCLAIMER_DESCRIPTION).trim();
   // Upsert with ai_cost_cents = rewrite.cost_cents
   ```

4. Throttle Claude calls: `await sleep(150)` between rows. Anthropic Tier 1 rate limits are generous (50 req/min for Sonnet 4.5) but we want headroom and predictable cost.

5. Progress: log every 25 rows + running cost total.

6. Plan report additions (`PHASE_2_6_1_PLAN_REPORT.md` … but for 2.6.2 maybe rename to `PHASE_2_6_2_PLAN_REPORT.md`):
   - Total Claude cost
   - Failures (Claude API errors, validation rejections) per row
   - Sample 3 ASINs showing original vs Claude-rewritten content

---

## STEP 4 — Replan + safety re-test

```bash
# Re-plan (wipe scrub-era plan rows, regenerate with Claude)
set -a; source .env.local; set +a
npx tsx scripts/disclaimer-injection-replan.ts cmpaisoq80000wlfz4llxuo5k --confirm

# Safety test (5 AMZCOM)
npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=5 --account=AMZCOM --limit=5

# If 5a >= 4/5 success → safety test (5 SALUTEM)
npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=5 --account=SALUTEM --limit=5
```

**Success criterion: 4/5 (80%) per cohort.** Below that → strategy review; Phase 2.6.2 prompt needs tuning (more explicit banned-words list, narrower bullet format examples, etc.).

**ABSOLUTELY DO NOT run full execute autonomously** until both safety tests pass and Vladimir confirms in chat.

---

## STEP 5 — Commits + push

**Branch:** `feat/phase-2-6-2-claude-rewrite`

```
1. feat(remediation): Claude content rewrite module (Sonnet 4.5 + caching)
2. test(remediation): integration tests for claude-rewrite (live API)
3. feat(remediation): plan script --mode=claude (Phase 2.6.2)
4. docs: Phase 2.6.2 spec + plan report after replan
```

Merge to main, push.

---

## STEP 6 — Russian report

After safety test, output:

```
Phase 2.6.2 Claude Rewrite — implementation готово, safety test [PASSED/FAILED]

Replan:
- 1038 plan rows deleted (scrub-era)
- 1038 new rows created с Claude rewrite
- AI cost: $X.XX (avg $0.0XX per listing)
- Cache hit rate after first call: ~95%

Safety re-test:
- AMZCOM ×5: success=X, failed=Y
- SALUTEM ×5: [SKIPPED | success=X, failed=Y]

Sample rewrite (B0F794DNK5):
  ORIGINAL bullet: "• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling"
  CLAUDE bullet:   "Includes 8 Oscar Mayer Bun-Length Franks (14 oz per pack)"

  ORIGINAL description (first 100): "<p>Introducing the ultimate frozen food..."
  CLAUDE description (first 100):    "This gift set includes Oscar Mayer Bun-Length Franks..."

NEXT (нужно approval):
[1] Full AMZCOM execute (40 listings): npx tsx ...
[2] Full SALUTEM execute (998 listings): npx tsx ...
[3] Verify after execute
```

Жди explicit confirmation Vladimir-а перед запуском [1]/[2].

---

## EDGE CASES + SAFETY CHECKLIST

- [ ] Claude API uses prompt caching (system prompt block has `cache_control: {type: 'ephemeral'}`)
- [ ] Defensive scrub on Claude output (regex still strips emojis/promo if Claude slips up)
- [ ] Per-row try/catch — Claude API failure on one row doesn't abort the run
- [ ] Throttle 150ms between Claude calls (50 req/min ceiling on Sonnet 4.5)
- [ ] Validation: bullets length 4–9, ≤500 chars each; description ≤2000 chars, no HTML
- [ ] ai_cost_cents populated on every row for cost tracking
- [ ] Plan report shows cost total + per-listing average + before/after diff samples
- [ ] Safety test gating preserved: 5a AMZCOM first, 5b SALUTEM only if 4/5 AMZCOM passed
- [ ] No automatic full execute — Vladimir approves every step
- [ ] Smart Scrub module from 2.6.1 stays in tree as fallback (`--mode=scrub`)

---

## DEFERRED TO PHASE 2.6.3 (out of scope here)

- Title rewrite (foreign-brand-in-title listings need Brand Registry consideration)
- Image regeneration (Vision-flagged listings need gpt-image-1 main image rebuild)
- BRAND_MISMATCH cohort (listings whose `brand` attribute differs from title)

---

**Status:** SPEC ONLY. Implementation NOT started. Vladimir reviews this prompt; on approval Claude Code executes Steps 1–6 autonomously per the same pattern as Phase 2.6.1.
