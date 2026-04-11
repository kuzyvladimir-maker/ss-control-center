/**
 * Customer Hub Decision Engine — AI analysis of buyer messages with
 * automatic fallback between Claude (primary) and OpenAI (fallback).
 * If the primary provider fails (missing key, API error, rate limit), the
 * next provider in the list is tried. Only when all providers have failed
 * do we return the safe heuristic fallback.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getAIConfig, type ProviderName } from "@/lib/ai-config";
import { findSimilarCases } from "./knowledge-base";

type KnowledgeBaseHint = Awaited<ReturnType<typeof findSimilarCases>>[number];

const SYSTEM_PROMPT = `You are an Amazon seller customer support decision agent for a business that sells grocery, chilled, frozen, and perishable products.

Your objectives:
1. Protect the seller account and metrics
2. Minimize unnecessary refunds
3. Prefer replacement over refund when commercially reasonable
4. Redirect responsibility to Amazon or carrier when supported by facts
5. Avoid argumentative or risky wording
6. Keep replies short, polite, and professional

PROBLEM TYPES (T1-T21):
T1=Not received (in transit), T2=Not received (delivered), T3=Late delivery,
T4=Spoiled/thawed/melted, T5=Damaged, T6=Wrong item, T7=Missing item,
T8=Expired product, T9=Shipping cost complaint, T10=Cancellation,
T11=Return/refund request, T12=Unauthorized purchase, T13=A-to-Z threat,
T14=Negative review threat, T15=Health/safety concern, T16=Carrier postage due,
T17=Quality complaint, T18=Pre-sale question, T19=Refund already issued,
T20=Repeat complaint,
T21=Shipping service mismatch (customer paid for expedited, shipped standard)

RISK LEVELS: LOW / MEDIUM / HIGH / CRITICAL
- LOW: tracking normal, no proof of issue, pre-sale question
- MEDIUM: wrong item without photo, unclear quality complaint
- HIGH: thawed food with photo, carrier delay in tracking, repeat wrong item,
        shipping mismatch (T21)
- CRITICAL: food poisoning, illness, lawyer/FDA threat, 3+ messages from same customer

DECISION PROCESS — follow this EXACT order:

STEP 1 — READ THE CUSTOMER MESSAGE FIRST (most important):
- What happened from the customer's perspective?
- What is the customer asking for? (cancel, refund, replacement, information?)
- What emotion? (angry, confused, polite, threatening?)
- What specific details did the customer mention? (paid for expedited,
  expected specific date, etc.)
- QUOTE the key phrases from the customer message in your reasoning.

STEP 2 — CHECK SHIPPING FACTS:
- Compare REQUESTED shipping service (from ORDER DATA) with ACTUAL shipping
  service (from SHIPPING section)
- If they don't match → this is a SHIPPING MISMATCH (T21) — high risk,
  seller responsibility
- Check tracking: where is the package NOW? When will it ACTUALLY arrive
  (carrier estimated delivery)?
- Calculate REAL delay: carrier_estimated_delivery - original_deliver_by
  (not just today - EDD)
- Check: was it shipped on time? Buy Shipping used?

STEP 3 — CHECK KNOWLEDGE BASE:
- Were there similar cases before? What was decided? What worked?
- Use the knowledge base entries provided in context to guide your decision.

STEP 4 — DECIDE ACTION:
- Based on Steps 1-3, choose the safest and most cost-effective action
- Follow economic ladder: clarify → redirect_amazon → replacement →
  partial_refund → full_refund
- Consider WHO SHOULD PAY based on facts

STEP 5 — GENERATE RESPONSE:
- Address what the CUSTOMER wrote (not just tracking facts)
- Use actual tracking data (carrier estimated delivery, not just EDD)
- Follow all policy guardrails
- Start with "Dear {name},"

CRITICAL RULES FOR RESPONSE GENERATION:
- The customer's message is the PRIMARY input — always acknowledge what they wrote
- Tracking data is SECONDARY — used to support the response with facts
- NEVER ignore what the customer said and just talk about tracking
- If customer mentions paying for expedited shipping but you shipped standard:
  NEVER say "we could not purchase Next Day" or "Amazon didn't offer that rate"
  — instead say "shipped using the fastest available shipping option"
- If order is in transit: NEVER suggest cancellation — say "once shipped,
  cancellation is no longer possible"
- Always give the customer a clear next step

INTERNAL ACTION choices (for internal queue, not customer-facing):
support_case / buy_shipping_reimbursement / sku_check / supplier_reorder / none

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

RESPONSE FORMAT — STRICT RULES:
1. FIRST LINE MUST BE: "Dear {customerName}," (use the exact customer name
   from the CONTEXT section)
   - If the customer name is "Customer" or Unknown, use "Dear Customer,"
   - For Spanish language, use "Estimado/a {customerName},"
   - This greeting line is MANDATORY — NEVER skip it
   - NEVER start a response with "Thank you" — the greeting ALWAYS comes first
2. Empty line after greeting
3. Thank-you or apology sentence
4. One factual sentence using ACTUAL tracking data provided in context
   (carrier, status, delivery date, days in transit)
5. One clear resolution sentence
6. Empty line before closing
7. "Best regards," on its own line
8. The store name on the next line

EXAMPLE:
"Dear Cathy,

Thank you for reaching out about your recent order. I can see your package
was shipped via UPS Ground on April 2 and was delivered on April 5 after
3 days in transit. Since this appears to be a carrier delivery issue
outside of our control, I recommend filing an A-to-Z claim with Amazon
for the fastest resolution.

Best regards,
Salutem Solutions"

CRITICAL RULES FOR THE RESPONSE:
- ALWAYS address the customer by name on the first line
- ALWAYS reference the actual tracking data (carrier, dates, transit time)
  from the SHIPPING section in the context
- NEVER guess tracking status — only use what is provided
- If tracking fields are null / Unknown — say "We are currently checking
  the status of your shipment" instead of inventing details
- Keep the response 4–8 sentences
- Match the customer's language (English or Spanish)

VIOLATION CHECK: If your suggestedResponse does not start with "Dear",
you MUST rewrite it before returning the JSON.

POLICY GUARDRAILS — HARD RULES (follow before writing response):

- NEVER suggest cancellation if the order is already shipped
  (trackingStatus = "in_transit" or "delivered"). Instead say:
  "Because your order has already shipped and is in transit, cancellation
  may not be possible at this point."
- NEVER promise a specific refund amount unless explicitly told to.
- NEVER admit seller fault for carrier delays. Use "delivery issue outside
  of our control" or "carrier delay".
- NEVER tell the customer to contact the carrier directly — always route
  through Amazon.
- NEVER write dates that are not in the SHIPPING section data. Use ONLY
  the exact dates provided:
    * Ship date from context = use that exact date verbatim.
    * EDD from context       = use that exact date verbatim.
    * DO NOT add days or guess dates.
    * If a date field is Unknown / null — do not mention any date.
- NEVER suggest "cancelling the order" for shipped orders. Instead:
    * in_transit + customer wants cancel → "Since your order is already
      in transit, I recommend contacting Amazon Customer Support through
      your order page for assistance."
    * delivered → "Your package has been delivered. If you'd like to
      return it, you can initiate a return through your Amazon order page."
- ALWAYS check: is the order shipped? If yes, NEVER suggest cancel.
- NEVER guarantee food safety after a spoilage complaint. Do not use
  phrases like "safe to eat", "fresh", or "in good condition".

CANCELLATION LOGIC (use trackingStatus from CONTEXT):
  null or "pending" → cancellation MAY be possible, offer to check
  "in_transit"     → CANNOT cancel, redirect to Amazon Customer Support
  "delivered"      → CANNOT cancel, offer return process
  "exception"      → investigate, may be able to intercept

SHIPPING MISMATCH (T21) — SPECIAL RULES:
- This is SELLER responsibility, not carrier or Amazon
- NEVER admit the mismatch directly ("we couldn't buy Next Day")
- Instead say: "shipped using the fastest available shipping option at the time"
- NEVER suggest cancellation for shipped orders
- Offer: wait for delivery → then return/refund through Amazon if no longer needed
- Risk level: HIGH
- Who pays: us (seller)

Example response for T21:
"Dear {name},

Thank you for your message. I understand your concern regarding the delivery
timing. Your order was processed and shipped promptly using the fastest
available shipping option at the time. The package is currently in transit
with {carrier} and is scheduled for delivery on {carrier_estimated_delivery}.
Unfortunately, once an order has been shipped, we are unable to cancel it.
We recommend waiting for delivery. If the item is no longer needed upon
arrival, you can request a return or refund through your Amazon account.

Best regards,
{store}"`;

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
  daysInTransit: number | null;
  daysLate: number | null;
  // Shipping service mismatch detection (T21) — set by the enricher from
  // Amazon order metadata vs Veeqo shipment data.
  requestedShippingService: string | null;
  actualShippingService: string | null;
  shippingMismatch: boolean;
  carrierEstimatedDelivery: string | null;
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
  // Optional extra instruction appended to the user message. Used by the
  // "Rewrite safer" button to steer the model (e.g. "Rewrite to be
  // strictly policy-safe for Amazon").
  extraInstruction?: string;
}

export interface FactCheckMismatch {
  field: "date" | "carrier" | "status";
  inResponse: string;
  actual: string;
  severity: "error" | "warning";
}

export interface FactCheckResult {
  passed: boolean;
  mismatches: FactCheckMismatch[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
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
  factCheck: FactCheckResult;
}

// Produce several human-readable variants of a YYYY-MM-DD date so
// factCheckResponse can match the AI's prose ("April 8", "Apr 8", "4/8").
// Noon time avoids timezone edge cases where the date would roll back.
function formatDateVariants(dateStr: string): string[] {
  const d = new Date(dateStr + "T12:00:00");
  if (Number.isNaN(d.getTime())) return [];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthsShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = d.getMonth();
  const day = d.getDate();
  return [
    `${monthsShort[month]} ${day}`,
    `${months[month]} ${day}`,
    `${month + 1}/${day}`,
    `${String(month + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
  ];
}

/**
 * Audit an AI-generated response against the known context data. Flags:
 *   - dates mentioned in the response that don't match shipDate / EDD /
 *     actualDelivery
 *   - carrier names that don't match the real carrier
 *   - tracking-status claims that contradict trackingStatus
 *
 * Any "error"-severity mismatch drops confidence to LOW. Any mismatch at
 * all drops it to at most MEDIUM. Clean response = HIGH confidence.
 */
