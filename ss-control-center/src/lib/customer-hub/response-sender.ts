import {
  sendBuyerMessage,
  getMessagingActionsForOrder,
} from "@/lib/amazon-sp-api/messaging";
import { prisma } from "@/lib/prisma";

export interface SendResult {
  success: boolean;
  method: "SP_API" | "MANUAL";
  /** Error message for display to the operator when success=false */
  error?: string;
  /** When success=false due to Amazon gating, list the actions that
   *  WERE allowed for this order so the UI can explain what's possible. */
  allowedActions?: string[];
  /** True when the failure is a "messaging window closed" scenario —
   *  distinct from auth errors, coding bugs, etc. The UI shows a
   *  yellow/orange "reply in Seller Central" banner in this case
   *  instead of a red error. */
  messagingClosed?: boolean;
}

/**
 * Send a prepared buyer response for a BuyerMessage row.
 *
 * - Amazon: posts via SP-API Messaging `createUnexpectedProblem`, updates
 *   the source row to SENT, and creates a companion `direction: "outgoing"`
 *   row so the conversation history renders both sides of the thread.
 * - Walmart: no public API — returns a MANUAL result so the UI prompts
 *   the operator to copy-paste into Seller Center.
 *
 * All failures are surfaced back to the caller, never swallowed, so the
 * Messages tab can show an error toast when things go wrong.
 */
export async function sendResponse(messageId: string): Promise<SendResult> {
  const message = await prisma.buyerMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) {
    return { success: false, method: "MANUAL", error: "Message not found" };
  }

  const responseText = message.editedResponse || message.suggestedResponse;
  if (!responseText) {
    return { success: false, method: "MANUAL", error: "No response text to send" };
  }
  if (!message.amazonOrderId) {
    return { success: false, method: "MANUAL", error: "No Order ID on message" };
  }
  if (message.channel === "Walmart") {
    return {
      success: false,
      method: "MANUAL",
      error:
        "Walmart has no public buyer-seller messaging API. Copy the response and paste it into Seller Center.",
    };
  }

  const storeId = `store${message.storeIndex}`;

  // Preflight — Amazon gates which message actions are available per
  // order (fulfillment status, messaging window, opt-outs). Without this
  // check, sendBuyerMessage would return 403 Unauthorized for gated
  // orders with no way for the operator to understand why.
  let allowedActions: string[] = [];
  try {
    const actions = await getMessagingActionsForOrder(
      message.amazonOrderId,
      storeId
    );
    allowedActions = actions.map((a) => a.name);
  } catch (preflightErr) {
    // A preflight failure is itself informative — usually a 403 means the
    // app's SP-API role doesn't cover Messaging at all, or the refresh
    // token is missing the Buyer Communication scope.
    const msg =
      preflightErr instanceof Error
        ? preflightErr.message
        : String(preflightErr);
    console.error("[response-sender] Preflight failed:", msg);
    return {
      success: false,
      method: "MANUAL",
      error: `Cannot check available message actions: ${msg}. Likely missing Buyer Communication role on SP-API app, or refresh token was generated before that role was added. Reply manually in Seller Central for now.`,
    };
  }

  if (!allowedActions.includes("unexpectedProblem")) {
    return {
      success: false,
      method: "MANUAL",
      messagingClosed: true,
      allowedActions,
      error:
        allowedActions.length === 0
          ? "Amazon has closed the buyer-seller messaging window for this order. Reply manually in Seller Central."
          : `Amazon does not currently allow 'unexpectedProblem' messages for this order (only ${allowedActions.join(", ")} are permitted). Reply manually in Seller Central.`,
    };
  }

  try {
    await sendBuyerMessage(
      message.amazonOrderId,
      "unexpectedProblem",
      { rawMessageBody: responseText },
      storeId
    );

    const now = new Date();

    // Mark the incoming row as sent
    await prisma.buyerMessage.update({
      where: { id: messageId },
      data: {
        status: "SENT",
        responseSentAt: now,
        responseSentVia: "SP_API",
      },
    });

    // Persist the outgoing reply so the conversation history renders both
    // sides of the thread. We copy the customer/order metadata so this row
    // can be displayed and filtered independently.
    await prisma.buyerMessage.create({
      data: {
        channel: message.channel,
        source: message.source,
        storeIndex: message.storeIndex,
        storeName: message.storeName,
        storeEmail: message.storeEmail,
        customerName: message.customerName,
        amazonOrderId: message.amazonOrderId,
        product: message.product,
        direction: "outgoing",
        customerMessage: responseText,
        status: "SENT",
        responseSentAt: now,
        responseSentVia: "SP_API",
        action: message.action,
        problemType: message.problemType,
        problemTypeName: message.problemTypeName,
        riskLevel: message.riskLevel,
      },
    });

    return { success: true, method: "SP_API" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[response-sender] SP-API Messaging error:", msg);
    return {
      success: false,
      method: "MANUAL",
      error: `SP-API error: ${msg}. Copy the response and paste it into Seller Central.`,
    };
  }
}
