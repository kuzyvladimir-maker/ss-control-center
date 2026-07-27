/**
 * GET /api/adjustments/sync-log
 *
 * Returns the 10 most-recent SyncLog entries whose jobName begins
 * with "adjustments". Drives the scan-history panel on /adjustments
 * so the operator can see "last successful run, N rows added".
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.syncLog.findMany({
    where: { jobName: { startsWith: "adjustments" } },
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  return NextResponse.json({ entries: rows });
}