export function factCheckResponse(
  response: string,
  context: AnalysisInput
): FactCheckResult {
  const mismatches: FactCheckMismatch[] = [];

  if (!response) {
    return { passed: true, mismatches: [], confidence: "HIGH" };
  }

  // --- Date checks ---
  if (context.shipDate || context.promisedEdd || context.actualDelivery) {
    const datePatterns =
      response.match(
        /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/gi
      ) || [];
    const shipDateFormatted = context.shipDate
      ? formatDateVariants(context.shipDate)
      : [];
    const eddFormatted = context.promisedEdd
      ? formatDateVariants(context.promisedEdd)
      : [];
    const deliveryFormatted = context.actualDelivery
      ? formatDateVariants(context.actualDelivery)
      : [];

    for (const dateInResponse of datePatterns) {
      const normalized = dateInResponse.trim().toLowerCase();
      const matches = (variants: string[]): boolean =>
        variants.some((v) => normalized.includes(v.toLowerCase()));
      if (
        !matches(shipDateFormatted) &&
        !matches(eddFormatted) &&
        !matches(deliveryFormatted)
      ) {
        mismatches.push({
          field: "date",
          inResponse: dateInResponse.trim(),
          actual: `Ship: ${context.shipDate || "N/A"}, EDD: ${context.promisedEdd || "N/A"}`,
          severity: "error",
        });
      }
    }
  }

  // --- Carrier check ---
  if (context.carrier) {
    const carrierMatch = response.match(/shipped via ([A-Za-z\s]+?)[\s,\.]/i);
    if (carrierMatch) {
      const inResponse = carrierMatch[1].trim().toLowerCase();
      const actualLower = context.carrier.toLowerCase();
      // Normalise common Veeqo values ("Buy Shipping" → "ups", "UPS®" → "ups")
      const actualNormalised = actualLower
        .replace("buy shipping", "ups")
        .replace("®", "")
        .trim();
      if (
        !inResponse.includes(actualNormalised) &&
        !actualNormalised.includes(inResponse)
      ) {
        mismatches.push({
          field: "carrier",
          inResponse: carrierMatch[1].trim(),
          actual: context.carrier,
          severity: "error",
        });
      }
    }
  }

  // --- Status checks ---
  const lower = response.toLowerCase();
  if (
    context.trackingStatus === "in_transit" &&
    /has been delivered|was delivered|package (?:was|has been) delivered/.test(
      lower
    )
  ) {
    mismatches.push({
      field: "status",
      inResponse: "delivered",
      actual: "in_transit",
      severity: "error",
    });
  }
  if (
    context.trackingStatus === "delivered" &&
    /is currently in transit|on its way|still in transit/.test(lower)
  ) {
    mismatches.push({
      field: "status",
      inResponse: "in transit",
      actual: "delivered",
      severity: "error",
    });
  }

  const hasErrors = mismatches.some((m) => m.severity === "error");
  const confidence: "HIGH" | "MEDIUM" | "LOW" = hasErrors
    ? "LOW"
    : mismatches.length > 0
      ? "MEDIUM"
      : "HIGH";
  return {
    passed: mismatches.length === 0,
    mismatches,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Post-generation validator + auto-fix
// ---------------------------------------------------------------------------
// The SYSTEM_PROMPT already tells the model not to suggest cancellations
// for shipped orders, invent dates, guarantee food safety, etc. — but AI
// still slips through those rules occasionally. This layer runs AFTER
// generation, catches the 6 most common policy violations, and if any are
// found it re-runs the model with a tight corrective prompt. If the retry
// also fails we fall back to a deterministic safe template.

interface ValidationResult {
  fixed: boolean;
  response: string;
  fixReason: string | null;
}

function buildSafeResponse(input: AnalysisInput): string {
  const name = input.customerName || "Customer";
  const store = input.storeName;

  if (input.trackingStatus === "in_transit") {
    return `Dear ${name},\n\nThank you for reaching out about your order. Your package was shipped on ${input.shipDate || "the scheduled date"} via ${input.carrier || "the carrier"} and is currently in transit. We understand the delivery is taking longer than expected, and we apologize for the inconvenience. For the fastest resolution regarding this delivery delay, we recommend contacting Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
  }

  if (input.trackingStatus === "delivered") {
    return `Dear ${name},\n\nThank you for contacting us. According to tracking information, your package was delivered on ${input.actualDelivery || "the expected date"}. If you have not received it, we recommend checking with neighbors, your front desk, or any secure delivery locations. For further assistance, please contact Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
  }

  return `Dear ${name},\n\nThank you for reaching out. We are looking into your concern and will provide an update shortly. If you need immediate assistance, please contact Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
}

export interface ValidatorAnalysisContext {
  /** Who should pay for resolution — from AnalysisResult.whoShouldPay */
  whoShouldPay?: string;
  /** Food-safety-risk flag — from AnalysisResult.foodSafetyRisk */
  foodSafetyRisk?: boolean;
}

export async function validateAndFixResponse(
  response: string,
  input: AnalysisInput,
  factCheck: FactCheckResult,
  analysisContext: ValidatorAnalysisContext = {}
): Promise<ValidationResult> {
  const violations: string[] = [];
  const lower = response.toLowerCase();

  // RULE 1 — cancel suggested but order is shipped (pending counts as ok)
  if (
    lower.includes("cancel") &&
    input.trackingStatus &&
    input.trackingStatus !== "pending" &&
    !lower.includes("cancellation may not be possible")
  ) {
    violations.push(
      `Response suggests cancellation but order is already ${input.trackingStatus}`
    );
  }

  // RULE 2 — factCheck caught wrong dates
  if (
    factCheck.mismatches.some(
      (m) => m.field === "date" && m.severity === "error"
    )
  ) {
    violations.push("Response contains incorrect dates");
  }

  // RULE 3 — says delivered but in transit
  if (
    input.trackingStatus === "in_transit" &&
    lower.includes("has been delivered")
  ) {
    violations.push("Response says delivered but order is in transit");
  }

  // RULE 4 — says in transit but delivered
  if (
    input.trackingStatus === "delivered" &&
    lower.includes("currently in transit")
  ) {
    violations.push("Response says in transit but order is delivered");
  }

  // RULE 5 — seller-funded refund offered when Amazon should pay
  if (
    analysisContext.whoShouldPay === "amazon" &&
    /we will refund|i will process a refund|full refund from us/i.test(response)
  ) {
    violations.push("Response offers seller refund but Amazon should pay");
  }

  // RULE 6 — guaranteeing food safety after spoilage
  if (
    analysisContext.foodSafetyRisk &&
    /safe to consume|perfectly safe|still good/i.test(response)
  ) {
    violations.push(
      "Response guarantees food safety after spoilage complaint"
    );
  }

  if (violations.length === 0) {
    return { fixed: false, response, fixReason: null };
  }

  console.log("[Validator] Violations detected:", violations);
  console.log("[Validator] Auto-fixing response…");

  const fixPrompt = `Your previous response had policy violations. Rewrite it following these MANDATORY constraints:

VIOLATIONS FOUND:
${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}

ORIGINAL RESPONSE:
"${response}"

FACTS (use ONLY these dates and data):
- Ship Date: ${input.shipDate || "unknown"}
- EDD: ${input.promisedEdd || "unknown"}
- Actual Delivery: ${input.actualDelivery || "not yet"}
- Tracking Status: ${input.trackingStatus || "unknown"}
- Carrier: ${input.carrier || "unknown"}
- Days In Transit: ${input.daysInTransit ?? "unknown"}
- Days Late: ${input.daysLate ?? "0"}
- Customer Name: ${input.customerName || "Customer"}
- Store Name: ${input.storeName}

MANDATORY RULES FOR REWRITE:
- Start with "Dear ${input.customerName || "Customer"},"
- Use ONLY the dates listed above — do NOT change them
- If order is in_transit: say "your order is currently in transit" and "we recommend contacting Amazon Customer Support through your order page"
- If order is delivered: reference the delivery
- NEVER suggest cancellation for shipped orders
- NEVER offer seller refund if Amazon should pay
- NEVER guarantee food safety
- End with "Best regards," and store name
- Keep 4-6 sentences

Return ONLY the rewritten response text, no JSON, no explanation.`;

  try {
    const config = await getAIConfig();
    for (const provider of config.providerChain) {
      const model =
        provider === "claude" ? config.claudeModel : config.openaiModel;
      try {
        const fixedText =
          provider === "claude"
            ? await callClaudeRaw(fixPrompt, model)
            : await callOpenAIRaw(fixPrompt, model);
        const trimmed = fixedText.trim();
        if (trimmed && trimmed.toLowerCase().startsWith("dear")) {
          console.log(`[Validator] Response fixed with ${provider}`);
          return {
            fixed: true,
            response: trimmed,
            fixReason: violations.join("; "),
          };
        }
      } catch (e) {
        console.warn(
          `[Validator] ${provider} rewrite failed:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  } catch (e) {
    console.error("[Validator] Auto-fix chain failed:", e);
  }

  // Last-resort deterministic template
  console.log("[Validator] Falling back to safe template");
  return {
    fixed: true,
    response: buildSafeResponse(input),
    fixReason: `Auto-fix failed, using safe template: ${violations.join("; ")}`,
  };
}

// Provider call returns the raw text from the model. Parsing + greeting
// fallback happens in tryParseAnalysis, which is shared between providers
// since both models return the same JSON schema.
async function callClaude(
  userMessage: string,
  model: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function callOpenAI(
  userMessage: string,
  model: string
): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    // Low temperature for consistent structured JSON output
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content || "";
}

// Raw text-only provider calls for the validator. Unlike the analysis
// calls above these DO NOT send SYSTEM_PROMPT — the validator passes its
// own constrained prompt and expects plain-text output, not JSON.
async function callClaudeRaw(
  prompt: string,
  model: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function callOpenAIRaw(
  prompt: string,
  model: string
): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1000,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0]?.message?.content || "";
}

