import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  analyzeMessage,
  factCheckResponse,
  validateAndFixResponse,
} from "@/lib/customer-hub/message-analyzer";
import type { AnalysisInput } from "@/lib/customer-hub/message-analyzer";
import { translateText } from "@/lib/customer-hub/translator";
import { enrichMessage } from "@/lib/customer-hub/message-enricher";
import type { ParsedBuyerEmail } from "@/lib/customer-hub/gmail-parser";

/**
 * Re-run the enricher on a stored BuyerMessage. Builds a synthetic
 * ParsedBuyerEmail from the row, calls enrichMessage to refresh shipping
 * facts (Amazon SP-API + Veeqo + carrier direct API), and writes the
 * fresh fields back to the row. Used by runAnalysis so re-analyze
 * always works against current carrier ETAs, not stale snapshots from
 * the original sync.
 */
async function reEnrichStoredMessage(messageId: string) {
  const m = await prisma.buyerMessage.findUnique({ where: { id: messageId } });
  if (!m) return null;

  const synthetic: ParsedBuyerEmail = {
    gmailMessageId: m.gmailMessageId || "",
    gmailThreadId: m.gmailThreadId || null,
    storeIndex: m.storeIndex,
    storeName: m.storeName,
    storeEmail: m.storeEmail || "",
    customerName: m.customerName,
    customerEmail: m.customerEmail,
    amazonOrderId: m.amazonOrderId,
    asin: m.asin,
    productName: m.product,
    customerMessage: m.customerMessage || "",
    language: m.language === "Spanish" ? "Spanish" : "English",
    receivedAt: m.receivedAt || m.createdAt,
  };

  try {
    const enriched = await enrichMessage(synthetic);
    await prisma.buyerMessage.update({
      where: { id: messageId },
      data: {
        orderDate: enriched.orderDate,
        orderTotal: enriched.orderTotal,
        product: enriched.product,
        productType: enriched.productType,
        quantity: enriched.quantity,
        carrier: enriched.carrier,
        service: enriched.service,
        trackingNumber: enriched.trackingNumber,
        shipDate: enriched.shipDate,
        promisedEdd: enriched.promisedEdd,
        actualDelivery: enriched.actualDelivery,
        trackingStatus: enriched.trackingStatus,
        daysInTransit: enriched.daysInTransit,
        daysLate: enriched.daysLate,
        requestedShippingService: enriched.requestedShippingService,
        actualShippingService: enriched.actualShippingService,
        shippingMismatch: enriched.shippingMismatch,
        carrierEstimatedDelivery: enriched.carrierEstimatedDelivery,
        trackingEvents: enriched.trackingEvents
          ? JSON.stringify(enriched.trackingEvents)
          : null,
        boughtThroughVeeqo: enriched.boughtThroughVeeqo,
        claimsProtected: enriched.claimsProtected,
        shippedOnTime: enriched.shippedOnTime,
      },
    });
    return await prisma.buyerMessage.findUnique({ where: { id: messageId } });
  } catch (e) {
    console.error(
      "[reEnrichStoredMessage] failed:",
      e instanceof Error ? e.message : String(e)
    );
    return m;
  }
}

/**
 * Parse the JSON-encoded trackingEvents column from the DB back into the
 * shape expected by AnalysisInput. Returns null on empty/invalid.
 */
function parseStoredTrackingEvents(
  stored: string | null | undefined
): AnalysisInput["trackingEvents"] {
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Mirror of message-enricher.ts detection — scans tracking events for
 * documentary delay/exception evidence. Used by the per-message route
 * when reading tracking from DB without re-fetching from carrier.
 */
function detectCarrierDelay(
  events: AnalysisInput["trackingEvents"]
): boolean {
  if (!events || events.length === 0) return false;
  const delayKeywords = [
    "delay",
    "delayed",
    "exception",
    "weather",
    "missed",
    "late",
    "rescheduled",
    "unable to deliver",
  ];
  return events.some((e) => {
    const blob = `${e.description || ""} ${e.status || ""}`.toLowerCase();
    return delayKeywords.some((kw) => blob.includes(kw));
  });
}

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
  "editedResponseRu",
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
  // Refresh shipping facts (Amazon SP-API + Veeqo + carrier API) before
  // re-running the model. Without this, re-analyze always reasons over
  // the snapshot from the original sync — so newer carrier ETAs from
  // UPS/FedEx/USPS direct lookups never reach the model.
  const message = await reEnrichStoredMessage(id);
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
    trackingEvents: parseStoredTrackingEvents(message.trackingEvents),
    carrierSelfDeclaredDelay: detectCarrierDelay(
      parseStoredTrackingEvents(message.trackingEvents)
    ),
    channel: message.channel || "Amazon",
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

  // Re-translate the new response + make sure customerMessage is translated
  // (back-fill for messages synced before the translator existed).
  const [suggestedRu, customerRu] = await Promise.all([
    result.suggestedResponse
      ? translateText(result.suggestedResponse, "en-ru").catch(() => null)
      : Promise.resolve(null),
    message.customerMessageRu
      ? Promise.resolve(message.customerMessageRu)
      : message.customerMessage
        ? translateText(message.customerMessage, "en-ru").catch(() => null)
        : Promise.resolve(null),
  ]);

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
      suggestedResponseRu: suggestedRu,
      supplierReorderNote: result.supplierReorderNote,
      customerMessageRu: customerRu,
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
    trackingEvents: parseStoredTrackingEvents(message.trackingEvents),
    carrierSelfDeclaredDelay: detectCarrierDelay(
      parseStoredTrackingEvents(message.trackingEvents)
    ),
    channel: message.channel || "Amazon",
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
  const suggestedRu = result.suggestedResponse
    ? await translateText(result.suggestedResponse, "en-ru").catch(() => null)
    : null;
  const updated = await prisma.buyerMessage.update({
    where: { id },
    data: {
      suggestedResponse: result.suggestedResponse,
      suggestedResponseRu: suggestedRu,
      supplierReorderNote: result.supplierReorderNote,
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
    trackingEvents: parseStoredTrackingEvents(message.trackingEvents),
    carrierSelfDeclaredDelay: detectCarrierDelay(
      parseStoredTrackingEvents(message.trackingEvents)
    ),
    channel: message.channel || "Amazon",
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
  const newResponseRu = await translateText(newResponse, "en-ru").catch(
    () => null
  );
  // Merge [AUTO-FIXED: ...] marker into reasoning so the UI banner shows
  const fixMarker = `[AUTO-FIXED: ${validation.fixReason}]`;
  const existingReasoning = message.reasoning || "";
  // Strip any prior [NEEDS REVIEW: ...] tag — the fix button just
  // addressed it, so leaving it in the UI would be confusing.
  const cleanedReasoning = existingReasoning.replace(
    /\[NEEDS REVIEW:[^\]]*\]/g,
    ""
  );
  const reasoning = cleanedReasoning.includes("[AUTO-FIXED:")
    ? cleanedReasoning
    : `${cleanedReasoning} ${fixMarker}`.trim();

  const updated = await prisma.buyerMessage.update({
    where: { id },
    data: {
      suggestedResponse: newResponse,
      suggestedResponseRu: newResponseRu,
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
