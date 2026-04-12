/**
 * A-to-Z / Chargeback claim analyzer — generates defense responses and
 * detects the optimal protection strategy based on shipping evidence.
 *
 * Produces TWO responses:
 *   1. Amazon-facing: formal, evidence-based, structured for the A-to-Z
 *      case portal (shipment facts + conclusion)
 *   2. Customer-facing: empathetic, solution-oriented (for optional
 *      direct contact while the claim is being reviewed)
 *
 * Strategy detection follows the Buy Shipping Claims Protection rules
 * from CUSTOMER_HUB_ALGORITHM_v3.0 §9.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getAIConfig } from "@/lib/ai-config";

export interface AtozAnalysisResult {
  amazonResponse: string;
  customerResponse: string;
  strategyType: string;
  strategyConfidence: string;
  whoShouldPay: string;
  evidenceSummary: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClaimRow = any;

function detectStrategy(claim: ClaimRow): {
  type: string;
  confidence: string;
} {
  const shippedOnTime = claim.shippedOnTime === true || claim.shippedOnTime === 1;
  const claimsProtected =
    claim.claimsProtectedBadge === true || claim.claimsProtectedBadge === 1;
  const isDelivered = !!claim.deliveredDate;
  const hasTracking = !!claim.trackingNumber;

  if (claimsProtected && shippedOnTime) {
    return { type: "BUY_SHIPPING_PROTECTION", confidence: "HIGH" };
  }
  if (isDelivered && hasTracking) {
    return { type: "PROOF_OF_DELIVERY", confidence: "HIGH" };
  }
  if (hasTracking && !isDelivered) {
    return { type: "CARRIER_DELAY_DEFENSE", confidence: "MEDIUM" };
  }
  return { type: "MANUAL_REVIEW", confidence: "LOW" };
}

const SYSTEM_PROMPT = `You are an Amazon seller defense specialist generating responses for A-to-Z Guarantee claims and chargebacks.

You will receive claim details and must generate TWO responses:

RESPONSE 1 — FOR AMAZON (formal, evidence-based):
Structure it EXACTLY as:
1. SHIPMENT: "Order was shipped on {date} via {carrier} {service}."
2. TRACKING: "Tracking number {number} shows {status}."
3. DELIVERY: "Package was delivered on {date} to {city}, {state}." (if delivered)
4. BUY SHIPPING: "This label was purchased through Amazon Buy Shipping." (if applicable)
5. ON-TIME SHIP: "Order was shipped on {date}, within the required ship-by date of {latestShipDate}." (if applicable)
6. CONCLUSION: "Based on the above evidence, we respectfully request this claim be resolved in our favor." or appropriate conclusion.

Keep it factual, no emotion, cite specific dates and tracking data.

RESPONSE 2 — FOR CUSTOMER (empathetic):
"Dear {name},

I see you've filed a claim regarding your order. [acknowledge their concern].
[offer based on situation — e.g., wait for delivery, contact Amazon CS, etc.]

Best regards,
{store}"

Keep it short (3-5 sentences), empathetic, solution-oriented.

HARD RULES:
- NEVER admit fault for carrier delays when Buy Shipping was used
- NEVER promise refund if Amazon should pay via Claims Protection
- Use ONLY facts from the provided data — no invented dates or carriers
- If data is insufficient, say "insufficient data" in evidence summary

Return VALID JSON ONLY:
{
  "amazonResponse": "formal response for Amazon case portal",
  "customerResponse": "empathetic response for buyer",
  "whoShouldPay": "us|amazon|carrier",
  "evidenceSummary": "one-line summary of key evidence"
}`;

export async function generateAtozResponse(
  claim: ClaimRow
): Promise<AtozAnalysisResult> {
  const strategy = detectStrategy(claim);

  const userMessage = `CLAIM DETAILS:
- Claim Type: ${claim.claimType || "A_TO_Z"}
- Reason: ${claim.claimReason || "Unknown"}
- Amount: $${claim.amount || "?"}
- Order ID: ${claim.amazonOrderId || "Unknown"}

SHIPPING EVIDENCE:
- Carrier: ${claim.carrier || "Unknown"}
- Tracking: ${claim.trackingNumber || "None"}
- Ship Date: ${claim.shipDate || "Unknown"}
- First Scan: ${claim.firstScanDate || "Unknown"}
- Delivered: ${claim.deliveredDate || "Not yet"}
- Shipped On Time: ${claim.shippedOnTime ? "YES" : claim.shippedOnTime === false ? "NO" : "Unknown"}
- Buy Shipping (Claims Protected): ${claim.claimsProtectedBadge ? "YES" : "NO"}

DETECTED STRATEGY: ${strategy.type} (confidence: ${strategy.confidence})

CUSTOMER NAME: ${claim.customerName || "Customer"}
STORE NAME: ${claim.storeName || "Salutem Solutions"}

Generate the two responses. Return valid JSON only.`;

  const config = await getAIConfig();
  let rawText = "";

  for (const provider of config.providerChain) {
    const model =
      provider === "claude" ? config.claudeModel : config.openaiModel;
    try {
      if (provider === "claude") {
        const client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
        const r = await client.messages.create({
          model,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        });
        rawText = r.content[0].type === "text" ? r.content[0].text : "";
      } else {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const r = await client.chat.completions.create({
          model,
          max_tokens: 2000,
          temperature: 0.3,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
        });
        rawText = r.choices[0]?.message?.content || "";
      }

      if (rawText) break;
    } catch (e) {
      console.error(
        `[AtozAnalyzer] ${provider} failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // Parse JSON from response
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        amazonResponse: parsed.amazonResponse || "",
        customerResponse: parsed.customerResponse || "",
        strategyType: strategy.type,
        strategyConfidence: strategy.confidence,
        whoShouldPay: parsed.whoShouldPay || "us",
        evidenceSummary: parsed.evidenceSummary || "",
      };
    }
  } catch {
    console.error("[AtozAnalyzer] JSON parse failed");
  }

  return {
    amazonResponse: "Unable to generate response — insufficient data or AI unavailable.",
    customerResponse: "",
    strategyType: strategy.type,
    strategyConfidence: strategy.confidence,
    whoShouldPay: "us",
    evidenceSummary: "AI analysis failed",
  };
}
