import { NextRequest, NextResponse } from "next/server";
import { analyzeScreenshots } from "@/lib/claude";
import { prisma } from "@/lib/prisma";
import { collectFrozenIncidentData } from "@/lib/frozen-analytics";
import { readFileSync } from "fs";
import { join } from "path";

function getCsPrompt(): string {
  // Try versions in order: v1.4, v1.2, v1
  const versions = ["CS_ALGORITHM_v1.4.md", "CS_ALGORITHM_v1.2.md", "CS_ALGORITHM_v1.md"];
  for (const file of versions) {
    try {
      return readFileSync(join(process.cwd(), "..", "docs", file), "utf-8");
    } catch {
      continue;
    }
  }
  return "";
}

function buildTrackingUrl(
  carrier: string | null,
  tracking: string | null
): string | null {
  if (!carrier || !tracking) return null;
  const c = carrier.toUpperCase();
  if (c === "UPS") return `https://www.ups.com/track?tracknum=${tracking}`;
  if (c === "FEDEX")
    return `https://www.fedex.com/fedextrack/?trknbr=${tracking}`;
  if (c === "USPS")
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const images: string[] = body.images || (body.image ? [body.image] : []);

    if (images.length === 0) {
      return NextResponse.json(
        { error: "At least one image (base64) is required" },
        { status: 400 }
      );
    }

    if (images.length > 5) {
      return NextResponse.json(
        { error: "Maximum 5 images allowed" },
        { status: 400 }
      );
    }

    // Strip data URL prefix from each image
    const base64Images = images.map((img: string) =>
      img.replace(/^data:image\/\w+;base64,/, "")
    );

    const csAlgorithm = getCsPrompt();

    const systemPrompt = `You are an AI Customer Service agent for Salutem Solutions.
Analyze the screenshot(s) of a customer service case from a marketplace.
There may be multiple screenshots: customer message, order details, tracking page, etc.
Combine information from ALL images to build a complete picture.

${csAlgorithm}

ABSOLUTE RULES — NEVER VIOLATE:
1. If carrierDelayDetected=true AND carrierBadge="Claims Protected" AND shippedOnTime=true:
   - action MUST be "A2Z_GUARANTEE"
   - response MUST guide customer to file A-to-Z claim (with step-by-step instructions)
   - response MUST NOT offer direct refund from seller
   - internalNotes MUST say: "НЕ делать прямой refund — ветка A, Claims Protected badge. Ждать A-to-Z от клиента."

2. If you cannot determine carrier delay from screenshot:
   - carrierDelayDetected = false
   - internalNotes should include: "Проверить трекинг в Veeqo/Control Center — не видно на скриншоте"
   - default to Branch B (our responsibility)

3. NEVER suggest a direct refund from seller for carrier-caused delays with Claims Protected badge.

4. For Amazon responses: NEVER include emojis in the customer response text.

5. For Walmart cases: do NOT include A-to-Z Guarantee information (Walmart has different mechanics). Walmart has NO frozen products.

6. SUPPLIER REORDER (v1.4): When action="REPLACEMENT", internalNotes MUST include:
   "🛒 SUPPLIER REORDER NEEDED: заказать [product] × [qty] у поставщика для замены клиенту [name] по заказу [orderId]"
   Vladimir is a reseller — there is NO stock on hand. Every replacement requires ordering from supplier first.

7. CONVERSATION HISTORY (v1.4): Read ALL messages visible in the screenshot, not just the last one.
   - If this is a REPEAT contact and customer already waited → do NOT say "please wait", offer solution immediately
   - If customer explicitly asks for replacement/refund → respect their preference
   - If customer is upset → use more apologetic, urgent tone

8. CARRIER SELF-DECLARED DELAY (v1.4): If tracking explicitly shows status "Delayed" (official carrier status):
   - This is DOCUMENTED PROOF of carrier fault
   - For Amazon: activate Buy Shipping Protection → guide to A-to-Z
   - internalNotes MUST include: "⚡ CARRIER SELF-DECLARED DELAY — статус 'Delayed' на трекинге. Сохранить скриншот. Добавить в модуль Buy Shipping Claims для компенсации."

9. DELIVERY STATUS: Distinguish carefully between:
   - "Delayed/Stuck" (shipped but carrier delayed) → NOT our fault
   - "Never shipped" (only label created, no scan) → OUR fault
   Never tell customer "your order was not shipped" when it was actually stuck with carrier.

Respond STRICTLY with valid JSON only. No preamble, no markdown, no backticks.
{
  "channel": "Amazon" or "Walmart",
  "store": "store name from screenshot or null",
  "orderId": "order number or null",
  "customerName": "customer first name or null",
  "product": "product name or null",
  "productType": "Frozen" or "Dry" or "Unknown",
  "category": "C1" through "C10",
  "categoryName": "brief category description",
  "priority": "LOW" or "MEDIUM" or "HIGH" or "CRITICAL",
  "language": "English" or "Spanish",
  "carrierDelayDetected": true or false,
  "carrierBadge": "Claims Protected" or "Late Delivery Risk" or "Unknown" or null,
  "shippedOnTime": true or false or null,
  "promisedEdd": "YYYY-MM-DD or null",
  "actualDelivery": "YYYY-MM-DD or null",
  "daysLate": number or null,
  "branch": "A" or "B" or null,
  "branchName": "branch description or null",
  "response": "complete ready-to-send message text in customer's language",
  "action": "REPLACEMENT" or "REFUND" or "A2Z_GUARANTEE" or "PHOTO_REQUEST" or "ESCALATE" or "INFO",
  "urgency": "urgency message e.g. Respond within 12 hours",
  "internalNotes": "internal notes for Vladimir in Russian",
  "trackingNumber": "tracking number if visible, otherwise null",
  "trackingCarrier": "UPS" or "FedEx" or "USPS" or null
}`;

    const result = await analyzeScreenshots(base64Images, systemPrompt);

    // Build tracking URL if tracking info was extracted
    const trackingUrl = buildTrackingUrl(
      result.trackingCarrier,
      result.trackingNumber
    );

    const csCase = await prisma.csCase.create({
      data: {
        channel: result.channel || "Unknown",
        store: result.store,
        orderId: result.orderId,
        customerName: result.customerName,
        product: result.product,
        productType: result.productType,
        category: result.category,
        categoryName: result.categoryName,
        priority: result.priority,
        language: result.language,
        branch: result.branch,
        branchName: result.branchName,
        response: result.response,
        action: result.action,
        urgency: result.urgency,
        internalNotes: result.internalNotes,
        imageData: `${base64Images.length} image(s)`,
        carrierDelayDetected: result.carrierDelayDetected || false,
        carrierBadge: result.carrierBadge,
        shippedOnTime: result.shippedOnTime,
        promisedEdd: result.promisedEdd,
        actualDelivery: result.actualDelivery,
        daysLate: result.daysLate,
        status: "open",
      },
    });

    // Auto-trigger Frozen Analytics data collection for C3 cases
    if (result.category === "C3") {
      collectFrozenIncidentData(csCase.id, result.orderId, {
        sku: undefined,
        productName: result.product,
        carrier: result.trackingCarrier?.toLowerCase(),
        shipDate: result.shippingTimeline?.shipDate || undefined,
        promisedEdd: result.promisedEdd || result.shippingTimeline?.edd || undefined,
        actualDelivery: result.actualDelivery || result.shippingTimeline?.actualDelivery || undefined,
        trackingNumber: result.trackingNumber,
        resolution: result.action?.toLowerCase(),
      }).catch(console.error);
    }

    return NextResponse.json({
      ...result,
      id: csCase.id,
      trackingUrl,
    });
  } catch (error) {
    console.error("CS Analysis error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to analyze screenshot",
      },
      { status: 500 }
    );
  }
}
