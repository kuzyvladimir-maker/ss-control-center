# CLAUDE_CODE_PROMPT_PHASE_2_6_1_CONTENT_SCRUB

> **Контекст (откуда задача):**
> Safety test 2026-05-19 на AMZCOM ×10 показал 10/10 VALIDATION_PREVIEW failure с Amazon code 99300. Discovery (`docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md`) выявил template AI-generation fingerprint в legacy content: emojis (✅🍽🎁💚🧊), manual `•` bullet characters, promotional adjectives, HTML в description. Disclaimer сам по себе чистый — но PATCH replaces полный массив и Amazon валидирует все элементы целиком.
>
> Решение: добавить **Smart Scrub stage** в plan script. Чистим existing content **до** добавления disclaimer-а, тогда финальный PATCH passes Amazon's PDP classifier.

---

## TARGET

- **Scan:** `cmpaisoq80000wlfz4llxuo5k`
- **Existing plan rows:** 1038 (status='plan'), 10 (status='failed' после safety test)
- **Action:** удалить старые plan/failed rows, создать новые plan rows с очищенным content + disclaimer

---

## STEP 1 — Extended discovery: проверить SALUTEM patterns

Перед implement-ом scrub нужно подтвердить что SALUTEM (998 листингов, главный аккаунт) имеет такой же template или отличается. Если SALUTEM clean — scrub применяется только к AMZCOM. Если же template одинаковый — universal scrub.

Расширь существующий `scripts/inspect-failed-content.ts` ИЛИ создай `scripts/inspect-salutem-samples.ts`:

1. Query ListingAuditResult JOIN ListingRemediation WHERE
   - scan_id = 'cmpaisoq80000wlfz4llxuo5k'
   - account = 'SALUTEM'
   - status = 'plan'
   - LIMIT 5 (взять 5 разных listings для representative sample)
   - Используй `ORDER BY RANDOM()` или взять spaced indices (every Nth) чтобы получить разнообразные samples

2. Для каждой row вывести full original_bullets + original_description + heuristic analysis (тот же что и для AMZCOM).

3. Append результат в существующий `docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md` под секцию **"SECTION B — SALUTEM samples (for comparison)"**.

4. В конце документа добавить **"VERDICT"** секцию:
   - **Verdict A:** "SALUTEM has same template as AMZCOM (emojis + manual bullets + promo + HTML) — apply universal scrub to all 1038 listings."
   - **Verdict B:** "SALUTEM is clean — apply scrub ONLY to AMZCOM cohort (40 listings)."
   - **Verdict C:** "SALUTEM has different non-compliant pattern — may need different scrub rules."

5. Claude Code сам делает verdict на основе heuristic counts. Не спрашивает Vladimir-а.

**Vladimir-ам важно:** результат discovery сохраняется в file → Claude Code продолжает работу с правильным verdict.

---

## STEP 2 — Smart Scrub module

Создать `src/lib/bundle-factory/remediation/content-scrub.ts`:

