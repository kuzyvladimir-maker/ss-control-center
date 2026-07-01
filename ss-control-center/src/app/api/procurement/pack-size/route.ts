// POST /api/procurement/pack-size
//
// Returns the multiplier for a marketplace listing — "how many physical
// items does one customer-ordered unit contain?". The Procurement page
// multiplies this by the order's quantity to show physical items to pick.
//
// Flow:
//   1. Sync regex pass (parsePackSize) — covers ~80% of titles cheaply
//      ("Pack of N", "Bundle of N", "Quantity of N", "N Cans", "8-Can",
//      "N Count", "N Pieces", etc.). Confident regex matches return
//      immediately and are persisted as source='regex'.
//   2. Title is "ambiguous" (regex matched but other plausible quantity
//      tokens exist — typical compound case: "12 / Carton | Bundle of 2")
//      OR regex returned null → look up ProductPackSizeCache.
//   3. Cache miss → call Claude Haiku 4.5 with a prompt-cached system
//      block that knows how to multiply compound expressions.
//   4. Any AI failure → fall back to whatever regex returned (or 1 if
//      regex also failed). We never block the procurement card.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { parsePackSize } from "@/lib/procurement/pack-size";
import { CLAUDE } from "@/lib/ai-models";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Body {
  title?: string;
}

interface PackSizeResponse {
  size: number;
  label: string;
  source: "cache" | "ai" | "regex" | "default";
}

const MODEL = CLAUDE.cheap;

// System prompt is byte-identical across requests — `cache_control` on it
// means second+ calls pay ~10% of input cost on the (stable) instructions.
const SYSTEM_PROMPT = `You extract pack-size multipliers from US marketplace product titles.

INPUT: a raw product title.

OUTPUT: a single integer = how many physical items are in ONE customer-ordered unit of this listing. Multiply compound expressions when present.

Rules:
- If the title says "Pack of N", "Bundle of N", "Set of N", "Box of N", "Case of N", "Quantity of N", "N Count", "N Pack", "N-Can", "N Cans", "N Bottles", "N Pieces", "N Cartons", "N pcs" — the multiplier is N.
- An explicit "Pack of N", "Bundle of N", "Box of N", "Case of N", "Set of N" or "Quantity of N" is AUTHORITATIVE — output N. Tokens like "N ct", "N count", "N oz", "N lb" sitting before it describe what is INSIDE one package, NOT how many packages the listing bundles, so do NOT multiply them in. "10 ct (Pack of 6)" = 6 (six bags, each a 10-count). "8 cans per box, Pack of 3" = 3. "4 oz Bottles, 6 Count (Pack of 2)" = 2.
- Only multiply when there are TWO distinct PACKAGE-level counts and no plain "Pack of N", e.g. "12 / Carton | Bundle of 2 Cartons" = 12 × 2 = 24.
- "Variety Pack" or "Bundle" alone without a number = 1.
- Weight tokens are NOT counts. "10.5 Ounce Can, Quantity of 4" = 4, not 10. "4.2 lb" = 1.
- Counts of flavours / varieties ("12 Flavors", "Mix of 6 Varieties") are NOT pack counts unless the title explicitly says one item per flavour. Default to 1 in that case.
- Decimal numbers ("1.62 fl oz") are weights / volumes, not counts. Ignore.
- If you cannot find any pack-size signal in the title, return 1.
- Output ONLY the integer — no quotes, no explanation, no units.

Examples:

INPUT: Sara Lee Artesano Bakery Bread Plain Sausage Rolls, 6 count, Soft Hot Dog Buns, 15 oz Bag (Pack of 2)
OUTPUT: 2

INPUT: Maruchan Instant Lunch. Chicken - Chicken - Cup - 12 / Carton | Bundle of 2 Cartons
OUTPUT: 24

INPUT: Campbell's Condensed Golden Mushroom Soup, 10.5 Ounce Can, Quantity of 4
OUTPUT: 4

INPUT: Fancy Feast Delights Wet Cat Food Variety Pack – 24 Cans, Cheese & Gravy Recipes
OUTPUT: 24

INPUT: Green Giant Pantry Provisions Variety Pack – 8-Can Everyday Veggie Essentials
OUTPUT: 8

INPUT: Del Monte Peaches Sliced 8.5 oz (Pack of 6)
OUTPUT: 6

INPUT: Thomas' Plain Mini Bagels, 10 ct (Pack of 6)
OUTPUT: 6

INPUT: Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)
OUTPUT: 4

INPUT: Salutem Vita - Pork Loin Bone-In Center Cut Roast, 4.2 lb (actual weight may vary within 5%)
OUTPUT: 1

INPUT: Salutem Vita Pets Salmon Recipe Wet Cat Food 5.5 oz Cans (Pack of 12)
OUTPUT: 12`;

