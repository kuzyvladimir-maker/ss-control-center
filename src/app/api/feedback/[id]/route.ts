import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const feedback = await prisma.sellerFeedback.findUnique({ where: { id } });
  if (!feedback) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(feedback);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const data: Record<string, unknown> = {};
    if (body.status) data.status = body.status;
    if (body.removable !== undefined) data.removable = body.removable;
    if (body.removalCategory !== undefined) data.removalCategory = body.removalCategory;
    if (body.removalConfidence !== undefined) data.removalConfidence = body.removalConfidence;
    if (body.suggestedAction !== undefined) data.suggestedAction = body.suggestedAction;
    if (body.aiReasoning !== undefined) data.aiReasoning = body.aiReasoning;
    if (body.removalRequestText !== undefined) data.removalRequestText = body.removalRequestText;
    if (body.removalDecision) {
      data.removalDecision = body.removalDecision;
      data.removalDecisionAt = new Date();
    }
    if (body.buyerContactText !== undefined) data.buyerContactText = body.buyerContactText;
    if (body.buyerContactSent) {
      data.buyerContactSent = true;
      data.buyerContactSentAt = new Date();
    }
    if (body.vladimirNotes !== undefined) data.vladimirNotes = body.vladimirNotes;

    if (body.status === "REMOVAL_SUBMITTED") {
      data.removalSubmittedAt = new Date();
    }

    const feedback = await prisma.sellerFeedback.update({
      where: { id },
      data,
    });

    return NextResponse.json(feedback);
  } catch (error) {
    console.error("Update feedback error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
