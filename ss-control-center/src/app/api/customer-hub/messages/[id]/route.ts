import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  analyzeMessage,
  factCheckResponse,
  validateAndFixResponse,
} from "@/lib/customer-hub/message-analyzer";
import type { AnalysisInput } from "@/lib/customer-hub/message-analyzer";

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
    if (body.action === "rewrite") {
      return await runRewrite(id, body.style);
    }
    if (body.action === "fix") {
      return await runFix(id);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Message POST error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

// PATCH — partial update. Only whitelisted fields are writeable through
// this endpoint; anything else in the body is silently ignored.
//
// Auto-behaviours:
//  - status=RESOLVED without resolution → resolution="resolved"
//  - status=SENT without responseSentAt  → responseSentAt=now (server clock)
//    This is used by the "Responded in Seller Central" button so Vladimir
//    doesn't have to send a client-side timestamp.
const PATCHABLE_FIELDS = [
  "status",
  "resolution",
  "editedResponse",
  "vladimirNotes",
  "responseSentVia",
  "responseSentAt",
] as const;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const data: Record<string, unknown> = {};
    for (const field of PATCHABLE_FIELDS) {
      if (body[field] !== undefined) data[field] = body[field];
    }
    // Coerce responseSentAt into a Date if the client sent a string
    if (typeof data.responseSentAt === "string") {
      data.responseSentAt = new Date(data.responseSentAt);
    }
    if (data.status === "RESOLVED" && !data.resolution) {
      data.resolution = "resolved";
    }
    if (data.status === "SENT" && data.responseSentAt === undefined) {
      data.responseSentAt = new Date();
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No patchable fields provided" },
        { status: 400 }
      );
    }

    const updated = await prisma.buyerMessage.update({ where: { id }, data });
    return NextResponse.json({ message: updated });
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
    daysInTransit: message.daysInTransit,
    daysLate: message.daysLate,
    requestedShippingService: message.requestedShippingService,
    actualShippingService: message.actualShippingService,
    shippingMismatch: message.shippingMismatch,
    carrierEstimatedDelivery: message.carrierEstimatedDelivery,
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
      factCheckJson: JSON.stringify(result.factCheck),
      reasoning: result.reasoning,
    },
  });

  return NextResponse.json({ message: updated, analysis: result });
}

// Rewrite — regenerate only `suggestedResponse` (and associated factCheck)
// with a style steering hint. Does NOT touch classification fields like
// problemType, riskLevel, action, etc. Used by the "Rewrite safer"
// dropdown in MessageDetail.
const REWRITE_STYLES: Record<string, string> = {
  polite: "Rewrite this response to be more empathetic and polite.",
  amazon_safe:
    "Rewrite to be strictly policy-safe for Amazon. No promises, no fault admission, redirect to Amazon Customer Support where appropriate.",
  shorter: "Rewrite this response in maximum 4 sentences.",
  no_refund:
    "Rewrite without mentioning refund, return, or money back. Keep the greeting and sign-off.",
};

async function runRewrite(id: string, style: unknown) {
  if (typeof style !== "string" || !(style in REWRITE_STYLES)) {
    return NextResponse.json(
      {
        error: `Invalid rewrite style. Expected one of: ${Object.keys(REWRITE_STYLES).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const message = await prisma.buyerMessage.findUnique({ where: { id } });
  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Reuse runAnalysis's context-building logic minus the full-row write.
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
    daysInTransit: message.daysInTransit,
    daysLate: message.daysLate,
    requestedShippingService: message.requestedShippingService,
    actualShippingService: message.actualShippingService,
    shippingMismatch: message.shippingMismatch,
    carrierEstimatedDelivery: message.carrierEstimatedDelivery,
    boughtThroughVeeqo: message.boughtThroughVeeqo,
    claimsProtected: message.claimsProtected,
    shippedOnTime: message.shippedOnTime,
    messageNumber: history.length + 1,
    conversationHistory: history.map((h) => ({
      date: h.createdAt.toISOString().split("T")[0],
      direction: h.direction,
      text: h.customerMessage || h.suggestedResponse || "",
      action: h.action,
    })),
    hasAtozClaim: false,
    hasNegativeFeedback: false,
    extraInstruction: REWRITE_STYLES[style],
  });

  // Only touch the response text + fact check — keep the rest intact.
  const updated = await prisma.buyerMessage.update({
    where: { id },
    data: {
      suggestedResponse: result.suggestedResponse,
      factCheckJson: JSON.stringify(result.factCheck),
    },
  });

  return NextResponse.json({
    message: updated,
    rewrittenWithStyle: style,
  });
}

// Fix — run the policy validator against the currently-saved response
// and apply any auto-fix. Used by the "Fix to policy-compliant" button
// in MessageDetail when the operator wants to manually trigger another
// pass (e.g. the first auto-fix slipped through or the warning appeared
// on an older message analysed before the validator existed).
async function runFix(id: string) {
  const message = await prisma.buyerMessage.findUnique({ where: { id } });
  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!message.suggestedResponse) {
    return NextResponse.json(
      { error: "Message has no suggested response to fix" },
      { status: 400 }
    );
  }

  const input: AnalysisInput = {
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
    daysInTransit: message.daysInTransit,
    daysLate: message.daysLate,
    requestedShippingService: message.requestedShippingService,
    actualShippingService: message.actualShippingService,
    shippingMismatch: message.shippingMismatch,
    carrierEstimatedDelivery: message.carrierEstimatedDelivery,
    boughtThroughVeeqo: message.boughtThroughVeeqo,
    claimsProtected: message.claimsProtected,
    shippedOnTime: message.shippedOnTime,
    messageNumber: 1,
    conversationHistory: [],
    hasAtozClaim: false,
    hasNegativeFeedback: false,
  };

  // First rerun fact check against the current response
  const currentFactCheck = factCheckResponse(message.suggestedResponse, input);

  // Then run the policy validator with the current response + fact check.
  // whoShouldPay and foodSafetyRisk come from the previously-saved analysis
  // on the BuyerMessage row.
  const validation = await validateAndFixResponse(
    message.suggestedResponse,
    input,
    currentFactCheck,
    {
      whoShouldPay: message.whoShouldPay || undefined,
      foodSafetyRisk: message.foodSafetyRisk,
    }
  );

  if (!validation.fixed) {
    return NextResponse.json({
      message,
      fixed: false,
      reason: "No policy violations detected — nothing to fix",
    });
  }

  const newResponse = validation.response;
  const newFactCheck = factCheckResponse(newResponse, input);
  // Merge [AUTO-FIXED: ...] marker into reasoning so the UI banner shows
  const fixMarker = `[AUTO-FIXED: ${validation.fixReason}]`;
  const existingReasoning = message.reasoning || "";
  const reasoning = existingReasoning.includes("[AUTO-FIXED:")
    ? existingReasoning
    : `${existingReasoning} ${fixMarker}`.trim();

  const updated = await prisma.buyerMessage.update({
    where: { id },
    data: {
      suggestedResponse: newResponse,
      factCheckJson: JSON.stringify(newFactCheck),
      reasoning,
    },
  });

  return NextResponse.json({
    message: updated,
    fixed: true,
    fixReason: validation.fixReason,
  });
}
