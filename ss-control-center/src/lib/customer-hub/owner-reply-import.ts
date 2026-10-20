/**
 * Owner reply history from Gmail — pure parsing helpers.
 *
 * When the owner answers a buyer in Seller Central, Amazon emails the seller
 * mailbox "Your e-mail to {Buyer}" (donotreply@amazon.com) with a copy of the
 * reply between "Begin message" / "End message" markers. Those copies are the
 * owner's real answers — the best examples the KB can have. The importer
 * (scripts/import-owner-replies-from-gmail.ts) pairs each copy with the
 * buyer's preceding message on the same order and stores the pair as a
 * KnowledgeBaseEntry with source = "owner_edit".
 */

import { createHash } from "node:crypto";

export interface ParsedConfirmation {
  orderId: string | null;
  buyerName: string | null;
  product: string | null;
  replyText: string;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse the plain text of an Amazon "Your e-mail to …" confirmation. */
export function parseConfirmationText(
  text: string,
  subject: string | null | undefined
): ParsedConfirmation | null {
  const m = text.match(/-{3,}\s*Begin message\s*-{3,}([\s\S]*?)-{3,}\s*End message\s*-{3,}/i);
  if (!m) return null;
  const replyText = m[1].trim();
  if (!replyText) return null;
  const orderId = text.match(/(\d{3}-\d{7}-\d{7})/)?.[1] ?? null;
  const buyerName = (subject || "").match(/Your e-mail to\s+(.+)$/i)?.[1]?.trim() || null;
  // Product name is the line right after the ASIN line in the order table.
  const product = text.match(/\bB0[0-9A-Z]{8}\s*\n\s*([^\n]{5,300})/)?.[1]?.trim() ?? null;
  return { orderId, buyerName, product, replyText };
}

const ACTION_RULES: Array<[RegExp, string]> = [
  [/\bfull refund\b|\brefund(ed)? (the|your) (full|entire)/i, "full_refund"],
  [/\bpartial refund\b|\brefund(ed)? \$?\d/i, "partial_refund"],
  [/\breplacement\b|\bre-?ship\b|\bsend (you )?(a )?new\b/i, "replacement"],
  [/\brefund\b/i, "full_refund"],
  [/\bphoto|picture|image|clarify|could you (please )?(confirm|provide|send)/i, "clarify"],
  [/\bA-to-z|contact amazon|amazon customer service/i, "redirect_amazon"],
];

/** Best-effort action label from the owner's reply text. */
export function inferOwnerAction(reply: string): string {
  for (const [re, action] of ACTION_RULES) if (re.test(reply)) return action;
  return "reassure";
}

export function pairHash(buyerText: string, replyText: string): string {
  return createHash("sha1").update(`${buyerText}\n---\n${replyText}`).digest("hex").slice(0, 16);
}
