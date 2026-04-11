/**
 * Customer Hub Decision Engine — Claude AI analysis of buyer messages
 */

import Anthropic from "@anthropic-ai/sdk";

const SYSTEM_PROMPT = `You are an Amazon seller customer support decision agent for a business that sells grocery, chilled, frozen, and perishable products.

Your objectives:
1. Protect the seller account and metrics
2. Minimize unnecessary refunds
3. Prefer replacement over refund when commercially reasonable
4. Redirect responsibility to Amazon or carrier when supported by facts
5. Avoid argumentative or risky wording
6. Keep replies short, polite, and professional

DECISION PROCESS:

1. CLASSIFY the problem type (T1-T20):
T1=Not received (in transit), T2=Not received (delivered), T3=Late delivery,
T4=Spoiled/thawed/melted, T5=Damaged, T6=Wrong item, T7=Missing item,
T8=Expired product, T9=Shipping cost complaint, T10=Cancellation,
T11=Return/refund request, T12=Unauthorized purchase, T13=A-to-Z threat,
T14=Negative review threat, T15=Health/safety concern, T16=Carrier postage due,
T17=Quality complaint, T18=Pre-sale question, T19=Refund already issued,
T20=Repeat complaint

2. ASSESS risk level: LOW / MEDIUM / HIGH / CRITICAL
- LOW: tracking normal, no proof of issue, pre-sale question
- MEDIUM: wrong item without photo, unclear quality complaint
- HIGH: thawed food with photo, carrier delay in tracking, repeat wrong item
- CRITICAL: food poisoning, illness, lawyer/FDA threat, 3+ messages from same customer

3. DECIDE action using economic ladder (cheapest safe exit first):
   clarify → redirect_amazon → replacement → partial_refund → full_refund

4. DETERMINE who should pay: us / amazon / carrier

5. CHECK internal action: support_case / buy_shipping_reimbursement / sku_check / supplier_reorder / none

HARD RULES:
- NEVER blame the customer
- NEVER say "this is not our fault"
- NEVER argue about food safety
- NEVER guarantee food safety after spoilage complaint
- NEVER use emojis, external links, or promotional content
- NEVER ask customer to change/remove review
- Do NOT return frozen food (food safety)
- If message #3+ from same customer → CRITICAL priority, prefer refund
- If Claims Protected + shipped on time + carrier delayed → redirect to A-to-Z

RESPONSE FORMAT:
1. Thank you / apology (if appropriate)
2. One factual sentence based on tracking/order data
3. One resolution sentence
4. Professional closing with store name
Keep response 4-8 sentences. Language MUST match customer's language.`;

export interface AnalysisInput {
  customerMessage: string;
  customerName: string | null;
  language: string;
  storeName: string;
  amazonOrderId: string | null;
  orderDate: string | null;
  orderTotal: number | null;
  product: string | null;
  productType: string | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingStatus: string | null;
  shipDate: string | null;
  promisedEdd: string | null;
  actualDelivery: string | null;
  daysLate: number | null;
  boughtThroughVeeqo: boolean;
  claimsProtected: boolean;
  shippedOnTime: boolean | null;
  messageNumber: number;
  conversationHistory: Array<{
    date: string;
    direction: string;
    text: string;
    action: string | null;
  }>;
  hasAtozClaim: boolean;
  hasNegativeFeedback: boolean;
}

export interface AnalysisResult {
  problemType: string;
  problemTypeName: string;
  riskLevel: string;
  action: string;
  secondaryAction: string | null;
  whoShouldPay: string;
  internalAction: string;
  foodSafetyRisk: boolean;
  atozRisk: string;
  suggestedResponse: string;
  reasoning: string;
}

export async function analyzeMessage(
  input: AnalysisInput
): Promise<AnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // A valid Anthropic key starts with "sk-ant-". Anything else (missing,
  // placeholder, or obviously malformed) triggers the heuristic fallback.
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    return fallbackResult(input);
  }

  try {
    const client = new Anthropic({ apiKey });
    const userMessage = buildContextMessage(input);

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return parseAnalysisResponse(text, input);
  } catch (e) {
    console.error("[Analyzer] Claude API failed:", e);
    return fallbackResult(input);
  }
}

