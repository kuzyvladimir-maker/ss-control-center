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
import { identifyImageViaClaudeCli } from "@/lib/image-gen/codex-worker";
import { completeJsonWithSubscription } from "@/lib/llm/subscription";
import { getProduct } from "@/lib/veeqo/client";

const SYSTEM_PROMPT = `You classify a product as FROZEN or DRY for logistics.

Context: Salutem Solutions sells food on Amazon. Frozen means goods that need gel packs and fast delivery (<=3 days). Dry means ordinary goods with no temperature control.

Hints:
- Photos of frozen goods often show a foam cooler, ice, or white packaging marked "Keep Frozen"
- The description may contain "frozen", "freezer", "thaw", "keep frozen", "ice pack", "perishable"
- The title often says it outright (e.g. "Frozen Pizza")
- Sausage, cheese, frozen sandwiches, pizza, seafood — usually Frozen
- Dry mixes, nuts, chips, shelf-stable baked goods — usually Dry

Answer with STRICTLY valid JSON and nothing before or after it:
{"type":"Frozen","confidence":0.92,"reasoning":"A short explanation in English, 1-2 sentences."}

The type field is strictly "Frozen" or "Dry". confidence is a number from 0 to 1. reasoning is short text.`;

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

  const prompt = SYSTEM_PROMPT
    + `\n\nProduct:\nTitle: ${title}\nDescription: ${(description || "").slice(0, 1500)}`;

  const images: string[] = [];
  if (imageUrl) {
    const img = await downloadImageAsBase64(imageUrl);
    if (img) images.push(img.base64);
  }

  let parsed: AIResult | null = null;
  let rawText = "";
  try {
    // Claude Max subscription through the box worker — no paid API tokens
    // anywhere in this platform (owner instruction 2026-08-06). The worker
    // returns a parsed object, so there is no JSON to dig out of prose.
    const result = images.length
      ? await identifyImageViaClaudeCli(images, prompt)
      : await completeJsonWithSubscription<Record<string, unknown>>({ prompt });
    if (result) {
      rawText = JSON.stringify(result);
      parsed = result as unknown as AIResult;
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: `Subscription vision lane failed: ${
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
