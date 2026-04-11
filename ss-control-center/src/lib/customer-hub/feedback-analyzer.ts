/**
 * Customer Hub — Seller Feedback Analyzer
 *
 * Uses Claude to classify an Amazon seller feedback entry against Amazon's
 * feedback removal policy and (optionally) draft a public response or
 * removal request. Falls back to a conservative heuristic result when the
 * Claude API is unavailable so the UI never breaks.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface FeedbackAnalysisInput {
  rating: number;
  comments: string | null;
  amazonOrderId: string | null;
  store: string | null;
  storeName?: string | null;
}

export interface FeedbackAnalysisResult {
  removable: boolean;
  removalCategory:
    | "PRODUCT_REVIEW"
    | "CARRIER_DELAY"
    | "OBSCENE"
    | "PERSONAL_INFO"
    | "PROMOTIONAL"
    | null;
  removalConfidence: "HIGH" | "MEDIUM" | "LOW";
  aiReasoning: string;
  removalRequestText: string | null;
  suggestedAction:
    | "REQUEST_REMOVAL"
    | "CONTACT_BUYER"
    | "RESPOND_PUBLICLY"
    | "MONITOR";
  publicResponse: string | null;
}

const FEEDBACK_ANALYSIS_PROMPT = `You are analyzing Amazon seller feedback to determine if it can be removed under Amazon's feedback removal policy, and to draft appropriate public responses.

RATING INTERPRETATION:
- 1–2: negative
- 3: neutral
- 4–5: positive

REMOVABLE feedback (violates Amazon policy):
- PRODUCT_REVIEW: The feedback is about the product itself, not the seller's service
- CARRIER_DELAY: The feedback complains about shipping speed when the seller shipped on time and used Amazon Buy Shipping
- OBSCENE: Contains profanity or inappropriate language
- PERSONAL_INFO: Contains personal information (phone, email, address)
- PROMOTIONAL: Contains promotional content or links

NOT REMOVABLE:
- Genuine seller service complaint (packaging, communication, accuracy)
- Legitimate experience with the seller

STRICT RULES:
- NEVER ask the customer to change or remove their review
- NEVER offer compensation, discounts, or gifts in exchange for changing/removing a review
- NEVER argue with the customer about food safety
- NEVER guarantee food safety after a spoilage complaint
- Keep public responses short, polite, and professional — no emojis, no promotional content

PUBLIC RESPONSE RULES:
- For POSITIVE feedback (rating 4–5): generate a public response by choosing one of these templates, or adapting one (vary wording between calls so different positive feedbacks don't get identical replies). Always sign with the store name.
  Template A: "Thank you so much for the wonderful feedback! Your satisfaction is our priority. — {storeName}"
  Template B: "We truly appreciate your kind words! It means a lot to our team. — {storeName}"
  Template C: "Thank you for taking the time to share your experience! We're thrilled you're happy with your order. — {storeName}"
- For NEGATIVE/NEUTRAL feedback (rating 1–3) that is NOT removable: generate a short, empathetic public response acknowledging the issue, without blaming the customer or guaranteeing anything. Sign with the store name.
- For REMOVABLE feedback: publicResponse should be null (we submit a removal request instead).

Respond with JSON only, no markdown fences, no prose:
{
  "removable": true|false,
  "removalCategory": "PRODUCT_REVIEW"|"CARRIER_DELAY"|"OBSCENE"|"PERSONAL_INFO"|"PROMOTIONAL"|null,
  "removalConfidence": "HIGH"|"MEDIUM"|"LOW",
  "aiReasoning": "short explanation",
  "removalRequestText": "Text to submit to Amazon for removal (only if removable, else null)",
  "suggestedAction": "REQUEST_REMOVAL"|"CONTACT_BUYER"|"RESPOND_PUBLICLY"|"MONITOR",
  "publicResponse": "Public reply text per rules above, or null"
}`;

function buildUserMessage(input: FeedbackAnalysisInput): string {
  const storeName = input.storeName || input.store || "our team";
  return `FEEDBACK:
Rating: ${input.rating}/5
Comment: "${input.comments ?? "(no comment)"}"
Order ID: ${input.amazonOrderId ?? "Unknown"}
Store: ${input.store ?? "Unknown"}
Store display name (use this to sign public responses): ${storeName}`;
}

function fallback(input: FeedbackAnalysisInput): FeedbackAnalysisResult {
  // Conservative heuristic: don't claim removability without the model.
  // For positive feedback (>=4) mark as MONITOR; for negative MONITOR too so
  // the human operator decides.
  return {
    removable: false,
    removalCategory: null,
    removalConfidence: "LOW",
    aiReasoning:
      "Claude API unavailable — manual review required. No automated classification performed.",
    removalRequestText: null,
    suggestedAction: input.rating <= 2 ? "CONTACT_BUYER" : "MONITOR",
    publicResponse: null,
  };
}

function coerceCategory(
  v: unknown
): FeedbackAnalysisResult["removalCategory"] {
  const allowed = [
    "PRODUCT_REVIEW",
    "CARRIER_DELAY",
    "OBSCENE",
    "PERSONAL_INFO",
    "PROMOTIONAL",
  ] as const;
  return (allowed as readonly string[]).includes(v as string)
    ? (v as FeedbackAnalysisResult["removalCategory"])
    : null;
}

function coerceConfidence(
  v: unknown
): FeedbackAnalysisResult["removalConfidence"] {
  return v === "HIGH" || v === "MEDIUM" ? v : "LOW";
}

function coerceAction(
  v: unknown
): FeedbackAnalysisResult["suggestedAction"] {
  const allowed = [
    "REQUEST_REMOVAL",
    "CONTACT_BUYER",
    "RESPOND_PUBLICLY",
    "MONITOR",
  ] as const;
  return (allowed as readonly string[]).includes(v as string)
    ? (v as FeedbackAnalysisResult["suggestedAction"])
    : "MONITOR";
}

function parseResponse(
  text: string,
  input: FeedbackAnalysisInput
): FeedbackAnalysisResult {
  // Strip markdown code fences if Claude added them despite the instruction.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      removable: parsed.removable === true,
      removalCategory: coerceCategory(parsed.removalCategory),
      removalConfidence: coerceConfidence(parsed.removalConfidence),
      aiReasoning:
        typeof parsed.aiReasoning === "string" ? parsed.aiReasoning : "",
      removalRequestText:
        typeof parsed.removalRequestText === "string"
          ? parsed.removalRequestText
          : null,
      suggestedAction: coerceAction(parsed.suggestedAction),
      publicResponse:
        typeof parsed.publicResponse === "string" ? parsed.publicResponse : null,
    };
  } catch (e) {
    console.error("[FeedbackAnalyzer] JSON parse failed:", e, cleaned.slice(0, 200));
    return fallback(input);
  }
}

export async function analyzeFeedback(
  input: FeedbackAnalysisInput
): Promise<FeedbackAnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.startsWith("sk-ant-")) {
    return fallback(input);
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system: FEEDBACK_ANALYSIS_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    return parseResponse(text, input);
  } catch (e) {
    console.error("[FeedbackAnalyzer] Claude API failed:", e);
    return fallback(input);
  }
}