```typescript
/**
 * Phase 2.6.1 — Smart Scrub for legacy AI-generated content.
 *
 * Amazon's modern PDP classifier rejects content with:
 *   • emojis (most unicode symbols)
 *   • manual bullet characters (•, ●, ►, etc.)
 *   • subjective/promotional adjectives
 *   • HTML tags in product_description (for grocery/food types)
 *
 * This module deterministically normalizes existing bullets and
 * description text to plain-text factual form, suitable for SP-API
 * PATCH that passes VALIDATION_PREVIEW.
 *
 * No AI, no external calls, $0 cost.
 */

// All emojis and most non-text symbols
const EMOJI_AND_SYMBOL_REGEX = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}]/gu;

// Manual bullet/list markers at start of lines or sentences
const MANUAL_BULLET_REGEX = /(?:^|\n)\s*[•●►▪○▶➤→\-\*]+\s*/g;

// Promotional adjectives — strip together with one trailing space
const PROMO_WORDS = [
  "ultimate", "perfect", "delightful", "delicious", "ideal",
  "amazing", "incredible", "premium", "exclusive", "must-have",
  "best", "finest", "exceptional", "outstanding", "magnificent",
  "wonderful", "fantastic", "superior", "top-quality", "world-class",
];
const PROMO_WORDS_REGEX = new RegExp(
  `\\b(?:${PROMO_WORDS.join("|")})\\s+`,
  "gi"
);

// HTML tags
const HTML_TAG_REGEX = /<\/?[a-zA-Z][^>]*>/g;

export interface ScrubResult {
  scrubbed: string;
  changesApplied: {
    emojiCount: number;
    manualBulletCount: number;
    promoWordCount: number;
    htmlTagCount: number;
  };
}

/**
 * Scrub a single bullet point string. May expand into multiple bullets
 * if the input contains newline-separated micro-bullets.
 */
export function scrubBullet(input: string): string[] {
  if (!input || typeof input !== "string") return [];

  // Split multi-line bullet entries into separate bullets
  const lines = input.split(/\n+/).map((line) => line.trim()).filter(Boolean);

  const cleaned = lines.map((line) => {
    let text = line;
    // Strip manual bullet chars
    text = text.replace(MANUAL_BULLET_REGEX, " ");
    // Strip emojis
    text = text.replace(EMOJI_AND_SYMBOL_REGEX, "");
    // Strip promo adjectives (and the space after)
    text = text.replace(PROMO_WORDS_REGEX, "");
    // Normalize whitespace
    text = text.replace(/\s+/g, " ").trim();
    // Capitalize first letter if it became lowercase after promo strip
    if (text.length > 0) {
      text = text.charAt(0).toUpperCase() + text.slice(1);
    }
    return text;
  });

  // Filter out empty bullets (those that became empty after scrub)
  // Also filter ones that are too short to be meaningful (< 8 chars)
  return cleaned.filter((line) => line.length >= 8);
}

/**
 * Scrub a description string. Strips HTML and converts to plain text
 * with proper paragraph breaks.
 */
export function scrubDescription(input: string): string {
  if (!input || typeof input !== "string") return "";

  let text = input;

  // Convert <p> open tags to nothing, close tags to double newline
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p[^>]*>/gi, "");

  // Convert <li> open to "- " prefix, close to newline
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<\/li>/gi, "\n");

  // Strip <ul>, <ol> tags
  text = text.replace(/<\/?ul[^>]*>/gi, "\n");
  text = text.replace(/<\/?ol[^>]*>/gi, "\n");

  // Convert <br> to single newline
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Strip all remaining HTML tags
  text = text.replace(HTML_TAG_REGEX, "");

  // Strip emojis
  text = text.replace(EMOJI_AND_SYMBOL_REGEX, "");

  // Strip promo words
  text = text.replace(PROMO_WORDS_REGEX, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Normalize whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Apply scrub to a list of bullets and return the new array.
 * May return more bullets than input (if multi-line entries split).
 */
export function scrubBulletArray(bullets: string[]): string[] {
  const result: string[] = [];
  for (const bullet of bullets) {
    const scrubbed = scrubBullet(bullet);
    result.push(...scrubbed);
  }
  return result;
}
```

**Unit tests:** создать `src/lib/bundle-factory/remediation/__tests__/content-scrub.test.ts` с тестовыми кейсами на real AMZCOM examples (взять из failed listings):

- Input: `"• ✅ Includes 8 Oscar Mayer Bun Length Franks for perfect grilling \n•  🍽️ Ideal for family barbecues and gatherings"`
- Expected output: `["Includes 8 Oscar Mayer Bun Length Franks for grilling", "Ideal for family barbecues and gatherings"]`

Минимум 5-6 test cases покрывающих все 4 категории scrub.

---

## STEP 3 — Modify plan script

Edit `scripts/disclaimer-injection-plan.ts`:

