// Receipt OCR — Claude vision reads a store receipt image (already on R2) and
// returns {merchant, total, tax, date}. Mirrors the vision-check pattern
// (Anthropic SDK + URL image block + JSON parse from the text response).

import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";

/**
 * The subscription vision lane takes bytes, not a URL — the box has no reason
 * to be able to fetch arbitrary URLs on our behalf, and fetching here keeps a
 * receipt image inside the request that asked for it.
 */
async function fetchImageBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Receipt image could not be read (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }
  return null;
}

export interface ReceiptFields {
  merchant: string | null;
  total: number | null;
  tax: number | null;
  date: string | null;
  currency: string;
  raw: string;
}

export async function parseReceipt(imageUrl: string): Promise<ReceiptFields> {
  const image = await fetchImageBase64(imageUrl);
  const prompt =
    `This is a photo of a store purchase receipt. Read it and extract:\n`
    + `- merchant: the store name (e.g. Walmart, BJ's, Sam's Club, Target, Costco, Instacart)\n`
    + `- total: the GRAND TOTAL actually paid (a number)\n`
    + `- tax: the sales tax amount if shown (a number) else null\n`
    + `- date: the purchase date as YYYY-MM-DD if shown else null\n`
    + `- currency: 3-letter code (default USD)\n\n`
    + `Respond with ONLY valid JSON, no preamble:\n`
    + `{"merchant": string|null, "total": number|null, "tax": number|null, "date": "YYYY-MM-DD"|null, "currency": "USD"}`;

  // Runs on the Claude Max subscription through the box worker; the platform
  // holds no paid API tokens (owner instruction 2026-08-06).
  const parsed = (await identifyImageViaClaudeCli([image], prompt)) ?? {};
  const raw = JSON.stringify(parsed);
  return {
    merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
    total: toNum(parsed.total),
    tax: toNum(parsed.tax),
    date: typeof parsed.date === "string" ? parsed.date : null,
    currency: typeof parsed.currency === "string" ? parsed.currency : "USD",
    raw,
  };
}
