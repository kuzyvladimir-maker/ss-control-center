// POST /api/procurement/clean-title
//
// Returns a short, search-friendly version of a marketplace product title
// — brand (real brands only; private labels dropped) + core product, with
// NO weight/size (Vladimir asked to drop it 2026-06-30 so the marketplace
// search isn't pinned to one size variant). Used by the Procurement card's
// Copy button so the operator can paste straight into an online-store search.
//
// Flow:
//   1. Look up ProductTitleCache by exact raw title — return immediately on hit.
//   2. Cache miss → call Claude Haiku 4.5 with a brand-aware system prompt
//      that's prompt-cached (the system block is identical request-to-request
//      so cached reads cost ~10% of full input).
//   3. Persist the result and return.
//   4. Any AI failure → fall back to the local regex helper. We still persist
//      the regex output (source='regex') so a later backfill can promote it
//      to AI-quality when the API recovers.
//
// Every path runs the final string through `stripSizeTokens` before
// returning. That's deliberate: the cache holds titles created earlier when
// weight was kept on purpose, and we can't cheaply flush the (production)
// cache — so we strip on the way out instead, making old and new entries
// alike come back size-free.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import {
  cleanProductTitleForSearch,
  stripSizeTokens,
} from "@/lib/procurement/clean-product-query";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface Body {
  title?: string;
}

interface CleanResponse {
  cleanTitle: string;
  source: "cache" | "ai" | "regex";
}

const MODEL = "claude-haiku-4-5";

// System prompt is byte-identical across requests so the prompt cache
// kicks in after the first call — only the per-call user message varies.
const SYSTEM_PROMPT = `You normalize US grocery / retail product titles for online-store search.

INPUT: a raw product title from a marketplace listing.

OUTPUT: a short search string with this structure:
  [Brand] <core product>

Rules:
- Brand: keep the real third-party brand at the start (Sara Lee, Arnold, Fancy Feast, Del Monte, Maruchan, Stur Drinks, Green Giant, Oscar Mayer, Bird's Eye, Eggo, Lean Cuisine, Ben & Jerry's, Stouffer's, etc.). EXCEPTION — if the brand at the start is one of these private labels (the seller's own brand, not a real retail brand), DROP it entirely: "Salutem Vita", "Salutem Vita Pets", "Starfit".
- Core product: the actual product noun phrase. When the title lists the product twice (one marketing/category description and one concrete name), pick the more specific concrete name. Drop marketing breadcrumbs like "Bakery Bread Plain".
- Weight / size: DROP it entirely. No oz, fl oz, lb, lbs, pounds, g, grams, kg, ml, liters, or any numeric size token. The search must NOT be pinned to one size variant.
- Drop: weight/size (see above), pack/count phrasing ("Pack of N", "(Pack of N)", "6 Count", "8-Can", "24 Cans"), container suffix (Bag, Box, Bottle) unless it is the only product noun left, parenthetical caveats like "(actual weight may vary within 5%)", trailing marketing tagline.
- Output: plain ASCII, single line, no quotes, no trailing punctuation. Output ONLY the cleaned title — no preamble, no explanation.

Examples:

INPUT: Sara Lee Artesano Bakery Bread Plain Sausage Rolls, 6 count, Soft Hot Dog Buns, 15 oz Bag (Pack of 2)
OUTPUT: Sara Lee Artesano Soft Hot Dog Buns

INPUT: Salutem Vita - Pork Loin Bone-In Center Cut Roast, 4.2 lb (actual weight may vary within 5%)
OUTPUT: Pork Loin Bone-In Center Cut Roast

INPUT: Arnold Premium Sub Rolls, 6 Count, 15 oz Box (Pack of 2)
OUTPUT: Arnold Premium Sub Rolls

INPUT: Fancy Feast Delights Wet Cat Food Variety Pack - 24 Cans, Cheese & Gravy Recipes
OUTPUT: Fancy Feast Delights Cheese & Gravy Wet Cat Food

INPUT: Stur Drinks Black Cherry, Liquid Water Enhancer 1.62 fl oz (Pack of 4)
OUTPUT: Stur Drinks Black Cherry Liquid Water Enhancer

INPUT: Del Monte Peaches Sliced 8.5 oz (Pack of 6)
OUTPUT: Del Monte Peaches Sliced

INPUT: Progresso Chickpea & Noodle Protein Soup, Vegetarian, 18.5 oz. (Pack of 6)
OUTPUT: Progresso Chickpea & Noodle Protein Soup Vegetarian

INPUT: Salutem Vita Pets Salmon Recipe Wet Cat Food 5.5 oz Cans (Pack of 12)
OUTPUT: Salmon Recipe Wet Cat Food

INPUT: Maruchan Ramen Noodle Pork Flavor Soup, 3 oz Shelf Stable Package (Pack of 8)
OUTPUT: Maruchan Ramen Noodle Pork Flavor Soup`;

