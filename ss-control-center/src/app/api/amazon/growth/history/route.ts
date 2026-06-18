/**
 * Amazon Growth — daily history + recovery API (experiment engine, Phase 0).
 *
 * GET ?storeIndex                  → coverage stats + lost-winner candidates + snapshot count
 * GET ?storeIndex&asin=XXX         → that ASIN's daily funnel series (trend)
 * POST { action }                  → ingestLatest | snapshot | backfill (operator-triggered)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ingestDay, backfillDays, latestSettledDay } from "@/lib/amazon/growth/daily-history";
import { snapshotOwnBrand } from "@/lib/amazon/growth/snapshots";
import { detectLostWinners } from "@/lib/amazon/growth/lost-winners";
import { getCatalogContent } from "@/lib/amazon/growth/catalog";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing, patchListing, type ListingPatch } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { logChange } from "@/lib/amazon/growth/change-log";

export const maxDuration = 300;

const DAY_MS = 864e5;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const asin = sp.get("asin");

  // Recovery rebuild kit: the best available content to restore an ASIN with —
  // our latest snapshot first, else the live catalog (works even if our offer is gone).
  if (asin && sp.get("view") === "rebuild") {
    const snap = await prisma.amazonListingSnapshot.findFirst({
      where: { storeIndex, asin },
      orderBy: { capturedAt: "desc" },
      select: { id: true, sku: true, title: true, bulletsJson: true, mainImageUrl: true, imageCount: true, capturedAt: true },
    });
    const inMirror = await prisma.amazonListingHealthItem.findFirst({ where: { storeIndex, asin }, select: { sku: true } });
    const catalog = await getCatalogContent(storeIndex, asin);
    return NextResponse.json({
      asin,
      inMirror: !!inMirror,
      sku: snap?.sku ?? inMirror?.sku ?? null,
      snapshot: snap
        ? { id: snap.id, title: snap.title, bullets: snap.bulletsJson ? JSON.parse(snap.bulletsJson) : [], mainImageUrl: snap.mainImageUrl, imageCount: snap.imageCount, capturedAt: snap.capturedAt }
        : null,
      catalog,
      bestSource: snap ? "snapshot" : catalog ? "catalog" : "none",
    });
  }

  // Per-ASIN trend.
  if (asin) {
    const rows = await prisma.amazonAsinDaily.findMany({
      where: { storeIndex, asin },
      orderBy: { date: "asc" },
      select: { date: true, sessions: true, unitsOrdered: true, orderedProductSales: true, unitSessionPct: true, featuredOfferPct: true },
    });
    return NextResponse.json({ asin, series: rows });
  }

  const [rowCount, distinctDays, distinctAsins, range, snapCount, lastSnap, lostWinners] = await Promise.all([
    prisma.amazonAsinDaily.count({ where: { storeIndex } }),
    prisma.amazonAsinDaily.findMany({ where: { storeIndex }, distinct: ["date"], select: { date: true } }),
    prisma.amazonAsinDaily.findMany({ where: { storeIndex }, distinct: ["asin"], select: { asin: true } }),
    prisma.amazonAsinDaily.aggregate({ where: { storeIndex }, _min: { date: true }, _max: { date: true } }),
    prisma.amazonListingSnapshot.count({ where: { storeIndex } }),
    prisma.amazonListingSnapshot.findFirst({ where: { storeIndex }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true } }),
    detectLostWinners(prisma, storeIndex, { resolveBrand: 12 }).catch(() => []),
  ]);

  return NextResponse.json({
    storeIndex,
    coverage: {
      rows: rowCount,
      days: distinctDays.length,
      asins: distinctAsins.length,
      firstDate: range._min.date,
      lastDate: range._max.date,
    },
    snapshots: { count: snapCount, lastAt: lastSnap?.capturedAt ?? null },
    lostWinners,
  });
}

export async function POST(request: NextRequest) {
  let storeIndex = 1;
  let action = "";
  let days = 90;
  let body0: Record<string, unknown> = {};
  try {
    const body = await request.json();
    body0 = body ?? {};
    if (body?.storeIndex) storeIndex = Number(body.storeIndex);
    action = String(body?.action ?? "");
    if (body?.days) days = Math.min(Number(body.days), 120);
  } catch {
    /* */
  }

  try {
    if (action === "ingestLatest") {
      const written = await ingestDay(prisma, storeIndex, latestSettledDay());
      return NextResponse.json({ ok: true, action, written });
    }
    if (action === "snapshot") {
      const res = await snapshotOwnBrand(prisma, storeIndex, { max: 60 });
      return NextResponse.json({ ok: true, action, ...res });
    }
    // Restore a listing's CONTENT (title/bullets/description) to a saved snapshot.
    // Only for listings that still exist (an active offer to PATCH). Logged + reversible.
    if (action === "restoreSnapshot") {
      const sku = String(body0.sku ?? "");
      const snapshotId = body0.snapshotId ? String(body0.snapshotId) : null;
      if (!sku) return NextResponse.json({ ok: false, error: "sku required" }, { status: 400 });
      const snap = snapshotId
        ? await prisma.amazonListingSnapshot.findUnique({ where: { id: snapshotId } })
        : await prisma.amazonListingSnapshot.findFirst({ where: { storeIndex, sku }, orderBy: { capturedAt: "desc" } });
      if (!snap?.attributesJson) return NextResponse.json({ ok: false, error: "no snapshot content" }, { status: 404 });

      const sellerId = await getMerchantToken(storeIndex);
      const listing = await getListing(storeIndex, sellerId, sku);
      const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
      const productType = summary?.productType;
      if (!productType) return NextResponse.json({ ok: false, error: "listing not found / no productType (offer gone — rebuild instead)" }, { status: 422 });

      const snapAttrs = JSON.parse(snap.attributesJson) as Record<string, unknown>;
      const CONTENT_FIELDS = ["item_name", "bullet_point", "product_description"];
      const patches: ListingPatch[] = [];
      for (const f of CONTENT_FIELDS) {
        if (snapAttrs[f] !== undefined) patches.push({ op: "replace", path: `/attributes/${f}`, value: snapAttrs[f] });
      }
      if (patches.length === 0) return NextResponse.json({ ok: false, error: "snapshot has no content fields" }, { status: 422 });

      const preview = await patchListing(storeIndex, sellerId, sku, productType, patches, { validationPreview: true });
      if (preview?.status !== "VALID") {
        return NextResponse.json({ ok: false, error: `Amazon rejected restore: ${preview?.issues?.[0]?.message ?? preview?.status}` }, { status: 502 });
      }
      const resp = await patchListing(storeIndex, sellerId, sku, productType, patches, {});
      const applied = resp?.status === "ACCEPTED";
      if (applied) {
        await logChange(prisma, {
          storeIndex, sku, source: "manual", changeType: "restore-snapshot", field: "content",
          beforeValue: null, afterValue: { snapshotId: snap.id, capturedAt: snap.capturedAt, fields: patches.map((p) => p.path) },
          patch: patches, submissionId: resp?.submissionId, amazonStatus: resp?.status,
        }).catch(() => {});
      }
      return NextResponse.json({ ok: applied, action, status: resp?.status, restoredFields: patches.length, fromSnapshot: snap.capturedAt });
    }

    if (action === "backfill") {
      const to = latestSettledDay();
      const from = new Date(to.getTime() - days * DAY_MS);
      // Bounded per call so the function never times out; call repeatedly to finish.
      const res = await backfillDays(prisma, storeIndex, from, to, { maxDays: 6 });
      return NextResponse.json({ ok: true, action, ...res });
    }
    return NextResponse.json({ ok: false, error: `unknown action ${action}` }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
