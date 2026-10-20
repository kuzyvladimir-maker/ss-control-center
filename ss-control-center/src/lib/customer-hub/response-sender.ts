import { prisma } from "@/lib/prisma";

/**
 * Buyer replies go out ONLY through Seller Central, from the VPS of that
 * Amazon account (owner rule, 2026-10-20): an agent on the account's VPS
 * opens the order's Buyer-Seller Messaging thread, pastes the prepared
 * reply (plus attachments when needed) and sends it in the communication
 * window. Never through Gmail, never through the SP-API messaging actions,
 * never from the iMac or the server browser (related-account risk).
 *
 * The hub prepares text, decision and attachments; the VPS send-task queue
 * and agent are designed in docs/wiki/customer-hub-vps-send.md and are not
 * built yet. Until then this function only reports that the reply must be
 * sent in Seller Central by hand; the confirmation sweep in
 * sync-messages.ts marks the case SENT when Amazon's "Your e-mail to …"
 * confirmation arrives.
 */

export interface SendResult {
  success: boolean;
  method: "VPS_AGENT" | "MANUAL";
  /** Error message for display to the operator when success=false */
  error?: string;
  /** Kept for the UI: true renders the yellow "reply in Seller Central"
   *  hint instead of a red error. */
  messagingClosed?: boolean;
  allowedActions?: string[];
}

export interface SendOptions {
  /** Who pressed send — the owner in the hub, or the autopilot. */
  initiator?: "OWNER" | "AUTOPILOT";
}

export async function sendResponse(
  messageId: string,
  // Reserved for the VPS send-task queue (who queued the task).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _opts: SendOptions = {}
): Promise<SendResult> {
  const message = await prisma.buyerMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) {
    return { success: false, method: "MANUAL", error: "Message not found" };
  }

  // One message, one send.
  if (message.responseSentAt) {
    return {
      success: false,
      method: "MANUAL",
      error: `Already sent ${message.responseSentAt.toISOString()} via ${message.responseSentVia || "unknown"}.`,
    };
  }

  const responseText = message.editedResponse || message.suggestedResponse;
  if (!responseText) {
    return { success: false, method: "MANUAL", error: "No response text to send" };
  }

  if (message.channel === "Walmart") {
    return {
      success: false,
      method: "MANUAL",
      error:
        "Walmart has no public buyer-seller messaging API. Copy the response and paste it into Seller Center.",
    };
  }

  return {
    success: false,
    method: "MANUAL",
    messagingClosed: true,
    error:
      "Replies are sent only through Seller Central from this account's VPS. The VPS send agent is not built yet — copy the reply into Buyer-Seller Messaging for this order. The case is marked sent automatically when Amazon's confirmation email arrives.",
  };
}