function extractText(message: Anthropic.Messages.Message): string {
  for (const block of message.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

async function cleanViaClaude(rawTitle: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === "<api_key>") {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const client = new Anthropic({ apiKey });
  // 200 max_tokens is plenty — outputs are short single-line strings.
  // Thinking is disabled by default on Haiku 4.5 (no `effort` either —
  // Haiku doesn't support those knobs). cache_control on the system block
  // means the second+ calls of the day pay ~10% of input cost on the
  // (large, stable) instructions and examples block.
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
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
  if (!text) throw new Error("Empty response from Claude");
  // Defensive: strip an accidental "OUTPUT:" prefix if the model leaks it.
  return text.replace(/^OUTPUT:\s*/i, "").trim();
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

  // 1. Cache lookup.
  try {
    const hit = await prisma.productTitleCache.findUnique({
      where: { rawTitle },
    });
    if (hit) {
      // Strip size on the way out: cached entries may predate the
      // weight-free rule and still carry "18.5 oz" etc.
      return NextResponse.json({
        cleanTitle: stripSizeTokens(hit.cleanTitle),
        source: "cache",
      } satisfies CleanResponse);
    }
  } catch (e) {
    // DB unavailable — fall through to AI, then to regex. Surface the
    // failure in the response.source so the client knows.
    console.warn("[clean-title] cache lookup failed", e);
  }

  // 2. Cache miss → ask Claude Haiku. The prompt already drops weight; the
  //    stripSizeTokens pass is a belt-and-suspenders guard before we persist.
  try {
    const cleanTitle = stripSizeTokens(await cleanViaClaude(rawTitle));
    // Persist for next time. Upsert so a concurrent request that wins the
    // race doesn't cause us to 500.
    try {
      await prisma.productTitleCache.upsert({
        where: { rawTitle },
        create: { rawTitle, cleanTitle, source: "ai" },
        update: { cleanTitle, source: "ai" },
      });
    } catch (e) {
      console.warn("[clean-title] cache write failed", e);
    }
    return NextResponse.json({
      cleanTitle,
      source: "ai",
    } satisfies CleanResponse);
  } catch (e) {
    // 3. AI path failed — fall back to local regex. Persist as 'regex' so
    // a maintenance pass can later replace these with AI output.
    const cleanTitle = cleanProductTitleForSearch(rawTitle);
    try {
      await prisma.productTitleCache.upsert({
        where: { rawTitle },
        create: { rawTitle, cleanTitle, source: "regex" },
        update: {}, // never overwrite a real cached value with regex
      });
    } catch {
      /* fine — regex worked, that's the important part */
    }
    console.warn(
      "[clean-title] AI failed, returning regex fallback:",
      e instanceof Error ? e.message : String(e),
    );
    return NextResponse.json({
      cleanTitle,
      source: "regex",
    } satisfies CleanResponse);
  }
}