1. Import `scrubBulletArray` + `scrubDescription` из `content-scrub.ts`.

2. **Логика scrub применяется conditionally** на основе VERDICT из Step 1:

   ```typescript
   // VERDICT loaded from constant or env var; if VERDICT_A → apply to all,
   // if VERDICT_B → apply only when row.account === 'AMZCOM'
   const SCRUB_VERDICT: 'A' | 'B' | 'C' = 'A'; // или подгружать из docs
   
   function shouldScrub(row: ListingAuditResult): boolean {
     if (SCRUB_VERDICT === 'A') return true;
     if (SCRUB_VERDICT === 'B') return row.account === 'AMZCOM';
     if (SCRUB_VERDICT === 'C') {
       // case-by-case, default to skip
       return false;
     }
     return false;
   }
   ```

3. В loop по rows, перед computing new_bullets:

   ```typescript
   const rawOriginalBullets = JSON.parse(row.original_bullets || "[]");
   const cleanedOriginalBullets = shouldScrub(row)
     ? scrubBulletArray(rawOriginalBullets)
     : rawOriginalBullets;
   const new_bullets = [...cleanedOriginalBullets, DISCLAIMER_BULLET];
   
   const rawOriginalDescription = row.original_description || "";
   const cleanedOriginalDescription = shouldScrub(row)
     ? scrubDescription(rawOriginalDescription)
     : rawOriginalDescription;
   const new_description = cleanedOriginalDescription.length > 0
     ? cleanedOriginalDescription.trim() + "\n\n" + DISCLAIMER_DESCRIPTION
     : DISCLAIMER_DESCRIPTION;
   ```

4. В `ListingRemediation`-row, сохрани BOTH:
   - `original_bullets` (raw original, для rollback)
   - `new_bullets` (scrubbed + disclaimer)
   - `original_description` (raw, для rollback)
   - `new_description` (scrubbed + disclaimer)

   В sp_api_response добавить metadata о scrub: `JSON.stringify({ scrub_applied: shouldScrub(row), scrub_verdict: SCRUB_VERDICT })` — для traceability.

5. В output добавь:
   - Сколько rows получили scrub
   - Sample diff (existing vs new) для 2 ASIN-ов

---

## STEP 4 — Re-plan (drop existing rows, re-create)

Создать `scripts/disclaimer-injection-replan.ts`:

**Args:** `<scan_id>`

1. WARN message: "This will delete all existing ListingRemediation rows for scan=X (status=plan, failed). Original audit data preserved. Continue? Pass --confirm flag."

2. С `--confirm`:
   - DELETE FROM ListingRemediation WHERE audit_result_id IN (SELECT id FROM ListingAuditResult WHERE scan_id=X) AND status IN ('plan', 'failed')
   - Reset ListingAuditResult.remediation_status='PENDING' для тех rows
   - Затем вызвать ту же логику что и в plan.ts (с новым scrub-enabled путём)

3. Output: "Replanned N rows with smart scrub applied."

---

## STEP 5 — Re-test safety на 5 AMZCOM + 5 SALUTEM

После re-plan'а выполнить **два** safety test'а:

### 5a. AMZCOM safety test (5 листингов)

```bash
set -a; source .env; set +a
npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=5 --account=AMZCOM --limit=5
```

Output: success/failed counts + 5 ASIN-ов с status.

### 5b. SALUTEM safety test (5 листингов)

**Только если 5a passed.** Если 5a failed → STOP и report.

```bash
npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=5 --account=SALUTEM --limit=5
```

Output: success/failed counts + 5 ASIN-ов с status.

---

## STEP 6 — Commit + push

**Branch:** `feat/phase-2-6-1-content-scrub`

**Commits:**

