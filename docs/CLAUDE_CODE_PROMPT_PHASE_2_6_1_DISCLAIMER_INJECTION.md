# CLAUDE_CODE_PROMPT_PHASE_2_6_1_DISCLAIMER_INJECTION

> **Бэкграунд (зачем эта фаза):**
> Audit scan `cmpaisoq80000wlfz4llxuo5k` (1585 listings, 99.9% vision coverage) показал что **51%+ всех листингов** имеют reason `Missing curator/assembler disclaimer` — самая частая проблема, формирующая основной operational risk после 2026-05-17 incident (RETAILER Distributor ban за Trademark Logo Misuse).
>
> Phase 2.6.1 = bulk text injection через SP-API PATCH. Без AI, без $$$, без image regeneration. Самая дешёвая фаза remediation pipeline с самым большим compliance impact. После завершения целая категория incident-risk-а закроется.
>
> Архитектурно это **первый working scenario из 7-stage remediation skeleton**, уже spec'нутого в `src/lib/bundle-factory/audit/remediation.ts` (Phase 2.0a). Дальше будут Phase 2.6.2 (Title rewrite), 2.6.3 (Image regen), 2.6.4 (Manual review).

---

## TARGET

- **Scan:** `cmpaisoq80000wlfz4llxuo5k` (02:52 scan, 1584/1585 vision coverage)
- **Buckets:** ВСЕ листинги где `risk_reasons` содержит `"Missing curator/assembler disclaimer"` — это покрывает и `DISCLAIMER_ONLY`, и `MULTI` (где disclaimer + другие issues). Добавление disclaimer-а independent от других fixes, можно делать вместе.
- **Skip:** листинги где disclaimer уже присутствует (substring check в существующих bullets/description), листинги без `original_bullets` (нечего патчить).

---

## DISCLAIMER TEXT (Option C — Defensive, approved by Vladimir 2026-05-19)

### Bullet (один дополнительный bullet добавляется к существующим)

```
Curated and packaged by Salutem Solutions LLC as a gift basket assembly. This is not a manufacturer's product; individual items are sourced from authorized retailers and assembled for buyer convenience.
```

### Description paragraph (добавляется в конец существующего description с двумя переносами)

```
About this gift basket: This product is a curated assembly created by Salutem Solutions LLC, a third-party curator. Salutem Solutions LLC is not affiliated with, sponsored by, or endorsed by any of the brands included in this collection. Each item is independently sourced from authorized retailers and assembled into this gift basket for buyer convenience. All trademarks, brand names, logos, and packaging visible in the product images are the property of their respective owners. This product is intended as a gift basket; included items are not modified, repackaged into branded materials, or altered in any way.
```

---

## АРХИТЕКТУРА (4 скрипта, 3 mode-а)

| Скрипт | Mode | Что делает | Trogает SP-API? |
|---|---|---|---|
| `disclaimer-injection-plan.ts` | DRY RUN | Identifies target listings → создаёт `ListingRemediation` rows со `status='plan'` → output sample 3 ASIN + total count | НЕТ |
| `disclaimer-injection-execute.ts` | APPLY | Reads 'plan' rows → batch SP-API PATCH с rate limit + retry → updates status | ДА (только с `--apply`) |
| `disclaimer-injection-verify.ts` | VERIFY | GETs each patched listing → confirms disclaimer text present → marks status | ДА (read-only) |
| `disclaimer-injection-rollback.ts` | ROLLBACK | Reverses patches — восстанавливает original bullets/description | ДА (только с `--apply`) |

---

## STEP 1 — Constants module

Создать `src/lib/bundle-factory/remediation/disclaimer-text.ts`:

```typescript
/**
 * Phase 2.6.1 — Disclaimer text constants for bulk injection.
 *
 * Option C (Defensive) selected by Vladimir on 2026-05-19 after the
 * 2026-05-17 Retailer Distributor ban for Trademark Logo Misuse.
 * Aligns with Amazon Gift Basket Exception (node 12011207011) positioning
 * and the NO-LOA compliance strategy in
 * BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md.
 */

export const DISCLAIMER_BULLET =
  "Curated and packaged by Salutem Solutions LLC as a gift basket assembly. " +
  "This is not a manufacturer's product; individual items are sourced from " +
  "authorized retailers and assembled for buyer convenience.";

export const DISCLAIMER_DESCRIPTION =
  "About this gift basket: This product is a curated assembly created by " +
  "Salutem Solutions LLC, a third-party curator. Salutem Solutions LLC is " +
  "not affiliated with, sponsored by, or endorsed by any of the brands " +
  "included in this collection. Each item is independently sourced from " +
  "authorized retailers and assembled into this gift basket for buyer " +
  "convenience. All trademarks, brand names, logos, and packaging visible " +
  "in the product images are the property of their respective owners. " +
  "This product is intended as a gift basket; included items are not " +
  "modified, repackaged into branded materials, or altered in any way.";

/**
 * Used by plan + verify scripts to detect whether a listing already has
 * the disclaimer. Robust substring check on the first ~60 chars of the
 * bullet, case-insensitive.
 */
export const DISCLAIMER_DETECTION_SUBSTRING = "curated and packaged by salutem solutions";
```

