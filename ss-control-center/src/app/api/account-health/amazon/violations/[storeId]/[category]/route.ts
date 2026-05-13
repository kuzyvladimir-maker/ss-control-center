import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/account-health/amazon/violations/[storeId]/[category]
// Returns the per-listing details for the latest snapshot of this store
// and the given policy category. Used by the drill-down Sheet.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ storeId: string; category: string }> }
) {
  const { storeId, category } = await params;
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store || store.storeIndex == null) {
    return NextResponse.json({ details: [] });
  }
  const snapshot = await prisma.accountHealthSnapshot.findFirst({
    where: { storeId: `store${store.storeIndex}` },
    orderBy: { createdAt: "desc" },
  });
  if (!snapshot) return NextResponse.json({ details: [] });

  const cat = await prisma.policyViolationCategory.findFirst({
    where: { snapshotId: snapshot.id, category },
  });
  if (!cat) return NextResponse.json({ details: [] });

  const details = await prisma.policyViolationDetail.findMany({
    where: { categoryId: cat.id },
    orderBy: { reportedAt: "desc" },
  });

  return NextResponse.json({
    category: cat.category,
    displayName: cat.displayName,
    count: cat.count,
    status: cat.status,
    details,
  });
}