1. `feat(remediation): smart scrub module (emojis, manual bullets, promo words, HTML)`
2. `test(remediation): unit tests for scrub algorithms`
3. `feat(remediation): SALUTEM samples discovery extension`
4. `feat(remediation): integrate scrub into plan script + replan script`
5. `docs: PHASE_2_6_1_FAILED_CONTENT_ANALYSIS update with SALUTEM samples + scrub verdict`

Merge в main, push.

---

## STEP 7 — Russian report Vladimir-у

После всех шагов output:

```
✅ Phase 2.6.1 Smart Scrub — implementation + re-plan + safety re-test готово

Discovery extension:
- SALUTEM samples analyzed: 5 listings
- VERDICT: [A/B/C] — [объяснение]
- Updated docs/PHASE_2_6_1_FAILED_CONTENT_ANALYSIS.md

Re-plan:
- Deleted N old ListingRemediation rows (status=plan/failed)
- Created M new rows with smart scrub applied
- Per-account: SALUTEM=X, AMZCOM=Y
- Per-strategy: scrub applied to Z listings, skipped on W (already clean)

Safety re-test results:
- AMZCOM ×5: success=X, failed=Y
  - Failed ASINs (if any): [list with error message]
- SALUTEM ×5: success=X, failed=Y (или "SKIPPED: AMZCOM test failed")
  - Failed ASINs (if any): [list with error message]

Sample scrub diff (для transparency):
  Original bullet:    "• ✅ Includes 8 Oscar Mayer ..."
  Scrubbed bullet:    "Includes 8 Oscar Mayer ..."
  Original description (first 100 chars): "<p>Introducing the ultimate ..."
  Scrubbed description (first 100 chars):  "Introducing the frozen food ..."

NEXT actions (Vladimir approves):
[1] If both safety tests passed → запустить full AMZCOM (remaining 35):
    npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=10 --account=AMZCOM

[2] After AMZCOM full → запустить SALUTEM (998 listings):
    npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=25 --account=SALUTEM

[3] Final verify:
    npx tsx scripts/disclaimer-injection-verify.ts cmpaisoq80000wlfz4llxuo5k

If safety tests failed → НЕ запускать [1]/[2]. Show errors, Claude в чате 
разберёт patterns и решит next strategy (e.g. tighten scrub, fall back to 
Claude rewrite Phase 2.6.2).
```

**Жди explicit confirmation от Vladimir-а перед запуском [1]/[2].**

---

## SAFETY CHECKLIST

- [ ] Scrub module pure deterministic, no external calls, unit-tested
- [ ] Replan script requires `--confirm` flag
- [ ] Old `ListingRemediation` rows deleted only after successful re-plan
- [ ] Original content preserved в new rows для rollback
- [ ] Safety re-test gates SALUTEM behind AMZCOM success
- [ ] Wiki updated если меняем architecture pattern (no — same pipeline, just better content)

---

## EDGE CASES

1. **Scrub оставляет bullet короче 8 chars** → filter out (`scrubBullet` уже делает это).

2. **Scrub оставляет полностью пустой bullets array** → не должно случиться (disclaimer всегда добавляется), но safety: если после scrub + disclaimer remained < 3 bullets, log warning. Amazon usually allows 1-5 bullets, минимум 1 точно ок.

3. **Description полностью пустой после scrub** → disclaimer paragraph один заполнит description. OK.

4. **Bullet содержит full URL** → scrub НЕ убирает URLs. Если они там есть — Amazon отвергнет. Возможно нужно добавить URL stripping. Discovery показал URLs=0 для AMZCOM, но проверь SALUTEM.

5. **Title всё ещё содержит foreign brand** (Cheez-It, Hamburger Helper, etc.) → Phase 2.6.1 НЕ меняет title. Эти листинги останутся BLOCKED по title даже после disclaimer injection. Это OK — title rewrite это Phase 2.6.2 отдельно.

6. **Original bullets уже clean (без emojis/promo)** → scrub no-op, output identical to input. OK.

---

## END OF PROMPT

Если что-то непонятно — НЕ guess. Спроси в чате.