Создать parent папку `src/lib/bundle-factory/remediation/` если её ещё нет (Phase 2.6.0 могла её не создать).

---

## STEP 2 — Plan script (DRY RUN, никаких SP-API вызовов)

Создать `scripts/disclaimer-injection-plan.ts`:

**Args:** `<scan_id>` (required)

**Логика:**

1. Load env (`dotenv/config` или `set -a; source .env; set +a` — используй pattern уже existing `run-audit-cli.ts`).

2. Use existing Prisma client из `src/lib/prisma.ts` (auto-connects к Turso когда `TURSO_*` env vars present).

3. `findUniqueOrThrow` `ListingAuditScan` по `scan_id`, validate `status === 'completed'`.

4. Query все `ListingAuditResult` для этого scan WHERE:
   - `risk_reasons` содержит substring `"Missing curator/assembler disclaimer"` (используй SQL LIKE или filter в memory после fetch — risk_reasons JSON string)
   - `remediation_status === 'PENDING'` (skip already-planned/done)
   - `original_bullets` не пустой и не `"[]"`

5. Для каждой row рассчитать `new_bullets` и `new_description`:
   - Parse `original_bullets` (stored как JSON array of strings)
   - Check: содержит ли любая существующая bullet substring `DISCLAIMER_DETECTION_SUBSTRING` (case-insensitive)? Если да → пометить эту row как `already_compliant`, **не** создавать remediation row, увеличить counter `already_compliant_count`.
   - Иначе: `new_bullets = [...original_bullets, DISCLAIMER_BULLET]`
   - Аналогичная проверка для `original_description`: если содержит `DISCLAIMER_DETECTION_SUBSTRING` → keep original.
   - Иначе: `new_description = original_description.trim() + "\n\n" + DISCLAIMER_DESCRIPTION` (если description пустой — просто `DISCLAIMER_DESCRIPTION`).

6. Внутри одной Prisma transaction:
   - Для каждой row upsert `ListingRemediation`:
     ```typescript
     {
       audit_result_id: row.id,
       status: 'plan',
       original_title: row.title,
       new_title: null, // не меняем title в Phase 2.6.1
       original_bullets: row.original_bullets, // raw JSON string
       new_bullets: JSON.stringify(new_bullets),
       original_description: row.original_description,
       new_description: new_description,
       original_image_url: row.main_image_url,
       new_image_url: null,
       ai_cost_cents: 0,
       sp_api_response: null,
       sp_api_error: null,
     }
     ```
   - Обновить `ListingAuditResult.remediation_status = 'PLANNED'`

7. Output (stdout + сохранить в `docs/PHASE_2_6_1_PLAN_REPORT.md`):
   - Total identified for scan: N
   - Already compliant (skipped): M
   - **Planned for remediation: N − M**
   - Breakdown by account (SALUTEM, AMZCOM)
   - Sample 3 ASINs с:
     - asin, title (truncated to 80 chars)
     - `original_bullets` (first 200 chars)
     - `new_bullets` (last 2 bullets — original last + disclaimer)
     - `original_description` (first 200 chars)
     - `new_description` (last 250 chars — disclaimer paragraph appended)
   - Final command для следующего шага:
     ```
     npx tsx scripts/disclaimer-injection-execute.ts <scan_id> --apply --batch-size=10
     ```

**ВАЖНО:** этот скрипт **никогда** не делает SP-API вызовы. Только DB writes.

---

## STEP 3 — Execute script (APPLY, делает реальные SP-API PATCH calls)

Создать `scripts/disclaimer-injection-execute.ts`:

