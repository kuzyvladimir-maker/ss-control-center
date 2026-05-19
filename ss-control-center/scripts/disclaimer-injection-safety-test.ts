/**
 * Phase 2.6.2 — Safety-test driver.
 *
 * Plans the per-cohort safety sample (5 AMZCOM + 5 SALUTEM with Claude
 * rewrite) and immediately runs the SP-API safety test against each,
 * all in a single Node process. Doing both inside one tsx invocation
 * avoids the cross-process replica-lag window that surfaced when running
 * `plan` then `execute` as separate processes against Turso.
 *
 * Failure policy:
 *   - 4/5 successes per cohort required to proceed (matches the spec
 *     threshold in docs/CLAUDE_CODE_PROMPT_PHASE_2_6_2_CLAUDE_REWRITE.md).
 *   - If AMZCOM cohort fails, SALUTEM cohort is skipped (no point
 *     burning Claude $$ on a strategy that's already invalidated).
 *
 * Usage:
 *   set -a; source .env; set +a   # or .env.local
 *   npx tsx scripts/disclaimer-injection-safety-test.ts          # dry — VALIDATION_PREVIEW only
 *   npx tsx scripts/disclaimer-injection-safety-test.ts --apply  # real PATCH (after Vladimir approval)
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import {
  DISCLAIMER_BULLET,
  DISCLAIMER_DESCRIPTION,
  hasDisclaimerText,
} from "@/lib/bundle-factory/remediation/disclaimer-text";
import {
  scrubBulletArray,
  scrubDescription,
} from "@/lib/bundle-factory/remediation/content-scrub";
import { rewriteListingContent } from "@/lib/bundle-factory/remediation/claude-rewrite";
import {
  getMerchantToken,
  NoUSMarketplaceError,
} from "@/lib/amazon-sp-api/sellers";
import {
  getListing,
  patchListing,
  type ListingPatch,
} from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { storeIndexFor, type AccountKey } from "@/lib/bundle-factory/audit/account-map";

const SCAN_ID = "cmpaisoq80000wlfz4llxuo5k";
const COHORT_SIZE = 5;
const COHORTS: AccountKey[] = ["AMZCOM", "SALUTEM"];
const SAFETY_THRESHOLD = 4; // 4/5 must succeed per cohort to declare PASSED

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface PlannedCohortRow {
  auditId: string;
  asin: string;
  sku: string;
  account: AccountKey;
  originalBullets: string[];
  newBullets: string[];
  newDescription: string;
  claudeBullets: string[];
  claudeDescription: string;
  aiCostCents: number;
  cacheHit: boolean;
}

async function resetStalePlanned(account: AccountKey, keepIds: string[]) {
  // Any AMZCOM/SALUTEM audit row with remediation_status='PLANNED' that
  // has NO matching ListingRemediation row is stale (deleted plan, status
  // never reverted). Force back to PENDING so plan-driver can pick it.
  const all = await prisma.listingAuditResult.findMany({
    where: {
      scan_id: SCAN_ID,
      account,
      remediation_status: "PLANNED",
      risk_reasons: { contains: "Missing curator/assembler disclaimer" },
    },
    select: { id: true },
  });
  const orphans = all.filter((a) => !keepIds.includes(a.id));
  if (orphans.length === 0) return 0;
  let resetCount = 0;
  for (const o of orphans) {
    await prisma.listingAuditResult.update({
      where: { id: o.id },
      data: { remediation_status: "PENDING" },
    });
    resetCount++;
  }
  return resetCount;
}

async function planCohort(account: AccountKey): Promise<PlannedCohortRow[]> {
  console.log(`\n── Planning ${COHORT_SIZE} ${account} rows (Claude rewrite) ──`);
  // Find which PLANNED rows are real (have a ListingRemediation) and reset
  // the rest to PENDING so plan can pick them.
  const liveRemediations = await prisma.listingRemediation.findMany({
    where: {
      audit_result: { scan_id: SCAN_ID, account },
      status: "plan",
    },
    select: { audit_result_id: true },
  });
  const resetCount = await resetStalePlanned(
    account,
    liveRemediations.map((r) => r.audit_result_id),
  );
  if (resetCount > 0) console.log(`  reset ${resetCount} stale PLANNED → PENDING`);

  const candidates = await prisma.listingAuditResult.findMany({
    where: {
      scan_id: SCAN_ID,
      account,
      remediation_status: "PENDING",
      risk_reasons: { contains: "Missing curator/assembler disclaimer" },
    },
    select: {
      id: true,
      asin: true,
      sku: true,
      account: true,
      title: true,
      brand: true,
      browse_node: true,
      original_bullets: true,
      original_description: true,
      main_image_url: true,
    },
    orderBy: { id: "asc" },
    take: COHORT_SIZE * 3, // overprovision in case some skip out
  });

  const rows: PlannedCohortRow[] = [];
  for (const c of candidates) {
    if (rows.length >= COHORT_SIZE) break;
    const originalBullets = parseJson<string[]>(c.original_bullets, []).filter(
      (b) => typeof b === "string",
    );
    if (originalBullets.length === 0) continue;
    if (hasDisclaimerText(c.original_description ?? "", ...originalBullets)) continue;

    const rewrite = await rewriteListingContent({
      asin: c.asin,
      title: c.title,
      brand: c.brand ?? "Salutem Vita",
      browse_node: c.browse_node,
      original_bullets: originalBullets,
      original_description: c.original_description ?? "",
    });
    if (rewrite.error) {
      console.log(`  ⚠ ${c.asin} Claude error: ${rewrite.error.slice(0, 80)}`);
      await sleep(150);
      continue;
    }
    const cleanedBullets = scrubBulletArray(rewrite.bullets);
    const cleanedDescription = scrubDescription(rewrite.description);
    const cappedBullets = cleanedBullets.slice(0, 9);
    const newBullets = [...cappedBullets, DISCLAIMER_BULLET];
    const trimmedDesc = cleanedDescription.trim();
    const newDescription = trimmedDesc
      ? trimmedDesc + "\n\n" + DISCLAIMER_DESCRIPTION
      : DISCLAIMER_DESCRIPTION;

    const meta = JSON.stringify({
      mode: "claude",
      scrub_applied: true,
      cache_hit: rewrite.cache_hit,
      ai_cost_cents: rewrite.cost_cents,
      planned_at: new Date().toISOString(),
    });
    await prisma.listingRemediation.upsert({
      where: { audit_result_id: c.id },
      create: {
        audit_result_id: c.id,
        status: "plan",
        original_title: c.title,
        new_title: null,
        original_bullets: JSON.stringify(originalBullets),
        new_bullets: JSON.stringify(newBullets),
        original_description: c.original_description ?? "",
        new_description: newDescription,
        original_image_url: c.main_image_url,
        new_image_url: null,
        ai_cost_cents: rewrite.cost_cents,
        sp_api_response: meta,
        sp_api_error: null,
      },
      update: {
        status: "plan",
        new_bullets: JSON.stringify(newBullets),
        new_description: newDescription,
        ai_cost_cents: rewrite.cost_cents,
        sp_api_response: meta,
        sp_api_error: null,
        completed_at: null,
      },
    });
    await prisma.listingAuditResult.update({
      where: { id: c.id },
      data: { remediation_status: "PLANNED" },
    });

    rows.push({
      auditId: c.id,
      asin: c.asin,
      sku: c.sku ?? "",
      account: c.account as AccountKey,
      originalBullets,
      newBullets,
      newDescription,
      claudeBullets: rewrite.bullets,
      claudeDescription: rewrite.description,
      aiCostCents: rewrite.cost_cents,
      cacheHit: rewrite.cache_hit,
    });
    console.log(
      `  ✓ ${c.asin} planned · ${rewrite.cost_cents}¢ · cache=${rewrite.cache_hit}`,
    );
    await sleep(150);
  }
  return rows;
}

interface SafetyResult {
  asin: string;
  account: AccountKey;
  ok: boolean;
  error?: string;
}

async function executeCohort(
  rows: PlannedCohortRow[],
  apply: boolean,
): Promise<SafetyResult[]> {
  const account = rows[0]?.account;
  if (!account) return [];
  console.log(`\n── Executing ${rows.length} ${account} rows · apply=${apply} ──`);
  const storeIndex = storeIndexFor(account);
  let sellerId: string;
  try {
    sellerId = await getMerchantToken(storeIndex);
  } catch (e) {
    if (e instanceof NoUSMarketplaceError) {
      console.error(`  ⚠ ${account}: no US marketplace participation`);
      return rows.map((r) => ({
        asin: r.asin,
        account,
        ok: false,
        error: "no US marketplace",
      }));
    }
    throw e;
  }

  const results: SafetyResult[] = [];
  for (const row of rows) {
    let productType = "PRODUCT";
    try {
      const live = await getListing(storeIndex, sellerId, row.sku);
      const fromSummary = live.summaries?.find(
        (s) => s.marketplaceId === MARKETPLACE_ID,
      )?.productType;
      if (fromSummary) productType = fromSummary;
    } catch (e) {
      const error = `GET productType failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push({ asin: row.asin, account, ok: false, error });
      await prisma.listingRemediation.updateMany({
        where: { audit_result_id: row.auditId },
        data: { status: "failed", sp_api_error: error.slice(0, 1000), completed_at: new Date() },
      });
      await prisma.listingAuditResult.update({
        where: { id: row.auditId },
        data: { remediation_status: "FAILED" },
      });
      console.log(`  ✗ ${row.asin} ${error.slice(0, 100)}`);
      await sleep(300);
      continue;
    }

    const patches: ListingPatch[] = [
      {
        op: "replace",
        path: "/attributes/bullet_point",
        value: row.newBullets.map((bp) => ({
          value: bp,
          language_tag: "en_US",
          marketplace_id: MARKETPLACE_ID,
        })),
      },
      {
        op: "replace",
        path: "/attributes/product_description",
        value: [
          {
            value: row.newDescription,
            language_tag: "en_US",
            marketplace_id: MARKETPLACE_ID,
          },
        ],
      },
    ];

    // VALIDATION_PREVIEW first
    try {
      const preview = await patchListing(
        storeIndex,
        sellerId,
        row.sku,
        productType,
        patches,
        { validationPreview: true },
      );
      if (preview?.status === "INVALID") {
        const issues = JSON.stringify(preview.issues ?? preview).slice(0, 800);
        const error = `VALIDATION_PREVIEW INVALID: ${issues}`;
        results.push({ asin: row.asin, account, ok: false, error });
        await prisma.listingRemediation.updateMany({
          where: { audit_result_id: row.auditId },
          data: { status: "failed", sp_api_error: error.slice(0, 1000), completed_at: new Date() },
        });
        await prisma.listingAuditResult.update({
          where: { id: row.auditId },
          data: { remediation_status: "FAILED" },
        });
        console.log(`  ✗ ${row.asin} INVALID ${issues.slice(0, 100)}`);
        await sleep(300);
        continue;
      }
    } catch (e) {
      const error = `VALIDATION_PREVIEW failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push({ asin: row.asin, account, ok: false, error });
      await prisma.listingRemediation.updateMany({
        where: { audit_result_id: row.auditId },
        data: { status: "failed", sp_api_error: error.slice(0, 1000), completed_at: new Date() },
      });
      await prisma.listingAuditResult.update({
        where: { id: row.auditId },
        data: { remediation_status: "FAILED" },
      });
      console.log(`  ✗ ${row.asin} ${error.slice(0, 100)}`);
      await sleep(300);
      continue;
    }

    if (!apply) {
      results.push({ asin: row.asin, account, ok: true });
      console.log(`  ✓ ${row.asin} validated (dry run)`);
      await sleep(300);
      continue;
    }

    try {
      const response = await patchListing(
        storeIndex,
        sellerId,
        row.sku,
        productType,
        patches,
      );
      results.push({ asin: row.asin, account, ok: true });
      await prisma.listingRemediation.updateMany({
        where: { audit_result_id: row.auditId },
        data: {
          status: "completed",
          sp_api_response: JSON.stringify(response).slice(0, 4000),
          completed_at: new Date(),
        },
      });
      await prisma.listingAuditResult.update({
        where: { id: row.auditId },
        data: { remediation_status: "DONE" },
      });
      console.log(`  ✓ ${row.asin} PATCH applied`);
    } catch (e) {
      const error = `PATCH failed: ${e instanceof Error ? e.message : String(e)}`;
      results.push({ asin: row.asin, account, ok: false, error });
      await prisma.listingRemediation.updateMany({
        where: { audit_result_id: row.auditId },
        data: { status: "failed", sp_api_error: error.slice(0, 1000), completed_at: new Date() },
      });
      await prisma.listingAuditResult.update({
        where: { id: row.auditId },
        data: { remediation_status: "FAILED" },
      });
      console.log(`  ✗ ${row.asin} ${error.slice(0, 100)}`);
    }
    await sleep(300);
  }
  return results;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Safety driver — scan ${SCAN_ID} · apply=${apply}`);
  console.log(`Cohort size: ${COHORT_SIZE} · threshold: ${SAFETY_THRESHOLD}/${COHORT_SIZE} per cohort`);

  const allResults: Record<AccountKey, SafetyResult[]> = {} as Record<
    AccountKey,
    SafetyResult[]
  >;
  const planByCohort: Record<AccountKey, PlannedCohortRow[]> = {} as Record<
    AccountKey,
    PlannedCohortRow[]
  >;
  let totalAiCents = 0;
  let totalCacheHits = 0;
  let totalClaudeCalls = 0;

  for (const cohort of COHORTS) {
    const plan = await planCohort(cohort);
    planByCohort[cohort] = plan;
    totalAiCents += plan.reduce((s, r) => s + r.aiCostCents, 0);
    totalCacheHits += plan.filter((r) => r.cacheHit).length;
    totalClaudeCalls += plan.length;
    if (plan.length === 0) {
      console.log(`  ⚠ ${cohort}: no rows planned, skipping execute`);
      allResults[cohort] = [];
      continue;
    }
    const results = await executeCohort(plan, apply);
    allResults[cohort] = results;
    const passed = results.filter((r) => r.ok).length;
    const gate = passed >= SAFETY_THRESHOLD ? "PASS" : "FAIL";
    console.log(
      `\n  ${cohort} cohort: ${passed}/${results.length} ${gate} (threshold ${SAFETY_THRESHOLD}/${COHORT_SIZE})`,
    );
    if (passed < SAFETY_THRESHOLD) {
      console.log("  Halting subsequent cohort runs per safety policy.");
      // Mark remaining cohorts as not run
      const remaining = COHORTS.slice(COHORTS.indexOf(cohort) + 1);
      for (const c of remaining) allResults[c] = [];
      break;
    }
  }

  console.log("\n═══ FINAL ═══");
  for (const cohort of COHORTS) {
    const r = allResults[cohort] ?? [];
    const passed = r.filter((x) => x.ok).length;
    console.log(`  ${cohort}: ${passed}/${r.length}`);
    for (const item of r) {
      console.log(`    ${item.ok ? "✓" : "✗"} ${item.asin}${item.error ? " — " + item.error.slice(0, 120) : ""}`);
    }
  }
  console.log(
    `\n  Claude cost: $${(totalAiCents / 100).toFixed(2)} (${totalClaudeCalls} calls, cache=${totalCacheHits}/${totalClaudeCalls})`,
  );

  // Sample 1 ASIN per cohort with before/after for the Russian report
  console.log("\n═══ SAMPLES ═══");
  for (const cohort of COHORTS) {
    const plan = planByCohort[cohort] ?? [];
    if (plan.length === 0) continue;
    const sample = plan[0];
    console.log(`\n[${cohort}] ${sample.asin}`);
    console.log(`  ORIGINAL bullet (last): ${sample.originalBullets[sample.originalBullets.length - 1].slice(0, 140)}`);
    console.log(`  CLAUDE bullet (first):  ${sample.claudeBullets[0].slice(0, 140)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
