import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { updateSkuRiskProfile } from "@/lib/frozen-analytics";

// GET — single incident detail
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const incident = await prisma.frozenIncident.findUnique({ where: { id } });
  if (!incident) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(incident);
}

// PATCH — update incident (outcome, notes)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const incident = await prisma.frozenIncident.update({
      where: { id },
      data: {
        ...(body.outcome && { outcome: body.outcome }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.resolution && { resolution: body.resolution }),
      },
    });

    // Recalculate SKU risk after update
    await updateSkuRiskProfile(incident.sku, incident.productName);

    return NextResponse.json(incident);
  } catch (error) {
    console.error("Update incident error:", error);
    return NextResponse.json(
      { error: "Failed to update incident" },
      { status: 500 }
    );
  }
}
