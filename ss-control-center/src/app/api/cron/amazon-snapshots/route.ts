/**
 * GET /api/cron/amazon-snapshots
 *
 * Versioned content snapshots of our own-brand listings (Salutem Vita + Starfit,
 * incl. gift sets) — experiment engine, Phase 0. Writes a new snapshot only when
 * content changed, building the change-over-time history used for diff-in-diff
 * baselines and recovering lost winners.
 *
 * Auth: same Bearer CRON_SECRET gate as the other crons.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { snapshotOwnBrand } from "@/lib/amazon/growth/snapshots";

export const maxDuration = 300;

const STORES = [1, 3];

function requireCronAuth(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authFail = requireCronAuth(request);
  if (authFail) return authFail;

  const out: unknown[] = [];
  for (const storeIndex of STORES) {
    try {
      out.push({ storeIndex, ...(await snapshotOwnBrand(prisma, storeIndex, { max: 150 })) });
    } catch (err) {
      out.push({ storeIndex, error: (err as Error).message });
    }
  }
  return NextResponse.json({ ok: true, stores: out });
}
