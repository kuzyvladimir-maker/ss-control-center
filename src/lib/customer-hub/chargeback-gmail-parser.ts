/**
 * Chargeback email parser
 *
 * Amazon sends chargeback notifications from two senders:
 *
 * 1. NEW CHARGEBACK (needs response within 7 days):
 *    From: cb-seller-notification@amazon.com
 *    Body: "there is a chargeback dispute involving the following transaction"
 *    Contains: Order number, amount, items, shipping address
 *    Deadline: 7 days from email date (explicit in body)
 *
 * 2. DECISION (funding result):
 *    From: cb-seller-query@amazon.com
 *    Subject: "{orderId}, Amazon.com Chargeback Dispute Funding Decision"
 *    Body: "Chargeback amount: XX.XX USD", "Order number: ..."
 *    Contains: whether seller is responsible or Amazon covered
 *
 * Verified from real emails 2026-02/03.
 */

import type { EmailToStoreMap } from "@/lib/gmail-api";

export interface ParsedChargebackEmail {
  amazonOrderId: string | null;
  amount: number | null;
  claimType: "CHARGEBACK";
  emailType: "new" | "decision";
  amazonDecision: "AMAZON_FUNDED" | "AGAINST_US" | null;
  deadline: string | null;
  product: string | null;
  shippingAddress: string | null;
  storeIndex: number;
  storeName: string;
  gmailMessageId: string;
  receivedAt: Date;
}

export function parseChargebackEmail(
  gmailMessageId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers: any[],
  bodyText: string,
  emailToStoreMap: EmailToStoreMap
): ParsedChargebackEmail | null {
  const getHeader = (name: string): string =>
    headers?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h: any) => h?.name?.toLowerCase() === name.toLowerCase()
    )?.value || "";

  const from = getHeader("From").toLowerCase();
  if (!from.includes("cb-seller")) return null;

  const subject = getHeader("Subject");
  const to = getHeader("To");
  const dateHeader = getHeader("Date");

  // Order ID — from body "Order number: XXX" or subject or general regex
  const orderMatch =
    bodyText.match(/Order number:\s*(\d{3}-\d{7}-\d{7})/) ||
    subject.match(/(\d{3}-\d{7}-\d{7})/) ||
    bodyText.match(/(\d{3}-\d{7}-\d{7})/);
  if (!orderMatch) return null;

  // Email type: new vs decision
  const isDecision =
    from.includes("cb-seller-query") ||
    subject.toLowerCase().includes("funding decision");

  // Amount — different patterns for new vs decision
  let amount: number | null = null;
  if (isDecision) {
    const m = bodyText.match(/Chargeback amount:\s*([\d,]+\.\d{2})/i);
    if (m) amount = parseFloat(m[1].replace(",", ""));
  }
  if (!amount) {
    const m = bodyText.match(/for ([\d,]+\.\d{2}) USD/);
    if (m) amount = parseFloat(m[1].replace(",", ""));
  }
  if (!amount) {
    const m = bodyText.match(/\$([\d,]+\.\d{2})/);
    if (m) amount = parseFloat(m[1].replace(",", ""));
  }

  // Amazon decision (for decision emails)
  let amazonDecision: ParsedChargebackEmail["amazonDecision"] = null;
  if (isDecision) {
    const bodyLower = bodyText.toLowerCase();
    if (
      bodyLower.includes("responsible for this chargeback") ||
      bodyLower.includes("debited your account")
    ) {
      amazonDecision = "AGAINST_US";
    } else if (bodyLower.includes("in your favor") || bodyLower.includes("resolved")) {
      amazonDecision = "AMAZON_FUNDED";
    }
  }

  // Product (from new chargeback emails)
  const productMatch = bodyText.match(
    /Items purchased:\s*\d+ of \(([^)]+)\)/
  );

  // Shipping address (multi-line after "Shipping address:")
  const addressMatch = bodyText.match(
    /Shipping address:\s*\n?([\s\S]{10,200}?)(?:\n\n|In response)/
  );

  // Deadline — 7 days from email date for new chargebacks
  let deadline: string | null = null;
  if (!isDecision && dateHeader) {
    const emailDate = new Date(dateHeader);
    if (!Number.isNaN(emailDate.getTime())) {
      const dl = new Date(emailDate);
      dl.setDate(dl.getDate() + 7);
      deadline = dl.toISOString().split("T")[0];
    }
  }

  let receivedAt = new Date();
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) receivedAt = parsed;
  }

  // Store detection
  let storeIndex = 1;
  let storeName = "Store";
  if (emailToStoreMap) {
    const toEmail = to.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() || "";
    for (const [email, info] of Object.entries(emailToStoreMap)) {
      if (toEmail === email.toLowerCase()) {
        storeIndex = info.storeIndex;
        storeName = info.storeName;
        break;
      }
    }
  }

  return {
    amazonOrderId: orderMatch[1],
    amount,
    claimType: "CHARGEBACK",
    emailType: isDecision ? "decision" : "new",
    amazonDecision,
    deadline,
    product: productMatch ? productMatch[1].trim() : null,
    shippingAddress: addressMatch ? addressMatch[1].trim() : null,
    storeIndex,
    storeName,
    gmailMessageId,
    receivedAt,
  };
}
