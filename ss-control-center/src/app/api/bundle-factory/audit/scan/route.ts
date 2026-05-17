/**
 * POST /api/bundle-factory/audit/scan
 *   Kicks off a new listing audit scan across all 5 Amazon accounts.
 *
 *   Returns immediately with the scan_id so the UI can poll
 *   /api/bundle-factory/audit/scans?id=…. The actual scanner runs in
 *   the background via fire-and-forget; on Vercel Hobby plan (60 s
 *   function cap) this may be killed mid-run, in which case partial
 *   results are still queryable and the scan can be re-run.
 *
 *   Body (all optional):
 *     {
 *       "initiated_by": "vladimir",
 *       "accounts": ["RETAILER", "SALUTEM"]     // restrict scope
 *     }
 *
 *   Response: { scan_id, status: 'pending' }
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { scanAllAccounts } from "@/lib/bundle-factory/audit/scanner";
import { scoreAuditResult } from "@/lib/bundle-factory/audit/risk-scorer";
import {
  ACCOUNT_KEYS,
  AUDIT_ORDER,
  type AccountKey,
} from "@/lib/bundle-factory/audit/account-map";

export const dynamic = "force-dynamic";
// Pro plans honour this up to 300; on Hobby it's clipped to 60 s and the
// scan continues to fire-and-forget — partial results remain in the DB.
export const maxDuration = 300;
export const runtime = "nodejs";

interface ScanRequestBody {
  initiated_by?: string;
  accounts?: string[];
}

async function runScanBackground(
  scanId: string,
  accounts: readonly AccountKey[],
) {
  try {
    const { totalInserted, byAccount, errors } = await scanAllAccounts(
      scanId,
      accounts,
    );

    // Score every freshly-inserted result.
    const newResults = await prisma.listingAuditResult.findMany({
      where: { scan_id: scanId },
      select: { id: true },
    });
    const counts = { BLOCKED: 0, WARNING: 0, LOW_RISK: 0, COMPLIANT: 0 };
    const scoringErrors: string[] = [];
    for (const r of newResults) {
      try {
        const { category } = await scoreAuditResult(r.id);
        counts[category]++;
      } catch (e) {
        scoringErrors.push(
          `${r.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const allErrors = [...errors, ...scoringErrors.slice(0, 10)];

    await prisma.listingAuditScan.update({
      where: { id: scanId },
      data: {
        status: "completed",
        completed_at: new Date(),
        total_listings: totalInserted,
        blocked_count: counts.BLOCKED,
        warning_count: counts.WARNING,
        low_risk_count: counts.LOW_RISK,
        compliant_count: counts.COMPLIANT,
        error_message: allErrors.length
          ? allErrors.join("\n").slice(0, 4000)
          : null,
      },
    });

    console.log(
      `[audit/scan] ${scanId} complete · total=${totalInserted} · ` +
        `byAccount=${JSON.stringify(byAccount)} · counts=${JSON.stringify(counts)}`,
    );
  } catch (e) {
    await prisma.listingAuditScan.update({
      where: { id: scanId },
      data: {
        status: "failed",
        completed_at: new Date(),
        error_message: e instanceof Error ? e.message : String(e),
      },
    });
  }
}

export const POST = withErrorHandler("audit/scan", async (request: Request) => {
  const body = (await readJson<ScanRequestBody>(request)) ?? {};

  let accounts: readonly AccountKey[] = AUDIT_ORDER;
  if (Array.isArray(body.accounts) && body.accounts.length > 0) {
    const invalid = body.accounts.filter(
      (a) => !ACCOUNT_KEYS.includes(a as AccountKey),
    );
    if (invalid.length > 0) {
      return badRequest(
        `Unknown account(s): ${invalid.join(", ")}. Allowed: ${ACCOUNT_KEYS.join(", ")}`,
      );
    }
    accounts = body.accounts as AccountKey[];
  }

  const scan = await prisma.listingAuditScan.create({
    data: {
      initiated_by: body.initiated_by ?? "vladimir",
      status: "pending",
      accounts_scanned: JSON.stringify(accounts),
    },
  });

  // Fire-and-forget. We intentionally do not await — the route returns
  // immediately so the UI can render a "scanning…" spinner and poll.
  void runScanBackground(scan.id, accounts);

  return NextResponse.json({ scan_id: scan.id, status: "pending" });
});
