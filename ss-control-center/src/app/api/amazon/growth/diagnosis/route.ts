/**
 * GET /api/amazon/growth/diagnosis
 *
 * The Action Center brain — ranked, plain-language problems for one store
 * computed from the Listing Health mirror. No writes.
 *
 * Query: storeIndex (default 1; selling accounts 1 and 3).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { diagnoseAmazonGrowth } from "@/lib/amazon/growth/growth-diagnosis";

export async function GET(request: NextRequest) {
  const storeIndex = Number(request.nextUrl.searchParams.get("storeIndex") ?? 1);
  try {
    const result = await diagnoseAmazonGrowth(prisma, storeIndex);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
