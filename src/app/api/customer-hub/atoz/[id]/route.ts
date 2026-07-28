import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateAtozResponse } from "@/lib/customer-hub/atoz-analyzer";

// GET — single A-to-Z claim or chargeback
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const claim = await prisma.atozzClaim.findUnique({ where: { id } });
    if (!claim) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ claim });
  } catch (err) {
    console.error("[atoz/[id]] GET failed:", err);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

// POST — actions: "analyze" (generate AI response + strategy)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.action === "analyze") {
      const claim = await prisma.atozzClaim.findUnique({ where: { id } });
      if (!claim) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const result = await generateAtozResponse(claim);

      const updated = await prisma.atozzClaim.update({
        where: { id },
        data: {
          generatedResponse: result.amazonResponse,
          strategyType: result.strategyType,
          strategyConfidence: result.strategyConfidence,
          evidenceSummary: result.evidenceSummary,
          status:
            claim.status === "NEW" || claim.status === "EVIDENCE_GATHERED"
              ? "RESPONSE_READY"
              : claim.status,
        },
      });

      return NextResponse.json({
        claim: updated,
        analysis: result,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("[atoz/[id]] POST failed:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// PATCH — partial update (status, notes, edited response, amazon decision)
const PATCHABLE = [
  "status",
  "editedResponse",
  "vladimirNotes",
  "amazonDecision",
  "amountCharged",
  "amountSaved",
] as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    for (const f of PATCHABLE) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No patchable fields" },
        { status: 400 }
      );
    }
    const updated = await prisma.atozzClaim.update({ where: { id }, data });
    return NextResponse.json({ claim: updated });
  } catch (err) {
    console.error("[atoz/[id]] PATCH failed:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
