/**
 * POST /api/shipping/classify-ai
 *
 * AI-assisted Frozen/Dry classification for a Veeqo product. Fetches the
 * product (title, description, main image), sends them to Claude with a
 * focused prompt, and returns the suggested type + confidence + reasoning.
 *
 * This endpoint does NOT persist anything — the UI shows the result as a
 * preview, then calls /api/shipping/product-type to commit (so the operator
 * can override before saving).
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getProduct } from "@/lib/veeqo/client";

const SYSTEM_PROMPT = `Ты классифицируешь товар как FROZEN или DRY для логистики.

Контекст: Salutem Solutions продаёт продукты питания на Amazon. Frozen — это замороженные товары, которые требуют хладопакетов и быстрой доставки (≤3 дня). Dry — обычные товары без температурного режима.

Подсказки:
- На картинках замороженных товаров часто изображён пенопластовый кулер, лёд, белые упаковки с пометкой "Keep Frozen"
- В описании могут быть слова "frozen", "freezer", "thaw", "keep frozen", "ice pack", "perishable"
- В title часто прямо указано (например "Frozen Pizza")
- Колбасы, сыр, замороженные сэндвичи, пицца, морепродукты — обычно Frozen
- Сухие смеси, орехи, чипсы, выпечка длительного хранения — обычно Dry

Ответь СТРОГО валидным JSON, без какого-либо текста до или после:
{"type":"Frozen","confidence":0.92,"reasoning":"Краткое объяснение на русском, 1-2 предложения."}

Поле type — строго "Frozen" или "Dry". confidence — число от 0 до 1. reasoning — короткий текст.`;

function detectMediaType(
  bytes: Uint8Array
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

async function downloadImageAsBase64(url: string): Promise<{
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
} | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      mediaType: detectMediaType(new Uint8Array(buf.subarray(0, 4))),
    };
  } catch {
    return null;
  }
}

interface AIResult {
  type: "Frozen" | "Dry";
  confidence: number;
  reasoning: string;
}

function parseClaudeJson(text: string): AIResult | null {
  // Strip code fences if Claude wrapped the JSON.
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  // Find the first JSON object substring.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]);
    if (obj.type !== "Frozen" && obj.type !== "Dry") return null;
    return {
      type: obj.type,
      confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0)),
      reasoning: String(obj.reasoning ?? ""),
    };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") {
    return NextResponse.json(
      { error: "AI service not configured (missing ANTHROPIC_API_KEY)" },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const productId = Number(body?.productId);
  if (!Number.isFinite(productId) || productId <= 0) {
    return NextResponse.json(
      { error: "productId is required" },
      { status: 400 }
    );
  }

  let product;
  try {
    product = await getProduct(productId);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not fetch product: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 }
    );
  }

  const title: string = product?.title ?? product?.name ?? "Unknown product";
  const description: string =
    product?.description ?? product?.html_description ?? "";
  const imageUrl: string | undefined =
    product?.main_image?.src ??
    product?.main_image?.url ??
    product?.images?.[0]?.src ??
    product?.images?.[0]?.url;

  const client = new Anthropic({ apiKey });

  const content: Anthropic.MessageCreateParams["messages"][0]["content"] = [];
  if (imageUrl) {
    const img = await downloadImageAsBase64(imageUrl);
    if (img) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
  }
  content.push({
    type: "text",
    text:
      SYSTEM_PROMPT +
      `\n\nТовар:\nTitle: ${title}\nDescription: ${(description || "").slice(0, 1500)}`,
  });

  let parsed: AIResult | null = null;
  let rawText = "";
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 512,
      messages: [{ role: "user", content }],
    });
    const textBlock = resp.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      rawText = textBlock.text;
      parsed = parseClaudeJson(textBlock.text);
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: `Claude call failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 502 }
    );
  }

  if (!parsed) {
    return NextResponse.json(
      {
        error: "Could not parse classification from AI response",
        rawText: rawText.slice(0, 500),
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    productId,
    productTitle: title,
    productImage: imageUrl ?? null,
    type: parsed.type,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  });
}
