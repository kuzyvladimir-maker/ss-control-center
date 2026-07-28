import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET — list seller feedback with filters
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const type = sp.get("type") || "seller"; // seller | reviews
  const rating = sp.get("rating"); // 1,2,3,4,5 or "negative" (1-2)
  const store = sp.get("store");
  const status = sp.get("status");
  const limit = parseInt(sp.get("limit") || "50");

  if (type === "reviews") {
    const where: Record<string, unknown> = {};
    if (rating) where.rating = parseInt(rating);
    if (store) where.store = store;

    const [reviews, total] = await Promise.all([
      prisma.productReview.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.productReview.count({ where }),
    ]);
    return NextResponse.json({ items: reviews, total, type: "reviews" });
  }

  // Seller feedback
  const where: Record<string, unknown> = {};
  if (rating === "negative") {
    where.rating = { lte: 2 };
  } else if (rating) {
    where.rating = parseInt(rating);
  }
  if (store) where.store = store;
  if (status) where.status = status;

  const [items, total] = await Promise.all([
    prisma.sellerFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.sellerFeedback.count({ where }),
  ]);

  return NextResponse.json({ items, total, type: "seller" });
}

// POST — manually add feedback entry
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.type === "review") {
      const review = await prisma.productReview.create({
        data: {
          asin: body.asin,
          reviewId: body.reviewId || `manual-${Date.now()}`,
          rating: body.rating,
          title: body.title,
          body: body.body,
          reviewDate: body.reviewDate || new Date().toISOString().split("T")[0],
          verified: body.verified || false,
          store: body.store,
        },
      });
      return NextResponse.json(review);
    }

    const feedback = await prisma.sellerFeedback.create({
      data: {
        amazonFeedbackId: body.amazonFeedbackId || `manual-${Date.now()}`,
        orderId: body.orderId,
        amazonOrderId: body.amazonOrderId,
        rating: body.rating,
        comments: body.comments,
        feedbackDate: body.feedbackDate || new Date().toISOString().split("T")[0],
        store: body.store,
        channel: body.channel || "Amazon",
      },
    });

    return NextResponse.json(feedback);
  } catch (error) {
    console.error("Create feedback error:", error);
    return NextResponse.json(
      { error: "Failed to create feedback" },
      { status: 500 }
    );
  }
}
