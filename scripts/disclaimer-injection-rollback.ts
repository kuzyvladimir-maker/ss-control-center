/**
 * Phase 2.6.1 — Rollback patched listings back to their original
 * bullets + description.
 *
 * Uses the same VALIDATION_PREVIEW + PATCH pipeline as execute, just
 * pushing the *original_* fields stored on the ListingRemediation row.
 *
 * Defaults to DRY: no `--apply` flag → only previews. With `--apply`,
 * pushes real PATCH calls. Same rate limit + retry behaviour as execute.
 *
 * Usage:
 *   set -a; source .env.local; set +a
 *   npx tsx scripts/disclaimer-injection-rollback.ts <scan_id> --apply
 *   npx tsx scripts/disclaimer-injection-rollback.ts <scan_id> --apply --status=completed --limit=10
 *
 * After successful rollback: row.status = 'rolled_back',
 * audit_result.remediation_status = 'PENDING' (so re-plan is possible).
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
  statuses: string[];
  account: AccountKey | null;
  limit: number | null;
  sleepMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/disclaimer-injection-rollback.ts <scan_id> [--apply] [--status=completed|failed|all] [--account=NAME] [--limit=N] [--sleep-ms=250]",
    );
    process.exit(1);
  }
  const scanId = argv[0];
  let apply = false;
  let statusesRaw = "all";
  let account: AccountKey | null = null;
  let limit: number | null = null;
  let sleepMs = 250;
  for (const a of argv.slice(1)) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--status=")) statusesRaw = a.split("=")[1];
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
  const statuses =
    statusesRaw === "all" ? ["completed", "failed", "verification_failed"] : [statusesRaw];
  return { scanId, apply, statuses, account, limit, sleepMs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildPatches(
  bullets: string[],
  description: string,
): ListingPatch[] {
  return [
    {
      op: "replace",
      path: "/attributes/bullet_point",
      value: bullets.map((bp) => ({
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
          value: description,
          language_tag: "en_US",
          marketplace_id: MARKETPLACE_ID,
        },
      ],
    },
  ];
}

async function main() {
  const args = parseArgs();
  const rows = await prisma.listingRemediation.findMany({
    where: {
      status: { in: args.statuses },
      audit_result: {
        scan_id: args.scanId,
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

  console.log(
    `Phase 2.6.1 ROLLBACK — scan ${args.scanId} — ${rows.length} row(s) match ` +
      `(status in [${args.statuses.join(",")}]` +
      (args.account ? `, account=${args.account}` : "") +
      (args.limit ? `, limit=${args.limit}` : "") +
      `)`,
  );
  if (rows.length === 0) return;
  if (!args.apply) {
    console.log("DRY RUN — re-run with --apply to actually push rollback PATCHes.");
  }

  // Per-account seller IDs.
  const sellerIdByAccount = new Map<AccountKey, string>();
  for (const acct of new Set(rows.map((r) => r.audit_result.account as AccountKey))) {
    try {
      sellerIdByAccount.set(acct, await getMerchantToken(storeIndexFor(acct)));
    } catch (e) {
      if (e instanceof NoUSMarketplaceError) {
        console.warn(`  ⚠ ${acct}: no US marketplace — rollback will skip its rows`);
      } else throw e;
    }
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;
  const byAccount: Record<string, number> = {};

  for (const r of rows) {
    const acct = r.audit_result.account as AccountKey;
    const sellerId = sellerIdByAccount.get(acct);
    if (!sellerId || !r.audit_result.sku) {
      skipped++;
      continue;
    }
    const originalBullets = (() => {
      try {
        const v = JSON.parse(r.original_bullets ?? "[]");
        return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      } catch {
        return [] as string[];
      }
    })();
    const originalDescription = r.original_description ?? "";
    const patches = buildPatches(originalBullets, originalDescription);
    const storeIndex = storeIndexFor(acct);

    try {
      const live = await getListing(storeIndex, sellerId, r.audit_result.sku);
      const productType =
        live.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID)
          ?.productType ?? "PRODUCT";
      // Always validate, even when not applying.
      const preview = await patchListing(
        storeIndex,
        sellerId,
        r.audit_result.sku,
        productType,
        patches,
        { validationPreview: true },
      );
      if (preview?.status === "INVALID") {
        failed++;
        await prisma.listingRemediation.update({
          where: { id: r.id },
          data: {
            sp_api_error: `rollback VALIDATION_PREVIEW INVALID: ${JSON.stringify(
              preview.issues ?? preview,
            ).slice(0, 1000)}`,
          },
        });
        continue;
      }
      if (args.apply) {
        const response = await patchListing(
          storeIndex,
          sellerId,
          r.audit_result.sku,
          productType,
          patches,
        );
        success++;
        byAccount[acct] = (byAccount[acct] ?? 0) + 1;
        await prisma.listingRemediation.update({
          where: { id: r.id },
          data: {
            status: "rolled_back",
            sp_api_response: `ROLLBACK at ${new Date().toISOString()}: ${JSON.stringify(
              response,
            ).slice(0, 3500)}`,
            completed_at: new Date(),
          },
        });
        await prisma.listingAuditResult.update({
          where: { id: r.audit_result.id },
          data: { remediation_status: "PENDING" },
        });
      } else {
        // dry-run path: count as success but no DB mutation
        success++;
        byAccount[acct] = (byAccount[acct] ?? 0) + 1;
      }
    } catch (e) {
      failed++;
      await prisma.listingRemediation.update({
        where: { id: r.id },
        data: {
          sp_api_error: `rollback failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      });
    }
    await sleep(args.sleepMs);
  }

  console.log("");
  console.log(`Rolled back: ${success} · failed: ${failed} · skipped: ${skipped}`);
  console.log("Per-account:");
  for (const acct of Object.keys(byAccount).sort()) {
    console.log(`  ${acct}: ${byAccount[acct]}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
