/**
 * A-to-Z Guarantee email parser
 *
 * Amazon sends A-to-Z notifications from atoz-guarantee-no-reply@amazon.com
 * with two patterns:
 *
 * 1. NEW CLAIM:
 *    Subject: "Claim received on order 111-XXXXXXX-XXXXXXX"
 *    Body: "We received an A-to-z Guarantee claim of $XX.XX on the order ..."
 *    Deadline: implicit — 3 calendar days from email date
 *
 * 2. DECISION:
 *    Subject: "Claim decision on order 111-XXXXXXX-XXXXXXX"
 *    Body: "We have granted an A-to-z Guarantee claim of $XX.XX on the order ..."
 *    Contains: "covered the cost" = AMAZON_FUNDED
 *    Contains: "should not be held responsible" = IN_OUR_FAVOR
 *
 * Verified from real emails 2026-03-14 and 2026-03-15.
 */

import type { EmailToStoreMap } from "@/lib/gmail-api";

export interface ParsedAtozEmail {
  amazonOrderId: string | null;
  amount: number | null;
  claimType: "A_TO_Z";
  /** "new" = claim just filed, "decision" = Amazon made a ruling */
  emailType: "new" | "decision";
  /** For decisions: did Amazon fund it or rule against us? */
  amazonDecision: "AMAZON_FUNDED" | "IN_OUR_FAVOR" | "AGAINST_US" | null;
  deadline: string | null;
  storeIndex: number;
  storeName: string;
  gmailMessageId: string;
  receivedAt: Date;
}

export function parseAtozEmail(
  gmailMessageId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers: any[],
  bodyText: string,
  emailToStoreMap: EmailToStoreMap
): ParsedAtozEmail | null {
  const getHeader = (name: string): string =>
    headers?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (h: any) => h?.name?.toLowerCase() === name.toLowerCase()
    )?.value || "";

  const from = getHeader("From").toLowerCase();
  if (!from.includes("atoz") && !from.includes("a-to-z")) return null;

  const subject = getHeader("Subject");
  const to = getHeader("To");
  const dateHeader = getHeader("Date");

  // Order ID — from subject first, then body
  const orderMatch =
    subject.match(/(\d{3}-\d{7}-\d{7})/) ||
    bodyText.match(/(\d{3}-\d{7}-\d{7})/);
  if (!orderMatch) return null;

  // Amount
  const amountMatch = bodyText.match(/claim of \$([\d,]+\.\d{2})/i);
  const amount = amountMatch
    ? parseFloat(amountMatch[1].replace(",", ""))
    : null;

  // Email type: new vs decision
  const subjectLower = subject.toLowerCase();
  const bodyLower = bodyText.toLowerCase();
  const isDecision =
    subjectLower.includes("decision") || bodyLower.includes("granted");
  const emailType: "new" | "decision" = isDecision ? "decision" : "new";

  // Amazon decision (for decision emails)
  let amazonDecision: ParsedAtozEmail["amazonDecision"] = null;
  if (isDecision) {
    if (
      bodyLower.includes("covered the cost") ||
      bodyLower.includes("should not be held responsible")
    ) {
      amazonDecision = "AMAZON_FUNDED";
    } else if (bodyLower.includes("in your favor")) {
      amazonDecision = "IN_OUR_FAVOR";
    } else {
      amazonDecision = "AGAINST_US";
    }
  }

  // Deadline for new claims — 3 calendar days from email date
  let deadline: string | null = null;
  if (emailType === "new" && dateHeader) {
    const emailDate = new Date(dateHeader);
    if (!Number.isNaN(emailDate.getTime())) {
      const dl = new Date(emailDate);
      dl.setDate(dl.getDate() + 3);
      deadline = dl.toISOString().split("T")[0];
    }
  }

  // Received at
  let receivedAt = new Date();
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) receivedAt = parsed;
  }

  // Store detection from To header
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
    claimType: "A_TO_Z",
    emailType,
    amazonDecision,
    deadline,
    storeIndex,
    storeName,
    gmailMessageId,
    receivedAt,
  };
}