**Args:**
- `<scan_id>` (required)
- `--apply` (REQUIRED для реального PATCH; без флага = dry-run echo)
- `--batch-size=N` (default: 10)
- `--max-error-rate=0.10` (stop если 10%+ errors в любом batch)
- `--account=SALUTEM|AMZCOM` (опционально, run только один account at a time)
- `--limit=N` (опционально, only first N rows для testing)
- `--sleep-ms=250` (опционально, sleep между request-ами, default 250ms = 4 req/sec)

**Логика:**

1. Load env. Sanity-check что `AMAZON_SP_CLIENT_ID_STORE{N}`, `AMAZON_SP_CLIENT_SECRET_STORE{N}`, `AMAZON_SP_REFRESH_TOKEN_STORE{N}` env vars present for каждого account, который будем patch-ить.

2. Query `ListingRemediation` WHERE:
   - JOIN `ListingAuditResult.scan_id = <scan_id>`
   - `status === 'plan'`
   - (опционально account filter через JOIN)
   - ORDER BY `audit_result_id` ASC
   - LIMIT (опционально)

3. **Без `--apply`:** print `"Would patch N listings. Re-run with --apply to execute."` Exit 0. Никаких SP-API вызовов.

4. **С `--apply`:**

   a. Group by account (SALUTEM uses STORE1 credentials, AMZCOM uses STORE3 credentials). Используй existing `src/lib/bundle-factory/audit/account-map.ts` mapping.
   
   b. Для каждого account, process в batches `--batch-size`. Rate limit: `--sleep-ms` между request-ами (default 250ms = 4 req/sec). SP-API Listings API allows ~5 req/sec, оставляем headroom.
   
   c. Для каждой remediation:
   
   - Update `status='in_progress'`, `started_at=now()`.
   
   - Build PATCH body (Amazon Listings Items API JSON Patch format):
     ```typescript
     {
       productType: "PRODUCT", // generic fallback
       patches: [
         {
           op: "replace",
           path: "/attributes/bullet_point",
           value: newBullets.map((bp) => ({
             value: bp,
             language_tag: "en_US",
             marketplace_id: "ATVPDKIKX0DER",
           })),
         },
         {
           op: "replace",
           path: "/attributes/product_description",
           value: [
             {
               value: newDescription,
               language_tag: "en_US",
               marketplace_id: "ATVPDKIKX0DER",
             },
           ],
         },
       ],
     }
     ```
     
     **Note про productType:** Amazon технически требует productType matching существующий type листинга. Если используем generic `"PRODUCT"` и Amazon отверг — нужно сначала GET listing → extract `summaries[0].productType` → use that. Можно сразу сделать это в helper: получить productType из API call'а до PATCH.
     
     **Альтернатива (safer):** Перед PATCH делаем GET listing с `includedData=summaries` → достаём `productType` → используем его. Это +1 SP-API call per listing, но 100% точность.
     
     **Решение:** делаем GET first для productType. Rate-budget OK.
   
   - PATCH с `mode=VALIDATION_PREVIEW` first:
     ```
     PATCH /listings/2021-08-01/items/{sellerId}/{sku}
       ?marketplaceIds=ATVPDKIKX0DER
       &mode=VALIDATION_PREVIEW
     ```
     Если validation fails → log error, status='failed', skip real PATCH.
   
   - Real PATCH (без `mode=VALIDATION_PREVIEW`).
   
   - **On success:**
     - `status='completed'`
     - `sp_api_response = JSON.stringify(response)`
     - `completed_at = now()`
     - Update `ListingAuditResult.remediation_status = 'DONE'`
   
   - **On error:**
     - 429: wait per `Retry-After` header, retry до 3 раз
     - 4xx/5xx other: `status='failed'`, `sp_api_error = error.message + " (HTTP " + status + ")"`
     - Update `ListingAuditResult.remediation_status = 'FAILED'`
   
   d. После каждого batch:
   - Log progress: `"Batch N/M done · success=X · failed=Y · skipped=Z · ETA=..."`
   - Pause 2 секунды
   - Если `error_rate_in_this_batch > max_error_rate` → **ABORT** с clear message:
     ```
     STOP: Error rate {actualRate}% exceeds threshold {maxRate}%.
     Last 3 errors:
       1. [ASIN] — [error message]
       2. [ASIN] — [error message]
       3. [ASIN] — [error message]
     
     To investigate: review ListingRemediation rows where status='failed'.
     To resume after fix: npx tsx scripts/disclaimer-injection-execute.ts <scan_id> --apply --batch-size=10
     ```

