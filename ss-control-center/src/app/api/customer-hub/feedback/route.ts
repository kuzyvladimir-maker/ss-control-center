import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/customer-hub/feedback
// Lists seller feedback for the Customer Hub "Feedback" tab.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const rating = sp.get("rating"); // "negative" | "1".."5" | null
    const store = sp.get("store");
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");
    const page = parseInt(sp.get("page") || "1");

    const where: Record<string, unknown> = {};
    if (rating === "negative") where.rating = { lte: 2 };
    else if (rating) where.rating = parseInt(rating);
    if (store && store !== "all") where.store = store;
    if (status && status !== "all") where.status = status;

    const [feedbacks, total] = await Promise.all([
      prisma.sellerFeedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: Math.max(0, (page - 1) * limit),
      }),
      prisma.sellerFeedback.count({ where }),
    ]);

    return NextResponse.json({ feedbacks, total });
  } catch (err) {
    console.error("[customer-hub/feedback] GET failed:", err);
    return NextResponse.json({ feedbacks: [], total: 0 });
  }
}

// POST /api/customer-hub/feedback
// Actions: { action: "sync" } → triggers feedback sync from SP-API Reports.
// Currently a stub — real sync will land when SP-API Feedback Reports is wired up.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.action !== "sync") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
    return NextResponse.json({
      synced: 0,
      message: "SP-API Feedback Reports sync coming soon",
    });
  } catch (err) {
    console.error("[customer-hub/feedback] POST failed:", err);
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 500 }
    );
  }
}