export async function analyzeMessage(
  input: AnalysisInput
): Promise<AnalysisResult> {
  // Runtime-configurable: operator picks primary provider + model per
  // provider from the Settings UI (Setting table). Providers without a
  // valid .env key are stripped from the chain automatically.
  const config = await getAIConfig();
  if (config.providerChain.length === 0) {
    console.error(
      "[Analyzer] No AI providers configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env"
    );
    return fallbackResult(input);
  }

  // Pull similar past cases from the knowledge base to give Claude/OpenAI
  // concrete worked examples. For shipping-mismatch cases we bias the
  // lookup to T21 so we always find the canonical scenario.
  let similarCases: KnowledgeBaseHint[] = [];
  try {
    similarCases = await findSimilarCases(
      input.shippingMismatch ? "T21" : null,
      input.customerMessage?.substring(0, 100) || null,
      3
    );
    if (similarCases.length > 0) {
      console.log(
        `[Analyzer] Found ${similarCases.length} similar KB case(s)`
      );
    }
  } catch (e) {
    console.warn(
      "[Analyzer] Knowledge base lookup failed:",
      e instanceof Error ? e.message : String(e)
    );
  }

  const userMessage = buildContextMessage(input, similarCases);
  let lastError = "";

  for (const provider of config.providerChain) {
    const model =
      provider === "claude" ? config.claudeModel : config.openaiModel;
    try {
      console.log(`[Analyzer] Trying ${provider} (${model})…`);
      const text =
        provider === "claude"
          ? await callClaude(userMessage, model)
          : await callOpenAI(userMessage, model);

      const parsed = tryParseAnalysis(text, input);
      if (parsed) {
        console.log(`[Analyzer] Success with ${provider}`);
        // Post-generation validator — catches policy violations that
        // slipped through the system prompt and auto-rewrites the
        // response. Fact check is re-run against the fixed version.
        const validation = await validateAndFixResponse(
          parsed.suggestedResponse,
          input,
          parsed.factCheck,
          {
            whoShouldPay: parsed.whoShouldPay,
            foodSafetyRisk: parsed.foodSafetyRisk,
          }
        );
        if (validation.fixed) {
          parsed.suggestedResponse = validation.response;
          parsed.reasoning =
            `${parsed.reasoning || ""} [AUTO-FIXED: ${validation.fixReason}]`.trim();
          parsed.factCheck = factCheckResponse(parsed.suggestedResponse, input);
        }
        return parsed;
      }
      lastError = `${provider} returned unparseable response`;
      console.error(`[Analyzer] ${lastError}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[Analyzer] ${provider} failed: ${lastError}`);
      // Fall through to next provider
    }
  }

  console.error(
    `[Analyzer] All providers failed. Last error: ${lastError}. Using heuristic fallback.`
  );
  return fallbackResult(input);
}

