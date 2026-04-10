/**
 * Parse Amazon buyer-seller emails from Gmail API response
 */

import { EMAIL_TO_STORE } from "@/lib/gmail-api";

export interface ParsedBuyerEmail {
  gmailMessageId: string;
  gmailThreadId: string | null;
  storeIndex: number;
  storeName: string;
  storeEmail: string;
  customerName: string | null;
  customerEmail: string | null;
  amazonOrderId: string | null;
  asin: string | null;
  productName: string | null;
  customerMessage: string;
  language: "English" | "Spanish";
  receivedAt: Date;
}

function getHeader(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headers: any[],
  name: string
): string {
  const h = headers?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return h?.value || "";
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detectLanguage(text: string): "English" | "Spanish" {
  const spanishWords = [
    "hola",
    "gracias",
    "pedido",
    "envío",
    "producto",
    "recibí",
    "llegó",
    "dónde",
    "cuándo",
    "por favor",
    "estimado",
    "buenos días",
  ];
  const lower = text.toLowerCase();
  const spanishCount = spanishWords.filter((w) => lower.includes(w)).length;
  return spanishCount >= 2 ? "Spanish" : "English";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(payload: any): string {
  // Direct body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Multipart — find text/html or text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function extractOrderId(subject: string, bodyText: string): string | null {
  const regex = /(\d{3}-\d{7}-\d{7})/;
  const subjectMatch = subject.match(regex);
  if (subjectMatch) return subjectMatch[1];
  const bodyMatch = bodyText.match(regex);
  if (bodyMatch) return bodyMatch[1];
  return null;
}

function extractCustomerName(subject: string): string | null {
  const match = subject.match(/from Amazon customer (.+?)[\s(]/);
  return match ? match[1].trim() : null;
}

function extractAsin(html: string): string | null {
  const match = html.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : null;
}

function extractProductName(html: string): string | null {
  // Amazon emails often have product name in a table cell after ASIN
  const match = html.match(
    /<td[^>]*>([^<]{5,100})<\/td>\s*<\/tr>/i
  );
  return match ? stripHtml(match[1]).trim() : null;
}

function extractCustomerMessage(html: string, plainText: string): string {
  // Try to find message block in HTML
  // Common patterns: after "Message:" label, in specific div
  const msgMatch = html.match(
    /Message:?\s*<\/[^>]+>\s*<[^>]+>([\s\S]*?)(?:<\/td|<\/div|<br\s*\/?>.*?<br)/i
  );
  if (msgMatch) return stripHtml(msgMatch[1]).trim();

  // Fallback: use plain text, strip Amazon boilerplate
  const lines = plainText.split("\n").filter((l) => l.trim());
  // Remove standard Amazon footer lines
  const filtered = lines.filter(
    (l) =>
      !l.includes("Amazon.com") &&
      !l.includes("Your feedback") &&
      !l.includes("marketplace.amazon.com") &&
      !l.includes("-------") &&
      !l.match(/^\s*#\s*\|\s*ASIN/)
  );
  return filtered.join("\n").trim() || plainText.substring(0, 2000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseAmazonBuyerEmail(emailData: any): ParsedBuyerEmail | null {
  const headers = emailData.payload?.headers || [];
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const subject = getHeader(headers, "Subject");

  // Must be from marketplace.amazon.com
  if (!from.includes("@marketplace.amazon.com")) {
    return null;
  }

  // Determine store from To header
  let storeIndex = 0;
  let storeName = "Unknown";
  let storeEmail = "";
  for (const [email, info] of Object.entries(EMAIL_TO_STORE)) {
    if (to.toLowerCase().includes(email.toLowerCase())) {
      storeIndex = info.storeIndex;
      storeName = info.storeName;
      storeEmail = email;
      break;
    }
  }
  if (storeIndex === 0) {
    // Fallback: use first match from to field
    const emailMatch = to.match(/[\w.-]+@[\w.-]+/);
    storeEmail = emailMatch ? emailMatch[0] : to;
    storeIndex = 1;
    storeName = "Unknown Store";
  }

  const rawHtml = extractBody(emailData.payload);
  const plainText = stripHtml(rawHtml);

  const amazonOrderId = extractOrderId(subject, plainText);
  const customerName = extractCustomerName(subject);
  const customerEmail = from.match(/<(.+?)>/)?.[1] || from;
  const asin = extractAsin(rawHtml);
  const productName = extractProductName(rawHtml);
  const customerMessage = extractCustomerMessage(rawHtml, plainText);
  const language = detectLanguage(customerMessage);

  const internalDate = emailData.internalDate
    ? new Date(parseInt(emailData.internalDate))
    : new Date();

  return {
    gmailMessageId: emailData.id,
    gmailThreadId: emailData.threadId || null,
    storeIndex,
    storeName,
    storeEmail,
    customerName,
    customerEmail,
    amazonOrderId,
    asin,
    productName,
    customerMessage,
    language,
    receivedAt: internalDate,
  };
}
