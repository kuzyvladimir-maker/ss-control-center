/**
 * GET /api/walmart/growth/diagnosis
 *
 * The Action Center brain: scans Listing Quality + Buy Box + live shipping
 * templates and returns a ranked, plain-language problem list with what-to-do
 * + the action to run. See src/lib/walmart/growth-diagnosis.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WalmartClient } from "@/lib/walmart/client";
import { diagnoseWalmartGrowth } from "@/lib/walmart/growth-diagnosis";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const storeIndex = Number(request.nextUrl.searchParams.get("storeIndex") ?? 1);
  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  try {
    const result = await diagnoseWalmartGrowth(prisma, client, storeIndex);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
