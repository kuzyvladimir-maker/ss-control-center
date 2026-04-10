import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeMessage } from "@/lib/customer-hub/message-analyzer";

// GET — single message with conversation history
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const message = await prisma.buyerMessage.findUnique({ where: { id } });
    if (!message) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Conversation history — same order
    let history: typeof message[] = [];
    if (message.amazonOrderId) {
      history = await prisma.buyerMessage.findMany({
        where: {
          amazonOrderId: message.amazonOrderId,
          id: { not: id },
        },
        orderBy: { createdAt: "asc" },
      });
    }

    return NextResponse.json({ message, history });
  } catch (error) {
    console.error("Message GET error:", error);
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }
}

// POST — analyze or other actions
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    if (body.action === "analyze") {
      return await runAnalysis(id);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Message POST error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// PATCH — update status, notes, edited response
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    if (body.status) data.status = body.status;
    if (body.editedResponse !== undefined) data.editedResponse = body.editedResponse;
    if (body.vladimirNotes !== undefined) data.vladimirNotes = body.vladimirNotes;
    if (body.resolution) data.resolution = body.resolution;

    const updated = await prisma.buyerMessage.update({ where: { id }, data });
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Message PATCH error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

async function runAnalysis(id: string) {
  const message = await prisma.buyerMessage.findUnique({ where: { id } });
  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Get conversation history
  let history: typeof message[] = [];
  if (message.amazonOrderId) {
    history = await prisma.buyerMessage.findMany({
      where: {
        amazonOrderId: message.amazonOrderId,
        id: { not: id },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  const messageNumber = history.length + 1;

  // Check for related claims/feedback
  let hasAtozClaim = false;
  let hasNegativeFeedback = false;
  if (message.amazonOrderId) {
    const atoz = await prisma.atozzClaim.findFirst({
      where: { amazonOrderId: message.amazonOrderId },
    });
    hasAtozClaim = !!atoz;

    const feedback = await prisma.sellerFeedback.findFirst({
      where: { orderId: message.amazonOrderId, rating: { lte: 2 } },
    });
    hasNegativeFeedback = !!feedback;
  }

  const result = await analyzeMessage({
    customerMessage: message.customerMessage || "",
    customerName: message.customerName,
    language: message.language,
    storeName: message.storeName,
    amazonOrderId: message.amazonOrderId,
    orderDate: message.orderDate,
    orderTotal: message.orderTotal,
    product: message.product,
    productType: message.productType,
    carrier: message.carrier,
    service: message.service,
    trackingNumber: message.trackingNumber,
    trackingStatus: message.trackingStatus,
    shipDate: message.shipDate,
    promisedEdd: message.promisedEdd,
    actualDelivery: message.actualDelivery,
    daysLate: message.daysLate,
    boughtThroughVeeqo: message.boughtThroughVeeqo,
    claimsProtected: message.claimsProtected,
    shippedOnTime: message.shippedOnTime,
    messageNumber,
    conversationHistory: history.map((h) => ({
      date: h.createdAt.toISOString().split("T")[0],
      direction: h.direction,
      text: h.customerMessage || h.suggestedResponse || "",
      action: h.action,
    })),
    hasAtozClaim,
    hasNegativeFeedback,
  });

  // Save analysis to DB
  const updated = await prisma.buyerMessage.update({
    where: { id },
    data: {
      problemType: result.problemType,
      problemTypeName: result.problemTypeName,
      riskLevel: result.riskLevel,
      action: result.action,
      secondaryAction: result.secondaryAction,
      whoShouldPay: result.whoShouldPay,
      internalAction: result.internalAction,
      foodSafetyRisk: result.foodSafetyRisk,
      atozRisk: result.atozRisk,
      suggestedResponse: result.suggestedResponse,
      category: result.problemType,
      categoryName: result.problemTypeName,
      priority: result.riskLevel,
      status: "ANALYZED",
    },
  });

  return NextResponse.json({ message: updated, analysis: result });
}
