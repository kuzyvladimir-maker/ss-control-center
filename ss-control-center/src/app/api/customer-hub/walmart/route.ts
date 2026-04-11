import { NextRequest, NextResponse } from "next/server";
import { analyzeScreenshots } from "@/lib/claude";

// POST /api/customer-hub/walmart
// Body: { images: string[] } — array of base64 image data URIs (or raw base64).
// Returns: { analysis: { orderId, customerName, product, customerMessage,
//   problemType, problemTypeName, riskLevel, action, whoShouldPay,
//   suggestedResponse, reasoning } }
//
// Analyses Walmart Seller Center screenshots via Claude vision. Walmart has
// no public buyer-seller API so the operator pastes screenshots and we
// extract structured data + draft a response following Walmart's strict
// "no negotiations, no incentives, quick resolution" rules.

const WALMART_SYSTEM_PROMPT = `You are analyzing Walmart seller customer support screenshots.
The screenshots show: order details, customer messages, tracking info.

Extract from screenshots:
- Order ID
- Customer name
- Product name and details
- Customer's message/complaint
- Tracking status if visible
- Any other relevant order data

Then classify and respond following Walmart rules:
- No negotiations or discounts EVER
- No asking customer to cancel
- No incentives or partial refunds
- Quick resolution: refund or replacement
- Short, polite, neutral tone
- Do NOT return food items (food safety)
- Never argue about food safety
- Never guarantee food safety after a spoilage complaint
- No emojis, no external links, no promotional content

WALMART CASE TYPES:
1. Cancel request (before/after shipment)
2. Where is my order
3. Delivered but not received
4. Missing items
5. Damaged / expired / wrong item
6. Returned to sender
7. Unclear request

PROBLEM TYPE CODES (T1-T20):
T1=Not received (in transit), T2=Not received (delivered), T3=Late delivery,
T4=Spoiled/thawed/melted, T5=Damaged, T6=Wrong item, T7=Missing item,
T8=Expired product, T9=Shipping cost complaint, T10=Cancellation,
T11=Return/refund request, T12=Unauthorized purchase, T15=Health/safety concern,
T17=Quality complaint, T19=Refund already issued, T20=Repeat complaint

RISK LEVELS:
- LOW: tracking normal, no proof of issue, simple pre-sale question
- MEDIUM: wrong item without photo, unclear quality complaint
- HIGH: thawed food with photo, carrier delay in tracking, repeat wrong item
- CRITICAL: food poisoning, illness, lawyer/FDA threat, 3+ messages from same customer

ACTION LADDER (cheapest safe exit first):
clarify → reassure → investigate → replacement → full_refund

RESPONSE FORMAT (Walmart style — 3-4 short sentences):
1. Hello [Name], we're sorry for the inconvenience.
2. [One factual sentence about what happened]
3. [One resolution sentence — refund or replacement only]
4. Thank you for your understanding.

Respond with JSON only (no markdown fences, no prose outside JSON):
{
  "orderId": "extracted string or null",
  "customerName": "extracted string or null",
  "product": "extracted string or null",
  "customerMessage": "extracted complaint text or null",
  "problemType": "T1-T20",
  "problemTypeName": "short human label",
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "action": "replacement|full_refund|clarify|reassure|investigate",
  "whoShouldPay": "us|walmart|carrier",
  "suggestedResponse": "Full response text for the customer, multi-line",
  "reasoning": "Internal 1-2 sentence explanation of the decision"
}`;

interface WalmartAnalysisBody {
  images?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as WalmartAnalysisBody;

    if (!Array.isArray(body.images) || body.images.length === 0) {
      return NextResponse.json(
        { error: "No images provided" },
        { status: 400 }
      );
    }

    // Normalise inputs: accept either raw base64 or full data URIs. analyzeScreenshots
    // expects raw base64 (it sniffs media type from the first few bytes).
    const base64Images: string[] = [];
    for (const raw of body.images) {
      if (typeof raw !== "string" || raw.length < 10) continue;
      const stripped = raw.replace(/^data:image\/\w+;base64,/, "");
      base64Images.push(stripped);
    }

    if (base64Images.length === 0) {
      return NextResponse.json(
        { error: "No valid base64 images in request" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      return NextResponse.json(
        { error: "Claude API is not configured on the server" },
        { status: 503 }
      );
    }

    const analysis = await analyzeScreenshots(base64Images, WALMART_SYSTEM_PROMPT);
    return NextResponse.json({ analysis });
  } catch (err) {
    console.error("[customer-hub/walmart] POST failed:", err);
    return NextResponse.json(
      {
        error: "Walmart analysis failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