// Re-export the provider type so other modules can reference it
export type { ProviderName };

function buildContextMessage(
  input: AnalysisInput,
  similarCases: KnowledgeBaseHint[] = []
): string {
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
- Requested Shipping Service: ${input.requestedShippingService || "Unknown"}
- Actual Shipping Service: ${input.actualShippingService || "Unknown"}
- Shipping Mismatch: ${input.shippingMismatch ? "YES — customer paid for different service than what was shipped" : "No"}
- Carrier Estimated Delivery: ${input.carrierEstimatedDelivery || "Unknown"}
- Tracking: ${input.trackingNumber || "None"}
- Status: ${input.trackingStatus || "Unknown"}
- Ship Date: ${input.shipDate || "Unknown"}
- Promised EDD: ${input.promisedEdd || "Unknown"}
- Actual Delivery: ${input.actualDelivery || "Unknown"}
- Days In Transit: ${input.daysInTransit ?? "Unknown"}
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

  if (similarCases.length > 0) {
    msg += "\n\nKNOWLEDGE BASE — SIMILAR PAST CASES:\n";
    for (const kb of similarCases) {
      msg += "---\n";
      msg += `Scenario: ${kb.scenario}\n`;
      msg += `Customer said: ${kb.customerSaid}\n`;
      msg += `Correct action: ${kb.correctAction}\n`;
      msg += `Correct response: ${kb.correctResponse.substring(0, 200)}\n`;
      msg += `Reasoning: ${kb.reasoning}\n`;
      msg += `Outcome: ${kb.outcome || "unknown"}\n`;
    }
    msg +=
      "\nUse these past cases as GUIDANCE for your response. Adapt to current situation.\n";
  }

  if (input.extraInstruction) {
    msg += `\n\nADDITIONAL INSTRUCTION:\n${input.extraInstruction}`;
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

// Belt-and-braces: Claude sometimes still skips the greeting despite the
// prompt's "VIOLATION CHECK" clause. If the response doesn't start with
// "Dear" (or the Spanish equivalent), prepend a correct greeting so the
// operator never has to hand-add one.
function ensureGreeting(
  response: string,
  input: AnalysisInput
): string {
  if (!response) return response;
  const trimmed = response.trimStart();
  const startsWithGreeting =
    /^dear\b/i.test(trimmed) || /^estimad[oa]\b/i.test(trimmed);
  if (startsWithGreeting) return response;

  const isSpanish = /^es/i.test(input.language);
  const nameForGreeting = input.customerName || "Customer";
  const greeting = isSpanish
    ? `Estimado/a ${nameForGreeting},`
    : `Dear ${nameForGreeting},`;
  return `${greeting}\n\n${trimmed}`;
}

// Ensure response ends with "Best regards,\n{store}" — Claude usually gets
// this right but OpenAI (especially gpt-4o-mini) sometimes forgets. We add
// the sign-off only if it's missing, preserving any existing closing.
function ensureClosing(
  response: string,
  input: AnalysisInput
): string {
  if (!response) return response;
  const trimmed = response.trimEnd();
  // Accept any "Best regards", "Kind regards", "Sincerely", or Spanish
  // "Atentamente" / "Saludos" as evidence of an explicit closing.
  const hasClosing =
    /(best regards|kind regards|sincerely|atentamente|saludos|cordialmente)/i.test(
      trimmed
    );
  if (hasClosing) return response;

  const isSpanish = /^es/i.test(input.language);
  const closing = isSpanish ? "Atentamente," : "Best regards,";
  return `${trimmed}\n\n${closing}\n${input.storeName}`;
}

// Provider-loop parser. Returns null on failure so the caller can fall
// through to the next provider. For a "safe" parser that returns a
// fallback result on failure, use the existing fallbackResult() directly.
function tryParseAnalysis(
  text: string,
  input: AnalysisInput
): AnalysisResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object") return null;
    const suggestedResponse = ensureClosing(
      ensureGreeting(parsed.suggestedResponse || "", input),
      input
    );
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
      suggestedResponse,
      reasoning: parsed.reasoning || "",
      factCheck: factCheckResponse(suggestedResponse, input),
    };
  } catch (e) {
    console.error("[Analyzer] JSON parse failed:", e);
    return null;
  }
}

function fallbackResult(input: AnalysisInput): AnalysisResult {
  const suggestedResponse = `Dear ${input.customerName || "Customer"},\n\nThank you for reaching out. We are looking into your concern and will get back to you shortly.\n\nBest regards,\n${input.storeName}`;
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
    suggestedResponse,
    reasoning: "AI analysis unavailable, using safe fallback",
    // Safe fallback has no AI-generated dates/carriers → always passes
    factCheck: { passed: true, mismatches: [], confidence: "HIGH" },
  };
}
