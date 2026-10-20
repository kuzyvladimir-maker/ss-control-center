/**
 * Customer Hub auto-send policy — pure function, no DB, no network.
 *
 * Decides whether an analyzed buyer message could be answered without the
 * owner. Design: docs/wiki/customer-hub-autopilot-architecture.md §4.
 *
 * Modes (Setting `customer_hub_autosend`):
 *   off    — not even evaluated for display
 *   shadow — DEFAULT: evaluated and stored on the row ("would auto-send" /
 *            "draft — why"), never sent
 *   on     — eligible messages are sent automatically (owner's explicit go)
 *
 * Only informational answers can ever be eligible. Refunds, replacements,
 * claims and anything about money stay drafts for one-click approval.
 */

export type AutosendMode = "off" | "shadow" | "on";

export const AUTOSEND_SETTING_KEY = "customer_hub_autosend";
export const AUTOSEND_DAILY_CAP_KEY = "customer_hub_autosend_daily_cap";
export const AUTOSEND_DEFAULT_DAILY_CAP = 10;
/** Below this KB match score there is no close owner example to lean on. */
export const AUTOSEND_MIN_KB_SCORE = 0.6;

export function parseAutosendMode(value: string | null | undefined): AutosendMode {
  const v = (value || "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "shadow";
}

/** Informational types only: where is it, late-but-coming, pre-sale, postage-due ack. */
export const AUTOSEND_ALLOWED_TYPES = new Set(["T1", "T3", "T16", "T18"]);

/** Actions that do not move money or goods. */
export const AUTOSEND_ALLOWED_ACTIONS = new Set(["reassure", "clarify", "none"]);

export interface AutosendInput {
  channel: string;
  language: string | null | undefined;
  problemType: string | null | undefined;
  action: string | null | undefined;
  riskLevel: string | null | undefined;
  foodSafetyRisk: boolean;
  atozRisk: string | null | undefined;
  factCheckConfidence: string | null | undefined;
  kbTopScore: number | null | undefined;
  responseText: string | null | undefined;
  /** Analyzer fell back to the safe template (all providers failed). */
  isFallback?: boolean;
  /** Any reply already went to this buyer on this order (any channel). */
  alreadyRepliedOnOrder: boolean;
  /** Analyzer appended [NEEDS REVIEW: …] / [AUTO-FIXED: …] to reasoning. */
  reasoning?: string | null;
  /** We know the order or the product (ASIN / title). Without it the AI
   *  answers blind — e.g. a pre-sale "16 boxes × 8 = 128?" got "please send
   *  the order ID" instead of an answer. */
  hasOrderContext: boolean;
  /** The buyer's relay address — email-relay sending needs it. */
  customerEmail?: string | null;
  autoSentToday: number;
  dailyCap: number;
}

export interface AutosendDecision {
  eligible: boolean;
  reasons: string[];
  evaluatedAt: string;
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
/** Amazon forbids asking for (positive) feedback/reviews in buyer messages. */
const REVIEW_ASK_RE =
  /\b(leave|write|post|update|change|remove)\b[^.]{0,40}\b(review|feedback|rating)\b|\b5[- ]star\b/i;
// Health claims only — "prevent any future issues" in a support reply is not one.
const HEALTH_RE =
  /\b(cures?\b|treats? (disease|illness|symptoms)|prevents? (disease|illness|cancer|infection)|heals?\b|healing\b|detox|weight loss|boosts? (your )?immun)/i;

/**
 * Message-body rules for a reply that goes to the buyer without the owner.
 * Returns human-readable violations; empty means clean.
 */
export function replyContentViolations(text: string): string[] {
  const out: string[] = [];
  if (EMOJI_RE.test(text)) out.push("reply contains an emoji");
  if (URL_RE.test(text)) out.push("reply contains a link");
  if (EMAIL_RE.test(text)) out.push("reply contains an email address");
  if (PHONE_RE.test(text)) out.push("reply contains a phone number");
  if (REVIEW_ASK_RE.test(text)) out.push("reply mentions reviews/feedback");
  if (HEALTH_RE.test(text)) out.push("reply makes a health claim");
  return out;
}

export function evaluateAutosend(
  input: AutosendInput,
  now: Date = new Date()
): AutosendDecision {
  const reasons: string[] = [];
  const type = (input.problemType || "").toUpperCase();
  const action = (input.action || "").toLowerCase();

  if (input.channel !== "Amazon") reasons.push(`channel ${input.channel} is draft-only`);
  if (input.isFallback) reasons.push("AI analysis failed — safe template");
  if (!AUTOSEND_ALLOWED_TYPES.has(type))
    reasons.push(`type ${type || "unknown"} is not informational`);
  if (!AUTOSEND_ALLOWED_ACTIONS.has(action))
    reasons.push(`action ${action || "unknown"} needs the owner`);
  if ((input.riskLevel || "").toUpperCase() !== "LOW")
    reasons.push(`risk ${input.riskLevel || "unknown"}`);
  if (input.foodSafetyRisk) reasons.push("food-safety risk");
  if ((input.atozRisk || "").toLowerCase() !== "low")
    reasons.push(`A-to-Z risk ${input.atozRisk || "unknown"}`);
  if ((input.factCheckConfidence || "").toUpperCase() !== "HIGH")
    reasons.push(`fact-check ${input.factCheckConfidence || "missing"}`);
  if ((input.kbTopScore ?? 0) < AUTOSEND_MIN_KB_SCORE)
    reasons.push(
      `no close owner example (best ${(input.kbTopScore ?? 0).toFixed(2)} < ${AUTOSEND_MIN_KB_SCORE})`
    );
  if (!/^en/i.test(input.language || "")) reasons.push(`language ${input.language || "unknown"}`);
  if (input.alreadyRepliedOnOrder) reasons.push("buyer already got a reply on this order");
  if (!input.hasOrderContext) reasons.push("no order or product context");
  if (/\[(NEEDS REVIEW|AUTO-FIXED)/.test(input.reasoning || ""))
    reasons.push("validator flagged the draft");
  if (!input.customerEmail || !/@marketplace\.amazon\.com$/i.test(input.customerEmail))
    reasons.push("no Amazon relay address");

  const text = (input.responseText || "").trim();
  if (!text) reasons.push("empty draft");
  else reasons.push(...replyContentViolations(text));

  if (input.autoSentToday >= input.dailyCap)
    reasons.push(`daily cap reached (${input.autoSentToday}/${input.dailyCap})`);

  return { eligible: reasons.length === 0, reasons, evaluatedAt: now.toISOString() };
}
