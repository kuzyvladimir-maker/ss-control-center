/**
 * Parse Amazon buyer-seller emails from Gmail API response
 */

import type { EmailToStoreMap } from "@/lib/gmail-api";

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

// Extract customer name from either the email Subject or the From display
// name. Amazon formats buyer-message subjects inconsistently and sometimes
// the name only appears in the sender display name:
//   From: "Alisa - Amazon Marketplace <xxx@marketplace.amazon.com>"
//   Subject: "Inquiry from Amazon customer Alisa (Order: 114-...)"
// We try the From header first (most reliable when present) then several
// Subject patterns. Name character class is restricted to letters + space +
// apostrophe + hyphen so we don't accidentally capture "(Order" or URL bits.
function extractCustomerName(
  subject: string,
  fromHeader?: string
): string | null {
  const cleanName = (raw: string): string | null => {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name || name.length < 2) return null;
    if (name.toLowerCase() === "customer") return null;
    return name;
  };

  // 1) From header — quoted or unquoted display name followed by "- Amazon"
  if (fromHeader) {
    const m = fromHeader.match(/^"?([^"<-]+?)\s*[-–]\s*Amazon/i);
    if (m) {
      const name = cleanName(m[1]);
      if (name) return name;
    }
  }

  // 2) Subject patterns — strictest to loosest. Restrict name chars to
  // [A-Za-z] + space + apostrophe + hyphen so we don't slurp "(Order".
  const subjectPatterns: RegExp[] = [
    /from Amazon customer ([A-Za-z][A-Za-z\s'-]+?)[\s(]/,
    /from Amazon customer ([A-Za-z][A-Za-z\s'-]+?)$/,
    /Amazon customer ([A-Za-z][A-Za-z\s'-]+?)[\s(]/,
    // Subject starts with "Name - Shipping inquiry..."
    /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*[-–]\s*[A-Z]/,
  ];

  for (const re of subjectPatterns) {
    const m = subject.match(re);
    if (m) {
      const name = cleanName(m[1]);
      if (name) return name;
    }
  }

  return null;
}

function extractAsin(html: string): string | null {
  // Try all /dp/<ASIN> and /gp/product/<ASIN> patterns, pick the first that
  // looks like a valid ASIN (starts with B, length 10, alphanumeric).
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?#"]|$)/g,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?#"]|$)/g,
    /[?&]asin=([A-Z0-9]{10})(?:[&"]|$)/gi,
  ];
  for (const re of patterns) {
    const matches = [...html.matchAll(re)];
    for (const m of matches) {
      const asin = m[1].toUpperCase();
      if (/^B[A-Z0-9]{9}$/.test(asin)) return asin;
    }
    // Fallback: accept any 10-char alphanum match if no B-prefix found
    if (matches.length > 0) return matches[0][1].toUpperCase();
  }
  return null;
}

function extractProductName(html: string): string | null {
  // Amazon buyer-message emails render the product row as:
  //   <a href=".../dp/ASIN">Product Name</a>
  // Try anchor-based match first (most reliable), then fall back to a
  // stricter table-cell pattern that requires the row to contain a product link.
  const anchorMatch = html.match(
    /<a[^>]*href="[^"]*\/dp\/[A-Z0-9]{10}[^"]*"[^>]*>([^<]{3,200})<\/a>/i
  );
  if (anchorMatch) {
    const name = stripHtml(anchorMatch[1]).trim();
    if (name.length >= 3) return name;
  }

  // Stricter table-cell fallback: require the row to contain a /dp/ link.
  const rowMatch = html.match(
    /<tr[^>]*>[\s\S]*?\/dp\/[A-Z0-9]{10}[\s\S]*?<td[^>]*>([^<]{5,200})<\/td>[\s\S]*?<\/tr>/i
  );
  if (rowMatch) {
    const name = stripHtml(rowMatch[1]).trim();
    if (name.length >= 3) return name;
  }

  return null;
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

/**
 * Parse a Gmail message into a ParsedBuyerEmail. The email→store mapping
 * is passed in (not imported) so the caller can preload it once from the
 * Setting table via `loadEmailToStoreMap()` and pass it into every call
 * during a bulk sync.
 */
export function parseAmazonBuyerEmail(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emailData: any,
  emailToStoreMap: EmailToStoreMap
): ParsedBuyerEmail | null {
  const headers = emailData.payload?.headers || [];
  const from = getHeader(headers, "From");
  const to = getHeader(headers, "To");
  const subject = getHeader(headers, "Subject");

  // Must be from marketplace.amazon.com
  if (!from.includes("@marketplace.amazon.com")) {
    return null;
  }

  // Determine store from To header using the pre-loaded email→store map
  // (built from Setting table + STORE{N}_NAME env vars). Case-insensitive.
  let storeIndex = 0;
  let storeName = "Unknown";
  let storeEmail = "";
  const toLower = to.toLowerCase();
  for (const [email, info] of emailToStoreMap) {
    if (toLower.includes(email)) {
      storeIndex = info.storeIndex;
      storeName = info.storeName;
      storeEmail = email;
      break;
    }
  }
  if (storeIndex === 0) {
    // Fallback: no matching entry — pick the first email-looking token in
    // To and keep going with an "Unknown Store" label.
    const emailMatch = to.match(/[\w.-]+@[\w.-]+/);
    storeEmail = emailMatch ? emailMatch[0] : to;
    storeIndex = 1;
    storeName = "Unknown Store";
  }

  const rawHtml = extractBody(emailData.payload);
  const plainText = stripHtml(rawHtml);

  const amazonOrderId = extractOrderId(subject, plainText);
  const customerName = extractCustomerName(subject, from);
  const customerEmail = from.match(/<(.+?)>/)?.[1] || from;
  const asin = extractAsin(rawHtml);
  const productName = extractProductName(rawHtml);
  const customerMessage = extractCustomerMessage(rawHtml, plainText);
  const language = detectLanguage(customerMessage);

  // Prefer the email's own "Date" header when present (represents the
  // wall-clock time Amazon sent the message), falling back to Gmail's
  // internalDate (when it landed in the mailbox), and finally to "now".
  const dateHeader = getHeader(headers, "Date");
  let receivedAt: Date = new Date();
  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) {
      receivedAt = parsed;
    }
  }
  if (
    receivedAt.getTime() === 0 ||
    Number.isNaN(receivedAt.getTime()) ||
    (!dateHeader && emailData.internalDate)
  ) {
    receivedAt = new Date(parseInt(emailData.internalDate));
  }

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
    receivedAt,
  };
}
