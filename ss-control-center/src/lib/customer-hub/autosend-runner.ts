/**
 * Runs the auto-send policy for one analyzed BuyerMessage and stores the
 * verdict on the row (`autosendDecision`). Sends only when the owner has set
 * Setting `customer_hub_autosend` = "on"; the default is shadow mode.
 */
import { prisma } from "@/lib/prisma";
import {
  AUTOSEND_DAILY_CAP_KEY,
  AUTOSEND_DEFAULT_DAILY_CAP,
  AUTOSEND_SETTING_KEY,
  evaluateAutosend,
  parseAutosendMode,
  type AutosendMode,
} from "./autosend-policy";
import { sendResponse } from "./response-sender";

export interface StoredAutosendDecision {
  mode: AutosendMode;
  eligible: boolean;
  reasons: string[];
  evaluatedAt: string;
  /** Set when mode=on and the send was attempted. */
  sent?: boolean;
  sendError?: string;
}

export async function getAutosendMode(): Promise<AutosendMode> {
  const row = await prisma.setting.findUnique({ where: { key: AUTOSEND_SETTING_KEY } });
  return parseAutosendMode(row?.value);
}

async function getDailyCap(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: AUTOSEND_DAILY_CAP_KEY } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : AUTOSEND_DEFAULT_DAILY_CAP;
}

export async function runAutosend(
  messageId: string,
  extra: {
    kbTopScore?: number;
    isFallback?: boolean;
    /** Record the verdict only, even in "on" mode (owner-triggered re-analyze). */
    neverSend?: boolean;
  } = {}
): Promise<StoredAutosendDecision | null> {
  const mode = await getAutosendMode();
  if (mode === "off") return null;

  const m = await prisma.buyerMessage.findUnique({ where: { id: messageId } });
  if (!m || m.direction !== "incoming") return null;

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const [repliedOnOrder, autoSentToday, dailyCap] = await Promise.all([
    m.amazonOrderId
      ? prisma.buyerMessage.count({
          where: {
            amazonOrderId: m.amazonOrderId,
            id: { not: m.id },
            OR: [{ direction: "outgoing" }, { responseSentAt: { not: null } }],
          },
        })
      : Promise.resolve(0),
    prisma.buyerMessage.count({
      where: { responseSentVia: "AUTOPILOT", direction: "incoming", responseSentAt: { gte: startOfDay } },
    }),
    getDailyCap(),
  ]);

  let factConfidence: string | null = null;
  try {
    factConfidence = m.factCheckJson ? JSON.parse(m.factCheckJson).confidence ?? null : null;
  } catch {
    factConfidence = null;
  }

  const verdict = evaluateAutosend({
    channel: m.channel,
    language: m.language,
    problemType: m.problemType,
    action: m.action,
    riskLevel: m.riskLevel,
    foodSafetyRisk: m.foodSafetyRisk,
    atozRisk: m.atozRisk,
    factCheckConfidence: factConfidence,
    kbTopScore: extra.kbTopScore,
    isFallback: extra.isFallback,
    responseText: m.editedResponse || m.suggestedResponse,
    alreadyRepliedOnOrder: repliedOnOrder > 0,
    reasoning: m.reasoning,
    customerEmail: m.customerEmail,
    autoSentToday,
    dailyCap,
  });

  const decision: StoredAutosendDecision = { mode, ...verdict };

  if (mode === "on" && verdict.eligible && !extra.neverSend) {
    const result = await sendResponse(m.id, { initiator: "AUTOPILOT" });
    decision.sent = result.success;
    if (!result.success) {
      decision.sendError = result.error;
      // Emergency stop: one failed autopilot send drops the whole hub back
      // to shadow mode until the owner looks at it.
      await prisma.setting.upsert({
        where: { key: AUTOSEND_SETTING_KEY },
        create: { key: AUTOSEND_SETTING_KEY, value: "shadow" },
        update: { value: "shadow" },
      });
    }
  }

  await prisma.buyerMessage.update({
    where: { id: m.id },
    data: { autosendDecision: JSON.stringify(decision) },
  });
  return decision;
}