function extractText(message: Anthropic.Messages.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

async function sizeViaClaude(rawTitle: string): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: MODEL,
    // Output is a single integer — 16 tokens is plenty.
    max_tokens: 16,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `INPUT: ${rawTitle}\nOUTPUT:`,
      },
    ],
  });
  const text = extractText(message).trim();
  const m = text.match(/(\d+)/);
  if (!m) throw new Error(`Claude returned non-numeric: "${text}"`);
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 999) {
    throw new Error(`Claude returned implausible size ${n}`);
  }
  return n;
}

export async function POST(req: NextRequest) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawTitle = (body.title ?? "").trim();
  if (!rawTitle) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const regexResult = parsePackSize(rawTitle);

  // 1. Cache lookup. Cache wins over regex because AI may have already
  // resolved a compound expression that regex can't multiply.
  try {
    const hit = await prisma.productPackSizeCache.findUnique({
      where: { rawTitle },
    });
    if (hit) {
      return NextResponse.json({
        size: hit.size,
        label: hit.label,
        source: "cache",
      } satisfies PackSizeResponse);
    }
  } catch (e) {
    console.warn("[pack-size] cache lookup failed", e);
  }

  // 2. Confident regex match (no ambiguity) — persist and return without
  // burning an AI call.
  if (regexResult && !regexResult.ambiguous) {
    try {
      await prisma.productPackSizeCache.upsert({
        where: { rawTitle },
        create: {
          rawTitle,
          size: regexResult.size,
          label: regexResult.label,
          source: "regex",
        },
        update: {}, // never overwrite a stored value with regex
      });
    } catch (e) {
      console.warn("[pack-size] cache write (regex) failed", e);
    }
    return NextResponse.json({
      size: regexResult.size,
      label: regexResult.label,
      source: "regex",
    } satisfies PackSizeResponse);
  }

  // 3. Ambiguous or no regex match → ask Claude.
  try {
    const aiSize = await sizeViaClaude(rawTitle);
    // Build a human label. Prefer the regex label when it's at least
    // partially descriptive; otherwise fall back to "N units".
    const label = regexResult ? `${regexResult.label} (× ${aiSize})` : `${aiSize} units`;
    try {
      await prisma.productPackSizeCache.upsert({
        where: { rawTitle },
        create: { rawTitle, size: aiSize, label, source: "ai" },
        update: { size: aiSize, label, source: "ai" },
      });
    } catch (e) {
      console.warn("[pack-size] cache write (ai) failed", e);
    }
    return NextResponse.json({
      size: aiSize,
      label,
      source: "ai",
    } satisfies PackSizeResponse);
  } catch (e) {
    console.warn(
      "[pack-size] AI failed, falling back:",
      e instanceof Error ? e.message : String(e),
    );
    // 4. AI failed — return whatever regex gave us (even if ambiguous),
    // or the default 1. Persist as source='regex' so a maintenance pass
    // can later promote it.
    if (regexResult) {
      try {
        await prisma.productPackSizeCache.upsert({
          where: { rawTitle },
          create: {
            rawTitle,
            size: regexResult.size,
            label: regexResult.label,
            source: "regex",
          },
          update: {},
        });
      } catch {
        /* fine — regex still works */
      }
      return NextResponse.json({
        size: regexResult.size,
        label: regexResult.label,
        source: "regex",
      } satisfies PackSizeResponse);
    }
    return NextResponse.json({
      size: 1,
      label: "1 unit",
      source: "default",
    } satisfies PackSizeResponse);
  }
}
