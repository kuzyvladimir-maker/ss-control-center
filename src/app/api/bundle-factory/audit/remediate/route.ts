/**
 * POST /api/bundle-factory/audit/remediate
 *   Marks one or more audit results for remediation.
 *
 *   Phase 2.0a only supports the **manual_review** path — the
 *   automated regeneration pipeline (Bundle Factory Stage 4/5 + SP-API
 *   patch) ships in Phase 2.1. For now this endpoint:
 *     1. Creates a ListingRemediation row per audit result.
 *     2. Sets ListingAuditResult.remediation_status = 'MANUAL_REVIEW'.
 *     3. Returns the list of created remediation IDs so the UI can
 *        link the operator to the case for Vladimir to handle manually.
 *
 *   Body:
 *     { "audit_result_ids": [ "cuid1", "cuid2", ... ] }
 *
 *   Response:
 *     { remediations: [{ id, audit_result_id, status }], count }
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  readJson,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RemediateBody {
  audit_result_ids?: string[];
}

export const POST = withErrorHandler(
  "audit/remediate",
  async (request: Request) => {
    const body = (await readJson<RemediateBody>(request)) ?? {};
    const ids = Array.isArray(body.audit_result_ids)
      ? body.audit_result_ids.filter((s) => typeof s === "string" && s.length > 0)
      : [];
    if (ids.length === 0) {
      return badRequest("audit_result_ids must be a non-empty array of strings");
    }

    const audits = await prisma.listingAuditResult.findMany({
      where: { id: { in: ids } },
      include: { remediation: true },
    });
    if (audits.length === 0) {
      return badRequest("No matching audit results found", { requested: ids });
    }

    const created: Array<{
      id: string;
      audit_result_id: string;
      status: string;
    }> = [];

    for (const a of audits) {
      // Skip if a remediation already exists for this audit — operator
      // shouldn't double-spawn manual reviews.
      if (a.remediation) {
        created.push({
          id: a.remediation.id,
          audit_result_id: a.id,
          status: a.remediation.status,
        });
        continue;
      }
      const rem = await prisma.listingRemediation.create({
        data: {
          audit_result_id: a.id,
          status: "manual_review",
          original_title: a.title,
          original_bullets: a.original_bullets,
          original_description: a.original_description,
          original_image_url: a.main_image_url,
        },
      });
      await prisma.listingAuditResult.update({
        where: { id: a.id },
        data: { remediation_status: "MANUAL_REVIEW" },
      });
      created.push({ id: rem.id, audit_result_id: a.id, status: rem.status });
    }

    return NextResponse.json({ remediations: created, count: created.length });
  },
);
