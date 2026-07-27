// Scanner — pulls every active listing across the 5 Amazon accounts
// into ListingAuditResult rows so the risk-scorer can grade them.
//
// Concurrency model: we run the 5 accounts in parallel but iterate each
// account's pagination sequentially (Listings API is rate-limited at
// 5 req/sec per store). A 200 ms throttle between detail fetches keeps
// us well under the limit; pagination is implicit (sequential).
//
// Failure handling:
//   - Per-account auth / Sellers API failure → account skipped, error
//     appended to scan.error_message, scan continues for other accounts.
//   - Per-listing detail fetch failure → that one listing skipped, error
//     logged, scan continues.
// The audit is preventative — we don't want one flaky account to abort
// the whole run.

import { prisma } from "@/lib/prisma";
import {
  getMerchantToken,
  NoUSMarketplaceError,
} from "@/lib/amazon-sp-api/sellers";
import {
  listSkus,
  getListing,
  flattenListing,
  type ListingItem,
} from "@/lib/amazon-sp-api/listings";
import {
  ACCOUNT_KEYS,
  AUDIT_ORDER,
  storeIndexFor,
  type AccountKey,
} from "./account-map";

// SP-API Listings rate limit: 5 req/sec per store. We use 220 ms (≈4.5
// req/sec) to leave headroom and avoid burst-window throttling.
const REQUEST_DELAY_MS = 220;

// Safety cap on pages per account — a malformed pagination token loop
// could otherwise burn an unbounded amount of API quota.
const MAX_PAGES_PER_ACCOUNT = 200; // 200 pages × 20 items = 4000 listings ceiling

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AccountScanReport {
  account: AccountKey;
  listingsInserted: number;
  errors: string[];
  /** Set when the account is intentionally skipped (e.g. Amazon suspended
   *  US membership). Skipped accounts do NOT appear in `errors[]` — UI
   *  renders them as a warning, not a failure. */
  skipped?: { reason: string };
}

async function scanOneAccount(
  scanId: string,
  account: AccountKey,
): Promise<AccountScanReport> {
  const storeIndex = storeIndexFor(account);
  const errors: string[] = [];
  let inserted = 0;

  let sellerId: string;
  try {
    sellerId = await getMerchantToken(storeIndex);
  } catch (e) {
    // No US Amazon.com participation → skip (not error). The audit can't
    // do anything productive against an account that's not in the US
    // marketplace; surfacing this as a hard error would just clutter
    // the operator's view of real problems.
    if (e instanceof NoUSMarketplaceError) {
      return {
        account,
        listingsInserted: 0,
        errors: [],
        skipped: { reason: e.message },
      };
    }
    return {
      account,
      listingsInserted: 0,
      errors: [
        `Sellers API lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      ],
    };
  }

  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    pageCount++;
    let pageItems: ListingItem[];
    let nextToken: string | undefined;
    try {
      const page = await listSkus(storeIndex, sellerId, {
        pageSize: 20,
        pageToken,
        includedData: ["summaries"],
      });
      pageItems = page.items;
      nextToken = page.pagination?.nextToken;
    } catch (e) {
      errors.push(
        `listSkus page ${pageCount}: ${e instanceof Error ? e.message : String(e)}`,
      );
      break;
    }

    for (const item of pageItems) {
      await sleep(REQUEST_DELAY_MS);
      try {
        const detail = await getListing(storeIndex, sellerId, item.sku);
        const flat = flattenListing(detail);
        if (!flat.asin) {
          // Some listings (deleted, mid-creation) have no ASIN yet —
          // skip rather than persist a row that can't be scored.
          errors.push(`sku ${item.sku}: no ASIN in summary`);
          continue;
        }
        await prisma.listingAuditResult.create({
          data: {
            scan_id: scanId,
            asin: flat.asin,
            sku: item.sku,
            account,
            title: flat.title,
            brand: flat.brand,
            browse_node: flat.browse_node,
            main_image_url: flat.main_image_url,
            original_bullets: JSON.stringify(flat.bullets),
            original_description: flat.description,
          },
        });
        inserted++;
      } catch (e) {
        errors.push(
          `sku ${item.sku}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    pageToken = nextToken;
  } while (pageToken && pageCount < MAX_PAGES_PER_ACCOUNT);

  if (pageCount >= MAX_PAGES_PER_ACCOUNT && pageToken) {
    errors.push(
      `hit MAX_PAGES_PER_ACCOUNT (${MAX_PAGES_PER_ACCOUNT}); some listings may be unscanned`,
    );
  }

  return { account, listingsInserted: inserted, errors };
}

export async function scanAllAccounts(
  scanId: string,
  accounts: readonly AccountKey[] = AUDIT_ORDER,
): Promise<{
  totalInserted: number;
  byAccount: Record<string, number>;
  errors: string[];
  skipped: Array<{ account: AccountKey; reason: string }>;
}> {
  await prisma.listingAuditScan.update({
    where: { id: scanId },
    data: { status: "running" },
  });

  const reports = await Promise.all(
    accounts.map((acct) => scanOneAccount(scanId, acct)),
  );

  const byAccount: Record<string, number> = {};
  const errors: string[] = [];
  const skipped: Array<{ account: AccountKey; reason: string }> = [];
  let totalInserted = 0;

  for (const r of reports) {
    byAccount[r.account] = r.listingsInserted;
    totalInserted += r.listingsInserted;
    if (r.skipped) {
      skipped.push({ account: r.account, reason: r.skipped.reason });
      continue;
    }
    if (r.errors.length > 0) {
      const truncated = r.errors.slice(0, 5);
      errors.push(
        `${r.account}: ${truncated.join("; ")}${
          r.errors.length > truncated.length
            ? ` (+${r.errors.length - truncated.length} more)`
            : ""
        }`,
      );
    }
  }

  return { totalInserted, byAccount, errors, skipped };
}

// Re-export so route handlers can import everything from one module.
export { ACCOUNT_KEYS, AUDIT_ORDER };
export type { AccountKey };
