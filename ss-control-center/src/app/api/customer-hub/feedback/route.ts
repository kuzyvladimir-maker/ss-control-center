import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET — list seller feedback for the Customer Hub "Feedback" tab.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const rating = sp.get("rating"); // "negative" | "1".."5"
    const store = sp.get("store");
    const status = sp.get("status");
    const limit = parseInt(sp.get("limit") || "50");

    const where: Record<string, unknown> = {};
    if (rating === "negative") where.rating = { lte: 2 };
    else if (rating) where.rating = parseInt(rating);
    if (store && store !== "all") where.store = store;
    if (status && status !== "all") where.status = status;

    const [feedback, total] = await Promise.all([
      prisma.sellerFeedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.sellerFeedback.count({ where }),
    ]);

    return NextResponse.json({ feedback, total });
  } catch (err) {
    console.error("[customer-hub/feedback] GET failed:", err);
    return NextResponse.json({ feedback: [], total: 0 });
  }
}
