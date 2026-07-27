import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const claim = await prisma.atozzClaim.findUnique({ where: { id } });
  if (!claim) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(claim);
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
    if (body.generatedResponse !== undefined) data.generatedResponse = body.generatedResponse;
    if (body.editedResponse !== undefined) data.editedResponse = body.editedResponse;
    if (body.amazonDecision) {
      data.amazonDecision = body.amazonDecision;
      data.decisionDate = new Date().toISOString().split("T")[0];
      if (body.amazonDecision === "IN_OUR_FAVOR" || body.amazonDecision === "AMAZON_FUNDED") {
        data.amountSaved = body.amount;
      } else if (body.amazonDecision === "AGAINST_US") {
        data.amountCharged = body.amount;
      }
    }
    if (body.appealSubmitted !== undefined) data.appealSubmitted = body.appealSubmitted;
    if (body.appealText !== undefined) data.appealText = body.appealText;
    if (body.vladimirNotes !== undefined) data.vladimirNotes = body.vladimirNotes;

    const claim = await prisma.atozzClaim.update({ where: { id }, data });
    return NextResponse.json(claim);
  } catch (error) {
    console.error("Update claim error:", error);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}
