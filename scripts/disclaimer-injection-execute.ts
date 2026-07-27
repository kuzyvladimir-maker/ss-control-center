/**
 * Phase 2.6.1 — Disclaimer Injection EXECUTE (real SP-API PATCH).
 *
 * Reads ListingRemediation rows with status='plan' for a given scan
 * and pushes their new_bullets + new_description to Amazon via the
 * Listings Items 2021-08-01 PATCH endpoint.
 *
 * Safety net:
 *   - Default mode is DRY (no --apply) — prints what WOULD be patched.
 *   - VALIDATION_PREVIEW mode hits Amazon BEFORE the real PATCH so we
 *     don't ship a malformed body to a thousand listings.
 *   - Per-account batching with configurable rate limit (--sleep-ms,
 *     default 250 ms = ~4 req/sec, well under the 5 req/sec ceiling).
 *   - 429 honors Retry-After, retried up to 3× (in spApiRequest).
 *   - Auto-abort if per-batch error rate exceeds --max-error-rate
 *     (default 0.10).
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-execute.ts <scan_id>                       # dry
 *   npx tsx scripts/disclaimer-injection-execute.ts <scan_id> --apply --limit=10    # safety test
 *   npx tsx scripts/disclaimer-injection-execute.ts <scan_id> --apply --batch-size=25
 *
 * Flags:
 *   --apply              Required to actually call SP-API
 *   --batch-size=N       Default 10
 *   --max-error-rate=N   Default 0.10 (abort if >10% errors in a batch)
 *   --account=NAME       Restrict to one account (SALUTEM | AMZCOM)
 *   --limit=N            Process only first N planned rows
 *   --sleep-ms=N         Default 250 ms between SP-API calls
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
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
import {
  ACCOUNT_KEYS,
  storeIndexFor,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

interface Args {
  scanId: string;
  apply: boolean;
  batchSize: number;
  maxErrorRate: number;
  account: AccountKey | null;
  limit: number | null;
  sleepMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/disclaimer-injection-execute.ts <scan_id> [--apply] [--batch-size=N] [--limit=N] [--account=NAME] [--max-error-rate=0.10] [--sleep-ms=250]",
    );
    process.exit(1);
  }
  const scanId = argv[0];
  let apply = false;
  let batchSize = 10;
  let maxErrorRate = 0.1;
  let account: AccountKey | null = null;
  let limit: number | null = null;
  let sleepMs = 250;
  for (const a of argv.slice(1)) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--batch-size=")) batchSize = Number(a.split("=")[1]);
    else if (a.startsWith("--max-error-rate=")) maxErrorRate = Number(a.split("=")[1]);
    else if (a.startsWith("--account=")) {
      const v = a.split("=")[1].toUpperCase();
      if (!ACCOUNT_KEYS.includes(v as AccountKey)) {
        console.error(`Unknown --account=${v}. Allowed: ${ACCOUNT_KEYS.join(", ")}`);
        process.exit(1);
      }
      account = v as AccountKey;
    } else if (a.startsWith("--limit=")) limit = Number(a.split("=")[1]);
    else if (a.startsWith("--sleep-ms=")) sleepMs = Number(a.split("=")[1]);
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { scanId, apply, batchSize, maxErrorRate, account, limit, sleepMs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PlannedRow {
  remediationId: string;
  auditResultId: string;
  asin: string;
  sku: string;
  account: AccountKey;
  newBullets: string[];
  newDescription: string;
}

function buildPatches(
  newBullets: string[],
  newDescription: string,
): ListingPatch[] {
  return [
    {
      op: "replace",
      path: "/attributes/bullet_point",
      value: newBullets.map((bp) => ({
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
          value: newDescription,
          language_tag: "en_US",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
    },
  ];
}

async function processOne(
  row: PlannedRow,
  sellerId: string,
  apply: boolean,
): Promise<{ ok: true; response: unknown } | { ok: false; error: string }> {
  const storeIndex = storeIndexFor(row.account);

  // Mark in-progress (DB only — no SP-API yet).
  await prisma.listingRemediation.update({
    where: { id: row.remediationId },
    data: { status: "in_progress", started_at: new Date() },
  });

  let productType = "PRODUCT";
  try {
    const live = await getListing(storeIndex, sellerId, row.sku);
    const fromSummary = live.summaries?.find(
      (s) => s.marketplaceId === MARKETPLACE_ID,
    )?.productType;
    if (fromSummary) productType = fromSummary;
  } catch (e) {
    return {
      ok: false,
      error: `GET productType failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const patches = buildPatches(row.newBullets, row.newDescription);

  // VALIDATION_PREVIEW first — Amazon tells us if the body would be
  // rejected before we actually mutate anything.
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
      const issues = JSON.stringify(preview.issues ?? preview);
      return { ok: false, error: `VALIDATION_PREVIEW INVALID: ${issues}` };
    }
  } catch (e) {
    return {
      ok: false,
      error: `VALIDATION_PREVIEW failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!apply) {
    return { ok: true, response: { dry: true, validated: true } };
  }

  try {
    const response = await patchListing(
      storeIndex,
      sellerId,
      row.sku,
      productType,
      patches,
    );
    return { ok: true, response };
  } catch (e) {
    return {
      ok: false,
      error: `PATCH failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function main() {
  const args = parseArgs();

  const scan = await prisma.listingAuditScan.findUniqueOrThrow({
    where: { id: args.scanId },
  });
  if (scan.status !== "completed") {
    throw new Error(`Scan ${scan.id} status=${scan.status}, expected 'completed'.`);
  }

  // Plan rows in order. Optional --account / --limit narrowing.
  const planRows = await prisma.listingRemediation.findMany({
    where: {
      status: "plan",
      audit_result: {
        scan_id: scan.id,
        ...(args.account ? { account: args.account } : {}),
      },
    },
    include: {
      audit_result: {
        select: { id: true, asin: true, sku: true, account: true },
      },
    },
    orderBy: { audit_result_id: "asc" },
    take: args.limit ?? undefined,
  });
  if (planRows.length === 0) {
    console.log("No 'plan' rows match the filter — nothing to do.");
    return;
  }
  const rows: PlannedRow[] = planRows.map((p) => {
    const newBullets = (() => {
      try {
        const v = JSON.parse(p.new_bullets ?? "[]");
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      } catch {
        return [] as string[];
      }
    })();
    return {
      remediationId: p.id,
      auditResultId: p.audit_result_id,
      asin: p.audit_result.asin,
      sku: p.audit_result.sku ?? "",
      account: p.audit_result.account as AccountKey,
      newBullets,
      newDescription: p.new_description ?? "",
    };
  });

  console.log(
    `Phase 2.6.1 EXECUTE — scan ${args.scanId} — ${rows.length} planned row(s)`,
  );
  console.log(
    `  apply=${args.apply}  batch=${args.batchSize}  sleep=${args.sleepMs}ms  ` +
      `max-error-rate=${args.maxErrorRate}` +
      (args.account ? `  account=${args.account}` : "") +
      (args.limit ? `  limit=${args.limit}` : ""),
  );
  if (!args.apply) {
    console.log(
      "\nDRY RUN — VALIDATION_PREVIEW will hit SP-API per row but no real PATCH " +
        "will mutate listings. Re-run with --apply for real execution.\n",
    );
  }

  // Resolve seller IDs once per account.
  const sellerIdByAccount = new Map<AccountKey, string>();
  const accountsInBatch = [...new Set(rows.map((r) => r.account))];
  for (const acct of accountsInBatch) {
    const storeIndex = storeIndexFor(acct);
    try {
      const id = await getMerchantToken(storeIndex);
      sellerIdByAccount.set(acct, id);
    } catch (e) {
      if (e instanceof NoUSMarketplaceError) {
        console.warn(
          `  ⚠ ${acct}: no US marketplace participation — rows for this account will be skipped`,
        );
      } else {
        throw e;
      }
    }
  }

  // Batch loop.
  const t0 = Date.now();
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const errorSamples: string[] = [];
  const errorFreq = new Map<string, number>();

  for (let batchStart = 0; batchStart < rows.length; batchStart += args.batchSize) {
    const batch = rows.slice(batchStart, batchStart + args.batchSize);
    const batchNo = Math.floor(batchStart / args.batchSize) + 1;
    const batchTotal = Math.ceil(rows.length / args.batchSize);
    let bSuccess = 0;
    let bFailed = 0;
    let bSkipped = 0;

    for (const row of batch) {
      const sellerId = sellerIdByAccount.get(row.account);
      if (!sellerId) {
        bSkipped++;
        totalSkipped++;
        await prisma.listingRemediation.update({
          where: { id: row.remediationId },
          data: {
            status: "failed",
            sp_api_error: "skipped: no US sellerId for account",
            completed_at: new Date(),
          },
        });
        await prisma.listingAuditResult.update({
          where: { id: row.auditResultId },
          data: { remediation_status: "FAILED" },
        });
        continue;
      }
      const result = await processOne(row, sellerId, args.apply);
      if (result.ok) {
        bSuccess++;
        totalSuccess++;
        await prisma.listingRemediation.update({
          where: { id: row.remediationId },
          data: {
            status: args.apply ? "completed" : "plan", // dry mode: still 'plan'
            sp_api_response: JSON.stringify(result.response).slice(0, 4000),
            completed_at: args.apply ? new Date() : null,
          },
        });
        if (args.apply) {
          await prisma.listingAuditResult.update({
            where: { id: row.auditResultId },
            data: { remediation_status: "DONE" },
          });
        }
      } else {
        bFailed++;
        totalFailed++;
        errorFreq.set(result.error, (errorFreq.get(result.error) ?? 0) + 1);
        if (errorSamples.length < 3) {
          errorSamples.push(`${row.asin} — ${result.error}`);
        }
        await prisma.listingRemediation.update({
          where: { id: row.remediationId },
          data: {
            status: "failed",
            sp_api_error: result.error.slice(0, 1000),
            completed_at: new Date(),
          },
        });
        await prisma.listingAuditResult.update({
          where: { id: row.auditResultId },
          data: { remediation_status: "FAILED" },
        });
      }
      await sleep(args.sleepMs);
    }

    const processed = bSuccess + bFailed + bSkipped;
    const batchErrorRate = processed > 0 ? bFailed / processed : 0;
    console.log(
      `Batch ${batchNo}/${batchTotal} done · ` +
        `success=${bSuccess} · failed=${bFailed} · skipped=${bSkipped} ` +
        `· error-rate=${(batchErrorRate * 100).toFixed(1)}%`,
    );
    if (batchErrorRate > args.maxErrorRate && processed >= 5) {
      console.error(
        `\nSTOP: Batch error rate ${(batchErrorRate * 100).toFixed(1)}% exceeds ` +
          `threshold ${(args.maxErrorRate * 100).toFixed(0)}%.`,
      );
      console.error("Last 3 errors:");
      errorSamples.slice(-3).forEach((s, i) => console.error(`  ${i + 1}. ${s}`));
      console.error(
        `\nTo investigate: SELECT * FROM ListingRemediation WHERE status='failed' ORDER BY completed_at DESC;`,
      );
      console.error(
        `To resume after fix: npx tsx scripts/disclaimer-injection-execute.ts ${scan.id} --apply --batch-size=${args.batchSize}`,
      );
      process.exit(2);
    }
    await sleep(2000);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log(`Final: success=${totalSuccess} failed=${totalFailed} skipped=${totalSkipped} elapsed=${elapsedSec}s`);
  if (errorFreq.size > 0) {
    const top5 = [...errorFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log("Top error messages:");
    for (const [msg, n] of top5) console.log(`  ${n}× ${msg}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
