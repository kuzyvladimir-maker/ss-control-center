import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { collectFrozenIncidentData } from "@/lib/frozen-analytics";

// GET — list incidents with filters
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const carrier = sp.get("carrier");
  const service = sp.get("service");
  const outcome = sp.get("outcome");
  const sku = sp.get("sku");
  const days = parseInt(sp.get("days") || "90");
  const limit = parseInt(sp.get("limit") || "100");

  const where: Record<string, unknown> = {};
  if (carrier) where.carrier = carrier;
  if (service) where.service = { contains: service };
  if (outcome) where.outcome = outcome;
  if (sku) where.sku = sku;

  // Date range filter
  const since = new Date();
  since.setDate(since.getDate() - days);
  where.createdAt = { gte: since };

  const [incidents, total] = await Promise.all([
    prisma.frozenIncident.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.frozenIncident.count({ where }),
  ]);

  return NextResponse.json({ incidents, total });
}

// POST — manually add an incident (by Order ID)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      orderId,
      sku,
      productName,
      carrier,
      service,
      shipDate,
      promisedEdd,
      actualDelivery,
      trackingNumber,
      destZip,
      destCity,
      destState,
      claimsProtectedBadge,
      labelCost,
      boxSize,
      weightLbs,
      outcome,
      notes,
    } = body;

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const incident = await collectFrozenIncidentData(
      body.csCaseId || null,
      orderId,
      {
        sku,
        productName,
        carrier,
        service,
        shipDate,
        promisedEdd,
        actualDelivery,
        trackingNumber,
        destZip,
        destCity,
        destState,
        claimsProtectedBadge,
        labelCost,
        boxSize,
        weightLbs,
      }
    );

    if (!incident) {
      return NextResponse.json(
        { error: "Failed to create incident" },
        { status: 500 }
      );
    }

    // Update outcome/notes if provided
    if (outcome || notes) {
      await prisma.frozenIncident.update({
        where: { id: incident.id },
        data: {
          ...(outcome && { outcome }),
          ...(notes && { notes }),
        },
      });
    }

    return NextResponse.json(incident);
  } catch (error) {
    console.error("Create incident error:", error);
    return NextResponse.json(
      { error: "Failed to create incident" },
      { status: 500 }
    );
  }
}
