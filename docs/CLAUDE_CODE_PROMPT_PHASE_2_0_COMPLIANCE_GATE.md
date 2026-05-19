# CLAUDE_CODE_PROMPT_PHASE_2_0_COMPLIANCE_GATE

> **Context:** Phase 2.0a Audit Tool + Phase 2.6.x Remediation (1015/1038 listings cleaned) — DONE. Phase 2.0 = protective gate for NEW listings created by Phase 2.1+ pipeline. Without it any Phase 2.1-2.5 output may repeat the 2026-05-17 RETAILER ban pattern.
>
> **Authoritative concept doc:** `docs/BUNDLE_FACTORY_COMPLIANCE_GATE_v1_0.md` (2026-05-17). All 8 hard rules, DB schemas, module structure, UI design, integration flow are already designed there. **Read that file first.** This prompt is the executable layer with concrete code patterns + Phase 2.6.2 updates.

---

## CHANGES vs concept doc (mandatory updates)

### A. Disclaimer text — replace with verified short version

Concept doc has the old long disclaimer that **triggers Amazon PDP code 99300** (verified empirically in Phase 2.6.2 safety test).

Use the constants module that's already in the repo:
```typescript
import { DISCLAIMER_BULLET, DISCLAIMER_DESCRIPTION, hasDisclaimerText } from "@/lib/bundle-factory/remediation/disclaimer-text";
```

DO NOT redefine the disclaimer. The current values in that module are the **only** versions that pass Amazon's classifier.

### B. Promotional/health banned word lists — expanded

Create `src/lib/bundle-factory/compliance/banned-words.ts` with **three tiers**:

1. `FOREIGN_BRANDS_HARD_BLOCK` — consolidated from `docs/marketplace-rules/amazon/prohibited-keywords.md` + audit findings + incident. Includes (minimum, expand as needed): Goya, El Monterey, Ore-Ida, Oh Snap!, Kraft, SpongeBob, Cheez-It, Hamburger Helper, Lunchables, Oscar Mayer, Jimmy Dean, Healthy Choice, Lean Cuisine, Velveeta, Birds Eye, Thomas', Michelina's, Pepperidge Farm, Freshpet, FarmRich, Eggland's Best, Old El Paso, Hungry-Man, Entenmann's, Little Bites, New York Bakery, Texas Toast, Tyson, Hormel, Hebrew National, Ball Park, Nathan's, Kellogg's, General Mills, Pillsbury, Betty Crocker, Stouffer's, Banquet, Heinz, French's, Hellmann's, Philadelphia, Tillamook, Sargento, Land O'Lakes.

2. `OWN_BRANDS` — exempt from Rule 1: Salutem Vita, Starfit, Salutem Solutions, Salutem.

3. `PROMOTIONAL_BANNED` — derived from actual Phase 2.6.2 99300 triggers: ultimate, perfect, delightful, delicious, ideal, amazing, incredible, premium, exclusive, must-have, best, finest, exceptional, outstanding, magnificent, wonderful, fantastic, superior, top-quality, world-class, awesome, high-quality, optimal, hassle-free, expertly, satisfying, experience, discover, trusted brand, quality and taste, experience the ease, order now, buy today, ready whenever you are.

4. `HEALTH_CLAIM_BANNED`: cure, treat, prevent, boost, weight loss, detox, antioxidant, immune, heal, therapeutic, medical, clinical, prescription, diagnosis.

### C. Reuse existing modules — DO NOT duplicate

- `src/lib/bundle-factory/audit/vision-check.ts` — Rule 6 (image vision) uses this directly. Already has own-brand whitelist + generic deli term filter (Phase 2.6.0 refinement).
- `src/lib/bundle-factory/audit/forbidden-brands.ts` — read for any additional brand lists.
- `BrandConflict` table — Rule 7 queries this. Already created and seeded with 5 incident ASINs by Phase 2.0a migration. **DO NOT recreate or re-seed.**

---

## STEPS

### STEP 1 — DB migration

1.1. `prisma/schema.prisma`: add `ComplianceCheck` + `ComplianceAuditLog` models per concept doc Section "Database schema additions". 

