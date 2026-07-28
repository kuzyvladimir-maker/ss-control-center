import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/customer-hub/feedback/:id/remove
// Marks that a removal request has been submitted to Amazon for this feedback.
// This doesn't actually call SP-API — Amazon doesn't expose programmatic
// feedback removal; the operator copies the removalRequestText and pastes it
// into Seller Central. This endpoint just records that the submission was
// made so the status can be tracked in the UI.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const updated = await prisma.sellerFeedback.update({
      where: { id },
      data: {
        status: "REMOVAL_SUBMITTED",
        removalSubmittedAt: new Date(),
      },
    });
    return NextResponse.json({ id, requested: true, feedback: updated });
  } catch (err) {
    console.error("[customer-hub/feedback/:id/remove] POST failed:", err);
    return NextResponse.json(
      { error: "Failed to mark as submitted" },
      { status: 500 }
    );
  }
}