5. **Final summary:**
   - Total processed
   - Successfully patched: N
   - Failed: M (с top 5 error messages by frequency)
   - Skipped/already compliant: K
   - Total time elapsed
   - Per-account breakdown
   - Total SP-API calls made (GET + PATCH)

---

## STEP 4 — Verify script

Создать `scripts/disclaimer-injection-verify.ts`:

**Args:**
- `<scan_id>` (required)
- `--limit=N` (опционально)

**Логика:**

1. Query `ListingRemediation` WHERE `status='completed'` для этого scan.

2. Для каждой row:
   - GET `/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=ATVPDKIKX0DER&includedData=attributes`
   - Parse response, extract `attributes.bullet_point[]` и `attributes.product_description[]`
   - Check: содержит ли `DISCLAIMER_DETECTION_SUBSTRING` (case-insensitive) в любом bullet OR в description?
   - Если **YES**: keep `status='completed'`, update `verified_at = now()` (используй существующее `updated_at` поле или добавь миграцией поле `verified_at` если хочется precision).
   - Если **NO**: mark `status='verification_failed'`, log warning. Это значит PATCH succeeded но Amazon's listing builder возможно overrode content (rare но happens).

3. Output:
   - Total verified successfully: N
   - Verification failed (PATCH succeeded но disclaimer отсутствует): M
   - List of M ASINs для manual review (если M > 0)

**Rate limit:** 4 req/sec (same as execute).

---

## STEP 5 — Rollback script

Создать `scripts/disclaimer-injection-rollback.ts`:

**Args:**
- `<scan_id>` (required)
- `--apply` (REQUIRED для real rollback)
- `--status=completed|failed|all` (default: all)
- `--account=SALUTEM|AMZCOM` (опционально)
- `--limit=N` (опционально)

**Логика:**

1. Query `ListingRemediation` matching filters.

2. Для каждой row: PATCH с `original_bullets` + `original_description` (восстановить как было до Phase 2.6.1):
   ```typescript
   {
     productType: <fetched via GET>,
     patches: [
       {
         op: "replace",
         path: "/attributes/bullet_point",
         value: JSON.parse(original_bullets).map(bp => ({
           value: bp, language_tag: "en_US", marketplace_id: "ATVPDKIKX0DER"
         })),
       },
       {
         op: "replace",
         path: "/attributes/product_description",
         value: [{
           value: original_description,
           language_tag: "en_US",
           marketplace_id: "ATVPDKIKX0DER",
         }],
       },
     ],
   }
   ```

3. On success:
   - `status='rolled_back'`
   - `sp_api_response` дописывается с rollback marker (`"ROLLBACK at <timestamp>: " + response`)
   - Update `ListingAuditResult.remediation_status = 'PENDING'` — чтобы можно было re-plan.

4. Output: total rolled back, per-account breakdown.

---

## STEP 6 — Spec doc + wiki update

Сохранить полный spec в `docs/BUNDLE_FACTORY_PHASE_2_6_1_DISCLAIMER_INJECTION.md`:
- Goal, target scan, target buckets
- Disclaimer text (Option C — and reasoning)
- Pipeline diagram (text-based)
- SP-API PATCH request examples (real JSON)
- Safety mechanisms
- Rollback procedure
- Outline Phase 2.6.2 (Title Rewrite), 2.6.3 (Image Regen), 2.6.4 (Manual Review)

