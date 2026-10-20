import {
  sendBuyerMessage,
  getMessagingActionsForOrder,
} from "@/lib/amazon-sp-api/messaging";
import { prisma } from "@/lib/prisma";
import {
  getGmailAccountByEmail,
  readMessage,
  sendGmailMessage,
} from "@/lib/gmail-api";

/** Buyer-Seller Messaging relay domain — mail from the seller's registered
 *  address to this address is posted into the buyer's message thread. */
const AMAZON_RELAY_RE = /@marketplace\.amazon\.com$/i;

export interface SendResult {
  success: boolean;
  method: "EMAIL_RELAY" | "SP_API" | "MANUAL";
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

export interface SendOptions {
  /** Who pressed send — the owner in the hub, or the autopilot. */
  initiator?: "OWNER" | "AUTOPILOT";
}

/**
 * Send a prepared buyer response for a BuyerMessage row.
 *
 * - Amazon, preferred (2026-10-19): reply by email from the store's seller
 *   mailbox to the buyer's `…@marketplace.amazon.com` relay address, inside
 *   the same Gmail thread. Amazon posts it into Buyer-Seller Messages. Needs
 *   the store's Gmail connected with the gmail.send scope.
 * - Amazon, fallback when there is no relay address: SP-API Messaging
 *   `createUnexpectedProblem` (rarely offered for replies — see
 *   docs/wiki/customer-hub-diagnosis-2026-10-18.md), updates
 *   the source row to SENT, and creates a companion `direction: "outgoing"`
 *   row so the conversation history renders both sides of the thread.
 * - Walmart: no public API — returns a MANUAL result so the UI prompts
 *   the operator to copy-paste into Seller Center.
 *
 * All failures are surfaced back to the caller, never swallowed, so the
 * Messages tab can show an error toast when things go wrong.
 */
export async function sendResponse(
  messageId: string,
  opts: SendOptions = {}
): Promise<SendResult> {
  const message = await prisma.buyerMessage.findUnique({
    where: { id: messageId },
  });

  if (!message) {
    return { success: false, method: "MANUAL", error: "Message not found" };
  }

  // One message, one send. A second press (or an overlapping autopilot
  // run) must never deliver the same reply twice.
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

  if (message.customerEmail && AMAZON_RELAY_RE.test(message.customerEmail)) {
    return sendViaEmailRelay(message, responseText, opts);
  }

  if (!message.amazonOrderId) {
    return { success: false, method: "MANUAL", error: "No Order ID on message" };
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
        responseSentVia: opts.initiator === "AUTOPILOT" ? "AUTOPILOT" : "SP_API",
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

type BuyerMessageRow = NonNullable<
  Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>
>;

function header(
  msg: Awaited<ReturnType<typeof readMessage>>,
  name: string
): string | null {
  const h = (msg.payload?.headers || []).find(
    (x) => x?.name?.toLowerCase() === name.toLowerCase()
  );
  return h?.value || null;
}

async function sendViaEmailRelay(
  message: BuyerMessageRow,
  responseText: string,
  opts: SendOptions
): Promise<SendResult> {
  const storeEmail = message.storeEmail;
  if (!storeEmail) {
    return {
      success: false,
      method: "MANUAL",
      error: "No seller mailbox recorded on this message. Reply in Seller Central.",
    };
  }
  const account = await getGmailAccountByEmail(storeEmail);
  if (!account) {
    return {
      success: false,
      method: "MANUAL",
      error: `Gmail ${storeEmail} is not connected. Connect it in Settings → Gmail (with send permission), or reply in Seller Central.`,
    };
  }

  // Thread the reply under the buyer's email so Amazon keeps one conversation.
  let subject = "Re: Your Amazon order";
  let inReplyTo: string | undefined;
  if (message.gmailMessageId) {
    try {
      const original = await readMessage(account.refreshToken, message.gmailMessageId);
      const origSubject = header(original, "Subject");
      if (origSubject) subject = /^re:/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
      inReplyTo = header(original, "Message-ID") || header(original, "Message-Id") || undefined;
    } catch (e) {
      console.warn(
        "[response-sender] could not read original email for threading:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  let sent: { id: string; threadId: string };
  try {
    sent = await sendGmailMessage(account.refreshToken, {
      to: message.customerEmail as string,
      subject,
      body: responseText,
      fromEmail: storeEmail,
      threadId: message.gmailThreadId || undefined,
      inReplyTo,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[response-sender] Gmail relay send failed:", msg);
    const scope = /insufficient|scope|permission|403/i.test(msg);
    return {
      success: false,
      method: "MANUAL",
      error: scope
        ? `Gmail ${storeEmail} is connected read-only. Re-connect it in Settings → Gmail to grant send permission, or reply in Seller Central.`
        : `Email send failed: ${msg}. Copy the response and paste it into Seller Central.`,
    };
  }

  const now = new Date();
  const via = opts.initiator === "AUTOPILOT" ? "AUTOPILOT" : "EMAIL_RELAY";
  await prisma.buyerMessage.update({
    where: { id: message.id },
    data: { status: "SENT", responseSentAt: now, responseSentVia: via },
  });
  await prisma.buyerMessage.create({
    data: {
      gmailMessageId: sent.id || null,
      gmailThreadId: sent.threadId || message.gmailThreadId,
      channel: message.channel,
      source: message.source,
      storeIndex: message.storeIndex,
      storeName: message.storeName,
      storeEmail: message.storeEmail,
      customerName: message.customerName,
      customerEmail: message.customerEmail,
      amazonOrderId: message.amazonOrderId,
      product: message.product,
      direction: "outgoing",
      customerMessage: responseText,
      status: "SENT",
      responseSentAt: now,
      responseSentVia: via,
      action: message.action,
      problemType: message.problemType,
      problemTypeName: message.problemTypeName,
      riskLevel: message.riskLevel,
    },
  });
  return { success: true, method: "EMAIL_RELAY" };
}
