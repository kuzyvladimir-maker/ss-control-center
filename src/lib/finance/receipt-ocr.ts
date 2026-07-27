// Receipt OCR — Claude vision reads a store receipt image (already on R2) and
// returns {merchant, total, tax, date}. Mirrors the vision-check pattern
// (Anthropic SDK + URL image block + JSON parse from the text response).

import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE } from "@/lib/ai-models";

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
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
  const client = getClient();
  if (!client) throw new Error("ANTHROPIC_API_KEY not set");

  const resp = await client.messages.create({
    model: CLAUDE.balanced,
    max_tokens: 400,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text:
              `This is a photo of a store purchase receipt. Read it and extract:\n` +
              `- merchant: the store name (e.g. Walmart, BJ's, Sam's Club, Target, Costco, Instacart)\n` +
              `- total: the GRAND TOTAL actually paid (a number)\n` +
              `- tax: the sales tax amount if shown (a number) else null\n` +
              `- date: the purchase date as YYYY-MM-DD if shown else null\n` +
              `- currency: 3-letter code (default USD)\n\n` +
              `Respond with ONLY valid JSON, no preamble:\n` +
              `{"merchant": string|null, "total": number|null, "tax": number|null, "date": "YYYY-MM-DD"|null, "currency": "USD"}`,
          },
        ],
      },
    ],
  });

  const textBlock = resp.content.find((b) => b.type === "text");
  const raw = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* keep empty */ }
  }
  return {
    merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
    total: toNum(parsed.total),
    tax: toNum(parsed.tax),
    date: typeof parsed.date === "string" ? parsed.date : null,
    currency: typeof parsed.currency === "string" ? parsed.currency : "USD",
    raw,
  };
}