Обновить wiki **обязательно** (per Vladimir's mandatory rule):
- `docs/wiki/phase-2-6-1-disclaimer-injection.md` — short page с linking к main spec
- `docs/wiki/CONNECTIONS.md` — добавить `Phase 2.6.1 ← Phase 2.0a audit`, `Phase 2.6.1 → SP-API Listings API`, `Phase 2.6.1 ⊂ Phase 2.6 Remediation`
- `docs/wiki/index.md` — добавить entry для Phase 2.6.1

---

## STEP 7 — Commit + push

**Branch:** `feat/phase-2-6-1-disclaimer-injection`

**Commits (логические единицы):**

1. `feat(remediation): disclaimer text constants module (Option C defensive)`
2. `feat(remediation): plan script (dry-run identification)`
3. `feat(remediation): execute script (batch SP-API PATCH with safety)`
4. `feat(remediation): verify script (post-patch validation)`
5. `feat(remediation): rollback script`
6. `docs: Phase 2.6.1 Disclaimer Injection spec + wiki`

Merge в main, push, Vercel auto-deploys.

---

## STEP 8 — Final action: run plan, NOT execute

**После всего commit'а:**

1. Run:
   ```bash
   set -a; source .env; set +a
   npx tsx scripts/disclaimer-injection-plan.ts cmpaisoq80000wlfz4llxuo5k
   ```

2. Это DRY RUN. Никаких SP-API вызовов. Создаст `ListingRemediation` rows со `status='plan'`.

3. **НЕ запускай execute step автоматически.** Вместо этого — output полный отчёт Vladimir-у (см. Step 9) и **жди explicit approval**.

---

## STEP 9 — Russian report для Vladimir

После завершения plan-этапа output по-русски:

```
✅ Phase 2.6.1 — Bulk Disclaimer Injection (этап PLAN завершён)

Создан plan для bulk injection disclaimer-а в bullets + description через 
SP-API PATCH. SP-API НЕ trogались — это dry run.

Цифры:
- Total identified в scan: [N]
- Already compliant (disclaimer уже есть): [M]
- Planned to patch: [N − M]
  - SALUTEM: [X]
  - AMZCOM: [Y]

Sample 3 листинга (что именно будет запатчено):

[ASIN1] — [title]
  Existing bullets (last 200 chars): "..."
  After patch — new last bullet: "[disclaimer text]"
  Existing description (last 200 chars): "..."
  After patch — appended paragraph: "[disclaimer paragraph]"

[ASIN2] ...
[ASIN3] ...

Spec: docs/BUNDLE_FACTORY_PHASE_2_6_1_DISCLAIMER_INJECTION.md
План в БД: ListingRemediation rows со status='plan' создано [N − M] штук
Wiki: обновлено (3 файла)

NEXT — нужно твоё approval:

[1] Запустить execute на 10 листингов первым batch'ем (safety test):
    npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=10 --limit=10

[2] После проверки 10 успешных → запустить full execute:
    npx tsx scripts/disclaimer-injection-execute.ts cmpaisoq80000wlfz4llxuo5k --apply --batch-size=25

[3] Verify после execute:
    npx tsx scripts/disclaimer-injection-verify.ts cmpaisoq80000wlfz4llxuo5k

[4] Rollback если нужно:
    npx tsx scripts/disclaimer-injection-rollback.ts cmpaisoq80000wlfz4llxuo5k --apply --status=completed --limit=10

ETA для full execute (≈[N − M] листингов, 4 req/sec, +GET для productType): 
~[estimated minutes] минут.
```

**Жди explicit confirmation от Vladimir** перед запуском execute.

---

## SAFETY CHECKLIST (Claude Code должен пройти перед commit)

- [ ] DRY RUN by default — `--apply` flag required для actual SP-API calls
- [ ] Original content preserved в `ListingRemediation.original_bullets/description` — rollback возможен
- [ ] Per-account rate limiting (different SP-API credentials)
- [ ] Exponential backoff на 429
- [ ] Auto-abort если error rate > 10% в batch
- [ ] VALIDATION_PREVIEW перед real PATCH
- [ ] Skip listings где disclaimer уже есть (idempotent)
- [ ] Никаких автоматических full execute — Vladimir approves каждый этап
- [ ] Wiki обновлена (3 файла)

---

## ИЗВЕСТНЫЕ EDGE CASES

1. **productType unknown** — если GET listing возвращает `productType` который мы не ожидаем (e.g. niche category), use that as-is в PATCH. Не hardcode.

2. **bullet_point может быть пустой** — у некоторых старых листингов attribute существует но пустой array, или вообще отсутствует. План: если `original_bullets === "[]"` → skip (uncommon, нечего патчить properly).

3. **product_description может быть пустой** — описание добавляется в чистый field, без `\n\n` separator-а.

4. **VALIDATION_PREVIEW может вернуть warnings без errors** — это OK, patch проходит. Только errors блокируют real PATCH.

5. **HTML в description** — Amazon allows ограниченные HTML tags. Disclaimer paragraph — plain text, без HTML. Если existing description содержит HTML, append disclaimer **after** any closing tags. Простой `+ "\n\n" + DISCLAIMER` работает корректно.

6. **ASIN с Brand Registry** (Salutem Vita on SALUTEM account) — никаких specific restrictions для PATCH. Brand Registry даёт ownership privileges, не блокирует self-editing.

---

## END OF PROMPT

Если что-то непонятно — НЕ guess. Спроси Vladimir-а в чате. Он tired но доступен для critical questions.