function buildContextMessage(input: AnalysisInput): string {
  let msg = `ANALYZE THIS CUSTOMER MESSAGE AND RESPOND IN JSON FORMAT.

CUSTOMER MESSAGE:
"${input.customerMessage}"

CONTEXT:
- Store: ${input.storeName}
- Customer: ${input.customerName || "Unknown"}
- Language: ${input.language}
- Order ID: ${input.amazonOrderId || "Unknown"}
- Order Date: ${input.orderDate || "Unknown"}
- Order Total: ${input.orderTotal ? "$" + input.orderTotal : "Unknown"}
- Product: ${input.product || "Unknown"}
- Product Type: ${input.productType || "Unknown"}

SHIPPING:
- Carrier: ${input.carrier || "Unknown"}
- Service: ${input.service || "Unknown"}
- Tracking: ${input.trackingNumber || "None"}
- Status: ${input.trackingStatus || "Unknown"}
- Ship Date: ${input.shipDate || "Unknown"}
- Promised EDD: ${input.promisedEdd || "Unknown"}
- Actual Delivery: ${input.actualDelivery || "Unknown"}
- Days Late: ${input.daysLate ?? "N/A"}
- Buy Shipping (Veeqo): ${input.boughtThroughVeeqo ? "YES" : "NO"}
- Claims Protected: ${input.claimsProtected ? "YES" : "NO"}
- Shipped On Time: ${input.shippedOnTime === null ? "Unknown" : input.shippedOnTime ? "YES" : "NO"}

MESSAGE HISTORY:
- This is message #${input.messageNumber} from this customer about this order
- Has A-to-Z claim: ${input.hasAtozClaim ? "YES" : "NO"}
- Has negative feedback: ${input.hasNegativeFeedback ? "YES" : "NO"}`;

  if (input.conversationHistory.length > 0) {
    msg += "\n\nPREVIOUS MESSAGES:\n";
    for (const h of input.conversationHistory) {
      msg += `[${h.date}] ${h.direction === "incoming" ? "CUSTOMER" : "OUR REPLY"}: ${h.text.substring(0, 200)}${h.text.length > 200 ? "..." : ""}\n`;
      if (h.action) msg += `  Action taken: ${h.action}\n`;
    }
  }

  msg += `

RESPOND WITH VALID JSON ONLY (no markdown, no backticks):
{
  "problemType": "T1-T20",
  "problemTypeName": "short name",
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "action": "clarify|redirect_amazon|replacement|partial_refund|full_refund|reassure|investigate",
  "secondaryAction": "fallback action or null",
  "whoShouldPay": "us|amazon|carrier",
  "internalAction": "support_case|buy_shipping_reimbursement|sku_check|supplier_reorder|none",
  "foodSafetyRisk": true/false,
  "atozRisk": "low|medium|high",
  "suggestedResponse": "The complete response to send to the customer. Sign off as ${input.storeName}.",
  "reasoning": "Brief internal reasoning for this decision"
}`;

  return msg;
}

function parseAnalysisResponse(
  text: string,
  input: AnalysisInput
): AnalysisResult {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        problemType: parsed.problemType || "T18",
        problemTypeName: parsed.problemTypeName || "Unknown",
        riskLevel: parsed.riskLevel || "MEDIUM",
        action: parsed.action || "investigate",
        secondaryAction: parsed.secondaryAction || null,
        whoShouldPay: parsed.whoShouldPay || "us",
        internalAction: parsed.internalAction || "none",
        foodSafetyRisk: parsed.foodSafetyRisk || false,
        atozRisk: parsed.atozRisk || "low",
        suggestedResponse: parsed.suggestedResponse || "",
        reasoning: parsed.reasoning || "",
      };
    }
  } catch (e) {
    console.error("[Analyzer] Parse failed:", e);
  }
  return fallbackResult(input);
}

function fallbackResult(input: AnalysisInput): AnalysisResult {
  return {
    problemType: "T18",
    problemTypeName: "Unable to classify",
    riskLevel: "MEDIUM",
    action: "investigate",
    secondaryAction: null,
    whoShouldPay: "us",
    internalAction: "none",
    foodSafetyRisk: false,
    atozRisk: "low",
    suggestedResponse: `Dear ${input.customerName || "Customer"},\n\nThank you for reaching out. We are looking into your concern and will get back to you shortly.\n\nBest regards,\n${input.storeName}`,
    reasoning: "AI analysis unavailable, using safe fallback",
  };
}
