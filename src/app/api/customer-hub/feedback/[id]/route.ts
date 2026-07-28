import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeFeedback } from "@/lib/customer-hub/feedback-analyzer";

// GET /api/customer-hub/feedback/:id
// Returns a single SellerFeedback row with all fields.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const feedback = await prisma.sellerFeedback.findUnique({ where: { id } });
    if (!feedback) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(feedback);
  } catch (err) {
    console.error("[customer-hub/feedback/:id] GET failed:", err);
    return NextResponse.json({ error: "Failed to load" }, { status: 500 });
  }
}

// POST /api/customer-hub/feedback/:id
// Actions: { action: "analyze" } → runs Claude analyzer and writes results
// back onto the row. Re-analyze is just calling this again.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    if (body.action !== "analyze") {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    const feedback = await prisma.sellerFeedback.findUnique({ where: { id } });
    if (!feedback) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Claude API wrapper already has its own try/catch + heuristic fallback;
    // wrap the call here too so any unexpected error still returns cleanly.
    let analysis;
    try {
      analysis = await analyzeFeedback({
        rating: feedback.rating,
        comments: feedback.comments,
        amazonOrderId: feedback.amazonOrderId,
        store: feedback.store,
        storeName: feedback.store,
      });
    } catch (err) {
      console.error("[customer-hub/feedback/:id] analyzer threw:", err);
      return NextResponse.json(
        { error: "Analysis failed", detail: (err as Error).message },
        { status: 502 }
      );
    }

    const updated = await prisma.sellerFeedback.update({
      where: { id },
      data: {
        removable: analysis.removable,
        removalCategory: analysis.removalCategory,
        removalConfidence: analysis.removalConfidence,
        aiReasoning: analysis.aiReasoning,
        removalRequestText: analysis.removalRequestText,
        suggestedAction: analysis.suggestedAction,
        publicResponse: analysis.publicResponse,
        status: "ANALYZED",
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[customer-hub/feedback/:id] POST failed:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// PATCH /api/customer-hub/feedback/:id
// Partial update for status, notes, or removal submission timestamp.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const data: Record<string, unknown> = {};
    if (typeof body.status === "string") data.status = body.status;
    if (typeof body.vladimirNotes === "string")
      data.vladimirNotes = body.vladimirNotes;
    if (body.removalSubmittedAt !== undefined) {
      data.removalSubmittedAt =
        body.removalSubmittedAt === null
          ? null
          : new Date(body.removalSubmittedAt);
    }
    if (typeof body.publicResponse === "string")
      data.publicResponse = body.publicResponse;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No fields to update" },
        { status: 400 }
      );
    }

    const updated = await prisma.sellerFeedback.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  } catch (err) {
    console.error("[customer-hub/feedback/:id] PATCH failed:", err);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
