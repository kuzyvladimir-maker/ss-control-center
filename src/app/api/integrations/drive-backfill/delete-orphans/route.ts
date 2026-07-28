// POST /api/integrations/drive-backfill/delete-orphans
//
// Manually removes ShippingPlanItem rows for an order whose label PDFs
// never made it to Drive AND can't be back-filled (Veeqo returns a stub
// PDF or 404). These are typically test/experiment purchases from before
// the Drive integration was working — they clutter the back-fill cron's
// error list forever.
//
// Safe-by-design: only deletes rows where labelPdfUrl is null OR points
// at our /api/shipping/label-pdf proxy. A row that already has a Drive
// webViewLink is untouched.
//
// Body: { orderNumber: string }
// Auth: admin (requireAdmin)

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({}));
  const orderNumber =
    typeof body.orderNumber === "string" ? body.orderNumber.trim() : "";

  if (!orderNumber) {
    return NextResponse.json(
      { error: "orderNumber is required" },
      { status: 400 },
    );
  }

  // Find matching rows first so we can return what was deleted to the
  // operator (useful for confirmation in the UI).
  const candidates = await prisma.shippingPlanItem.findMany({
    where: {
      orderNumber,
      status: "bought",
      OR: [
        { labelPdfUrl: null },
        { labelPdfUrl: { contains: "/api/shipping/label-pdf" } },
      ],
    },
    select: { id: true, orderNumber: true, sku: true, labelPdfUrl: true },
  });

  if (candidates.length === 0) {
    return NextResponse.json({
      deleted: 0,
      message:
        "No matching orphan rows for that orderNumber (either everything is already on Drive, or the order does not exist).",
    });
  }

  const result = await prisma.shippingPlanItem.deleteMany({
    where: { id: { in: candidates.map((c) => c.id) } },
  });

  return NextResponse.json({
    deleted: result.count,
    items: candidates.map((c) => ({
      id: c.id,
      orderNumber: c.orderNumber,
      sku: c.sku,
    })),
  });
}
