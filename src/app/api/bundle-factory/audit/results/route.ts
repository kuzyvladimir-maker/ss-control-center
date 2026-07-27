/**
 * GET /api/bundle-factory/audit/results
 *   ?scan_id=<scanId>           (required)
 *   ?risk_category=BLOCKED|WARNING|LOW_RISK|COMPLIANT
 *   ?account=SALUTEM|PERSONAL|AMZCOM|SIRIUS|RETAILER
 *   ?remediation_status=PENDING|REGENERATING|UPDATED|SKIPPED|FAILED|MANUAL_REVIEW
 *   ?limit=100  (default 100, max 1000)
 *
 *   Returns one row per audited listing for the given scan, ranked by
 *   risk_score desc. The UI uses this for the main audit table.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  intParam,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import { ACCOUNT_KEYS } from "@/lib/bundle-factory/audit/account-map";

export const dynamic = "force-dynamic";

const RISK_CATEGORIES = ["BLOCKED", "WARNING", "LOW_RISK", "COMPLIANT"] as const;
const REMEDIATION_STATUSES = [
  "PENDING",
  "REGENERATING",
  "UPDATED",
  "SKIPPED",
  "FAILED",
  "MANUAL_REVIEW",
] as const;

export const GET = withErrorHandler(
  "audit/results",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const scanId = searchParams.get("scan_id");
    const riskCategory = searchParams.get("risk_category");
    const account = searchParams.get("account");
    const remediationStatus = searchParams.get("remediation_status");
    const limit = Math.min(
      1000,
      Math.max(1, intParam(searchParams, "limit", 100)),
    );

    if (!scanId) return badRequest("scan_id is required");
    if (
      riskCategory &&
      !RISK_CATEGORIES.includes(riskCategory as (typeof RISK_CATEGORIES)[number])
    ) {
      return badRequest(
        `Invalid risk_category. Allowed: ${RISK_CATEGORIES.join(", ")}`,
      );
    }
    if (account && !ACCOUNT_KEYS.includes(account as (typeof ACCOUNT_KEYS)[number])) {
      return badRequest(
        `Invalid account. Allowed: ${ACCOUNT_KEYS.join(", ")}`,
      );
    }
    if (
      remediationStatus &&
      !REMEDIATION_STATUSES.includes(
        remediationStatus as (typeof REMEDIATION_STATUSES)[number],
      )
    ) {
      return badRequest(
        `Invalid remediation_status. Allowed: ${REMEDIATION_STATUSES.join(", ")}`,
      );
    }

    const results = await prisma.listingAuditResult.findMany({
      where: {
        scan_id: scanId,
        ...(riskCategory ? { risk_category: riskCategory } : {}),
        ...(account ? { account } : {}),
        ...(remediationStatus ? { remediation_status: remediationStatus } : {}),
      },
      orderBy: [{ risk_score: "desc" }, { created_at: "asc" }],
      take: limit,
    });

    return NextResponse.json({ results, count: results.length });
  },
);
