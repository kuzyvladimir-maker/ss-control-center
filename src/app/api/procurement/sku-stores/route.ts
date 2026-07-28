import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMissingTableError } from "@/lib/procurement/store-list";

export const dynamic = "force-dynamic";

/**
 * Batch read of store priorities for many SKUs at once.
 *
 * GET /api/procurement/sku-stores?sku=A&sku=B&sku=C
 *   → { prioritiesBySku: { A: ["Publix","Walmart"], B: [...], ... }, dbReady: true }
 *
 * Used by the Procurement page to populate per-card store chips without
 * firing one request per visible card. SKUs missing from the response
 * have no entry — the UI shows "магазины не указаны".
 */
export async function GET(req: NextRequest) {
  const skus = req.nextUrl.searchParams.getAll("sku").filter(Boolean);
  if (skus.length === 0) {
    return NextResponse.json({ prioritiesBySku: {}, dbReady: true });
  }

  try {
    const rows = await prisma.sKUStorePriority.findMany({
      where: { sku: { in: skus } },
      orderBy: { priority: "asc" },
      select: { sku: true, storeName: true, priority: true },
    });

    const map: Record<string, string[]> = {};
    for (const r of rows) {
      (map[r.sku] ??= []).push(r.storeName);
    }
    return NextResponse.json({ prioritiesBySku: map, dbReady: true });
  } catch (e: unknown) {
    if (isMissingTableError(e)) {
      return NextResponse.json({ prioritiesBySku: {}, dbReady: false });
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/sku-stores batch]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
