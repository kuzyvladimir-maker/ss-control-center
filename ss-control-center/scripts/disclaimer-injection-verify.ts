/**
 * Phase 2.6.1 — Verify post-patch disclaimer presence.
 *
 * For every ListingRemediation row with status='completed' for the
 * given scan, GET the live listing from Amazon and confirm the
 * disclaimer substring is in either bullets or description. Rows that
 * fail verification are marked status='verification_failed' so the
 * operator knows Amazon's listing builder may have rejected/altered
 * our patch downstream.
 *
 * Read-only against SP-API. Same 4 req/sec throttle as execute.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-verify.ts <scan_id> [--limit=N] [--sleep-ms=250]
 */

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import {
  getMerchantToken,
  NoUSMarketplaceError,
} from "@/lib/amazon-sp-api/sellers";
import { getListing, flattenListing } from "@/lib/amazon-sp-api/listings";
import {
  hasDisclaimerText,
} from "@/lib/bundle-factory/remediation/disclaimer-text";
import {
  storeIndexFor,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

interface Args {
  scanId: string;
  limit: number | null;
  sleepMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/disclaimer-injection-verify.ts <scan_id> [--limit=N] [--sleep-ms=250]",
    );
    process.exit(1);
  }
  const scanId = argv[0];
  let limit: number | null = null;
  let sleepMs = 250;
  for (const a of argv.slice(1)) {
    if (a.startsWith("--limit=")) limit = Number(a.split("=")[1]);
    else if (a.startsWith("--sleep-ms=")) sleepMs = Number(a.split("=")[1]);
    else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { scanId, limit, sleepMs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs();
  const rows = await prisma.listingRemediation.findMany({
    where: {
      status: "completed",
      audit_result: { scan_id: args.scanId },
    },
    include: {
      audit_result: { select: { asin: true, sku: true, account: true } },
    },
    orderBy: { completed_at: "asc" },
    take: args.limit ?? undefined,
  });
  console.log(
    `Verify Phase 2.6.1 — scan ${args.scanId} — ${rows.length} 'completed' rows`,
  );
  if (rows.length === 0) return;

  // Cache seller IDs per account.
  const sellerIdByAccount = new Map<AccountKey, string>();
  for (const acct of new Set(rows.map((r) => r.audit_result.account as AccountKey))) {
    try {
      sellerIdByAccount.set(acct, await getMerchantToken(storeIndexFor(acct)));
    } catch (e) {
      if (e instanceof NoUSMarketplaceError) {
        console.warn(`  ⚠ ${acct}: no US marketplace — verify will skip its rows`);
      } else throw e;
    }
  }

  let verified = 0;
  let verifFailed = 0;
  const failedAsins: Array<{ asin: string; account: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const acct = r.audit_result.account as AccountKey;
    const sellerId = sellerIdByAccount.get(acct);
    if (!sellerId || !r.audit_result.sku) {
      verifFailed++;
      failedAsins.push({ asin: r.audit_result.asin, account: acct });
      continue;
    }
    try {
      const live = await getListing(storeIndexFor(acct), sellerId, r.audit_result.sku);
      const flat = flattenListing(live);
      const hit = hasDisclaimerText(flat.description, ...flat.bullets);
      if (hit) {
        verified++;
        // Touch updated_at via a no-op data change.
        await prisma.listingRemediation.update({
          where: { id: r.id },
          data: { sp_api_response: r.sp_api_response /* no-op, refreshes updated_at */ },
        });
      } else {
        verifFailed++;
        failedAsins.push({ asin: r.audit_result.asin, account: acct });
        await prisma.listingRemediation.update({
          where: { id: r.id },
          data: { status: "verification_failed" },
        });
      }
    } catch (e) {
      verifFailed++;
      failedAsins.push({ asin: r.audit_result.asin, account: acct });
      await prisma.listingRemediation.update({
        where: { id: r.id },
        data: {
          status: "verification_failed",
          sp_api_error: `verify GET failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
    if ((i + 1) % 25 === 0 || i === rows.length - 1) {
      process.stderr.write(
        `  verified ${verified} · failed ${verifFailed} · processed ${i + 1}/${rows.length}\r`,
      );
    }
    await sleep(args.sleepMs);
  }
  process.stderr.write("\n");

  console.log("");
  console.log(`Verified successfully: ${verified}`);
  console.log(`Verification failed:   ${verifFailed}`);
  if (failedAsins.length > 0) {
    console.log("");
    console.log("ASINs needing manual review:");
    for (const f of failedAsins.slice(0, 20)) {
      console.log(`  ${f.account}  ${f.asin}`);
    }
    if (failedAsins.length > 20) {
      console.log(`  … (+${failedAsins.length - 20} more — query DB for full list)`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