1.2. Add fields to `BundleDraft` and `ChannelSKU`:
```prisma
compliance_status         String    @default("PENDING")  // 'PENDING' | 'CAN_PUBLISH' | 'BLOCKED'
compliance_check_id       String?
compliance_blocked_at     DateTime?
compliance_blocked_reasons String?  // JSON array of failed rule IDs (quick access)
```

1.3. Create `scripts/turso-migrate-phase-2-0-compliance-gate.mjs` modeled after existing `turso-migrate-bundle-factory-phase-2-0a-audit.mjs`. IF NOT EXISTS guards. Run on production Turso.

1.4. Local: `npx prisma migrate dev --name phase_2_0_compliance_gate && npx prisma generate`.

### STEP 2 — Module structure

Create directory `src/lib/bundle-factory/compliance/`:
- `types.ts` — ComplianceInput, RuleResult, ComplianceDecision interfaces
- `banned-words.ts` — 4 constant arrays per "CHANGES B" above
- `browse-nodes.ts` — GIFT_BASKET_EXCEPTION_NODES + isGiftBasketExceptionNode()
- `rules/rule-1-title-foreign-brands.ts` — checks input.title against FOREIGN_BRANDS_HARD_BLOCK, skipping OWN_BRANDS. Returns `{ rule_id, passed, reason, details: { foreign_brands_in_title } }`.
- `rules/rule-2-brand-field.ts` — input.brand must be in ['Salutem Vita', 'Starfit', 'Generic'].
- `rules/rule-3-disclaimer-bullets.ts` — uses `hasDisclaimerText()` from existing disclaimer-text.ts. If `options.autoFix` and missing, append `DISCLAIMER_BULLET` to input.bullets and mark `auto_fix_applied: true`.
- `rules/rule-4-disclaimer-description.ts` — same shape for description. Append with `\n\n` separator.
- `rules/rule-5-browse-node.ts` — count distinct brands in `input.bundle_components`. If >1 and `input.browse_node` not in GIFT_BASKET_EXCEPTION_NODES → block.
- `rules/rule-6-image-vision-check.ts` — async; calls existing `runVisionCheck()` from `bundle-factory/audit/vision-check.ts`. Skip if `input.skip_image_check` or `!input.main_image_url`. Returns vision_cost_cents alongside RuleResult.
- `rules/rule-7-permanent-blocklist.ts` — async; queries `BrandConflict` where status='active'. Match = (foreign_brand substring in title) AND (any product_keyword substring in title). Return matches array.
- `rules/rule-8-promotional-language.ts` — case-insensitive substring scan of title + bullets + description against PROMOTIONAL_BANNED and HEALTH_CLAIM_BANNED.
- `audit-log.ts` — `writeAuditLog(entry: AuditLogEntry)` helper writing to ComplianceAuditLog.
- `gate.ts` — main orchestrator `runComplianceGate(input, options)`. Runs all 8 rules sequentially. Persists `ComplianceCheck` record. Updates parent BundleDraft/ChannelSKU compliance_status. Writes audit log entry. Returns `ComplianceDecision`. Fail-closed on Rule 6 vision errors (treat as BLOCKED, not skip).

Each rule should be pure function (rules 1-5, 8) or async (rules 6-7). Each returns `RuleResult` with rule_id, passed, optional reason/details, optional auto_fix_attempted/auto_fix_applied.

### STEP 3 — API endpoints

`src/app/api/bundle-factory/compliance/check/route.ts`:
- POST: body = ComplianceInput + optional autoFix flag → returns ComplianceDecision

`src/app/api/bundle-factory/compliance/checks/route.ts`:
- GET `?bundle_draft_id=X&limit=50` — recent ComplianceCheck records

`src/app/api/bundle-factory/compliance/brand-conflicts/route.ts`:
- GET — list active BrandConflict entries
- POST — add new BrandConflict (Vladimir manually flags new incident)

### STEP 4 — UI page

Route: `/bundle-factory/compliance` with 4 tabs (per concept doc):
1. **Recent Decisions** — last 50 ComplianceCheck rows
2. **Blocked Drafts** — BundleDraft.compliance_status='BLOCKED' with re-check + manual override
3. **Brand Conflicts** — BrandConflict table with add form
4. **Audit Log** — paginated ComplianceAuditLog

Follow Salutem Design System (see `docs/wiki/design/index.md`). Use shadcn/ui (Tabs, Table, Badge, Dialog).

