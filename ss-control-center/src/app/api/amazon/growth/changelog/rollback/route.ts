/**
 * POST /api/amazon/growth/changelog/rollback
 *
 * Revert one attribute-set change: re-PATCH the field back to its logged
 * beforeValue (or delete it if it was added). Records the rollback in the log.
 *
 * Body: { id }   (the AmazonChangeLog row id)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { logChange } from "@/lib/amazon/growth/change-log";

export const maxDuration = 90;

export async function POST(request: NextRequest) {
  let id = "";
  try {
    id = String((await request.json())?.id ?? "");
  } catch {
    /* */
  }
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const row = await prisma.amazonChangeLog.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (row.changeType !== "attribute-set" || !row.field) {
    return NextResponse.json({ ok: false, error: "rollback only supported for attribute changes" }, { status: 422 });
  }
  if (row.rolledBack) return NextResponse.json({ ok: false, error: "already rolled back" }, { status: 409 });

  const before = row.beforeValue ? JSON.parse(row.beforeValue) : null;

  try {
    const sellerId = await getMerchantToken(row.storeIndex);
    const listing = await getListing(row.storeIndex, sellerId, row.sku);
    const productType = (listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0])?.productType;
    if (!productType) return NextResponse.json({ ok: false, error: "no productType" }, { status: 422 });

    // before === null → the field was added; revert by deleting it.
    const patches: ListingPatch[] = before
      ? [{ op: "replace", path: `/attributes/${row.field}`, value: [before] }]
      : [{ op: "delete", path: `/attributes/${row.field}` }];

    const resp = await patchListing(row.storeIndex, sellerId, row.sku, productType, patches, {});
    if (resp?.status !== "ACCEPTED") {
      return NextResponse.json({ ok: false, error: `Amazon rejected: ${resp?.issues?.[0]?.message ?? resp?.status}` }, { status: 502 });
    }

    await prisma.amazonChangeLog.update({ where: { id }, data: { rolledBack: true, rolledBackAt: new Date() } });
    await logChange(prisma, {
      storeIndex: row.storeIndex,
      sku: row.sku,
      source: "manual",
      changeType: "rollback",
      field: row.field,
      beforeValue: row.afterValue ? JSON.parse(row.afterValue) : null,
      afterValue: before,
      patch: patches,
      submissionId: resp?.submissionId,
      amazonStatus: resp?.status,
    }).catch(() => {});

    return NextResponse.json({ ok: true, id, status: resp?.status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