Update `src/components/bundle-factory/BundleFactorySubNav.tsx` — add "Compliance" tab.

### STEP 5 — Tests

`src/lib/bundle-factory/compliance/__tests__/rules.test.ts`:
- 3 tests per rule (pass / fail / edge) = ~24 tests total
- Mock vision check for rule 6 in unit tests; one live integration test gated by ANTHROPIC_API_KEY

`src/lib/bundle-factory/compliance/__tests__/gate.test.ts`:
- 6 fixture scenarios: clean / 5-Cheez-It-replay / missing-disclaimer-autoFix-true / missing-disclaimer-autoFix-false / multi-brand-wrong-node / promotional-words

### STEP 6 — Smoke test

Create `scripts/smoke-test-compliance-gate.ts`:
- 4 realistic cases (clean / incident replay / autoFix / promotional)
- Run with `npx tsx scripts/smoke-test-compliance-gate.ts`
- Output decision per case + matched rules

### STEP 7 — Wiki (MANDATORY per CLAUDE.md)

- Create `docs/wiki/phase-2-0-compliance-gate.md` — short page linking to main spec
- Update `docs/wiki/CONNECTIONS.md`: `Phase 2.0 ← Phase 2.0a vision-check`, `Phase 2.0 ← Phase 2.6.2 disclaimer-text`, `Phase 2.0 → Phase 2.5 Distribution gate`, `Phase 2.0 ⊂ Bundle Factory Phase 2`
- Update `docs/wiki/index.md` — add entry after Phase 2.6.1

### STEP 8 — Branch + commits + push

Branch: `feat/phase-2-0-compliance-gate`

Logical commits:
1. `feat(compliance): Prisma schema + Turso migration`
2. `feat(compliance): banned-words + browse-nodes constants`
3. `feat(compliance): 8 rule implementations + types`
4. `feat(compliance): orchestrator gate.ts + audit-log helper`
5. `feat(compliance): API endpoints`
6. `feat(compliance): UI page + sub-nav integration`
7. `test(compliance): unit tests + integration tests`
8. `docs(compliance): Phase 2.0 wiki + smoke test`

Merge to main, push.

### STEP 9 — Russian report

After all steps complete, report by-русски:
- What was built (2 tables, 8 rules, orchestrator, API, UI, tests)
- Smoke test results (4 cases × decision)
- URL: https://salutemsolutions.info/bundle-factory/compliance
- What Compliance Gate does + what it does NOT do (no scanning existing listings — that's Phase 2.0a; no content generation — that's Phase 2.2)
- Next: Phase 2.1 (Brief + Research) — spec already exists at `docs/CLAUDE_CODE_PROMPT_BUNDLE_FACTORY_PHASE_2_1.md`; Compliance Gate will be wired into it after Stage 4 (content generation)

---

## SAFETY CHECKLIST

- [ ] Turso migration idempotent (IF NOT EXISTS guards)
- [ ] vision-check.ts + forbidden-brands.ts reused (NOT duplicated)
- [ ] disclaimer-text.ts constants reused (NOT redefined)
- [ ] BrandConflict table NOT dropped/recreated (already seeded by Phase 2.0a)
- [ ] Auto-fix only for rules 3 + 4 (disclaimer injection) — title/image violations require AI regeneration, not auto-patch
- [ ] runComplianceGate fail-closed on Rule 6 vision errors (treat as BLOCKED, never CAN_PUBLISH if vision call fails)
- [ ] Wiki updated (3 files)
- [ ] Tests cover passing + failing + edge cases per rule

---

## NOT IN SCOPE

- Wiring Compliance Gate into Stage 4 / Stage 7 of Bundle Factory pipeline — that happens in Phase 2.1-2.5 (gate is **ready** for them, not yet wired)
- Telegram alerts on BLOCKED — deferred to Phase 2.5
- Bulk re-check of existing BundleDraft (there are zero BundleDraft rows yet)

---

## END

If anything is unclear, ask in chat. Do not guess on Amazon classifier behavior — we already paid the price of guessing in Phase 2.6.1 (Smart Scrub) and Phase 2.6.2 (Option C defensive disclaimer). Phase 2.6.2 findings are authoritative.
